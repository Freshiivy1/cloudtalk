/**
 * Env-based username/password login — the off-platform fallback for the Kimi
 * OAuth flow (which only exists on the Kimi platform). When ADMIN_USERNAME and
 * ADMIN_PASSWORD are both set, the `auth.login` tRPC mutation accepts those
 * credentials and issues the exact same `kimi_sid` session JWT as the OAuth
 * callback (see api/kimi/auth.ts), backed by a `users` row whose unionId is
 * `local:<username>`.
 *
 * Both values are read from process.env at call time (not via lib/env) so
 * tests can mutate them per-case. The password is never logged and compared
 * in constant time (SHA-256 digests + timingSafeEqual) to blunt timing
 * side-channels; the username is compared the same way to avoid user
 * enumeration via early-exit timing.
 *
 * The env-configured account is provisioned with role "admin" on first login
 * (it is the deployment owner). Existing rows keep whatever role they have.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@db/schema";
import type { User } from "@db/schema";
import { getDb } from "./queries/connection";

export interface LocalAdminCredentials {
  username: string;
  password: string;
}

/** Returns the configured credentials, or undefined unless BOTH are non-empty. */
export function getLocalAdminCredentials(): LocalAdminCredentials | undefined {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return undefined;
  return { username, password };
}

export function isLocalLoginConfigured(): boolean {
  return getLocalAdminCredentials() !== undefined;
}

/**
 * Open-access mode: when AUTH_DISABLED=true the deployment shows NO login
 * page — every request is automatically authenticated as the owner account
 * (the env-configured admin username, or "owner"). Session checks, role
 * checks and auth.me all pass transparently.
 */
export function isAuthDisabled(): boolean {
  return (process.env.AUTH_DISABLED ?? "").toLowerCase() === "true";
}

/**
 * The user every request maps to in open-access mode. Upserts the backing
 * `users` row (role "admin") when the DB is reachable; otherwise returns a
 * synthetic admin so the UI still opens without a database.
 */
export async function getOpenAccessUser(): Promise<User> {
  const username = getLocalAdminCredentials()?.username ?? "owner";
  const unionId = localUnionId(username);
  const db = getDb();
  const existing = (
    await db.select().from(schema.users).where(eq(schema.users.unionId, unionId)).limit(1)
  ).at(0);
  if (existing) return existing;
  const [r] = await db.insert(schema.users).values({
    unionId,
    name: username,
    role: "admin",
  });
  const id = Number((r as unknown as { insertId: number }).insertId);
  const created = (
    await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1)
  ).at(0);
  if (!created) throw new Error("Failed to load freshly created user");
  return created;
}

/** Synthetic admin used by open-access mode when the database is unreachable. */
export function syntheticOpenAccessUser(): User {
  return {
    id: 0,
    unionId: localUnionId(getLocalAdminCredentials()?.username ?? "owner"),
    name: getLocalAdminCredentials()?.username ?? "owner",
    email: null,
    role: "admin",
    avatar: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastSignInAt: new Date(0),
  } as unknown as User;
}

/** Stable users.unionId for a locally authenticated account. */
export function localUnionId(username: string): string {
  return `local:${username}`;
}

/**
 * Constant-time string comparison. Inputs are hashed first so timingSafeEqual
 * always sees equal-length buffers (no length leak via early return).
 */
export function passwordsEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/**
 * Verify username+password against the env-configured credentials and, on
 * success, upsert the backing `users` row. Returns undefined for any
 * credential mismatch; callers are expected to have checked
 * isLocalLoginConfigured() first (this throws if unconfigured, as a
 * defense-in-depth guard against direct misuse).
 */
export async function verifyLocalLogin(
  username: string,
  password: string,
): Promise<User | undefined> {
  const creds = getLocalAdminCredentials();
  if (!creds) {
    throw new Error(
      "Password login is not configured (set ADMIN_USERNAME and ADMIN_PASSWORD)",
    );
  }

  const userOk = passwordsEqual(creds.username, username);
  const passOk = passwordsEqual(creds.password, password);
  if (!userOk || !passOk) return undefined;

  const db = getDb();
  const unionId = localUnionId(creds.username);
  const existing = (
    await db.select().from(schema.users).where(eq(schema.users.unionId, unionId)).limit(1)
  ).at(0);
  if (existing) {
    await db
      .update(schema.users)
      .set({ lastSignInAt: new Date() })
      .where(eq(schema.users.id, existing.id));
    return { ...existing, lastSignInAt: new Date() };
  }

  const [r] = await db.insert(schema.users).values({
    unionId,
    name: creds.username,
    role: "admin",
  });
  const id = Number((r as unknown as { insertId: number }).insertId);
  const created = (
    await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1)
  ).at(0);
  if (!created) throw new Error("Failed to load freshly created user");
  return created;
}
