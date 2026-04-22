"use strict";
/* crystal.ap lab console — state machine wrapping the gen service (:8770),
   session bridge (:8766), and binjgb-wasm. */

// -----------------------------------------------------------------------------
// constants
// -----------------------------------------------------------------------------
const GEN_BASE   = "https://crystal-ap-host.gerbiljames.workers.dev";
const GB_ROM_SIZE = 2097152;

// Pokemon Crystal WRAM offsets (from 0xC000). Drawn from
// worlds/pokemon_crystal/data/data.json.
const WRAM_BASE = 0xC000;
const RAM = {
  wArchipelagoOptions:          0xfc9,
  wArchipelagoTrackerSlot:      0xfd4,
  wMapEventStatus:              0x143a,
  wArchipelagoItemReceived:     0x1ca7,
  wArchipelagoItemIndex:        0x1ca8,
  wArchipelagoSafeWrite:        0x1caa,
  wArchipelagoFlagItemReceived: 0x1cb0,
  wStatusFlags:                 0x181f,
  wEventFlags:                  0x1a88,
};

// -----------------------------------------------------------------------------
// DOM helpers
// -----------------------------------------------------------------------------
const $ = sel => document.querySelector(sel);
const app = $(".app");

// Push a single history entry on first leaving home, so the browser back
// button returns to home instead of the previous page. Flag is cleared when
// we go back to options so a subsequent seed can re-push.
let _historyPushed = false;
function setStep(step) {
  app.dataset.step = step;
  if (window.__updateEmuMaxH) window.__updateEmuMaxH();
  if (step !== "options" && !_historyPushed) {
    history.pushState({ inApp: true }, "");
    _historyPushed = true;
  } else if (step === "options") {
    _historyPushed = false;
  }
  // Flag earlier steps as done.
  const order = ["options", "generating", "rom", "patching", "play"];
  const idx = order.indexOf(step);
  document.querySelectorAll(".steps li").forEach(el => {
    const elIdx = order.indexOf(el.dataset.step);
    el.classList.toggle("done", elIdx !== -1 && elIdx < idx);
  });
}

// Browser back while in-app → same teardown as clicking the brand.
window.addEventListener("popstate", () => {
  try { apWorker.stopSession(); } catch {}
  window.location.reload();
});

function setSessionState(state, label) {
  const chip = $("#session-chip");
  chip.dataset.state = state;
  chip.querySelector(".label").textContent = label ?? state;
  app.dataset.session = state;
}

// -----------------------------------------------------------------------------
// logging
// -----------------------------------------------------------------------------
const logEl = $("#log");
// #log is <pre>; actual scroll happens on its parent #log-wrap. We keep the
// view pinned to the bottom unless the user has scrolled up to read history.
const logWrap = $("#log-wrap");
function isLogAtBottom() {
  // With a generous slack so near-misses still auto-scroll.
  if (!logWrap || logWrap.hidden) return true;
  return logWrap.scrollHeight - logWrap.clientHeight - logWrap.scrollTop < 16;
}
function logLine(kind, msg) { logPush(kind, { text: String(msg) }); }
function logAnsi(kind, msg)  { logPush(kind, { ansi: String(msg) }); }
function logPush(kind, content) {
  const stick = isLogAtBottom();
  const now = new Date();
  const t = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;
  const line = document.createElement("span");
  line.className = `log-${kind}`;
  if ("ansi" in content) line.innerHTML = ansiToHtml(content.ansi);
  else                   line.textContent = content.text;
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = `${t} `;
  logEl.appendChild(time);
  logEl.appendChild(line);
  logEl.appendChild(document.createTextNode("\n"));
  if (stick && logWrap) logWrap.scrollTop = logWrap.scrollHeight;
}

// Minimal ANSI SGR → HTML converter for the subset colorama emits. Maps ANSI
// color codes to our palette so AP log lines keep their semantic colors.
const ANSI_COLORS = {
  30:"#3e3c36", 31:"#d97757", 32:"#8fc4b0", 33:"#c9a86a",
  34:"#7ba2c4", 35:"#d49bc9", 36:"#5a9c89", 37:"#ebe3cf",
  90:"#6b6657", 91:"#e2896d", 92:"#a4d3c2", 93:"#d7b87e",
  94:"#92b4cd", 95:"#deabd1", 96:"#70ad99", 97:"#f4ecd8",
};
function ansiToHtml(s) {
  const out = [];
  const re = /\x1b\[([\d;]*)m/g;
  let cur = null, last = 0, m;
  const flush = (end) => {
    if (end <= last) return;
    const chunk = escHtml(s.slice(last, end));
    out.push(cur ? `<span style="color:${cur}">${chunk}</span>` : chunk);
  };
  while ((m = re.exec(s)) !== null) {
    flush(m.index);
    const codes = m[1].split(";").filter(c => c.length).map(Number);
    if (codes.length === 0 || codes.includes(0)) cur = null;
    for (const c of codes) if (c in ANSI_COLORS) cur = ANSI_COLORS[c];
    last = m.index + m[0].length;
  }
  flush(s.length);
  return out.join("");
}
function escHtml(s) { return s.replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"})[c]); }
const log  = (m) => logLine("info", m);
const logOk  = (m) => logLine("ok", m);
const logErr = (m) => logLine("err", m);
const logWarn = (m) => logLine("warn", m);

// -----------------------------------------------------------------------------
// dropzone wiring
// -----------------------------------------------------------------------------
function wireDropzone(zoneEl, inputEl, onFile) {
  const onDrag = ev => { ev.preventDefault(); zoneEl.classList.add("drag-over"); };
  const onLeave = () => zoneEl.classList.remove("drag-over");
  zoneEl.addEventListener("dragenter", onDrag);
  zoneEl.addEventListener("dragover",  onDrag);
  zoneEl.addEventListener("dragleave", onLeave);
  zoneEl.addEventListener("drop", ev => {
    ev.preventDefault(); zoneEl.classList.remove("drag-over");
    const f = ev.dataTransfer?.files?.[0];
    if (f) onFile(f);
  });
  inputEl.addEventListener("change", () => {
    if (inputEl.files && inputEl.files[0]) onFile(inputEl.files[0]);
  });
}

// -----------------------------------------------------------------------------
// YAML "name:" extractor (best-effort, spike-grade)
// -----------------------------------------------------------------------------
function extractSlotNameFromYaml(text) {
  const m = text.match(/^name:\s*(.+)\s*$/m);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, "").replace(/\s*#.*$/, "");
}

// -----------------------------------------------------------------------------
// Read a single entry out of a .apcrystalpre (zip). Handles STORED and DEFLATE
// compression — enough for archipelago.json, which is all we care about.
// -----------------------------------------------------------------------------
async function readZipEntry(bytes, targetName) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  let pos = 0;
  while (pos <= bytes.length - 30) {
    if (view.getUint32(pos, true) !== 0x04034b50) { pos++; continue; }
    const method    = view.getUint16(pos + 8, true);
    const compSize  = view.getUint32(pos + 18, true);
    const nameLen   = view.getUint16(pos + 26, true);
    const extraLen  = view.getUint16(pos + 28, true);
    const name      = dec.decode(bytes.subarray(pos + 30, pos + 30 + nameLen));
    const dataStart = pos + 30 + nameLen + extraLen;
    if (name === targetName) {
      const data = bytes.subarray(dataStart, dataStart + compSize);
      if (method === 0) return data;
      if (method === 8) {
        const stream = new Response(data).body.pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }
      throw new Error("unsupported compression method " + method);
    }
    pos = dataStart + compSize;
  }
  throw new Error(`${targetName} not found in patch`);
}

async function readPatchManifest(patchBytes) {
  const raw = await readZipEntry(patchBytes, "archipelago.json");
  return JSON.parse(new TextDecoder().decode(raw));
}

// Crystal's patch extension is .apcrystal (stable) or .apcrystalpre (prerelease
// apworld). Accept both everywhere; surface only .apcrystal in user-facing copy.
const isPatchName = (n) => /\.apcrystal(pre)?$/i.test(n);

// Extract every file in a zip. Used when the user drops the full AP output
// zip (patch + multidata + spoiler), so we can host the multidata on
// archipelago.gg even when we didn't generate it ourselves.
async function extractAllZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const out = {};
  let pos = 0;
  while (pos <= bytes.length - 30) {
    if (view.getUint32(pos, true) !== 0x04034b50) { pos++; continue; }
    const method    = view.getUint16(pos + 8, true);
    const compSize  = view.getUint32(pos + 18, true);
    const nameLen   = view.getUint16(pos + 26, true);
    const extraLen  = view.getUint16(pos + 28, true);
    const name      = dec.decode(bytes.subarray(pos + 30, pos + 30 + nameLen));
    const dataStart = pos + 30 + nameLen + extraLen;
    const chunk     = bytes.subarray(dataStart, dataStart + compSize);
    if (method === 0) out[name] = chunk;
    else if (method === 8) {
      const stream = new Response(chunk).body.pipeThrough(new DecompressionStream("deflate-raw"));
      out[name] = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    pos = dataStart + compSize;
  }
  return out;
}

// Upload a multidata blob to archipelago.gg via our host proxy. Returns
// {room_url, ws_url, host, port} on success, null on any failure.
async function tryHostMultidata(multidataBytes) {
  try {
    const resp = await fetch(`${GEN_BASE}/host`, { method: "POST", body: multidataBytes });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      logWarn(`archipelago.gg host failed: ${j.error || resp.status}`);
      return null;
    }
    return await resp.json();
  } catch (e) {
    logWarn(`host proxy unreachable: ${e}`);
    return null;
  }
}

