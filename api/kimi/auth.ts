/**
 * Kimi platform OAuth — callback handler + session authentication.
 *
 * Flow (browser): Login.tsx builds
 *   {VITE_KIMI_AUTH_URL}/api/oauth/authorize?client_id={VITE_APP_ID}
 *     &redirect_uri={origin}/api/oauth/callback&response_type=code&scope=profile
 *     &state=base64(redirectUri)
 * and the platform redirects back here with ?code=&state=.
 *
 * This handler exchanges the authorization code for an access token, fetches
 * the platform profile, upserts the local `users` row (keyed by `unionId`),
 * then issues a signed session JWT in the `kimi_sid` cookie.
 *
 * ASSUMPTIONS (the platform's exact endpoints are not part of this repo):
 *  - POST {KIMI_AUTH_URL}/api/oauth/token accepts JSON
 *      { grant_type: "authorization_code", client_id, code, redirect_uri }
 *    and returns { access_token }.
 *  - GET  {KIMI_AUTH_URL}/api/oauth/userinfo with
 *      Authorization: Bearer <access_token>
 *    returns { unionId | openId | sub, name?, email?, avatar? }.
 *  Override the base URL with KIMI_AUTH_URL (falls back to VITE_KIMI_AUTH_URL).
 *
 * Sessions are stateless: an HMAC-signed JWT (jose) carrying the numeric user
 * id as `sub`, verified on every request by authenticateRequest(). Sign with
 * SESSION_SECRET; a dev-only default is used when unset.
 */
import * as cookie from "cookie";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { SignJWT, jwtVerify } from "jose";
import { Session } from "@contracts/constants";
import * as schema from "@db/schema";
import type { User } from "@db/schema";
import { env } from "../lib/env";
import { getSessionCookieOptions } from "../lib/cookies";
import { getDb } from "../queries/connection";

const DEV_SECRET = "cloudtalk-dev-session-secret-do-not-use-in-prod";

function secretKey(): Uint8Array {
  const secret = env.sessionSecret ?? (env.isProduction ? undefined : DEV_SECRET);
  if (!secret) {
    throw new Error("SESSION_SECRET is required in production");
  }
  return new TextEncoder().encode(secret);
}

/**
 * Sign the stateless session JWT (HS256, sub = numeric user id, expiry per
 * Session.maxAgeMs). Shared by the Kimi OAuth callback and the env-based
 * password login (api/local-auth.ts) — both issue the same `kimi_sid` cookie.
 */
export async function issueSessionToken(userId: number): Promise<string> {
  return new SignJWT({ sub: String(userId) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${Session.maxAgeMs}ms`)
    .sign(secretKey());
}

/**
 * Resolve the session cookie → the DB user, or undefined when absent/invalid.
 * Used by createContext(); callers treat failure as "anonymous".
 */
export async function authenticateRequest(headers: Headers): Promise<User | undefined> {
  const raw = headers.get("cookie");
  if (!raw) return undefined;
  const token = cookie.parse(raw)[Session.cookieName];
  if (!token) return undefined;

  let userId: number;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    userId = Number(payload.sub);
    if (!Number.isFinite(userId)) return undefined;
  } catch {
    return undefined;
  }

  const rows = await getDb()
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return rows.at(0);
}

/* -------------------------------------------------------------------------- */
/* OAuth callback                                                              */
/* -------------------------------------------------------------------------- */

interface TokenResponse {
  access_token?: string;
  [k: string]: unknown;
}

interface PlatformProfile {
  unionId?: string;
  openId?: string;
  sub?: string;
  name?: string | null;
  email?: string | null;
  avatar?: string | null;
  [k: string]: unknown;
}

async function exchangeCode(code: string, redirectUri: string): Promise<PlatformProfile> {
  const base = env.kimiAuthUrl;
  if (!base) throw new Error("KIMI_AUTH_URL (or VITE_KIMI_AUTH_URL) is not configured");

  const tokenRes = await fetch(`${base}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: env.kimiAppId,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`OAuth token exchange failed: ${tokenRes.status}`);
  }
  const token = (await tokenRes.json()) as TokenResponse;
  if (!token.access_token) throw new Error("OAuth token exchange returned no access_token");

  const profileRes = await fetch(`${base}/api/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!profileRes.ok) {
    throw new Error(`OAuth userinfo failed: ${profileRes.status}`);
  }
  return (await profileRes.json()) as PlatformProfile;
}

async function upsertUser(profile: PlatformProfile): Promise<User> {
  const unionId = profile.unionId ?? profile.openId ?? profile.sub;
  if (!unionId) throw new Error("OAuth profile has no stable id (unionId/openId/sub)");

  const db = getDb();
  const existing = (
    await db.select().from(schema.users).where(eq(schema.users.unionId, unionId)).limit(1)
  ).at(0);
  if (existing) {
    await db
      .update(schema.users)
      .set({
        name: profile.name ?? existing.name,
        email: profile.email ?? existing.email,
        avatar: profile.avatar ?? existing.avatar,
        lastSignInAt: new Date(),
      })
      .where(eq(schema.users.id, existing.id));
    return { ...existing, lastSignInAt: new Date() };
  }
  const [r] = await db.insert(schema.users).values({
    unionId,
    name: profile.name ?? null,
    email: profile.email ?? null,
    avatar: profile.avatar ?? null,
  });
  const id = Number((r as unknown as { insertId: number }).insertId);
  const created = (
    await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1)
  ).at(0);
  if (!created) throw new Error("Failed to load freshly created user");
  return created;
}

/**
 * GET {Paths.oauthCallback} — completes the OAuth code exchange and issues the
 * session cookie, then redirects to the app root (state carries the original
 * redirect_uri as base64, per Login.tsx; it is validated but not required).
 */
export function createOAuthCallbackHandler() {
  return async (c: Context) => {
    const code = c.req.query("code");
    if (!code) return c.text("Missing OAuth code", 400);

    const state = c.req.query("state");
    let redirectUri = new URL(c.req.url).origin + "/api/oauth/callback";
    if (state) {
      try {
        const decoded = atob(state);
        if (/^https?:\/\//.test(decoded)) redirectUri = decoded;
      } catch {
        /* malformed state — fall back to the request origin */
      }
    }

    try {
      const profile = await exchangeCode(code, redirectUri);
      const user = await upsertUser(profile);
      const token = await issueSessionToken(user.id);
      const opts = getSessionCookieOptions(c.req.raw.headers);
      c.header(
        "set-cookie",
        cookie.serialize(Session.cookieName, token, {
          httpOnly: opts.httpOnly,
          path: opts.path,
          sameSite: opts.sameSite.toLowerCase() as "lax" | "none",
          secure: opts.secure,
          maxAge: Math.floor(Session.maxAgeMs / 1000),
        }),
      );
      return c.redirect("/");
    } catch (err) {
      console.error("[oauth] callback failed:", err);
      return c.text("Authentication failed", 502);
    }
  };
}
