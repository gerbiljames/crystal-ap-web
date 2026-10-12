// Discord sign-in (OAuth2 authorization code flow) and the signed cookie that
// remembers who someone is afterwards. No server-side session store: the
// cookie carries the Discord id and an expiry, signed with SESSION_SECRET.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Config } from "./config.ts";
import type { PublicUser } from "../../shared/protocol.ts";

const COOKIE = "yogos_session";
const STATE_COOKIE = "yogos_oauth_state";
const SESSION_DAYS = 30;

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    // A malformed escape (a stray %) in some other cookie on the domain must
    // not take the request, or the server, down with it.
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { /* ignore that cookie */ }
  }
  return out;
}

function cookie(config: Config, name: string, value: string, maxAgeSec: number): string {
  const secure = config.publicUrl.protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function verify(secret: string, signed: string | undefined): string | null {
  if (!signed) return null;
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const payload = signed.slice(0, i);
  const mac = Buffer.from(signed.slice(i + 1));
  const want = Buffer.from(sign(secret, payload));
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return null;
  return payload;
}

export function sessionCookie(config: Config, userId: string): string {
  const expires = Date.now() + SESSION_DAYS * 86400_000;
  const payload = `${userId}.${expires}`;
  return cookie(config, COOKIE, `${payload}.${sign(config.sessionSecret, payload)}`, SESSION_DAYS * 86400);
}

export function clearSessionCookie(config: Config): string {
  return cookie(config, COOKIE, "", 0);
}

// The signed-in Discord id, or null.
export function userIdFrom(config: Config, req: IncomingMessage): string | null {
  const payload = verify(config.sessionSecret, parseCookies(req)[COOKIE]);
  if (!payload) return null;
  const [id, expires] = payload.split(".");
  if (!id || !(Number(expires) > Date.now())) return null;
  return id;
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------
function redirectUri(config: Config) {
  return new URL("/api/auth/callback", config.publicUrl).toString();
}

// Where the sign-in starts, plus the state cookie that ties the callback to it.
export function beginLogin(config: Config): { location: string; setCookie: string } {
  const state = randomBytes(16).toString("hex");
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", config.discord.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri(config));
  url.searchParams.set("scope", config.discord.guildId ? "identify guilds" : "identify");
  url.searchParams.set("state", state);
  const signed = `${state}.${sign(config.sessionSecret, state)}`;
  return { location: url.toString(), setCookie: cookie(config, STATE_COOKIE, signed, 600) };
}

export class AuthError extends Error {}

// When a Discord account was created: its id's top bits are milliseconds
// since the start of 2015.
export function discordCreatedAt(id: string): number {
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}

// Finish the sign-in: check the state, trade the code for a token, and look
// the user up. Resolves to the Discord user.
export async function completeLogin(config: Config, req: IncomingMessage, query: URLSearchParams): Promise<PublicUser> {
  const state = verify(config.sessionSecret, parseCookies(req)[STATE_COOKIE]);
  if (!state || state !== query.get("state")) throw new AuthError("the sign-in expired or came from somewhere else — try again");
  const code = query.get("code");
  if (!code) throw new AuthError(query.get("error_description") || "Discord didn't sign you in");

  const tokenRes = await discord("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.discord.clientId,
      client_secret: config.discord.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(config),
    }),
  });
  if (!tokenRes.ok) throw new AuthError(`Discord rejected the sign-in (${tokenRes.status})`);
  const token = await tokenRes.json() as { access_token: string; token_type: string };
  const auth = { authorization: `${token.token_type} ${token.access_token}` };

  const meRes = await discord("https://discord.com/api/users/@me", { headers: auth });
  if (!meRes.ok) throw new AuthError(`couldn't read your Discord profile (${meRes.status})`);
  const me = await meRes.json() as { id: string; username: string; global_name?: string | null; avatar?: string | null };

  const before = config.discord.createdBefore;
  if (before !== null && !(/^\d+$/.test(me.id) && discordCreatedAt(me.id) < before)) {
    throw new AuthError(`this event is only open to Discord accounts made before ${new Date(before).toUTCString()}`);
  }

  if (config.discord.guildId) {
    const guildsRes = await discord("https://discord.com/api/users/@me/guilds", { headers: auth });
    if (!guildsRes.ok) throw new AuthError(`couldn't check your Discord servers (${guildsRes.status})`);
    const guilds = await guildsRes.json() as { id: string }[];
    if (!guilds.some((g) => g.id === config.discord.guildId)) throw new AuthError("this event is only open to members of its Discord server");
  }

  return {
    id: me.id,
    name: me.global_name || me.username,
    avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null,
  };
}

// A Discord API call that gives up rather than leave a sign-in hanging.
async function discord(url: string, init: RequestInit): Promise<Response> {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(10000) }); }
  catch { throw new AuthError("Discord didn't answer — try signing in again"); }
}

export function clearStateCookie(config: Config): string {
  return cookie(config, STATE_COOKIE, "", 0);
}
