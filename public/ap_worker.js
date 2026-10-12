"use strict";
// Single Pyodide worker that patches the ROM and runs the AP game client.
// Boots the full Archipelago + apworld import graph on first use, then:
//   patch(romBytes, patchBytes) → patchedBytes
//   session-start               → BizHawkClientContext against the server
//
// Protocol (main ↔ worker):
//   { id, cmd, ...payload }     → { id, ok, out? } | { id, error }
//   progress events stream as    { id, event: "progress", phase }

importScripts("https://cdn.jsdelivr.net/pyodide/v0.29.5/full/pyodide.js");

// Hide JSPI (WebAssembly stack switching) from Pyodide. Where the browser has
// it, Pyodide runs every event-loop callback on a switchable stack, and under
// Firefox 156 that corrupts the wasm heap within minutes: fatals with
// "RuntimeError: index out of bounds" in whatever touches the damage next
// (malloc, the JsProxy type cache). A bare Pyodide page with no app code
// reproduces it with JSPI on and not with it off. Nothing here suspends — no
// run_sync, no syncify — so JSPI buys us nothing. Pyodide has no option for
// this; it only feature-detects, via `"Suspending" in WebAssembly` (and the
// older Suspender API).
delete WebAssembly.Suspending;
delete WebAssembly.Suspender;
delete WebAssembly.promising;

let pyodide = null;
// Only true once ensureInit has run all the way through. `pyodide` alone is a
// bad readiness signal — it's assigned partway through boot, and it stays
// truthy after a fatal error.
let booted = false;
let initPromise = null;
// Bundled Archipelago source is split into ap/core.tar plus one tar per
// Crystal apworld version (see pack.sh / apworlds.json). Archipelago's
// registries are keyed by game name, so only one version of each world package
// can live in this interpreter. Which tars make up this runtime is decided on
// the main thread (src/lib/apworld.ts, from the versions.json baked into the
// bundle) and handed over in a `configure` message the wrapper posts the moment
// it spawns us — before any command that could boot. A different world set
// means a different worker; the wrapper restarts us for that.
const AP_DIR = "ap/";
let runtimeConfig = null;    // { coreTar, worlds: [versions.json entries] }
let loadedWorlds = [];       // runtimeConfig.worlds once this boot has committed to them
// Session state (lives while a BizHawk AP session is running).
let sessionTasks = null;           // py cancellables
let nextBhId = 1;
const bhPending = new Map();        // id → { resolve, reject }

// Python stdout/stderr lines are batched: a connected session prints in
// bursts (one line per PrintJSON packet), and a postMessage per line costs
// the main thread a task dispatch each. Lines queue here and go out as one
// {event:"py-log", msgs:[...]} per worker tick. Any other post flushes the
// queue first so log lines never reorder against replies or bridge requests,
// and a fatal reply always carries the diagnostics printed just before it.
// The tick timer can't fire while synchronous Python (boot, patch) holds
// the worker for minutes, so while one of those commands
// runs each line goes out as it's printed: the log keeps moving through long
// silent stretches, and a line printed just before a hang (or a kill for
// one) isn't left in the queue. Otherwise a batch also goes out once it's
// LOG_FLUSH_MS old.
const LOG_FLUSH_MS = 100;
const SYNC_HEAVY_CMDS = new Set(["init", "patch"]);
let syncHeavyRuns = 0;
let logQueue = [];
let logFlushTimer = null;
let logQueuedAt = 0;
function flushLog() {
  if (logFlushTimer !== null) { clearTimeout(logFlushTimer); logFlushTimer = null; }
  if (logQueue.length === 0) return;
  const msgs = logQueue;
  logQueue = [];
  self.postMessage({ event: "py-log", msgs });
}
self._pyLog = (msg) => {
  if (logQueue.length === 0) logQueuedAt = performance.now();
  logQueue.push(msg);
  if (syncHeavyRuns > 0 || performance.now() - logQueuedAt >= LOG_FLUSH_MS) flushLog();
  else if (logFlushTimer === null) logFlushTimer = setTimeout(flushLog, 0);
};
function post(msg, transfer) {
  flushLog();
  self.postMessage(msg, transfer || []);
}
self._post = post;
// An uncaught error or rejection reaches the main thread as worker.onerror,
// which terminates us — flush first so the stderr lines leading up to it
// (typically the traceback) still make it out. Listeners only; the error
// still propagates to the parent.
self.addEventListener("error", flushLog);
self.addEventListener("unhandledrejection", flushLog);

