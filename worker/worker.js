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
const MAX_BODY = 10 << 20;
// Pages that may call this Worker. Browsers send Origin on cross-origin
// POSTs, so this stops other sites from spending our archipelago.gg room
// quota through visitors' browsers. It doesn't stop a script that forges
// the header; the HOST_LIMITER rate limit (wrangler.toml) covers that.
// Override with a comma-separated ALLOWED_ORIGINS var.
const DEFAULT_ORIGINS = [
  "https://gerbiljames.github.io",
  "http://localhost:8765",
  "http://127.0.0.1:8765",
  "http://127.0.0.1:4173",   // vite preview
  "http://localhost:4173",
];
// Workers on the Free plan get 50 subrequests per invocation: 2 to upload
// and create the room leaves room for this many polls of the room page.
const MAX_POLLS = 40;
const POLL_MS = 1500;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin":  origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age":       "86400",
    "Vary":                         "Origin",
  };
}

export default {
  async fetch(request, env = {}) {
    const allowed = env.ALLOWED_ORIGINS
      ? env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
      : DEFAULT_ORIGINS;
    const origin = request.headers.get("Origin");
    const cors = origin && allowed.includes(origin) ? corsHeaders(origin) : {};
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...cors },
    });

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method === "GET") {
      return json({ ok: true, endpoint: "POST multidata bytes here", version: 1 });
    }
    if (request.method !== "POST") {
      return json({ error: "POST a .archipelago body" }, 405);
    }
    if (!origin || !allowed.includes(origin)) {
      // With CORS headers, so a page that isn't listed (a new dev port) sees
      // this message instead of an opaque "Failed to fetch".
      return new Response(JSON.stringify({ error: `origin ${origin || "(none)"} not allowed` }), {
        status: 403,
        headers: { "Content-Type": "application/json", ...(origin ? corsHeaders(origin) : {}) },
      });
    }
    if (env.HOST_LIMITER) {
      const key = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.HOST_LIMITER.limit({ key });
      if (!success) return json({ error: "too many rooms requested — try again in a minute" }, 429);
    }
    // Refuse oversized bodies before buffering them.
    const declared = Number(request.headers.get("Content-Length"));
    if (declared > MAX_BODY) return json({ error: "multidata too large" }, 413);
    try {
      const multidata = await request.arrayBuffer();
      if (multidata.byteLength === 0)  return json({ error: "empty body" }, 400);
      if (multidata.byteLength > MAX_BODY) return json({ error: "multidata too large" }, 413);
      const room = await uploadAndHost(multidata);
      return json(room);
    } catch (err) {
      return json({ error: String(err.message || err) }, 502);
    }
  },
};

// WebHost reports a rejected upload as a 200 page carrying flash messages.
function flashMessages(html) {
  const out = [];
  const re = /<div class="user-message">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const text = m[1].replace(/<[^>]*>/g, "").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  }
  return out;
}

async function uploadAndHost(multidata) {
  // WebHost bounces us through a session cookie, so use a CookieJar equivalent.
  const jar = new CookieJar();

  // Step 1: POST /uploads (multipart) → 302 to /seed/<uuid>
  const form = new FormData();
  form.append("file", new Blob([multidata], { type: "application/octet-stream" }), "seed.archipelago");
  const r1 = await jar.fetch(`${WEBHOST_BASE}/uploads`, { method: "POST", body: form, redirect: "manual" });
  if (!(r1.status >= 300 && r1.status < 400)) {
    const reasons = r1.ok ? flashMessages(await r1.text()) : [];
    throw new Error(reasons.length ? `archipelago.gg rejected the upload: ${reasons.join("; ")}` : `upload failed: HTTP ${r1.status}`);
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
  const roomUrl = `${WEBHOST_BASE}/room/${roomId}`;

  // Step 3: GET /room/<roomId> and poll until a port is assigned. WebHost
  // spins up a MultiServer lazily on first hit and re-renders with the port.
  // Only the quoted '/connect host:port' WebHost itself renders counts, and
  // only for an archipelago.gg host: other page text (player names) can
  // contain a /connect of its own.
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    if (poll) await new Promise((r) => setTimeout(r, POLL_MS));
    const r3 = await jar.fetch(roomUrl);
    if (r3.status === 404) throw new Error(`room ${roomId} not found`);
    if (!r3.ok) continue;  // transient upstream error: poll again
    const html = await r3.text();
    const portMatch = /'\/connect\s+((?:[\w-]+\.)*archipelago\.gg):(\d+)'/.exec(html);
    if (portMatch) {
      const host = portMatch[1], port = Number(portMatch[2]);
      return {
        seed_id:  seedId,
        room_id:  roomId,
        room_url: roomUrl,
        ws_url:   `wss://${host}:${port}`,
        host, port,
      };
    }
    if (html.includes("There was an error hosting this Room")) {
      throw new Error(`archipelago.gg couldn't start the room — see ${roomUrl}`);
    }
  }
  throw new Error(`timed out waiting for the room's port — it may still come up at ${roomUrl}`);
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
