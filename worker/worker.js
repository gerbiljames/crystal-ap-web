/**
 * Cloudflare Worker: proxy for the archipelago.gg upload step.
 *
 * The browser can't POST cross-origin to archipelago.gg/uploads because that
 * origin doesn't send CORS headers. This Worker runs at our edge, takes the
 * multidata POST from the browser, forwards it to archipelago.gg, and returns
 * the resulting room info as JSON.
 *
 * Deploy:
 *   npm i -g wrangler
 *   wrangler deploy
 * (see wrangler.toml next to this file)
 */

const WEBHOST_BASE = "https://archipelago.gg";
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age":       "86400",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method === "GET") {
      return json({ ok: true, endpoint: "POST multidata bytes here", version: 1 });
    }
    if (request.method !== "POST") {
      return json({ error: "POST a .archipelago body" }, 405);
    }
    try {
      const multidata = await request.arrayBuffer();
      if (multidata.byteLength === 0)  return json({ error: "empty body" }, 400);
      if (multidata.byteLength > 10 << 20) return json({ error: "multidata too large" }, 413);
      const room = await uploadAndHost(multidata);
      return json(room);
    } catch (err) {
      return json({ error: String(err.message || err) }, 502);
    }
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function uploadAndHost(multidata) {
  // WebHost bounces us through a session cookie, so use a CookieJar equivalent.
  const jar = new CookieJar();

  // Step 1: POST /uploads (multipart) → 302 to /seed/<uuid>
  const form = new FormData();
  form.append("file", new Blob([multidata], { type: "application/octet-stream" }), "seed.archipelago");
  const r1 = await jar.fetch(`${WEBHOST_BASE}/uploads`, { method: "POST", body: form, redirect: "manual" });
  if (!(r1.status >= 300 && r1.status < 400)) {
    throw new Error(`upload failed: HTTP ${r1.status}`);
  }
  const seedMatch = /\/seed\/([\w-]+)/.exec(r1.headers.get("Location") || "");
  if (!seedMatch) throw new Error("upload did not redirect to /seed/");
  const seedId = seedMatch[1];

  // Step 2: GET /new_room/<seedId> → 302 to /room/<roomId>
  const r2 = await jar.fetch(`${WEBHOST_BASE}/new_room/${seedId}`, { redirect: "manual" });
  if (!(r2.status >= 300 && r2.status < 400)) {
    throw new Error(`new_room failed: HTTP ${r2.status}`);
  }
  const roomMatch = /\/room\/([\w-]+)/.exec(r2.headers.get("Location") || "");
  if (!roomMatch) throw new Error("new_room did not redirect to /room/");
  const roomId = roomMatch[1];

  // Step 3: GET /room/<roomId> and poll until a port is assigned. WebHost
  // spins up a MultiServer lazily on first hit and re-renders with the port.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const r3 = await jar.fetch(`${WEBHOST_BASE}/room/${roomId}`);
    const html = await r3.text();
    const portMatch = /\/connect\s+([\w.-]+):(\d+)/.exec(html);
    if (portMatch) {
      const host = portMatch[1], port = Number(portMatch[2]);
      return {
        seed_id:  seedId,
        room_id:  roomId,
        room_url: `${WEBHOST_BASE}/room/${roomId}`,
        ws_url:   `wss://${host}:${port}`,
        host, port,
      };
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error("timed out waiting for room port");
}

/**
 * Minimal cookie jar. WebHost uses a session cookie to track ownership across
 * the three requests; without one we'd get a fresh session each hop.
 */
class CookieJar {
  constructor() { this.cookies = new Map(); }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  consume(setCookies) {
    for (const h of setCookies) {
      // "key=val; Path=/; ..." — we only care about key=val.
      const kv = h.split(";")[0];
      const eq = kv.indexOf("=");
      if (eq > 0) this.cookies.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }
  }
  async fetch(url, init = {}) {
    const headers = new Headers(init.headers || {});
    const cookie = this.header();
    if (cookie) headers.set("Cookie", cookie);
    const resp = await fetch(url, { ...init, headers });
    // Workers expose Set-Cookie via getSetCookie() (Response.headers).
    const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
    this.consume(setCookies);
    return resp;
  }
}