// Crash diagnostics. A fatal Pyodide error (a WASM trap like "index out of
// bounds", an OOM) reports itself through console.error — the header, the
// cause, and a dump of what Python was running — which only the worker's
// devtools console would show; mirror it into the app log. An uncaught error
// from a background task (the game watcher, the server loop) never passes
// through a command's catch, so log its stack here before it propagates.
const _consoleError = console.error.bind(console);
// Firefox's Error.stack is the frames alone — no "Name: message" header like
// Chrome's — so a stack-only line loses what actually went wrong (the trap
// kind, "out of memory", ...). Lead with the message whenever the stack lacks it.
function describeError(e) {
  const head = `${e.name || "Error"}: ${e.message}`;
  if (!e.stack) return head;
  return e.stack.includes(e.message) ? e.stack : head + "\n" + e.stack;
}
// The wasm heap at the moment of a fatal: one near its ceiling points at an
// OOM rather than a bug, which the stack alone can't distinguish.
function heapSize() {
  try { return `${Math.round(pyodide._module.HEAP8.length / 1048576)} MiB`; }
  catch { return "unknown"; }
}
console.error = (...args) => {
  _consoleError(...args);
  try {
    let line = args.map((a) => (a instanceof Error ? describeError(a) : String(a))).join(" ");
    if (/suffered a fatal error/.test(line)) line += ` (wasm heap ${heapSize()})`;
    self._pyLog("[worker] " + line);
    flushLog();
  } catch {}
};
self.addEventListener("error", (ev) => {
  try {
    self._pyLog("[worker] uncaught: " + (ev.error instanceof Error ? describeError(ev.error) : ev.message));
    flushLog();
  } catch {}
});

// After a fatal error (OOM, a WASM abort, an exception crossing the JS↔WASM
// boundary) Pyodide latches a dead flag: every later call throws "already
// fatally failed" and the runtime can never be revived in place. ensureInit
// can't tell — `pyodide` is still a truthy, dead object — so probe with a
// trivial eval whenever a command fails. A true result means the main thread
// must terminate and respawn this worker; there is no in-place recovery.
function pyodideIsDead() {
  if (!pyodide) return false;
  try { pyodide.runPython("1"); return false; }
  catch (err) { return /fatally failed|fatal error/i.test(err?.message || String(err)); }
}

async function ensureInit(id) {
  if (booted) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const report = (phase) => post({ id, event: "progress", phase });

    if (!runtimeConfig) throw new Error("ap worker booted before it was configured");
    loadedWorlds = runtimeConfig.worlds;
    // Start the tar downloads now so they overlap the Pyodide boot.
    const tarsPromise = Promise.all([
      fetchBuf(AP_DIR + runtimeConfig.coreTar),
      ...loadedWorlds.map(w => fetchBuf(AP_DIR + w.tar)),
    ]);
    tarsPromise.catch(() => {});

    report("pyodide-boot");
    pyodide = await loadPyodide({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/",
      // Output below sys.stdout/stderr (which _Tee reroutes once the runtime
      // is up): boot messages and C-level dumps such as a fatal error's
      // Python traceback. Into the app log rather than only the console.
      stdout: (line) => self._pyLog(line),
      stderr: (line) => self._pyLog(line),
    });
    await pyodide.loadPackage(["pyyaml", "micropip", "typing-extensions", "orjson"]);

    await pyodide.loadPackage(["ssl"]);
    report("install-deps");
    await pyodide.runPythonAsync(`
import micropip
await micropip.install(["pathspec", "schema", "jellyfish", "colorama", "websockets", "platformdirs"])
    `);

    report("bsdiff4-shim");
    await pyodide.runPythonAsync(BSDIFF4_SHIM_PY);

    report("fetch-ap-source");
    const chosen = loadedWorlds;
    const [coreBuf, ...worldBufs] = await tarsPromise;

    report("unpack-ap-source");
    pyodide.FS.mkdir("/ap");
    pyodide.unpackArchive(coreBuf, "tar", { extractDir: "/ap" });
    // World tars are rooted at worlds/<package>/, so layering them over /ap
    // lands each world exactly where the core's worlds/ loader will find it.
    for (const buf of worldBufs) pyodide.unpackArchive(buf, "tar", { extractDir: "/ap" });

    report("import-ap");
    await pyodide.runPythonAsync(SETUP_PY(chosen.map(w => w.package)));
    // Install the websockets shim once, at boot. The BizHawkClientContext's
    // connections all go through its _ws.connect patch, so sessions just
    // assume it's already in place.
    await pyodide.runPythonAsync(WS_SHIM_PY);
    // Forward Python stdout/stderr to the main thread so we can see what the
    // session client is doing. to_js + Object.fromEntries converts the dict
    // into a plain JS object that postMessage's structured-clone can carry.
    await pyodide.runPythonAsync(`
import sys
from js import self as _js_self, Object as _Js_Object
from pyodide.ffi import to_js as _to_js
def _jpost(d):
    _js_self._post(_to_js(d, dict_converter=_Js_Object.fromEntries))
class _Tee:
    def __init__(self): self.buf = ""
    def write(self, s):
        self.buf += s
        while "\\n" in self.buf:
            line, self.buf = self.buf.split("\\n", 1)
            if line.strip():
                _js_self._pyLog(line)
    def flush(self): pass
sys.stdout = _Tee()
sys.stderr = _Tee()
    `);
    report("ready");
    booted = true;
  })();
  // A half-finished boot is worse than no boot: `pyodide` is already assigned
  // from line 62 onwards, so the old `if (pyodide) return` fast path would let
  // every later command run against a runtime with no AP source imported. Tear
  // the attempt down instead and let the next command boot from scratch — a
  // fresh loadPyodide brings a fresh MEMFS, so the retry isn't poisoned by the
  // files this attempt already unpacked. Matters most for recovery: the whole
  // respawn story assumes a replacement worker can still boot after an OOM.
  initPromise.catch(() => {
    pyodide = null;
    booted = false;
    initPromise = null;
    loadedWorlds = [];
  });
  return initPromise;
}

