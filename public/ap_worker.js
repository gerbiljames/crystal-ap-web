"use strict";
// Single Pyodide worker that hosts both patching and generation.
// Boots the full Archipelago + apworld import graph on first use, then:
//   patch(romBytes, patchBytes) → patchedBytes
//   generate(yamlText)          → { artifacts: {name: Uint8Array}, ... }
//
// Protocol (main ↔ worker):
//   { id, cmd, ...payload }     → { id, ok, out? } | { id, error }
//   progress events stream as    { id, event: "progress", phase }

importScripts("https://cdn.jsdelivr.net/pyodide/v0.29.3/full/pyodide.js");

let pyodide = null;
let initPromise = null;
// Session state (lives while a BizHawk AP session is running).
let sessionTasks = null;           // py cancellables
let nextBhId = 1;
const bhPending = new Map();        // id → { resolve, reject }
// True while an in-process MultiServer is running. Cleared on host-stop.
let hostRunning = false;

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

// Run Python and surface the traceback as a real Error message on failure.
// Pyodide's own PythonError sometimes loses the traceback string in transit
// between the worker-side exception and our outer JS catch.
async function runPyChecked(code) {
  const wrapped = `
import traceback
def _go():
${code.split("\n").map(l => "    " + l).join("\n")}
try:
    _go()
    _ = None
except BaseException:
    _ = traceback.format_exc()
_
`;
  const result = await pyodide.runPythonAsync(wrapped);
  if (result) throw new Error(result);
}

async function ensureInit(id) {
  if (pyodide) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const report = (phase) => post({ id, event: "progress", phase });

    report("pyodide-boot");
    pyodide = await loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.29.3/full/" });
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
    const tarBuf = await (await fetch("ap.tar")).arrayBuffer();

    report("unpack-ap-source");
    pyodide.FS.mkdir("/ap");
    pyodide.unpackArchive(tarBuf, "tar", { extractDir: "/ap" });

    report("import-ap");
    await pyodide.runPythonAsync(SETUP_PY);
    // Install the websockets shim once, at boot. Both the in-browser
    // MultiServer (loopback) and the BizHawkClientContext (real wss://)
    // share this single _ws.connect / _ws.serve patch — sessions and host
    // setup just assume it's already in place.
    await pyodide.runPythonAsync(WS_SHIM_PY);
    // Forward Python stdout/stderr to the main thread so we can see what the
    // session client is doing. to_js + Object.fromEntries converts the dict
    // into a plain JS object that postMessage's structured-clone can carry.
    await pyodide.runPythonAsync(`
import sys
from js import self as _js_self, Object as _Js_Object
from pyodide.ffi import to_js as _to_js
def _jpost(d):
    _js_self.postMessage(_to_js(d, dict_converter=_Js_Object.fromEntries))
class _Tee:
    def __init__(self, prefix): self.prefix = prefix; self.buf = ""
    def write(self, s):
        self.buf += s
        while "\\n" in self.buf:
            line, self.buf = self.buf.split("\\n", 1)
            if line.strip():
                _jpost({"event": "py-log", "level": self.prefix, "msg": line})
    def flush(self): pass
sys.stdout = _Tee("stdout")
sys.stderr = _Tee("stderr")
    `);
    report("ready");
  })();
  return initPromise;
}

async function patch(id, romBytes, patchBytes) {
  await ensureInit(id);
  pyodide.FS.writeFile("/tmp/vanilla.gbc", romBytes);
  pyodide.FS.writeFile("/tmp/seed.apcrystalpre", patchBytes);
  // Dispatch by game name from the patch's archipelago.json manifest. Stable
  // and prerelease both ship a PokemonCrystalProcedurePatch class but they
  // live in different modules and produce binary-incompatible patches.
  await pyodide.runPythonAsync(`
import zipfile, json
with zipfile.ZipFile("/tmp/seed.apcrystalpre") as zf:
    _manifest = json.loads(zf.read("archipelago.json"))
_game = _manifest.get("game", "Pokemon Crystal")
from worlds.Files import AutoPatchRegister
_PatchClass = AutoPatchRegister.patch_types.get(_game)
if _PatchClass is None:
    raise RuntimeError(f"no patch handler for game {_game!r}")
_PatchClass.source_data = open("/tmp/vanilla.gbc","rb").read()
_PatchClass(path="/tmp/seed.apcrystalpre").patch("/tmp/patched.gbc")
  `);
  // slice() detaches ownership from whatever Pyodide's FS returned — otherwise
  // transferring the buffer can detach Pyodide's own heap.
  const out = pyodide.FS.readFile("/tmp/patched.gbc").slice();
  return { out, transfer: [out.buffer] };
}