// -----------------------------------------------------------------------------
// IndexedDB: two stores
//   sav   — SRAM per seed, keyed by ROM SHA-1
//   rom   — patched ROM bytes per seed, keyed by gen_service seed_id
// -----------------------------------------------------------------------------
const SAVE_DB_NAME     = "crystal-ap-saves";
const SAVE_STORE       = "sav";        // SRAM per seed, keyed by ROM SHA-1
const ROM_STORE        = "rom";        // patched ROM per seed, keyed by seed_id
const VANILLA_STORE    = "vanilla";    // vanilla ROM, single key "rom"
const ARTIFACTS_STORE  = "artifacts";  // gen artifacts per seed, keyed by seed_id
const DB_VERSION       = 4;
function openSaveDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SAVE_DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SAVE_STORE))      db.createObjectStore(SAVE_STORE);
      if (!db.objectStoreNames.contains(ROM_STORE))       db.createObjectStore(ROM_STORE);
      if (!db.objectStoreNames.contains(VANILLA_STORE))   db.createObjectStore(VANILLA_STORE);
      if (!db.objectStoreNames.contains(ARTIFACTS_STORE)) db.createObjectStore(ARTIFACTS_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
function idbGet(db, k, store = SAVE_STORE) { return new Promise((res, rej) => {
  const t = db.transaction(store, "readonly").objectStore(store).get(k);
  t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error);
});}
function idbPut(db, k, v, store = SAVE_STORE) { return new Promise((res, rej) => {
  const t = db.transaction(store, "readwrite").objectStore(store).put(v, k);
  t.onsuccess = () => res(); t.onerror = () => rej(t.error);
});}
function idbDel(db, k, store = SAVE_STORE) { return new Promise((res, rej) => {
  const t = db.transaction(store, "readwrite").objectStore(store).delete(k);
  t.onsuccess = () => res(); t.onerror = () => rej(t.error);
});}
// Single shared connection for the module.
let _dbPromise = null;
function db() {
  if (!_dbPromise) _dbPromise = openSaveDb().catch(err => { console.warn("IDB open failed:", err); return null; });
  return _dbPromise;
}

// -----------------------------------------------------------------------------
// local session history
// -----------------------------------------------------------------------------
const SESSIONS_KEY = "crystal-ap-sessions";
const SESSIONS_MAX = 20;

function loadSessions() {
  try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]"); }
  catch { return []; }
}
function saveSessions(list) {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(list.slice(0, SESSIONS_MAX))); }
  catch { /* storage full or disabled — not fatal */ }
}
function recordSession(entry) {
  const list = loadSessions().filter(s => s.id !== entry.id);
  list.unshift({ ...entry, savedAt: Date.now() });
  saveSessions(list);
  renderResumeList();
}
async function forgetSession(id) {
  const sess = loadSessions().find(s => s.id === id);
  saveSessions(loadSessions().filter(s => s.id !== id));
  renderResumeList();
  const dbc = await db();
  if (dbc) {
    idbDel(dbc, id, ROM_STORE).catch(() => {});
    idbDel(dbc, id, ARTIFACTS_STORE).catch(() => {});
    if (sess?.romHash) idbDel(dbc, sess.romHash, SAVE_STORE).catch(() => {});
  }
}
function formatAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)      return "just now";
  if (s < 3600)    return Math.floor(s / 60)    + "m ago";
  if (s < 86400)   return Math.floor(s / 3600)  + "h ago";
  return             Math.floor(s / 86400) + "d ago";
}