async function fetchBuf(url) {
  const res = await fetch(url);
  // A bundle tar only disappears when a deploy drops that version, so a 404
  // means this page predates the deploy.
  if (res.status === 404) throw new Error(`fetch ${url}: not found — the site was probably updated since this page was opened; reload it`);
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}
async function patch(id, romBytes, patchBytes, overrides) {
  await ensureInit(id);
  pyodide.FS.writeFile("/tmp/vanilla.gbc", romBytes);
  pyodide.FS.writeFile("/tmp/seed.apcrystalpre", patchBytes);
  // The apworld's apply_overrides step reads option overrides straight from
  // host.yaml via get_settings(). get_settings() memoizes on first access, so
  // rewriting the file wouldn't take effect — instead we set the override dict
  // directly on the (cached) settings group. Both the stable and prerelease
  // Crystal worlds read get_settings().pokemon_crystal_settings.option_overrides,
  // so this single assignment covers whichever patch class runs. A fresh dict
  // per call matters because apply_overrides may pop keys from it.
  const overridesJson = JSON.stringify(JSON.stringify(overrides || {}));
  // Dispatch by game name from the patch's archipelago.json manifest.
  await pyodide.runPythonAsync(`
import zipfile, json
with zipfile.ZipFile("/tmp/seed.apcrystalpre") as zf:
    _manifest = json.loads(zf.read("archipelago.json"))
_game = _manifest.get("game", "Pokemon Crystal")
from worlds.Files import AutoPatchRegister
_PatchClass = AutoPatchRegister.patch_types.get(_game)
if _PatchClass is None:
    raise RuntimeError(f"no patch handler for game {_game!r}")
from settings import get_settings as _get_settings
_grp = getattr(_get_settings(), "pokemon_crystal_settings", None)
if _grp is not None:
    _grp.option_overrides = json.loads(${overridesJson})
_PatchClass.source_data = open("/tmp/vanilla.gbc","rb").read()
_PatchClass(path="/tmp/seed.apcrystalpre").patch("/tmp/patched.gbc")

# A stable .apcrystal carries its own basepatch, so patching succeeds even when
# it was generated by an apworld whose ROM layout differs from the one loaded
# here — the mismatch would only surface as a silent connect failure in the
# client's validate_rom. Run the same check it does, up front, so the user
# gets the generating version in the error instead.
import sys as _sys
_data = getattr(_sys.modules[_PatchClass.__module__], "data", None)
try:
    _ra = _data.rom_addresses
    with open("/tmp/patched.gbc", "rb") as _f:
        _rom = _f.read()
    _ver = int.from_bytes(_rom[_ra["AP_ROM_Version"]:_ra["AP_ROM_Version"] + 2], "little")
    _rev = _rom[_ra["AP_ROM_Revision"]]
    _req = _data.rom_version if _rev == 0 else _data.rom_version_11
    _gen = bytes(b for b in _rom[_ra["AP_Version"]:_ra["AP_Version"] + 32] if b).decode("ascii", "replace") or "unknown"
except (AttributeError, KeyError, TypeError) as _e:
    print(f"[patch] skipping ROM checksum check: {_e!r}")
    _ver = _req = None
if _ver is not None and _ver != _req:
    raise RuntimeError(f"this patch was generated with {_game} apworld {_gen} (ROM checksum {_ver:04x}), "
                       f"which the bundled {_data.manifest.world_version} (checksum {_req:04x}) can't play")
  `);
  // slice() detaches ownership from whatever Pyodide's FS returned — otherwise
  // transferring the buffer can detach Pyodide's own heap.
  const out = pyodide.FS.readFile("/tmp/patched.gbc").slice();
  return { out, transfer: [out.buffer] };
}

