// BizHawk protocol bridge. CommonClient on the worker side speaks the
// BizHawk JSON protocol (newline-delimited) to talk to a connector. We
// run no actual TCP socket; instead the worker posts "bh-req" events over
// postMessage with the raw string, we parse + service them against the
// live emulator, and respond in kind.

import { logLine } from "./log.js";

const b64enc = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); };
const b64dec = (str)   => { const s = atob(str); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };

// emu is the emulator handle returned by bootEmulator: needs romHash,
// readDomain, writeDomain, DOMAIN_SIZE. apWorker is the Pyodide worker
// wrapper from lib/ap-worker.js.
export function installBizHawkBridge(emu, apWorker) {
  const { romHash, readDomain, writeDomain, DOMAIN_SIZE } = emu;

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
      case "READ":  return { type: "READ_RESPONSE", value: b64enc(readDomain(req.domain, req.address, req.size)) };
      case "WRITE": writeDomain(req.domain, req.address, b64dec(req.value)); return { type: "WRITE_RESPONSE" };
      default:      return { type: "ERROR", err: "Unknown command: " + req.type };
    }
  }

  apWorker.setBhHandler((reqId, payload) => {
    // payload is the raw string CommonClient would have sent over TCP.
    let responseJson;
    if (payload.trim() === "VERSION") {
      responseJson = "1";  // expected by get_script_version; parsed as int().
    } else {
      try {
        const reqs = JSON.parse(payload);
        // Match connector_bizhawk_generic.lua: process requests in order and,
        // once any GUARD fails, skip every remaining request (echoing the
        // failed GUARD_RESPONSE) instead of executing it. Without this the
        // WRITEs in a guarded_write run unconditionally, so a stale write
        // clobbers memory the game changed between the client's read and write.
        const reses: any[] = [];
        let failedGuard: any = null;
        for (const r of reqs) {
          if (failedGuard !== null) { reses.push(failedGuard); continue; }
          let res;
          try { res = serviceRequest(r); }
          catch (err) { res = { type: "ERROR", err: String(err) }; }
          reses.push(res);
          if (res.type === "GUARD_RESPONSE" && !res.value) failedGuard = res;
        }
        responseJson = JSON.stringify(reses);
      } catch (err) {
        responseJson = JSON.stringify([{ type: "ERROR", err: String(err) }]);
      }
    }
    apWorker.sendBhResponse(reqId, responseJson);
  });

  apWorker.setPrintHandler((text) => logLine("chat", "» " + text));
}