function renderResumeList() {
  const sessions = loadSessions();
  const wrap = $("#resume-list");
  const inner = $("#resume-list-inner");
  if (!sessions.length) { wrap.hidden = true; inner.innerHTML = ""; return; }
  wrap.hidden = false;
  inner.innerHTML = "";
  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = "resume-row";
    row.innerHTML = `
      <span class="slot">${escapeHtml(s.slot || "?")}</span>
      <span class="id">
        ${escapeHtml(s.id)}
        ${s.romCached ? '<span class="rom-cached" title="patched ROM cached locally — resume skips the ROM upload">ROM</span>' : ""}
      </span>
      <span class="meta">
        <em>${s.hosted ? `${escapeHtml(s.hosted.host)}:${s.hosted.port}` : "no host"}</em>
        ${formatAge(Date.now() - s.savedAt)}
      </span>
      <span class="actions">
        <button class="btn-primary resume" data-id="${s.id}">resume</button>
        <button class="forget" data-id="${s.id}" title="remove from this device">forget</button>
      </span>
    `;
    inner.appendChild(row);
  }
  inner.querySelectorAll(".resume").forEach(b => b.addEventListener("click", () => resumeSession(b.dataset.id)));
  inner.querySelectorAll(".forget").forEach(b => b.addEventListener("click", () => forgetSession(b.dataset.id)));
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]); }

async function resumeSession(id) {
  const session = loadSessions().find(s => s.id === id);
  if (!session) return;
  STATE.seedId   = id;
  STATE.slotName = session.slot || "Player1";
  STATE.hosted   = session.hosted || null;

  // Only resumable if we already cached the patched ROM — otherwise we'd
  // need the original YAML to regenerate, which we don't persist.
  const dbc = await db();
  const cachedRom = dbc ? await idbGet(dbc, id, ROM_STORE).catch(() => null) : null;
  if (cachedRom && cachedRom.byteLength === GB_ROM_SIZE) {
    STATE.patchedRom = cachedRom;
    // Reload saved gen artifacts so the play sidebar can still offer downloads.
    const savedArtifacts = dbc ? await idbGet(dbc, id, ARTIFACTS_STORE).catch(() => null) : null;
    if (savedArtifacts) STATE.artifacts = savedArtifacts;
    setStep("play");
    logOk(`resumed ${id} with cached ROM`);
    await bootEmulatorAndUi();
    return;
  }
  logErr(`no cached ROM for ${id} — drop your YAML again to regenerate`);
}

// -----------------------------------------------------------------------------
// app state
// -----------------------------------------------------------------------------
const STATE = {
  seedId: null,           // client-side uuid
  slotName: "Player1",
  artifacts: null,        // {name: Uint8Array} — in-memory gen outputs
  hosted: null,           // {room_url, ws_url, host, port} from archipelago.gg
  patchedRom: null,       // ArrayBuffer
  emulator: null,
};

// initial state
setStep("options");
renderResumeList();

// Persist the "host on archipelago.gg" toggle across visits. Default on.
const HOST_PREF_KEY = "crystal-ap-host-pref";
const hostToggle = $("#host-toggle");
hostToggle.checked = localStorage.getItem(HOST_PREF_KEY) === "on";
hostToggle.addEventListener("change", () => {
  try { localStorage.setItem(HOST_PREF_KEY, hostToggle.checked ? "on" : "off"); } catch {}
});

// Brand click → kill everything and go home. Full page reload is the
// simplest correct teardown — the emulator, Pyodide worker, AP session, and
// any pending promises all die; cached ROM + SRAM live in IDB so the next
// "resume" comes back up quickly.
$("#brand-home").addEventListener("click", ev => {
  ev.preventDefault();
  try { apWorker.stopSession(); } catch {}
  window.location.reload();
});

// "Start over" buttons inside error boxes — clear transient state and return
// to the home/options view. The Pyodide worker stays warm.
document.querySelectorAll(".err-back").forEach(btn => {
  btn.addEventListener("click", () => {
    STATE.seedId = null;
    STATE.artifacts = null;
    STATE.hosted = null;
    STATE.patchedRom = null;
    $("#gen-err").hidden = true;
    $("#rom-err").hidden = true;
    $("#yaml-err").hidden = true;
    $("#seed-result").hidden = true;
    $("#gen-progress").hidden = true;
    $("#rom-progress").hidden = true;
    $("#result-grid").innerHTML = "";
    renderResumeList();
    setStep("options");
  });
});

// -----------------------------------------------------------------------------
// STEP 01 · YAML upload  →  browser-side generation
// -----------------------------------------------------------------------------
(function initOptions() {
  const dz   = $("#dz-yaml");
  const file = $("#yaml-file");
  const errBox = $("#yaml-err");
  const errMsg = $("#yaml-err-msg");
  const showErr = (msg) => { errMsg.textContent = msg; errBox.hidden = false; logErr(msg); };

  const onFile = async (f) => {
    errBox.hidden = true;
    log(`read ${f.name} (${f.size} bytes)`);
    STATE.seedId = (crypto.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 12);

    const name = f.name.toLowerCase();
    const isPatch = isPatchName(name);
    const isZip   = name.endsWith(".zip");
    if (isPatch || isZip) {
      let bytes;
      try { bytes = new Uint8Array(await f.arrayBuffer()); }
      catch (e) { showErr(`could not read file: ${e}`); return; }

      // Unpack into an artifacts dict. For a raw .apcrystalpre, that's the
      // single file; for a zip (AP's canonical output), pull all entries.
      let artifacts = {};
      if (isPatch) {
        artifacts[f.name] = bytes;
      } else {
        try { artifacts = await extractAllZipEntries(bytes); }
        catch (e) { showErr(`could not read zip: ${e}`); return; }
      }
      const patchName = Object.keys(artifacts).find(isPatchName);
      if (!patchName) { showErr(`no .apcrystal found inside ${f.name}`); return; }

      // Pull slot + server hints from the patch's archipelago.json.
      let manifest = {};
      try { manifest = await readPatchManifest(artifacts[patchName]); }
      catch (e) { logWarn(`couldn't read archipelago.json: ${e.message || e}`); }
      if (manifest.player_name) {
        STATE.slotName = manifest.player_name;
        log(`slot from patch: ${manifest.player_name}`);
      }

      // Try to host on archipelago.gg if we have multidata AND the toggle is on.
      const multiName = Object.keys(artifacts).find(n => n.toLowerCase().endsWith(".archipelago"));
      let hosted = null;
      if (multiName && hostToggle.checked) {
        setStep("generating");
        $("#gen-progress").hidden = false;
        $("#gen-seed").textContent = STATE.seedId;
        $("#gen-status").textContent = "hosting on archipelago.gg…";
        hosted = await tryHostMultidata(artifacts[multiName]);
        $("#gen-progress").hidden = true;
      } else if (!multiName && hostToggle.checked) {
        logWarn("hosting requested but no .archipelago was found — skip to ROM");
      }
      // Fall back to server baked into the patch's archipelago.json.
      if (!hosted && manifest.server && manifest.server.includes(":")) {
        const [h, portStr] = manifest.server.split(":");
        const p = Number(portStr);
        if (h && Number.isInteger(p)) {
          hosted = { host: h, port: p, ws_url: `wss://${h}:${p}`, room_url: null };
          log(`server from patch: ${h}:${p}`);
        }
      }

      STATE.artifacts = artifacts;
      STATE.hosted = hosted;
      logOk(`using uploaded ${isPatch ? "patch" : "zip"} — skipping generation` + (hosted ? "" : "; no host"));
      enterRomStep();
      return;
    }
    if (!(name.endsWith(".yaml") || name.endsWith(".yml"))) {
      showErr(`unsupported file type: ${f.name}`);
      return;
    }

    let text;
    try { text = await f.text(); }
    catch (e) { showErr(`could not read file: ${e}`); return; }
    const slot = extractSlotNameFromYaml(text);
    if (slot) { STATE.slotName = slot; log(`parsed slot name: ${slot}`); }

    setStep("generating");
    runGeneration(text);
  };

  wireDropzone(dz, file, onFile);
})();