async function sessionStart(id, server, slotName, password) {
  await ensureInit(id);
  // Tear down any prior session first so repeated connects don't stack
  // client instances (each old BizHawkClientContext keeps streaming its
  // own py-log events and fires duplicate bridge requests).
  if (sessionTasks) await sessionStop(id);
  // Register a JS-side resolver so the Python shim can hand off bizhawk
  // requests to the main thread and await responses.
  self._bhEnqueue = (reqId, payload) => {
    post({ id, event: "bh-req", reqId, payload });
  };
  await pyodide.runPythonAsync(SESSION_START_PY(server, slotName, password || ""));
  sessionTasks = true;
}

async function sessionStop(id) {
  if (!pyodide || !sessionTasks) return;
  try {
    await pyodide.runPythonAsync(`
import asyncio
# Mark as intentional BEFORE cancelling — server_loop's finally block
# queues an auto-reconnect unless this flag is set, which is what was
# causing the session to keep coming back after stopSession.
try: ctx.disconnected_intentionally = True
except Exception: pass
try: ctx.exit_event.set()
except Exception: pass
# If an auto-reconnect was already scheduled by a prior blip, cancel it.
try:
    _ar = getattr(ctx, "autoreconnect_task", None)
    if _ar is not None: _ar.cancel()
except Exception: pass
# Close the live socket so pending reads unblock.
try:
    _sock = getattr(ctx, "server", None)
    if _sock is not None:
        _ws = getattr(_sock, "socket", None)
        if _ws is not None:
            await _ws.close()
except Exception: pass
# Cancel our own tasks and await them so server_loop's finally actually
# runs before we exit sessionStop.
for _n in ("server", "watcher", "watchdog"):
    _t = _bh_tasks.get(_n)
    if _t is None: continue
    _t.cancel()
    try: await _t
    except (asyncio.CancelledError, Exception): pass
_bh_tasks.clear()
# After a drop, server_autoreconnect runs a fresh server_loop as
# ctx.server_task, which the tasks above don't cover: left running, one
# still opening its socket connects after the stop as a hidden session.
try:
    _st = getattr(ctx, "server_task", None)
    if _st is not None and not _st.done():
        _st.cancel()
        try: await _st
        except (asyncio.CancelledError, Exception): pass
except Exception: pass
# A server_loop that got connected resets disconnected_intentionally, so its
# finally may have queued another reconnect: set the flag and cancel again.
try:
    ctx.disconnected_intentionally = True
    _ar = getattr(ctx, "autoreconnect_task", None)
    if _ar is not None: _ar.cancel()
except Exception: pass
    `);
  } catch {}
  sessionTasks = null;
}

// Session start/stop run one at a time, in arrival order. Each
// awaits Python, so run concurrently a stop could land while its start is
// still mid-flight, see nothing to stop, and let the start finish into a
// session the main thread had already dropped.
let lifecycleChain = Promise.resolve();
function inLifecycleOrder(fn) {
  const run = lifecycleChain.then(fn);
  lifecycleChain = run.catch(() => {});
  return run;
}

