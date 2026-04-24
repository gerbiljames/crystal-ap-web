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
  await pyodide.runPythonAsync(`
from worlds.pokemon_crystal.rom import PokemonCrystalProcedurePatch
PokemonCrystalProcedurePatch.source_data = open("/tmp/vanilla.gbc","rb").read()
PokemonCrystalProcedurePatch(path="/tmp/seed.apcrystalpre").patch("/tmp/patched.gbc")
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
import asyncio, json, re
from js import self as _js_self, WebSocket as _JsWebSocket
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

# ------------------------------------------------------------------ websockets
# Python 'websockets' can't open raw sockets in Pyodide. Replace its connect()
# with a tiny wrapper around the browser's WebSocket.
import websockets as _ws
class _BrowserWS:
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
            try:
                self._queue.put_nowait(ev.data)
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
    async def wait_open(self):
        await self._open_fut
    async def send(self, data):
        if isinstance(data, (bytes, bytearray)):
            data = bytes(data)
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
        # Browser WS auto-keeps alive — return an already-resolved future.
        fut = asyncio.get_event_loop().create_future()
        fut.set_result(None); return fut
    async def pong(self, *a, **kw): return None

async def _ws_connect(uri, *args, **kwargs):
    # Force wss://. The page is served over HTTPS, so mixed-content
    # blocks any ws:// connection with a SecurityError regardless of
    # what scheme the user / CommonClient supplied.
    u = re.sub(r"^wss?://", "", uri)
    u = "wss://" + u
    ws = _BrowserWS(u)
    await ws.wait_open()
    return ws
_ws.connect = _ws_connect

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
print("session started")
`;
}

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

# Eagerly import the apworld so failures surface rather than being swallowed
# by AutoWorldRegister.
import worlds.pokemon_crystal.world  # noqa: F401
from worlds.AutoWorld import AutoWorldRegister
_ = AutoWorldRegister.world_types  # force registration
`;
