// Binjgb emulator: ROM load, memory helpers, audio, run loop, SRAM
// persistence, and keyboard input. The caller owns the canvas element and
// the SRAM IDB; everything else is encapsulated here.
//
// `Binjgb` is a global set by the binjgb.js <script> tag in index.html.

/* global Binjgb */

import { idbGet, idbPut } from "./idb.js";
import { STATE_STORE } from "./constants.js";
import { log, logOk, logErr, logWarn } from "./log.js";
import { getAudioContext } from "./audio.js";

const EVENT_NEW_FRAME = 1, EVENT_AUDIO_BUFFER_FULL = 2, EVENT_UNTIL_TICKS = 4;
const CPU_TICKS_PER_SECOND = 4194304;
const MAX_UPDATE_SEC = 5 / 60;
const AUDIO_LATENCY_SEC = 0.1;
const AUDIO_FRAMES = 4096;
const CGB_COLOR_CURVE = 2;

export interface EmulatorHandle {
  e: number;
  Module: any;
  readMem: (addr: number, len?: number) => Uint8Array;
  writeMem: (addr: number, bytes: Uint8Array) => void;
  guardedWrite: (guardAddr: number, expected: Uint8Array, writeAddr: number, bytes: Uint8Array) => boolean;
  readDomain: (domain: string, addr: number, sz: number) => Uint8Array;
  writeDomain: (domain: string, addr: number, bytes: Uint8Array) => void;
  romHash: string;
  DOMAIN_SIZE: Record<string, number>;
  setVolume: (v: number) => void;
}

export interface BootEmulatorOptions {
  canvas: HTMLCanvasElement;
  romBuf: ArrayBuffer;
  saveDb: IDBDatabase | null;
}