self.onmessage = async (ev) => {
  const { id, cmd } = ev.data;
  const heavy = SYNC_HEAVY_CMDS.has(cmd);
  if (heavy) syncHeavyRuns++;
  try {
    if (cmd === "configure") {
      // Fire-and-forget from spawn(); must land before any booting command.
      // A booted (or booting) runtime can't take a different world set — the
      // wrapper restarts the worker for that instead of re-configuring.
      if (booted || initPromise) throw new Error("ap worker configured after boot");
      runtimeConfig = ev.data.runtime;
    } else if (cmd === "init") {
      await ensureInit(id);
      post({ id, ok: true, out: { worlds: loadedWorlds } });
    } else if (cmd === "patch") {
      const { out, transfer } = await patch(id, ev.data.rom, ev.data.patch, ev.data.overrides);
      post({ id, ok: true, out }, transfer);
    } else if (cmd === "session-start") {
      await inLifecycleOrder(() => sessionStart(id, ev.data.server, ev.data.slot, ev.data.password));
      post({ id, ok: true });
    } else if (cmd === "ping") {
      // Liveness probe. Fatal detection is otherwise purely reactive — it needs
      // a command to fail — but a dead runtime stops originating bizhawk
      // requests and connection events, so nothing would ever call in and the tab
      // would sit on a "live" chip that does nothing. Touch Python for real:
      // an ok reply from a dead runtime would defeat the point.
      if (booted) pyodide.runPython("1");
      post({ id, ok: true });
    } else if (cmd === "session-stop") {
      await inLifecycleOrder(() => sessionStop(id));
      post({ id, ok: true });
    } else if (cmd === "bh-res") {
      // Main-thread's response to a previously sent bizhawk request.
      // Each globals.get() is a fresh PyProxy; at several replies a second,
      // leaving them to the FinalizationRegistry piles them up.
      const resolve = pyodide.globals.get("_bh_resolve");
      try { resolve(ev.data.reqId, ev.data.payload); } finally { resolve.destroy(); }
    } else {
      post({ id, error: "unknown cmd: " + cmd });
    }
  } catch (err) {
    // Pyodide's PythonError carries the traceback in .message; fall back to
    // String() for anything else. No JS stack — it's always Pyodide internals.
    const msg = err?.message || String(err);
    const fatal = pyodideIsDead();
    // A fatal is a crash inside the runtime, not a Python exception: say what
    // was running and where, so a report can point somewhere.
    if (fatal) self._pyLog(`[worker] fatal during ${cmd} (wasm heap ${heapSize()}): ${(err instanceof Error ? describeError(err) : msg).split("\n").slice(0, 12).join("\n")}`);
    post({ id, error: msg, fatal });
  } finally {
    if (heavy) syncHeavyRuns--;
  }
};

// --- Python blobs ---

const BSDIFF4_SHIM_PY = `
import sys, types, bz2
_mod = types.ModuleType("bsdiff4")
def _offtin(buf):
    y = buf[7] & 0x7F
    for i in range(6, -1, -1):
        y = y * 256 + buf[i]
    if buf[7] & 0x80:
        y = -y
    return y
def _patch(old, patch):
    if patch[:8] != b"BSDIFF40":
        raise ValueError("not a bsdiff4 patch")
    cl = _offtin(patch[8:16])
    dl = _offtin(patch[16:24])
    ns = _offtin(patch[24:32])
    ctrl  = bz2.decompress(patch[32:32+cl])
    diff  = bz2.decompress(patch[32+cl:32+cl+dl])
    extra = bz2.decompress(patch[32+cl+dl:])
    new = bytearray(ns)
    oldpos = newpos = cp = dp = ep = 0
    ol = len(old)
    while newpos < ns:
        a = _offtin(ctrl[cp:cp+8])
        b = _offtin(ctrl[cp+8:cp+16])
        s = _offtin(ctrl[cp+16:cp+24])
        cp += 24
        if a > 0:
            base = old[oldpos:oldpos+a].ljust(a, b"\\x00") if oldpos+a > ol else old[oldpos:oldpos+a]
            d = diff[dp:dp+a]
            new[newpos:newpos+a] = bytes((x + y) & 0xFF for x, y in zip(base, d))
            dp += a; newpos += a; oldpos += a
        if b > 0:
            new[newpos:newpos+b] = extra[ep:ep+b]
            ep += b; newpos += b
        oldpos += s
    return bytes(new)
_mod.patch = _patch
sys.modules["bsdiff4"] = _mod
`;

