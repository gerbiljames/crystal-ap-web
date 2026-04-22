// archipelago.gg upload via our Cloudflare Worker proxy (CORS workaround).
// Returns {room_url, ws_url, host, port} on success, null on any failure.

import { GEN_BASE } from "./constants.js";
import { logWarn } from "./log.js";

export async function tryHostMultidata(multidataBytes) {
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