async function generate(id, yamlText) {
  await ensureInit(id);
  await runPyChecked(`
import shutil, os
shutil.rmtree("/tmp/players", ignore_errors=True)
shutil.rmtree("/tmp/out",     ignore_errors=True)
os.makedirs("/tmp/players"); os.makedirs("/tmp/out")
with open("/tmp/players/player.yaml","w") as f: f.write(${JSON.stringify(yamlText)})
  `);

  post({ id, event: "progress", phase: "rolling-seed" });
  await runPyChecked(`
import sys, os
os.chdir("/ap")
sys.argv = [
    "Generate.py",
    "--player_files_path", "/tmp/players",
    "--outputpath",        "/tmp/out",
]
import Generate as _gen
import Main as _main
erargs, seed = _gen.main()
_main.main(erargs, seed)
  `);

  // Expand any produced zip so artifacts are first-class.
  post({ id, event: "progress", phase: "collecting-artifacts" });
  await pyodide.runPythonAsync(`
import os, zipfile
outdir = "/tmp/out"
for name in list(os.listdir(outdir)):
    if name.endswith(".zip"):
        with zipfile.ZipFile(os.path.join(outdir, name)) as zf:
            zf.extractall(outdir)
  `);
  const names = (await pyodide.runPythonAsync(`
import os
sorted(os.listdir("/tmp/out"))
  `)).toJs();
  const artifacts = {};
  const transfer = [];
  for (const name of names) {
    // Copy out of Pyodide's heap so transferring our buffer doesn't detach
    // Pyodide's own memory and break subsequent calls.
    const bytes = pyodide.FS.readFile("/tmp/out/" + name).slice();
    artifacts[name] = bytes;
    transfer.push(bytes.buffer);
  }
  return { out: { artifacts }, transfer };
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
  trackerStop();
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
for _n in ("server", "watcher"):
    _t = _bh_tasks.get(_n)
    if _t is None: continue
    _t.cancel()
    try: await _t
    except (asyncio.CancelledError, Exception): pass
_bh_tasks.clear()
    `);
  } catch {}
  sessionTasks = null;
}

// Persistence keyed by seedId, written directly from the worker so saves
// don't depend on main-thread liveness around tab close. Mirror of constants
// in src/lib/constants.ts; keep in sync if they change.
const MHOST_DB_NAME = "crystal-ap-saves";
const MHOST_DB_VERSION = 7;
const MHOST_STORE = "mhostsave";
let _mhostDbPromise = null;
function mhostDb() {
  if (_mhostDbPromise) return _mhostDbPromise;
  _mhostDbPromise = new Promise((resolve) => {
    const req = indexedDB.open(MHOST_DB_NAME, MHOST_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // The main thread owns the schema; only create our store if it's
      // somehow missing so we don't clobber stores added by main.
      if (!db.objectStoreNames.contains(MHOST_STORE)) db.createObjectStore(MHOST_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return _mhostDbPromise;
}
function mhostGet(seedId) {
  return mhostDb().then((db) => db && new Promise((res) => {
    const t = db.transaction(MHOST_STORE, "readonly").objectStore(MHOST_STORE).get(seedId);
    t.onsuccess = () => res(t.result || null);
    t.onerror   = () => res(null);
  }));
}
function mhostPut(seedId, bytes) {
  return mhostDb().then((db) => db && new Promise((res) => {
    const t = db.transaction(MHOST_STORE, "readwrite").objectStore(MHOST_STORE).put(bytes, seedId);
    t.onsuccess = () => res(true);
    t.onerror   = () => res(false);
  }));
}

let _hostSeedId = null;

async function hostStart(id, seedId, multidataBytes) {
  await ensureInit(id);
  // Stop any prior host so re-hosting after a regenerate doesn't pile
  // up stale Contexts (each holds a copy of the multidata in memory).
  if (hostRunning) await hostStop(id);
  _hostSeedId = seedId || null;
  pyodide.FS.writeFile("/tmp/seed.archipelago", multidataBytes);
  // Pre-load any persisted .apsave for this seed into MEMFS at the path
  // MultiServer.init_save expects: it does os.path.splitext on the multidata
  // path and replaces the extension, so /tmp/seed.archipelago → /tmp/seed.apsave
  // (NOT /tmp/seed.archipelago.apsave). See vendor/archipelago/MultiServer.py:611.
  if (_hostSeedId) {
    try {
      const stored = await mhostGet(_hostSeedId);
      if (stored && stored.byteLength) pyodide.FS.writeFile("/tmp/seed.apsave", new Uint8Array(stored));
    } catch { /* ignore — fall through to fresh save */ }
  }
  // Save callback from Python's _async_saver. Writes the .apsave bytes
  // straight to IndexedDB so the worker is self-sufficient around tab
  // close — no main-thread round-trip required for durability.
  self._mhostSave = (bytesView) => {
    if (!_hostSeedId) return;
    // Copy off Pyodide's heap before the transaction goes async.
    const copy = new Uint8Array(bytesView).slice();
    mhostPut(_hostSeedId, copy);
  };
  await pyodide.runPythonAsync(HOST_START_PY);
  const uri = pyodide.globals.get("_host_uri");
  hostRunning = true;
  return { out: { ws_url: uri } };
}

async function hostStop(id) {
  if (!pyodide || !hostRunning) return;
  try { await pyodide.runPythonAsync(HOST_STOP_PY); } catch {}
  hostRunning = false;
  _hostSeedId = null;
}

// --- Universal Tracker bridge ---
// Pure data-in / data-out: caller supplies multidata bytes plus the local
// player's checked-locations set; we hand back the in-logic location names.
// No dependency on _host_ctx, session ctx, or websockets — multidata is the
// authoritative source for slot_data + locations + items.
let trackerReady = false;

async function trackerInit(id, multidataBytes, slotName) {
  await ensureInit(id);
  const available = pyodide.globals.get("_TRACKER_AVAILABLE");
  if (!available) {
    return { out: { ok: false, reason: "tracker world failed to import" } };
  }
  pyodide.FS.writeFile("/tmp/ut_seed.archipelago", multidataBytes);
  pyodide.globals.set("_ut_slot_name_in", String(slotName || ""));
  const errOrEmpty = await pyodide.runPythonAsync(TRACKER_INIT_PY);
  if (errOrEmpty) {
    trackerReady = false;
    return { out: { ok: false, reason: String(errOrEmpty) } };
  }
  trackerReady = true;
  return { out: { ok: true } };
}

async function trackerUpdate(id, checkedLocIds) {
  if (!pyodide || !trackerReady) return { out: { ok: false, locations: [], go: "no" } };
  pyodide.globals.set("_ut_checked_in", pyodide.toPy(checkedLocIds || []));
  const result = await pyodide.runPythonAsync(TRACKER_UPDATE_PY);
  const tup = result?.toJs ? result.toJs() : result;
  const go = (tup && typeof tup[0] === "string") ? tup[0] : "no";
  const locations = Array.isArray(tup?.[1]) ? tup[1] : (tup?.[1] ? Array.from(tup[1]) : []);
  if (result?.destroy) result.destroy();
  return { out: { ok: true, locations, go } };
}

async function trackerChecks(id) {
  if (!pyodide || !trackerReady || !sessionTasks) return { out: { checked: [] } };
  pyodide.globals.set("_ut_ctx_q", pyodide.globals.get("ctx") ?? null);
  const result = await pyodide.runPythonAsync(TRACKER_CHECKS_PY);
  const arr = result?.toJs ? result.toJs() : Array.from(result || []);
  if (result?.destroy) result.destroy();
  return { out: { checked: arr.map((x) => Number(x)) } };
}

function trackerStop() {
  trackerReady = false;
  if (!pyodide) return;
  try {
    pyodide.runPython(`
import builtins as _b
for _n in ("_ut_tracker", "_ut_multidata", "_ut_slot", "_ut_slot_name", "_ut_game"):
    try: delattr(_b, _n)
    except Exception: pass
`);
  } catch {}
}

self.onmessage = async (ev) => {
  const { id, cmd } = ev.data;
  try {
    if (cmd === "init") {
      await ensureInit(id);
      post({ id, ok: true });
    } else if (cmd === "patch") {
      const { out, transfer } = await patch(id, ev.data.rom, ev.data.patch);
      post({ id, ok: true, out }, transfer);
    } else if (cmd === "generate") {
      const { out, transfer } = await generate(id, ev.data.yaml);
      post({ id, ok: true, out }, transfer);
    } else if (cmd === "host") {
      const { out } = await hostStart(id, ev.data.seedId, ev.data.multidata);
      post({ id, ok: true, out });
    } else if (cmd === "host-flush") {
      // Synchronous flush from a pagehide/visibility-hidden handler so the
      // very last actions before tab close persist instead of waiting for
      // the next 5s tick that may never run.
      if (hostRunning) {
        try {
          await pyodide.runPythonAsync(`
try:
    if getattr(_host_ctx, "saving", False):
        _host_ctx._save()
        _host_ctx.save_dirty = False
        _push_apsave(_host_ctx.save_filename)
except Exception: pass
          `);
        } catch {}
      }
      post({ id, ok: true });
    } else if (cmd === "host-stop") {
      await hostStop(id);
      post({ id, ok: true });
    } else if (cmd === "session-start") {
      await sessionStart(id, ev.data.server, ev.data.slot, ev.data.password);
      post({ id, ok: true });
    } else if (cmd === "session-stop") {
      await sessionStop(id);
      post({ id, ok: true });
    } else if (cmd === "session-input") {
      // Dispatch a line of user input through the same ClientCommandProcessor
      // that console_loop would — handles both /commands and plain chat.
      if (!sessionTasks) return;
      const text = ev.data.text || "";
      pyodide.globals.get("_cmdproc")(text);
    } else if (cmd === "tracker-init") {
      const { out } = await trackerInit(id, ev.data.multidata, ev.data.slotName);
      post({ id, ok: true, out });
    } else if (cmd === "tracker-update") {
      const { out } = await trackerUpdate(id, ev.data.checked);
      post({ id, ok: true, out });
    } else if (cmd === "tracker-checks") {
      const { out } = await trackerChecks(id);
      post({ id, ok: true, out });
    } else if (cmd === "tracker-stop") {
      trackerStop();
      post({ id, ok: true });
    } else if (cmd === "bh-res") {
      // Main-thread's response to a previously sent bizhawk request.
      pyodide.globals.get("_bh_resolve")(ev.data.reqId, ev.data.payload);
    } else {
      post({ id, error: "unknown cmd: " + cmd });
    }
  } catch (err) {
    // runPyChecked gives us formatted Python tracebacks; fall back to .message
    // then to String() for anything else. No JS stack — it's always Pyodide internals.
    const msg = err?.message || String(err);
    post({ id, error: msg });
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
_bh_next = [0]

async def _send_message_shim(self, message):
    _bh_next[0] += 1
    rid = _bh_next[0]
    fut = asyncio.get_event_loop().create_future()
    _bh_pending[rid] = fut
    _js_self._bhEnqueue(rid, message)
    return await fut

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

from CommonClient import server_loop
from worlds._bizhawk.context import BizHawkClientContext, _game_watcher

_bh_tasks = {}
_server_arg = ${j(server)}
_password_arg = ${password ? j(password) : "None"}
ctx = BizHawkClientContext(_server_arg, _password_arg)
ctx.auth = ${j(slot)}
_bh_tasks["server"]  = asyncio.create_task(server_loop(ctx), name="ServerLoop")
_bh_tasks["watcher"] = asyncio.create_task(_game_watcher(ctx), name="GameWatcher")
_cmdproc = ctx.command_processor(ctx)
globals()["_cmdproc"] = _cmdproc

# Sync wrapper around ctx.on_package — process_server_cmd calls it without
# awaiting, so async wrappers silently no-op. Emits a "tracker-dirty" event
# whenever the set of checked locations or items received may have changed.
_orig_on_package = ctx.on_package
def _ut_on_package(cmd, args):
    try: _orig_on_package(cmd, args)
    finally:
        if cmd in ("Connected", "ReceivedItems", "RoomUpdate"):
            try: _jpost({"event": "tracker-dirty"})
            except Exception as _e: print(f"[ut] dirty post failed: {_e}")
ctx.on_package = _ut_on_package

print("session started")
`;
}