function SESSION_START_PY(server, slot, password) {
  const j = (s) => JSON.stringify(s);
  return `
import asyncio, json
from js import self as _js_self, Object as _Js_Object
from pyodide.ffi import create_proxy, to_js

# ------------------------------------------------------------------ bizhawk
# Replace the TCP-based BizHawkContext._send_message with a postMessage bridge
# so the main thread's binjgb can service memory ops.
import worlds._bizhawk as _bh
_bh_pending = {}
# Ids keep counting across sessions, so a reply to a previous session's
# request can never resolve one of this session's.
if "_bh_next" not in globals():
    _bh_next = [0]

async def _send_message_shim(self, message):
    _bh_next[0] += 1
    rid = _bh_next[0]
    fut = asyncio.get_event_loop().create_future()
    _bh_pending[rid] = fut
    _js_self._bhEnqueue(rid, message)
    # Same failure as the TCP original's timeout: a request whose reply never
    # comes (dropped while the emulator rebooted, say) makes the watcher
    # reconnect instead of hanging item sync for good. 15s rather than its 5s:
    # replies come back through the page's main thread, which can be busy for
    # a few seconds (booting the emulator, a long garbage collection).
    try:
        return await asyncio.wait_for(fut, timeout=15)
    except asyncio.TimeoutError as exc:
        _bh_pending.pop(rid, None)
        self.connection_status = _bh.ConnectionStatus.NOT_CONNECTED
        raise _bh.RequestFailedError("Connection timed out") from exc

async def _connect_shim(ctx):
    ctx.connection_status = _bh.ConnectionStatus.CONNECTED
    ctx._port = 0
    return True

def _disconnect_shim(ctx):
    ctx.connection_status = _bh.ConnectionStatus.NOT_CONNECTED

_bh.BizHawkContext._send_message = _send_message_shim
_bh.connect    = _connect_shim
_bh.disconnect = _disconnect_shim

def _bh_resolve(rid, payload):
    fut = _bh_pending.pop(rid, None)
    if fut is not None and not fut.done():
        fut.set_result(payload)
import builtins as _b
_b._bh_resolve = _bh_resolve
globals()["_bh_resolve"] = _bh_resolve

# ------------------------------------------------------------------ bootstrap
import logging
# Strip handlers that prior sessions attached (Archipelago's init_logging
# adds both a FileLog (useless here — no filesystem) and a StreamLog that
# ends up duplicating every message on reconnect). Clear them all and let
# named loggers propagate to the one clean root StreamHandler we install
# below. FileLog stays muzzled permanently.
for _l in list(logging.Logger.manager.loggerDict.values()):
    if isinstance(_l, logging.Logger):
        _l.handlers.clear()
_flog = logging.getLogger("FileLog")
_flog.handlers.clear()
_flog.propagate = False
logging.basicConfig(level=logging.INFO, format="%(message)s", force=True)

# Hints and chat are blocked, so the server's tips about !hint and !help
# would only mislead: leave them out of the console.
_UNUSABLE_TIPS = ("A !hint costs ", "Now that you are connected, you can use !help")
class _DropUnusableTips(logging.Filter):
    def filter(self, record):
        try: return not str(record.getMessage()).startswith(_UNUSABLE_TIPS)
        except Exception: return True
for _h in logging.getLogger().handlers:
    _h.addFilter(_DropUnusableTips())

from CommonClient import server_loop
from worlds._bizhawk.context import BizHawkClientContext, _game_watcher
# context.py binds connect/disconnect by name at import, so the patches on
# the package above only reach it when it's imported after them. Patch its
# own names too, whichever came first.
import worlds._bizhawk.context as _bh_context
_bh_context.connect    = _connect_shim
_bh_context.disconnect = _disconnect_shim

_bh_tasks = {}
_server_arg = ${j(server)}
_password_arg = ${password ? j(password) : "None"}
ctx = BizHawkClientContext(_server_arg, _password_arg)
ctx.auth = ${j(slot)}

# ------------------------------------------------------------------ connection
# The page needs to know when the server connection is up, so it can let the
# player play only while their checks reach the server.
#   "connected": the server accepted our Connect.
#   "closed":    the socket went away. CommonClient reconnects on its own.
#   "refused":   our password was rejected. The session is over; don't retry.
def _post_ap_state(state, **extra):
    try: _jpost({"event": "ap-state", "state": state, **extra})
    except Exception as _e: print(f"[session] state post failed: {_e}")

# Auto-reconnect only happens once CommonClient knows a username, which it
# otherwise learns from the first Connected. Seed it so a first attempt that
# fails (a server restart, a blip during boot) is retried too.
ctx.username = ${j(slot)}

# CommonClient doubles its reconnect delay after every failure. The session
# ends if the game stays away for the server's grace period, so keep retrying
# every few seconds instead of backing off past it.
_RECONNECT_DELAY = 3

# A network that dies without closing the socket looks connected forever. Ask
# the server something cheap every few seconds; no answer means the
# connection is gone, so stop play and reconnect.
_WATCHDOG_EVERY = 5
_WATCHDOG_TIMEOUT = 10
_watchdog = {"sent": None}

_orig_on_package = ctx.on_package
def _yogos_on_package(cmd, args):
    try: _orig_on_package(cmd, args)
    finally:
        if cmd == "Connected":
            _watchdog["sent"] = None
            _post_ap_state("connected")
        elif cmd == "Retrieved":
            # The watchdog's answer: proof the connection works (the page
            # waits for this to resume after the network came back).
            if _watchdog["sent"] is not None: _post_ap_state("alive")
            _watchdog["sent"] = None
ctx.on_package = _yogos_on_package

async def _yogos_watchdog():
    loop = asyncio.get_event_loop()
    while True:
        await asyncio.sleep(_WATCHDOG_EVERY)
        sock = ctx.server.socket if ctx.server else None
        if sock is None or sock.closed or ctx.slot is None:
            _watchdog["sent"] = None
            continue
        if _watchdog["sent"] is None:
            _watchdog["sent"] = loop.time()
            try: await ctx.send_msgs([{"cmd": "Get", "keys": ["_read_race_mode"]}])
            except Exception: pass
        elif loop.time() - _watchdog["sent"] > _WATCHDOG_TIMEOUT:
            print("the server stopped answering — reconnecting")
            _watchdog["sent"] = None
            _post_ap_state("closed")
            try: await sock.close()
            except Exception: pass

_orig_connection_closed = ctx.connection_closed
async def _yogos_connection_closed():
    try: await _orig_connection_closed()
    finally:
        # server_loop doubles the delay after this hook and before its
        # reconnect task reads it, so set half to get _RECONNECT_DELAY.
        ctx.current_reconnect_delay = _RECONNECT_DELAY / 2
        _post_ap_state("closed")
ctx.connection_closed = _yogos_connection_closed

# A rejected password lands in server_auth with no password left, where the
# stock client waits forever for one to be typed into a console we don't have.
# The server only rejects us once the session's credentials have been rotated,
# so stop here instead.
_orig_server_auth = ctx.server_auth
async def _yogos_server_auth(password_requested=False):
    if password_requested and not ctx.password:
        ctx.disconnected_intentionally = True
        _post_ap_state("refused", reason="InvalidPassword")
        try:
            if ctx.server and ctx.server.socket: await ctx.server.socket.close()
        except Exception: pass
        return
    return await _orig_server_auth(password_requested)
ctx.server_auth = _yogos_server_auth

_bh_tasks["server"]  = asyncio.create_task(server_loop(ctx), name="ServerLoop")
_bh_tasks["watcher"] = asyncio.create_task(_game_watcher(ctx), name="GameWatcher")
_bh_tasks["watchdog"] = asyncio.create_task(_yogos_watchdog(), name="ConnectionWatchdog")
print("session started")
`;
}