async function runGeneration(yamlText) {
  const start = performance.now();
  $("#gen-err").hidden = true;
  $("#seed-result").hidden = true;
  $("#result-grid").innerHTML = "";
  $("#gen-progress").hidden = false;
  $("#gen-status").textContent = "starting";
  $("#gen-seed").textContent = STATE.seedId;
  const tickElapsed = () => { $("#gen-elapsed").textContent = `${((performance.now()-start)/1000).toFixed(1)}s`; };
  const elapsedTimer = setInterval(tickElapsed, 100);

  let artifacts;
  try {
    const res = await apWorker.generate(yamlText, (phase) => {
      $("#gen-status").textContent = PHASE_LABELS[phase] || phase;
      log("gen: " + phase);
    });
    artifacts = res.out.artifacts;
  } catch (err) {
    clearInterval(elapsedTimer); tickElapsed();
    $("#gen-progress").hidden = true;
    $("#gen-err").hidden = false;
    $("#gen-err-msg").textContent = err.message || String(err);
    logErr(`generation failed: ${err.message || err}`);
    return;
  }

  STATE.artifacts = artifacts;  // {name: Uint8Array}
  logOk(`generated ${Object.keys(artifacts).length} artifacts locally`);

  // Optionally hand the multidata to the host proxy — the one thing we can't
  // do in-browser (CORS to archipelago.gg). Gated by the user's toggle.
  const multiName = Object.keys(artifacts).find(n => n.endsWith(".archipelago"));
  let hosted = null;
  if (multiName && hostToggle.checked) {
    $("#gen-status").textContent = "hosting on archipelago.gg…";
    hosted = await tryHostMultidata(artifacts[multiName]);
  } else if (!hostToggle.checked) {
    log("hosting disabled — the multidata is downloadable from the results card");
  }
  STATE.hosted = hosted;

  clearInterval(elapsedTimer); tickElapsed();
  $("#gen-progress").hidden = true;
  $("#gen-status").textContent = hosted ? "ready · hosted" : "ready";
  renderArtifactChips();
  await updateContinueButton();
  $("#seed-result").hidden = false;
  logOk(hosted ? `hosted on ${hosted.host}:${hosted.port}` : "no archipelago.gg room (skipped)");
  // Session not recorded yet — we defer until the ROM patch actually succeeds
  // so abandoned seeds don't clutter the resume list with unrunnable entries.
}

function renderArtifactChips() {
  const grid = $("#result-grid");
  grid.innerHTML = "";
  const chip = (href, title, kind, sublabel, download) => {
    const a = document.createElement("a");
    a.href = href;
    a.className = "result-chip";
    a.target = "_blank";
    a.rel = "noopener";
    a.title = title;
    if (kind === "download") { a.download = download || title; }
    const left = document.createElement("span");
    left.className = "chip-left";
    left.innerHTML = `<span class="label">${sublabel}</span><span class="title">${title}</span>`;
    const right = document.createElement("span");
    right.className = "arrow";
    right.textContent = kind === "download" ? "↓" : "↗";
    a.appendChild(left); a.appendChild(right);
    grid.appendChild(a);
  };

  if (STATE.hosted) chip(STATE.hosted.room_url, "archipelago.gg room", "external", "host");

  const artifacts = STATE.artifacts || {};
  const blobUrl = (name) => URL.createObjectURL(new Blob([artifacts[name]], { type: "application/octet-stream" }));
  const patch = Object.keys(artifacts).find(isPatchName);
  const spoil = Object.keys(artifacts).find(n => n.endsWith("_Spoiler.txt"));
  const multi = Object.keys(artifacts).find(n => n.endsWith(".archipelago"));
  if (patch) chip(blobUrl(patch), patch,       "download", "patch",      patch);
  if (spoil) chip(blobUrl(spoil), "spoiler",   "download", "txt",        spoil);
  if (multi) chip(blobUrl(multi), "multidata", "download", "archipelago", multi);
}

$("#next-rom").addEventListener("click", enterRomStep);

// If the vanilla ROM is cached, the "continue" button jumps straight to play
// (we auto-patch). Otherwise it goes to the ROM upload step. Label reflects
// whichever is about to happen.
async function updateContinueButton() {
  const btn = $("#next-rom");
  if (!btn) return;
  const dbc = await db();
  const cached = dbc ? await idbGet(dbc, "rom", VANILLA_STORE).catch(() => null) : null;
  btn.textContent = (cached && cached.byteLength === GB_ROM_SIZE)
    ? "Continue → Play"
    : "Continue → ROM";
}

// -----------------------------------------------------------------------------
// Pyodide worker (generation + patching). Lazy-inits on first call.
// -----------------------------------------------------------------------------
const apWorker = (() => {
  let worker = null;
  let nextId = 1;
  const pending = new Map();
  let onProgress = null;
  let onBhReq    = null;   // main-thread bizhawk request handler
  let onPrint    = null;

  function handle(ev) {
    const { id, event, phase, reqId, payload, ok, error, out } = ev.data;
    if (event === "progress") { onProgress?.(phase); return; }
    if (event === "bh-req")   { onBhReq?.(reqId, payload); return; }
    if (event === "printjson"){ onPrint?.(ev.data.text); return; }
    if (event === "py-log")   { logAnsi("info", ev.data.msg); return; }
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve({ ok, out });
  }
  function spawn() {
    if (worker) return worker;
    worker = new Worker("ap_worker.js");
    worker.onmessage = handle;
    worker.onerror = ev => logErr("ap worker error: " + ev.message);
    return worker;
  }
  function call(cmd, payload = {}, transfer = [], cb = null) {
    onProgress = cb;
    const id = nextId++;
    spawn().postMessage({ id, cmd, ...payload }, transfer);
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }
  function fire(cmd, payload = {}) { spawn().postMessage({ cmd, ...payload }); }
  return {
    init:         (cb)                         => call("init", {}, [], cb),
    patch:        (rom, patch, cb)             => call("patch",    { rom, patch }, [rom.buffer, patch.buffer], cb),
    generate:     (yaml, cb)                   => call("generate", { yaml }, [], cb),
    startSession: (server, slot, password)     => call("session-start", { server, slot, password }),
    stopSession:  ()                           => call("session-stop"),
    sendBhResponse: (reqId, payload)           => fire("bh-res", { reqId, payload }),
    setBhHandler: (fn)                         => { onBhReq = fn; },
    setPrintHandler: (fn)                      => { onPrint = fn; },
  };
})();