// Installed once at boot. Shims `websockets.connect` (browser WS for real
// wss://, in-process pipe for loopback://) and `websockets.serve` (registers
// an in-process handler — no real listening socket, browsers can't have one).
const WS_SHIM_PY = `
import asyncio, re, websockets as _ws
from js import WebSocket as _JsWebSocket
from pyodide.ffi import create_proxy

# websockets.broadcast() reaches into private attrs (protocol.state,
# send_in_progress, frames_sent, ...) that only exist on the upstream's real
# Connection class. Replace it with a minimal version that just enqueues the
# message on every still-open connection — works for both our loopback pipe
# and the browser-WS shim, neither of which has those internals.
def _ws_broadcast(connections, message, raise_exceptions=False):
    sent = []
    for conn in list(connections):
        try:
            if getattr(conn, "closed", False): continue
            if isinstance(message, (bytes, bytearray)):
                if hasattr(conn, "send_binary"): conn.send_binary(message)
                else: sent.append(asyncio.create_task(conn.send(bytes(message))))
            else:
                if hasattr(conn, "send_text"): conn.send_text(message)
                else: sent.append(asyncio.create_task(conn.send(message)))
        except Exception:
            if raise_exceptions: raise
_ws.broadcast = _ws_broadcast

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
            self._closed = True
            self._queue.put_nowait(None)
            if not self._close_fut.done(): self._close_fut.set_result(None)
        def on_error(ev):
            if not self._open_fut.done():
                self._open_fut.set_exception(ConnectionError("ws error"))
        for evt, cb in (("open", on_open), ("message", on_message),
                        ("close", on_close), ("error", on_error)):
            p = create_proxy(cb); self._proxies.append(p)
            self._ws.addEventListener(evt, p)
    async def wait_open(self): await self._open_fut
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

# ---- loopback pipe (used when MultiServer runs inside this same Pyodide) ----
# Two _LoopbackPipe halves share a pair of asyncio.Queues. No real network,
# no TLS, no port — just two coroutines reading from each other's queues.
class _LoopbackPipe:
    extensions = []
    def __init__(self, send_q, recv_q, remote=("loopback", 0)):
        self._send_q = send_q
        self._recv_q = recv_q
        self._closed = False
        self._remote = remote
    @property
    def remote_address(self): return self._remote
    @property
    def closed(self): return self._closed
    @property
    def open(self): return not self._closed
    @property
    def socket(self): return self
    @property
    def protocol(self): return _LoopbackProto
    def send_text(self, msg):
        # websockets.broadcast() bypasses send() and calls .send_text /
        # .send_binary on the underlying connection. Forward to our queue.
        if self._closed: return
        try: self._send_q.put_nowait(msg)
        except Exception: pass
    def send_binary(self, data):
        if self._closed: return
        try: self._send_q.put_nowait(bytes(data))
        except Exception: pass
    async def send(self, msg):
        if self._closed: raise _ws.ConnectionClosed(None, None)
        if isinstance(msg, (bytes, bytearray)): msg = bytes(msg)
        await self._send_q.put(msg)
    async def recv(self):
        msg = await self._recv_q.get()
        if msg is None: raise _ws.ConnectionClosed(None, None)
        return msg
    async def close(self, code=1000, reason=""):
        if self._closed: return
        self._closed = True
        # Sentinel both queues: peer's recv unblocks (their __aiter__ ends),
        # AND our own recv unblocks (so a handler that's currently awaiting
        # recv() also exits when we close from this side).
        try: self._send_q.put_nowait(None)
        except Exception: pass
        try: self._recv_q.put_nowait(None)
        except Exception: pass
    def __aiter__(self): return self
    async def __anext__(self):
        msg = await self._recv_q.get()
        if msg is None: raise StopAsyncIteration
        return msg
    async def ping(self, *a, **kw):
        f = asyncio.get_event_loop().create_future(); f.set_result(None); return f
    async def pong(self, *a, **kw): return None

# Registry of loopback "servers". Key: synthetic URI; value: handler coroutine.
_loopback_servers = {}
_loopback_counter = [0]

class _LoopbackServer:
    """Stand-in for the awaitable websockets.serve() returns. Awaiting yields
    a Server-shaped object; close() unregisters the handler."""
    def __init__(self, uri, handler):
        self.uri = uri
        self.handler = handler
    def __await__(self):
        # already "listening" — just yield once for shape compatibility.
        yield from asyncio.sleep(0).__await__()
        return self
    def close(self):
        _loopback_servers.pop(self.uri, None)
    async def wait_closed(self): pass

def _serve(handler, host=None, port=None, **kwargs):
    _loopback_counter[0] += 1
    uri = f"loopback://room{_loopback_counter[0]}"
    _loopback_servers[uri] = handler
    return _LoopbackServer(uri, handler)
_ws.serve = _serve

async def _loopback_connect(uri):
    handler = _loopback_servers.get(uri)
    if handler is None:
        raise ConnectionRefusedError(f"no loopback server at {uri}")
    a = asyncio.Queue(); b = asyncio.Queue()
    server_side = _LoopbackPipe(send_q=b, recv_q=a)
    client_side = _LoopbackPipe(send_q=a, recv_q=b)
    asyncio.create_task(handler(server_side, "/"), name="LoopbackHandler")
    return client_side

async def _ws_connect(uri, *args, **kwargs):
    if uri.startswith("loopback://"):
        return await _loopback_connect(uri)
    # Force wss:// for real connections — the page is served over HTTPS,
    # so mixed-content blocks ws:// regardless of caller-supplied scheme.
    u = re.sub(r"^wss?://", "", uri)
    u = "wss://" + u
    ws = _BrowserWS(u)
    await ws.wait_open()
    return ws
_ws.connect = _ws_connect
`;