// Installed once at boot. Shims `websockets.connect` with the browser's
// WebSocket, since Pyodide has no sockets of its own.
const WS_SHIM_PY = `
import asyncio, re, websockets as _ws
from js import WebSocket as _JsWebSocket
from pyodide.ffi import create_proxy

# ---- browser WebSocket bridge (used by CommonClient at session-start) ----
class _BrowserWS:
    extensions = []
    def __init__(self, url):
        self._ws = _JsWebSocket.new(url)
        self._open_fut = asyncio.get_event_loop().create_future()
        self._close_fut = asyncio.get_event_loop().create_future()
        self._queue: asyncio.Queue = asyncio.Queue()
        self._closed = False
        self._proxies = []
        def on_open(ev):
            if not self._open_fut.done(): self._open_fut.set_result(None)
        def on_message(ev):
            try: self._queue.put_nowait(ev.data)
            except Exception: pass
        def on_close(ev):
            # 4001: the server replaced this connection with a newer one for
            # the same turn (it's being played elsewhere now). Only news if
            # this is still our connection: one we already gave up on gets
            # replaced by our own reconnect.
            if getattr(ev, "code", 0) == 4001 and not self._closed:
                try: _jpost({"event": "ap-state", "state": "replaced"})
                except Exception: pass
            self._closed = True
            self._queue.put_nowait(None)
            if not self._close_fut.done(): self._close_fut.set_result(None)
            # Not from inside the callback: its own proxy is on the stack.
            asyncio.get_event_loop().call_soon(self._release)
        def on_error(ev):
            if not self._open_fut.done():
                self._open_fut.set_exception(ConnectionError("ws error"))
        for evt, cb in (("open", on_open), ("message", on_message),
                        ("close", on_close), ("error", on_error)):
            p = create_proxy(cb); self._proxies.append((evt, p))
            self._ws.addEventListener(evt, p)
    def _release(self):
        # Every connect attempt (auto-reconnect retries included) makes one of
        # these; without this, each closed socket's listeners, proxies and
        # queue stay alive for the worker's lifetime.
        for evt, p in self._proxies:
            try: self._ws.removeEventListener(evt, p)
            except Exception: pass
            try: p.destroy()
            except Exception: pass
        self._proxies = []
    async def wait_open(self):
        # A connect cancelled (disconnect, session replaced) or failed while
        # still opening would otherwise leave the socket to finish opening and
        # stay attached to the server unread. Closing it also fires the close
        # event that releases its proxies.
        try:
            await self._open_fut
        except BaseException:
            try: self._ws.close()
            except Exception: pass
            raise
    async def send(self, data):
        if isinstance(data, (bytes, bytearray)): data = bytes(data)
        self._ws.send(data)
    async def recv(self):
        data = await self._queue.get()
        if data is None: raise _ws.ConnectionClosed(None, None)
        return data
    async def close(self, code=1000, reason=""):
        try: self._ws.close()
        except Exception: pass
        # On a dead network the close event may not come for minutes; end the
        # reader now so the client notices and starts reconnecting.
        if not self._closed:
            self._closed = True
            self._queue.put_nowait(None)
    def __aiter__(self): return self
    async def __anext__(self):
        data = await self._queue.get()
        if data is None: raise StopAsyncIteration
        return data
    @property
    def closed(self): return self._closed
    @property
    def open(self): return not self._closed
    @property
    def socket(self): return self
    async def ping(self, *a, **kw):
        f = asyncio.get_event_loop().create_future(); f.set_result(None); return f
    async def pong(self, *a, **kw): return None

async def _ws_connect(uri, *args, **kwargs):
    # Respect the caller-supplied scheme — forcing wss:// breaks ws:// to a
    # local multiserver. Only upgrade ws→wss when the page is HTTPS and the
    # browser would mixed-content-block ws:// anyway. (Localhost gets a pass
    # since browsers treat it as a secure context for ws://.)
    try:
        from js import location as _loc
        _page_https = str(_loc.protocol) == "https:"
    except Exception:
        _page_https = False
    u = uri
    if _page_https and u.startswith("ws://"):
        _host = u[len("ws://"):].split("/", 1)[0].split(":", 1)[0]
        if _host not in ("localhost", "127.0.0.1", "[::1]"):
            u = "wss://" + u[len("ws://"):]
    ws = _BrowserWS(u)
    await ws.wait_open()
    return ws
_ws.connect = _ws_connect
`;