// Shared progress-phase labels for the worker pipeline.
const PHASE_LABELS = {
  "pyodide-boot":        "booting runtime…",
  "install-deps":        "installing dependencies…",
  "bsdiff4-shim":        "preparing bsdiff4…",
  "fetch-ap-source":     "fetching AP source…",
  "unpack-ap-source":    "unpacking AP source…",
  "import-ap":           "importing Archipelago…",
  "ready":               "ready",
  "rolling-seed":        "rolling seed…",
  "collecting-artifacts":"collecting artifacts…",
};

async function runPatch(romBytes, sourceLabel = "uploaded") {
  const errBox = $("#rom-err");
  const errMsg = $("#rom-err-msg");
  const progress = $("#rom-progress");
  const progressText = $("#rom-progress-text");
  const showErr = msg => { errMsg.textContent = msg; errBox.hidden = false; progress.hidden = true; logErr(msg); };

  errBox.hidden = true;
  progress.hidden = false;
  progressText.textContent = "reading ROM…";
  setStep("patching");
  log(`${sourceLabel} ROM (${romBytes.length} bytes); patching locally`);

  const patchName = Object.keys(STATE.artifacts || {}).find(isPatchName);
  if (!patchName) { showErr("no .apcrystal on this session — regenerate"); return; }
  const patchBytes = STATE.artifacts[patchName].slice();
  // Snapshot the vanilla BEFORE we transfer it into the worker — afterwards
  // romBytes.buffer is detached and touching it throws.
  const vanillaBuf = romBytes.slice().buffer;

  try {
    const { out } = await apWorker.patch(romBytes, patchBytes, (phase) => {
      progressText.textContent = PHASE_LABELS[phase] || phase;
      log("patcher: " + phase);
    });
    progressText.textContent = "booting emulator…";
    if (out.byteLength !== GB_ROM_SIZE) {
      showErr(`patched ROM was ${out.byteLength} bytes, expected ${GB_ROM_SIZE}`);
      return;
    }
    STATE.patchedRom = out.buffer;
    logOk(`patched locally (${out.byteLength} bytes)`);
    // Record the session only now — prior attempts that never reached a
    // patched ROM don't clutter the resume list with unrunnable entries.
    recordSession({
      id: STATE.seedId,
      slot: STATE.slotName,
      hosted: STATE.hosted,
      romCached: true,
    });
    const dbc = await db();
    if (dbc) {
      idbPut(dbc, STATE.seedId, out.buffer.slice(0), ROM_STORE)
        .catch(err => logWarn("cache patched rom failed: " + err));
      idbPut(dbc, "rom", vanillaBuf, VANILLA_STORE)
        .catch(err => logWarn("cache vanilla rom failed: " + err));
      // Persist gen artifacts too so resume can still offer patch/multidata/
      // spoiler downloads. Values are Uint8Arrays; IDB structured-clones them.
      if (STATE.artifacts) {
        idbPut(dbc, STATE.seedId, STATE.artifacts, ARTIFACTS_STORE)
          .catch(err => logWarn("cache artifacts failed: " + err));
      }
    }
    setStep("play");
    progress.hidden = true;
    await bootEmulatorAndUi();
  } catch (err) {
    showErr(`patch failed: ${err.message || err}`);
  }
}

(function initRom() {
  const dz = $("#dz-rom");
  const file = $("#rom-file");
  const errBox = $("#rom-err");
  const errMsg = $("#rom-err-msg");

  const showErr = msg => { errMsg.textContent = msg; errBox.hidden = false; logErr(msg); };

  const onFile = async (f) => {
    errBox.hidden = true;
    if (f.size !== GB_ROM_SIZE) {
      showErr(`expected 2,097,152 bytes, got ${f.size.toLocaleString()} — is this the right file?`);
      return;
    }
    let romBuf;
    try { romBuf = new Uint8Array(await f.arrayBuffer()); }
    catch (e) { showErr(`read failed: ${e}`); return; }
    await runPatch(romBuf, "uploaded");
  };

  wireDropzone(dz, file, onFile);
})();

// When user clicks "Continue", try cached vanilla first. If present, go
// straight into patching (no flash of the ROM drop UI); otherwise show the
// dropzone.
async function enterRomStep() {
  const dbc = await db();
  const cached = dbc ? await idbGet(dbc, "rom", VANILLA_STORE).catch(() => null) : null;
  if (cached && cached.byteLength === GB_ROM_SIZE) {
    log("using saved vanilla ROM from this browser");
    await runPatch(new Uint8Array(cached), "cached");
    return;
  }
  setStep("rom");
}