// Builds an in-process MultiServer Context against /tmp/seed.archipelago.
// Stubs out signal handlers (Pyodide can't add_signal_handler) and disables
// auto-saving (no persistent FS across reloads). Stashes the loopback URI
// in `_host_uri` and the context in `_host_ctx` for the connect path and
// for HOST_STOP_PY to read.
const HOST_START_PY = `
import asyncio, signal, functools, sys, logging
sys.path.insert(0, "/ap")

# Pyodide can't take signal handlers; MultiServer.main installs SIGINT/SIGTERM
# but we drive it programmatically and never touch main(). Make these no-ops
# so any stray import path that adds a handler doesn't blow up.
signal.signal = lambda *a, **kw: None
try:
    _loop = asyncio.get_event_loop()
    _loop.add_signal_handler = lambda *a, **kw: None
    _loop.remove_signal_handler = lambda *a, **kw: None
except Exception: pass

# Strip prior log handlers — Archipelago's init_logging adds a FileLog (no
# filesystem here) and a duplicate StreamLog on each re-host.
for _l in list(logging.Logger.manager.loggerDict.values()):
    if isinstance(_l, logging.Logger): _l.handlers.clear()
_flog = logging.getLogger("FileLog")
_flog.handlers.clear()
_flog.propagate = False
logging.basicConfig(level=logging.INFO, format="%(message)s", force=True)

import MultiServer as _ms

# Context._load_game_data mutates the shared worlds.network_data_package by
# del'ing keys (vendor/archipelago/MultiServer.py:347). Re-hosting (a second
# Context()) would KeyError on the already-removed keys. Patch once with a
# pop-safe variant so re-host is idempotent.
def _safe_load_game_data(self):
    import worlds as _w
    self.gamespackage = _w.network_data_package["games"]
    self.item_name_groups = {n: w.item_name_groups for n, w in _w.AutoWorldRegister.world_types.items()}
    self.location_name_groups = {n: w.location_name_groups for n, w in _w.AutoWorldRegister.world_types.items()}
    for n, w in _w.AutoWorldRegister.world_types.items():
        self.non_hintable_names[n] = w.hint_blacklist
    for game_package in self.gamespackage.values():
        game_package.pop("item_name_groups", None)
        game_package.pop("location_name_groups", None)
_ms.Context._load_game_data = _safe_load_game_data

# Defaults match settings.ServerOptions (vendor/archipelago/settings.py:612).
_host_ctx = _ms.Context(
    host="loopback",
    port=0,
    server_password=None,
    password=None,
    location_check_points=1,
    hint_cost=10,
    item_cheat=True,
    release_mode="auto",
    collect_mode="auto",
    countdown_mode="auto",
    remaining_mode="goal",
    auto_shutdown=0,
    compatibility=2,
    log_network=False,
)
_host_ctx.load("/tmp/seed.archipelago", False)

# MultiServer's stock _start_async_saving spins a real OS thread (line 649 of
# vendor/archipelago/MultiServer.py). Pyodide is single-threaded, so we
# replace it with an asyncio task that runs on the same event loop the
# request handlers use. After each successful _save(), the freshly-written
# .apsave bytes are read back from MEMFS and forwarded to the main thread,
# which is responsible for persisting them to IndexedDB.
import os
from js import self as _js_self
from pyodide.ffi import to_js as _to_js

async def _async_saver(ctx):
    # 5s instead of MultiServer's 60s — saves are tiny (a few KB), and a
    # browser tab is far more likely to be closed between ticks than a
    # long-lived server process. Lower interval = less data loss.
    ctx.auto_save_interval = 5
    interval = 5
    while not ctx.exit_event.is_set():
        try:
            await asyncio.wait_for(ctx.exit_event.wait(), timeout=interval)
            break
        except asyncio.TimeoutError:
            pass
        if not ctx.save_dirty:
            continue
        try:
            ctx._save()
            ctx.save_dirty = False
            _push_apsave(ctx.save_filename)
        except Exception as e:
            ctx.logger.exception(e)

def _push_apsave(path):
    try:
        if not path or not os.path.exists(path): return
        with open(path, "rb") as f:
            data = f.read()
        if not data: return
        _js_self._mhostSave(_to_js(memoryview(data)))
    except Exception: pass

def _start_async_saving_shim(self, atexit_save=True):
    if not getattr(self, "auto_saver_task", None):
        self.auto_saver_task = asyncio.create_task(_async_saver(self), name="MhostSave")
_ms.Context._start_async_saving = _start_async_saving_shim

_host_ctx.init_save(True)

_host_server = await _ws.serve(
    functools.partial(_ms.server, ctx=_host_ctx),
    host=None, port=None,
)
_host_uri = _host_server.uri
print(f"in-browser MultiServer ready at {_host_uri}")
`;

