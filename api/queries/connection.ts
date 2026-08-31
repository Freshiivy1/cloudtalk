/**
 * Shared MySQL (mysql2) connection pool + Drizzle handle.
 *
 * Every router/service module imports lazily (never at module top level) so
 * importing the router graph in tests/tools does not require a live database —
 * the pool is only created on first use.
 *
 * Connection string: DATABASE_URL (mysql://user:pass@host:port/db), loaded
 * from .env via dotenv. This is the single source of truth also used by
 * drizzle.config.ts and db/seed.ts.
 *
 * Resilience contract:
 * - `getDb()` keeps the historical behavior for DB-required modules and throws
 *   when DATABASE_URL is missing.
 * - `getDbOrNull()` is the safe path for user-facing telephony routes: it
 *   returns null instead of throwing so real calls can proceed without history.
 */
import "dotenv/config";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "@db/schema";

let pool: mysql.Pool | null = null;
let db: MySql2Database<typeof schema> | null = null;

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function getDb(): MySql2Database<typeof schema> {
  if (db) return db;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required (mysql://user:pass@host:port/database)",
    );
  }
  pool = mysql.createPool({
    uri: url,
    connectionLimit: 10,
    enableKeepAlive: true,
    // Bound the time a single query can spend waiting on a TCP connect. With a
    // stale/unreachable DATABASE_URL (e.g. an expired external MySQL still set
    // in the dashboard while the app is meant to run in no-history mode) the
    // default 10s timeout makes every graceful-fallback op stall for seconds;
    // several sequential ops then exceed the platform proxy timeout and the
    // batched tRPC request surfaces as HTTP 5xx even though the code "handles"
    // the missing DB. 3s is still generous for a healthy MySQL.
    connectTimeout: 3000,
  });
  db = drizzle(pool, { schema, mode: "default" });
  return db;
}

/** Safe variant for optional-history paths: null when no DB is configured. */
export function getDbOrNull(): MySql2Database<typeof schema> | null {
  if (!hasDatabase()) return null;
  try {
    return getDb();
  } catch (err) {
    console.error("[db] connection unavailable:", err);
    return null;
  }
}

/** Graceful shutdown hook for scripts (seed, fire-test). */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}