const SETUP_PY = (worldPackages) => `
import sys, os
sys.path.insert(0, "/ap")
os.chdir("/ap")
import ModuleUpdate as _mu
_mu.update = lambda *a, **kw: None
_mu.requirements_files = set()
import Utils
try: Utils.local_path.cached_path = "/ap"
except AttributeError: pass

# Disable settings.py's interactive folder picker. When a path setting points
# at a non-existent dir, settings.py defaults to popping a tkinter dialog —
# Pyodide has no tkinter, so the access raises ModuleNotFoundError instead of
# returning the configured path. Setting no_gui=True makes the settings layer
# accept the configured path as-is.
import settings as _ap_settings
_ap_settings.no_gui = True

# Seed a host.yaml so settings.get_settings() finds a file on first access.
# With no settings file present, get_settings() falls into its "create a new
# one" branch and calls Settings.save(), whose fsync/rename against Pyodide's
# MEMFS can raise. The patcher reads its option overrides through
# get_settings(), so give it a file to find.
if not os.path.exists("/ap/host.yaml"):
    with open("/ap/host.yaml", "w", encoding="utf-8") as _hy:
        _hy.write("{}\\n")

# Pyodide has no threads — replace concurrent.futures.ThreadPoolExecutor with
# a synchronous impl so Main.py's pool.submit / as_completed path just runs
# inline. Not a correctness issue; just slower-on-the-hot-path.
import concurrent.futures as _cf
class _F:
    def __init__(self, fn, args, kwargs):
        try:
            self._val = fn(*args, **kwargs); self._exc = None
        except BaseException as e:
            self._val = None; self._exc = e
    def result(self, timeout=None):
        if self._exc is not None: raise self._exc
        return self._val
    def exception(self, timeout=None): return self._exc
    def add_done_callback(self, fn): fn(self)
    def done(self): return True
    def cancelled(self): return False
class _Sync:
    def __init__(self, *a, **kw): pass
    def submit(self, fn, *args, **kw): return _F(fn, args, kw)
    def map(self, fn, *iters): return (fn(*xs) for xs in zip(*iters))
    def shutdown(self, wait=True, cancel_futures=False): pass
    def __enter__(self): return self
    def __exit__(self, *a): pass
_cf.ThreadPoolExecutor = _Sync
_cf.as_completed = lambda fs, timeout=None: iter(list(fs))

# Eagerly import every bundled Crystal apworld so failures surface rather than
# being swallowed by AutoWorldRegister, and so the patch dispatch table in
# AutoPatchRegister has each PokemonCrystalProcedurePatch class ready.
${worldPackages.map(pkg => `import worlds.${pkg}.world  # noqa: F401`).join("\n")}
from worlds.AutoWorld import AutoWorldRegister
_ = AutoWorldRegister.world_types  # force registration
`;