const HOST_STOP_PY = `
import asyncio
# Final flush: persist any state that hasn't hit a save tick yet so the user
# doesn't lose progress between the last 60s saver run and tab close.
try:
    if getattr(_host_ctx, "save_dirty", False):
        _host_ctx._save()
        _host_ctx.save_dirty = False
        _push_apsave(_host_ctx.save_filename)
except Exception: pass
try: _host_ctx.exit_event.set()
except Exception: pass
try:
    _t = getattr(_host_ctx, "auto_saver_task", None)
    if _t is not None: _t.cancel()
except Exception: pass
try: _host_server.close()
except Exception: pass
# Best-effort: close any client sockets so MultiServer's per-client loops exit.
try:
    for _ep in list(getattr(_host_ctx, "endpoints", [])):
        try: await _ep.socket.close()
        except Exception: pass
except Exception: pass
try: del _host_ctx
except Exception: pass
try: del _host_server
except Exception: pass
try: del _host_uri
except Exception: pass
`;

const SETUP_PY = `
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
# returning the configured path. UT's TrackerPlayersPath("Players") triggers
# this on first access. Setting no_gui=True makes the settings layer accept
# the configured path as-is.
import settings as _ap_settings
_ap_settings.no_gui = True

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

# Eagerly import both apworlds so failures surface rather than being swallowed
# by AutoWorldRegister, and so the patch dispatch table in AutoPatchRegister
# has both PokemonCrystalProcedurePatch classes ready (stable + prerelease).
import worlds.pokemon_crystal.world  # noqa: F401
import worlds.pokemon_crystal_prerelease.world  # noqa: F401
# Universal Tracker. Imported eagerly so AutoWorldRegister picks up TrackerWorld
# and so any incompatibility surfaces at boot, not on tab-click. The flag is
# read back by JS to decide whether to enable the Tracker tab in the UI.
try:
    import worlds.tracker  # noqa: F401
    _TRACKER_AVAILABLE = True
except Exception as _ut_err:
    _TRACKER_AVAILABLE = False
    print(f"[ut] tracker world unavailable: {_ut_err}")
from worlds.AutoWorld import AutoWorldRegister
_ = AutoWorldRegister.world_types  # force registration
`;