export async function bootEmulator({ canvas, romBuf, saveDb }: BootEmulatorOptions): Promise<EmulatorHandle | null> {
  log("booting binjgb…");
  const Module = await Binjgb();

  // Hash the ROM for SRAM keying (and to serve HASH requests).
  const romHashBuf = await crypto.subtle.digest("SHA-1", romBuf);
  const romHash = [...new Uint8Array(romHashBuf)].map(b => b.toString(16).padStart(2,"0").toUpperCase()).join("");

  // Allocate & copy into wasm heap.
  const size = (romBuf.byteLength + 0x7fff) & ~0x7fff;
  const romPtr = Module._malloc(size);
  new Uint8Array(Module.HEAP8.buffer, romPtr, size).fill(0).set(new Uint8Array(romBuf));

  // Shared AudioContext, primed on the first user gesture in the tab
  // (see lib/audio.ts). Already running by the time we get here, so
  // there's no silent window before the first emulator input.
  const audioCtx = getAudioContext();
  const e = Module._emulator_new_simple(romPtr, size, audioCtx.sampleRate, AUDIO_FRAMES, CGB_COLOR_CURVE);
  if (e === 0) { logErr("invalid ROM (binjgb rejected it)"); return null; }

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
  const fbPtr = Module._get_frame_buffer_ptr(e);
  const fbSize = Module._get_frame_buffer_size(e);
  const fbView = new Uint8Array(Module.HEAP8.buffer, fbPtr, fbSize);
  const ctx2d = canvas.getContext("2d");
  const imageData = ctx2d.createImageData(160, 144);

  // --- audio ---
  // AudioContext is primed by lib/audio.ts on the first user gesture. If
  // the user somehow reaches play before any gesture (unlikely — they had
  // to click through dropzones etc.), pushAudio waits for state==running.
  const audioBufPtr  = Module._get_audio_buffer_ptr(e);
  const audioBufCap  = Module._get_audio_buffer_capacity(e);
  let audioStartSec = 0;
  let audioVolume  = 0.5;
  let audioMuted   = false;

  function pushAudio() {
    if (audioCtx.state !== "running") return;
    const srcBuf = new Uint8Array(Module.HEAP8.buffer, audioBufPtr, audioBufCap);
    const now = audioCtx.currentTime;
    const nowPlusLatency = now + AUDIO_LATENCY_SEC;
    audioStartSec = audioStartSec || nowPlusLatency;
    if (audioStartSec < now) audioStartSec = nowPlusLatency;
    const buffer = audioCtx.createBuffer(2, AUDIO_FRAMES, audioCtx.sampleRate);
    const c0 = buffer.getChannelData(0);
    const c1 = buffer.getChannelData(1);
    const gain = audioMuted ? 0 : audioVolume;
    // Binjgb outputs 8-bit unsigned stereo interleaved. Divide-by-255 (no
    // -128 centering) matches the reference demo — the DC offset is
    // inaudible.
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

  const setVolume = (v) => { audioVolume = v; audioMuted = v === 0; };

  // --- SRAM + savestate persistence ---
  // SRAM (cart battery) and the binjgb savestate (CPU/VRAM/WRAM/APU/…) are
  // serialised separately by binjgb, so we persist both. SRAM alone lets the
  // user download a vanilla .sav; the savestate is what actually resumes them
  // mid-step, mid-battle, mid-dialogue.
  //
  // Both file_data buffers are allocated once and reused — the wasm heap is
  // fixed at 16MB and mallocing ~200KB savestate buffers every 2s fragments
  // it into OOM within a few minutes.
  const sramFd  = Module._ext_ram_file_data_new(e);
  const stateFd = Module._state_file_data_new(e);

  const extractSram = () => {
    Module._emulator_write_ext_ram(e, sramFd);
    const p = Module._get_file_data_ptr(sramFd);
    const l = Module._get_file_data_size(sramFd);
    return new Uint8Array(Module.HEAP8.buffer, p, l).slice();
  };
  const loadSram = (bytes) => {
    const l = Module._get_file_data_size(sramFd);
    if (bytes.length !== l) { logWarn("save size mismatch, skipping load"); return; }
    new Uint8Array(Module.HEAP8.buffer, Module._get_file_data_ptr(sramFd), l).set(bytes);
    Module._emulator_read_ext_ram(e, sramFd);
  };
  const extractState = () => {
    Module._emulator_write_state(e, stateFd);
    const p = Module._get_file_data_ptr(stateFd);
    const l = Module._get_file_data_size(stateFd);
    return new Uint8Array(Module.HEAP8.buffer, p, l).slice();
  };
  const loadState = (bytes) => {
    const l = Module._get_file_data_size(stateFd);
    // State size is binjgb-version sensitive — mismatch means a build bump
    // happened between sessions, so drop it rather than corrupt the emulator.
    if (bytes.length !== l) { logWarn("savestate size mismatch, ignoring it"); return false; }
    new Uint8Array(Module.HEAP8.buffer, Module._get_file_data_ptr(stateFd), l).set(bytes);
    Module._emulator_read_state(e, stateFd);
    return true;
  };
  if (saveDb) {
    // Load SRAM first so the cart battery is populated for games that haven't
    // yet accumulated a savestate; if a savestate exists, applying it second
    // overwrites everything including cart RAM to the exact prior moment.
    const existingSram = await idbGet<ArrayBuffer>(saveDb, romHash).catch(() => null);
    if (existingSram) { loadSram(new Uint8Array(existingSram)); logOk(`loaded SRAM (${existingSram.byteLength} bytes) from prior session`); }
    else { log("fresh save slot"); }
    const existingState = await idbGet<ArrayBuffer>(saveDb, romHash, STATE_STORE).catch(() => null);
    if (existingState && loadState(new Uint8Array(existingState))) logOk("resumed from savestate");
  }

  // --- run loop ---
  // Driven by a Web Worker setInterval tick so the emulator keeps stepping
  // when the tab/window is hidden or unfocused (rAF is throttled/suspended
  // in the background; workers aren't). Canvas paints still piggyback on
  // the natural browser repaint cadence, which is all that matters
  // visually — and audio is gated separately in pushAudio.
  let lastTickSec = 0, leftoverTicks = 0, sramDirty = false, stateDirty = false;
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
    // Savestate always reflects current emulator state, so any tick that
    // advanced the emulator should schedule a rewrite.
    stateDirty = true;
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

  // --- debounced SRAM + savestate commit ---
  if (saveDb) {
    setInterval(async () => {
      if (sramDirty) {
        sramDirty = false;
        try { await idbPut(saveDb, romHash, extractSram()); }
        catch (err) { logErr("SRAM save failed: " + err); sramDirty = true; }
      }
      if (stateDirty) {
        stateDirty = false;
        try { await idbPut(saveDb, romHash, extractState(), STATE_STORE); }
        catch (err) { logErr("savestate save failed: " + err); stateDirty = true; }
      }
    }, 2000);
    window.addEventListener("pagehide", () => {
      try { if (sramDirty)  idbPut(saveDb, romHash, extractSram()); } catch {}
      try { if (stateDirty) idbPut(saveDb, romHash, extractState(), STATE_STORE); } catch {}
    });
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

  return {
    e, Module,
    readMem, writeMem, guardedWrite,
    readDomain, writeDomain,
    romHash,
    DOMAIN_SIZE,
    setVolume,
  };
}