// -----------------------------------------------------------------------------
// STEP 04 · play — boot emulator, wire session bridge
// -----------------------------------------------------------------------------
async function bootEmulatorAndUi() {
  log("booting binjgb…");
  const Module = await Binjgb();
  const romBuf = STATE.patchedRom;

  // Hash the ROM for SRAM keying (and to serve HASH requests).
  const romHashBuf = await crypto.subtle.digest("SHA-1", romBuf);
  const romHash = [...new Uint8Array(romHashBuf)].map(b => b.toString(16).padStart(2,"0").toUpperCase()).join("");

  // Allocate & copy into wasm heap.
  const size = (romBuf.byteLength + 0x7fff) & ~0x7fff;
  const romPtr = Module._malloc(size);
  new Uint8Array(Module.HEAP8.buffer, romPtr, size).fill(0).set(new Uint8Array(romBuf));

  const audioCtx = new AudioContext();
  const AUDIO_FRAMES = 4096;
  const CGB_COLOR_CURVE = 2;
  const e = Module._emulator_new_simple(romPtr, size, audioCtx.sampleRate, AUDIO_FRAMES, CGB_COLOR_CURVE);
  if (e === 0) { logErr("invalid ROM (binjgb rejected it)"); return; }

  const joypadBufferPtr = Module._joypad_new();
  Module._emulator_set_default_joypad_callback(e, joypadBufferPtr);

  // --- memory helpers (CPU-space via read/write_mem) ---
  const readMem = (addr, len = 1) => {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = Module._emulator_read_mem(e, (addr + i) & 0xFFFF);
    return out;
  };
  const writeMem = (addr, bytes) => {
    for (let i = 0; i < bytes.length; i++) Module._emulator_write_mem(e, (addr + i) & 0xFFFF, bytes[i]);
  };
  const guardedWrite = (guardAddr, expected, writeAddr, bytes) => {
    const g = readMem(guardAddr, expected.length);
    for (let i = 0; i < expected.length; i++) if (g[i] !== expected[i]) return false;
    writeMem(writeAddr, bytes); return true;
  };

  // --- domain helpers (for BizHawk protocol) ---
  const romBytes = new Uint8Array(romBuf.slice(0)); // stable copy for ROM domain reads
  const DOMAIN_SIZE = { WRAM: 32768, HRAM: 127, ROM: romBytes.length };
  const readDomain = (domain, addr, sz) => {
    if (domain === "ROM")  return romBytes.slice(addr, addr + sz);
    if (domain === "WRAM") { const p = Module._emulator_get_wram_ptr(e); return new Uint8Array(Module.HEAP8.buffer, p + addr, sz).slice(); }
    if (domain === "HRAM") { const p = Module._emulator_get_hram_ptr(e); return new Uint8Array(Module.HEAP8.buffer, p + addr, sz).slice(); }
    throw new Error("unsupported domain: " + domain);
  };
  const writeDomain = (domain, addr, bytes) => {
    if (domain === "WRAM") { const p = Module._emulator_get_wram_ptr(e); new Uint8Array(Module.HEAP8.buffer, p + addr, bytes.length).set(bytes); return; }
    if (domain === "HRAM") { const p = Module._emulator_get_hram_ptr(e); new Uint8Array(Module.HEAP8.buffer, p + addr, bytes.length).set(bytes); return; }
    throw new Error("unsupported write domain: " + domain);
  };

  // --- frame buffer → canvas ---
  const canvas = $("#screen");
  const fbPtr = Module._get_frame_buffer_ptr(e);
  const fbSize = Module._get_frame_buffer_size(e);
  const fbView = new Uint8Array(Module.HEAP8.buffer, fbPtr, fbSize);
  const ctx2d = canvas.getContext("2d");
  const imageData = ctx2d.createImageData(160, 144);

  const EVENT_NEW_FRAME = 1, EVENT_AUDIO_BUFFER_FULL = 2, EVENT_UNTIL_TICKS = 4;
  const CPU_TICKS_PER_SECOND = 4194304;
  const MAX_UPDATE_SEC = 5 / 60;
  const AUDIO_LATENCY_SEC = 0.1;

  // --- audio ---
  // Browsers require a user gesture before audio can start. We resume the
  // AudioContext on the first click/keydown; until then pushBuffer is a no-op.
  const audioBufPtr  = Module._get_audio_buffer_ptr(e);
  const audioBufCap  = Module._get_audio_buffer_capacity(e);
  let audioStarted = false;
  let audioStartSec = 0;
  let audioVolume  = 0.5;
  let audioMuted   = false;
  const resumeAudio = () => {
    if (audioCtx.state === "suspended") audioCtx.resume();
    audioStarted = true;
    window.removeEventListener("click", resumeAudio, true);
    window.removeEventListener("keydown", resumeAudio, true);
  };
  window.addEventListener("click", resumeAudio, true);
  window.addEventListener("keydown", resumeAudio, true);

  function pushAudio() {
    if (!audioStarted) return;
    const srcBuf = new Uint8Array(Module.HEAP8.buffer, audioBufPtr, audioBufCap);
    const now = audioCtx.currentTime;
    const nowPlusLatency = now + AUDIO_LATENCY_SEC;
    audioStartSec = audioStartSec || nowPlusLatency;
    if (audioStartSec < now) audioStartSec = nowPlusLatency;
    const buffer = audioCtx.createBuffer(2, AUDIO_FRAMES, audioCtx.sampleRate);
    const c0 = buffer.getChannelData(0);
    const c1 = buffer.getChannelData(1);
    const gain = audioMuted ? 0 : audioVolume;
    // Binjgb outputs 8-bit unsigned stereo interleaved. Divide-by-255 (no -128
    // centering) matches the reference demo — the DC offset is inaudible.
    for (let i = 0; i < AUDIO_FRAMES; i++) {
      c0[i] = srcBuf[2 * i]     * gain / 255;
      c1[i] = srcBuf[2 * i + 1] * gain / 255;
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(audioCtx.destination);
    src.start(audioStartSec);
    audioStartSec += AUDIO_FRAMES / audioCtx.sampleRate;
  }

  // Volume control
  const volInput = $("#vol");
  const volLabel = $("#vol-label");
  const applyVol = () => {
    const v = Number(volInput.value) / 100;
    audioVolume = v;
    audioMuted = v === 0;
    volLabel.classList.toggle("muted", audioMuted);
    volLabel.textContent = audioMuted ? "mute" : "vol";
  };
  volInput.addEventListener("input", applyVol);
  applyVol();

  // --- SRAM persistence ---
  const saveDb = await db();
  // Stash romHash on the stored session entry so forget() can also purge SRAM.
  if (STATE.seedId) {
    const list = loadSessions();
    const entry = list.find(s => s.id === STATE.seedId);
    if (entry && entry.romHash !== romHash) {
      entry.romHash = romHash;
      saveSessions(list);
    }
  }
  const extractSram = () => {
    const fd = Module._ext_ram_file_data_new(e);
    Module._emulator_write_ext_ram(e, fd);
    const p = Module._get_file_data_ptr(fd);
    const l = Module._get_file_data_size(fd);
    const out = new Uint8Array(Module.HEAP8.buffer, p, l).slice();
    Module._file_data_delete(fd);
    return out;
  };
  const loadSram = (bytes) => {
    const fd = Module._ext_ram_file_data_new(e);
    const l = Module._get_file_data_size(fd);
    if (bytes.length !== l) { Module._file_data_delete(fd); logWarn(`save size mismatch, skipping load`); return; }
    new Uint8Array(Module.HEAP8.buffer, Module._get_file_data_ptr(fd), l).set(bytes);
    Module._emulator_read_ext_ram(e, fd);
    Module._file_data_delete(fd);
  };
  if (saveDb) {
    const existing = await idbGet(saveDb, romHash).catch(() => null);
    if (existing) { loadSram(new Uint8Array(existing)); logOk(`loaded SRAM (${existing.byteLength} bytes) from prior session`); }
    else { log("fresh save slot"); }
  }

  // --- run loop ---
  // Driven by a Web Worker setInterval tick so the emulator keeps stepping
  // when the tab/window is hidden or unfocused (rAF is throttled/suspended
  // in the background; workers aren't). Canvas paints still piggyback on
  // the natural browser repaint cadence, which is all that matters
  // visually — and audio is gated separately in pushAudio.
  let lastTickSec = 0, leftoverTicks = 0, sramDirty = false;
  function step() {
    const nowSec = performance.now() / 1000;
    const deltaSec = Math.max(nowSec - (lastTickSec || nowSec), 0);
    const deltaTicks = Math.min(deltaSec, MAX_UPDATE_SEC) * CPU_TICKS_PER_SECOND;
    const ticks = Module._emulator_get_ticks_f64(e);
    const until = ticks + deltaTicks - leftoverTicks;
    while (true) {
      const ev = Module._emulator_run_until_f64(e, until);
      if (ev & EVENT_NEW_FRAME) { imageData.data.set(fbView); ctx2d.putImageData(imageData, 0, 0); }
      if (ev & EVENT_AUDIO_BUFFER_FULL) pushAudio();
      if (ev & EVENT_UNTIL_TICKS) break;
    }
    if (Module._emulator_was_ext_ram_updated(e)) sramDirty = true;
    leftoverTicks = (Module._emulator_get_ticks_f64(e) - until) | 0;
    lastTickSec = nowSec;
  }
  const tickerSource = `
    let id = null;
    self.onmessage = (e) => {
      if (e.data === 'start' && id == null) id = setInterval(() => postMessage(0), 16);
      else if (e.data === 'stop')           { clearInterval(id); id = null; }
    };
  `;
  const tickerUrl = URL.createObjectURL(new Blob([tickerSource], { type: "application/javascript" }));
  const ticker = new Worker(tickerUrl);
  ticker.onmessage = step;
  ticker.postMessage("start");
  window.addEventListener("pagehide", () => ticker.postMessage("stop"));
  logOk("emulator running");

  // --- debounced SRAM commit ---
  if (saveDb) {
    setInterval(async () => {
      if (!sramDirty) return;
      sramDirty = false;
      try { await idbPut(saveDb, romHash, extractSram()); }
      catch (err) { logErr("SRAM save failed: " + err); sramDirty = true; }
    }, 2000);
    window.addEventListener("pagehide", () => { if (sramDirty) { try { idbPut(saveDb, romHash, extractSram()); } catch {} }});
  }

  // --- keyboard (ignore text inputs) ---
  const keyMap = {
    ArrowDown: "_set_joyp_down", ArrowUp: "_set_joyp_up",
    ArrowLeft: "_set_joyp_left", ArrowRight: "_set_joyp_right",
    KeyZ: "_set_joyp_B", KeyX: "_set_joyp_A",
    Enter: "_set_joyp_start", Tab: "_set_joyp_select",
  };
  const isTextTarget = t => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  window.addEventListener("keydown", ev => { if (isTextTarget(ev.target)) return; const fn = keyMap[ev.code]; if (fn) { Module[fn](e, true); ev.preventDefault(); } });
  window.addEventListener("keyup",   ev => { if (isTextTarget(ev.target)) return; const fn = keyMap[ev.code]; if (fn) { Module[fn](e, false); ev.preventDefault(); } });

  // --- compute emulator max-height from actual layout ---
  // CSS can't model the real chrome (nav + step padding + frame chrome +
  // gap + gamepad) reliably across devices, so measure it and publish a
  // CSS var the canvas can clamp against.
  const playGameEl = document.querySelector(".play-game");
  const gamepadEl = document.querySelector(".gamepad");
  const screenFrameEl = document.querySelector(".screen-frame");
  const canvasEl = document.querySelector("#screen");
  const doMeasure = () => {
    if (!playGameEl || !gamepadEl || !screenFrameEl || !canvasEl) return;
    // Only active when play step is live (mobile layout + visible).
    if (playGameEl.offsetParent === null || getComputedStyle(gamepadEl).display === "none") {
      document.documentElement.style.removeProperty("--emu-max-h");
      return;
    }
    const vh = window.innerHeight;
    const pgTop = playGameEl.getBoundingClientRect().top;
    const gpH = gamepadEl.offsetHeight;
    // Chrome inside screen-frame = frame minus canvas.
    const frameChrome = screenFrameEl.offsetHeight - canvasEl.offsetHeight;
    // Size play-game to exactly fill from its top to the viewport bottom,
    // so margin-top:auto on the gamepad actually anchors to viewport
    // bottom (not some guessed offset).
    const pgH = Math.max(240, vh - pgTop);
    document.documentElement.style.setProperty("--play-game-h", `${pgH}px`);
    const budget = Math.max(120, pgH - gpH - 14 - frameChrome);
    document.documentElement.style.setProperty("--emu-max-h", `${budget}px`);
  };
  // Defer to next frame so layout is settled after attribute/CSS changes.
  const updateEmuMaxH = () => requestAnimationFrame(() => requestAnimationFrame(doMeasure));
  window.__updateEmuMaxH = updateEmuMaxH;
  updateEmuMaxH();
  window.addEventListener("resize", updateEmuMaxH);
  window.addEventListener("orientationchange", updateEmuMaxH);
  new MutationObserver(updateEmuMaxH).observe(document.body, { attributes: true, attributeFilter: ["data-step"], subtree: true });

  // --- on-screen gamepad (touch + mouse for desktop testing) ---
  document.querySelectorAll(".gp-btn[data-input]").forEach(btn => {
    const input = btn.dataset.input;
    const fn = `_set_joyp_${input}`;
    const press = (ev) => { ev.preventDefault(); Module[fn](e, true);  btn.dataset.held = "1"; };
    const release = (ev) => { ev.preventDefault(); Module[fn](e, false); btn.dataset.held = "0"; };
    btn.addEventListener("touchstart", press,   { passive: false });
    btn.addEventListener("touchend",   release, { passive: false });
    btn.addEventListener("touchcancel",release, { passive: false });
    btn.addEventListener("mousedown",  press);
    btn.addEventListener("mouseup",    release);
    btn.addEventListener("mouseleave", release);
    // Prevent the default button context menu (long-press on iOS).
    btn.addEventListener("contextmenu", ev => ev.preventDefault());
  });

  // --- populate session + artifact UI ---
  if (STATE.hosted) $("#sess-server").value = `${STATE.hosted.host}:${STATE.hosted.port}`;
  if (STATE.slotName) $("#sess-slot").value = STATE.slotName;
  const links = $("#session-links");
  links.innerHTML = "";
  const addLink = (href, label, kind = "external", download = null) => {
    const a = document.createElement("a");
    a.href = href; a.target = "_blank"; a.rel = "noopener";
    if (kind === "download") { a.dataset.kind = "download"; if (download) a.download = download; }
    a.textContent = label;
    links.appendChild(a);
  };
  if (STATE.hosted) addLink(STATE.hosted.room_url, "archipelago.gg room");
  const artifacts = STATE.artifacts || {};
  const blobUrl = (name) => URL.createObjectURL(new Blob([artifacts[name]], { type: "application/octet-stream" }));
  const patch = Object.keys(artifacts).find(isPatchName);
  const spoil = Object.keys(artifacts).find(n => n.endsWith("_Spoiler.txt"));
  const multi = Object.keys(artifacts).find(n => n.endsWith(".archipelago"));
  if (patch) addLink(blobUrl(patch), "patch (.apcrystal)", "download", patch);
  if (multi) addLink(blobUrl(multi), "multidata", "download", multi);
  if (spoil) addLink(blobUrl(spoil), "spoiler log", "download", spoil);

  // --- b64 helpers for protocol ---
  const b64enc = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); };
  const b64dec = (str)   => { const s = atob(str); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };

  function serviceRequest(req) {
    switch (req.type) {
      case "PING":                 return { type: "PONG" };
      case "SYSTEM":               return { type: "SYSTEM_RESPONSE", value: "GBC" };
      case "PREFERRED_CORES":      return { type: "PREFERRED_CORES_RESPONSE", value: {} };
      case "HASH":                 return { type: "HASH_RESPONSE", value: romHash };
      case "MEMORY_SIZE":          return { type: "MEMORY_SIZE_RESPONSE", value: DOMAIN_SIZE[req.domain] ?? 0 };
      case "LOCK":                 return { type: "LOCKED" };
      case "UNLOCK":               return { type: "UNLOCKED" };
      case "DISPLAY_MESSAGE":      logLine("info", "[game] " + req.message); return { type: "DISPLAY_MESSAGE_RESPONSE" };
      case "PRINTJSON":            logLine("chat", "» " + req.text); return { type: "PRINTJSON_ACK" };
      case "SET_MESSAGE_INTERVAL": return { type: "SET_MESSAGE_INTERVAL_RESPONSE" };
      case "GUARD": {
        const expected = b64dec(req.expected_data);
        const actual = readDomain(req.domain, req.address, expected.length);
        let ok = true;
        for (let i = 0; i < expected.length; i++) if (expected[i] !== actual[i]) { ok = false; break; }
        return { type: "GUARD_RESPONSE", value: ok, address: req.address };
      }
      case "READ": return { type: "READ_RESPONSE", value: b64enc(readDomain(req.domain, req.address, req.size)) };
      case "WRITE": writeDomain(req.domain, req.address, b64dec(req.value)); return { type: "WRITE_RESPONSE" };
      default: return { type: "ERROR", err: "Unknown command: " + req.type };
    }
  }

  // --- BizHawk protocol is served by the Pyodide worker via postMessage ---
  // Wire the handler once per page; the worker posts "bh-req" events with
  // newline-delimited BizHawk frames ("VERSION", or a JSON list).
  apWorker.setBhHandler((reqId, payload) => {
    // payload is the raw string CommonClient would have sent over TCP.
    let responseJson;
    if (payload.trim() === "VERSION") {
      responseJson = "1";  // expected by get_script_version; parsed as int().
    } else {
      try {
        const reqs = JSON.parse(payload);
        const reses = reqs.map(r => {
          try { return serviceRequest(r); }
          catch (err) { return { type: "ERROR", err: String(err) }; }
        });
        responseJson = JSON.stringify(reses);
      } catch (err) {
        responseJson = JSON.stringify([{ type: "ERROR", err: String(err) }]);
      }
    }
    apWorker.sendBhResponse(reqId, responseJson);
  });

  apWorker.setPrintHandler((text) => logLine("chat", "» " + text));

  async function connectSession() {
    const server = $("#sess-server").value.trim();
    const slot   = $("#sess-slot").value.trim();
    const pw     = $("#sess-pw").value;
    if (!server || !slot) { logErr("server and slot are required"); return; }
    setSessionState("connecting", "connecting…");
    $("#btn-connect").disabled = true;
    $("#btn-disconnect").disabled = false;
    ["sess-server", "sess-slot", "sess-pw"].forEach(id => $("#" + id).readOnly = true);
    logOk(`connecting session for ${slot}@${server}`);
    try {
      await apWorker.startSession(server, slot, pw);
      setSessionState("live", slot);
      logOk(`session started`);
      // Persist whatever the user actually connected with so this seed auto-fills
      // the same values next time — both for manual-entry and overrides of the
      // archipelago.gg-hosted info. Passwords are intentionally not saved.
      const list = loadSessions();
      const entry = list.find(s => s.id === STATE.seedId);
      if (entry) {
        entry.slot = slot;
        const [h, portStr] = server.split(":");
        const port = Number(portStr);
        if (h && Number.isInteger(port)) {
          entry.hosted = { host: h, port, ws_url: `wss://${h}:${port}`, room_url: entry.hosted?.room_url || null };
        }
        saveSessions(list);
        STATE.slotName = slot;
        STATE.hosted = entry.hosted;
      }
    } catch (err) {
      setSessionState("error", "error");
      logErr("session start failed: " + (err.message || err));
      $("#btn-connect").disabled = false;
      $("#btn-disconnect").disabled = true;
      ["sess-server", "sess-slot", "sess-pw"].forEach(id => $("#" + id).readOnly = false);
    }
  }
  async function disconnectSession() {
    try { await apWorker.stopSession(); } catch {}
    setSessionState("idle", "disconnected");
    $("#btn-connect").disabled = false;
    $("#btn-disconnect").disabled = true;
    ["sess-server", "sess-slot", "sess-pw"].forEach(id => $("#" + id).readOnly = false);
  }

  $("#btn-connect").addEventListener("click", connectSession);
  $("#btn-disconnect").addEventListener("click", disconnectSession);

  // --- log toggle ---
  $("#log-toggle").addEventListener("click", () => {
    const wrap = $("#log-wrap");
    const btn = $("#log-toggle");
    const expanded = wrap.hidden;
    wrap.hidden = !expanded;
    btn.setAttribute("aria-expanded", String(expanded));
    btn.querySelector(".chev").textContent = expanded ? "−" : "+";
    if (expanded) wrap.scrollTop = wrap.scrollHeight;
  });

  // --- expose for console poking ---
  STATE.emulator = { e, Module, readMem, writeMem, guardedWrite, readDomain, writeDomain, romHash };
  window.ap = {
    e, Module, readMem, writeMem, guardedWrite, readDomain, writeDomain, romHash,
    RAM, WRAM_BASE,
  };
  log("ready · enter session details and Connect");
}