// Build a TrackerCore from raw multidata bytes alone. Multidata fully
// describes slot_data, locations, and items — everything UT needs except the
// player's progress, which we feed in via tracker-update. Pokemon Crystal
// supports yamlless tracking (ut_can_gen_without_yaml + staticmethod
// interpret_slot_data) so no real Players/*.yaml is required.
// Returns "" on success, or a traceback string.
const TRACKER_INIT_PY = `
import traceback
try:
    import os, logging
    # Default TrackerPlayersPath("Players") is required-to-exist; without the
    # dir, settings.py would try to browse() (no tkinter in Pyodide).
    os.makedirs("/ap/Players", exist_ok=True)
    import MultiServer as _ms
    with open("/tmp/ut_seed.archipelago", "rb") as _f:
        _multidata = _ms.Context.decompress(_f.read())
    # connect_names: { slot_name: (team, slot, ...) }. Fall back to the only
    # entry for solo seeds where the supplied slot_name doesn't match.
    _slot_name = _ut_slot_name_in
    _entry = _multidata["connect_names"].get(_slot_name)
    if _entry is None:
        _names = list(_multidata["connect_names"].keys())
        if len(_names) == 1:
            _slot_name, _entry = _names[0], _multidata["connect_names"][_names[0]]
        else:
            raise RuntimeError(f"slot name {_ut_slot_name_in!r} not in multidata; choices: {_names}")
    _team, _slot = _entry[0], _entry[1]
    _slot_data = _multidata["slot_data"].get(_slot, {}) or {}
    _game = _multidata["slot_info"][_slot].game
    from worlds.tracker.TrackerCore import TrackerCore
    from worlds.AutoWorld import AutoWorldRegister
    _world_cls = AutoWorldRegister.world_types.get(_game)
    if _world_cls is None:
        raise RuntimeError(f"no registered world for game {_game!r}")
    _tracker = TrackerCore(logging.getLogger("UT"), False, False)
    # Seed sorting_priorities BEFORE initalize_tracker_core, so any error path
    # inside it doesn't KeyError on missing 'ut_status' priority.
    try:
        (_yp, _tracker.output_format, _tracker.hide_excluded, _tracker.use_split,
         _enf_def, _tracker.enable_glitched_logic, _tracker.sorting_priorities,
         _tracker.sorting_method) = _tracker._set_host_settings()
        if _tracker.enforce_deferred_connections is None:
            _tracker.enforce_deferred_connections = _enf_def
    except Exception as _hs_e:
        print(f"[ut] _set_host_settings failed, using defaults: {_hs_e}")
        _tracker.sorting_priorities = {
            "default": 0, "hinted": 1, "excluded": 2, "excluded_glitched": 3,
            "hinted_glitched": 4, "glitched": 5, "unconnected": 6,
            "error": -1, "other": 7, "ut_status": 8,
        }
        _tracker.sorting_method = "label"
        _tracker.output_format = "Both"
        _tracker.hide_excluded = False
        _tracker.use_split = True
        _tracker.enable_glitched_logic = True
    _tracker.set_slot_params(_game, _slot, _slot_name, _team)
    _tracker.initalize_tracker_core(_world_cls, _slot_data)
    if _tracker.gen_error:
        raise RuntimeError("tracker init failed:\\n" + _tracker.gen_error)
    if _tracker.multiworld is None:
        raise RuntimeError("tracker init produced no multiworld")
    # Park on builtins so it survives pyodide's per-call namespaces.
    import builtins as _b
    _b._ut_tracker   = _tracker
    _b._ut_multidata = _multidata
    _b._ut_slot      = _slot
    _b._ut_slot_name = _slot_name
    _b._ut_game      = _game
    _ret = ""
except Exception:
    _ret = traceback.format_exc()
_ret
`;

// Read the player's currently checked-locations set off the active session
// ctx. Tracker is gated on a live session, so we never look at _host_ctx here.
const TRACKER_CHECKS_PY = `
def _ut_get_checks():
    _c = _ut_ctx_q
    if _c is None: return []
    try:
        return list(getattr(_c, "checked_locations", set()) or set())
    except Exception:
        return []
_ut_get_checks()
`;

// Recompute in-logic locations given the player's current set of checked
// location IDs. items_received is derived from multidata for solo seeds.
const TRACKER_UPDATE_PY = `
def _ut_compute():
    import builtins as _b
    _t = getattr(_b, "_ut_tracker", None)
    _md = getattr(_b, "_ut_multidata", None)
    _slot = getattr(_b, "_ut_slot", None)
    if _t is None or _md is None or _slot is None: return []
    try:
        from NetUtils import NetworkItem
        _checked = set(int(x) for x in (_ut_checked_in or []))
        _all_locs = _md["locations"][_slot]   # {loc_id: (item_id, recipient_slot, item_flags)}
        _missing = set(_all_locs.keys()) - _checked
        _items = []
        for _lid in _checked:
            _info = _all_locs.get(_lid)
            if _info is None: continue
            _iid, _recv, _flags = _info[0], _info[1], _info[2]
            if _recv != _slot: continue   # not for us — would be sent over network
            _items.append(NetworkItem(_iid, _lid, _slot, _flags))
        _t.set_items_received(_items)
        _t.set_missing_locations(_missing)
        _state = _t.updateTracker()
        # Go mode mirrors UT's TrackerClient: has_beaten_game on the live state
        # ("yes"), or on the glitches_state ("glitched"), else "no".
        _go = "no"
        try:
            _mw = _t.multiworld
            _pid = _t.player_id
            if _state.state is not None and _mw.has_beaten_game(_state.state, _pid):
                _go = "yes"
            elif _state.glitches_state is not None and _mw.has_beaten_game(_state.glitches_state, _pid):
                _go = "glitched"
        except Exception:
            pass
        return [_go, list(_state.in_logic_locations)]
    except Exception:
        import traceback; traceback.print_exc()
        return ["no", []]
_ut_compute()
`;

