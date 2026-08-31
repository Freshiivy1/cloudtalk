/**
 * Shared MySQL (mysql2) connection pool + Drizzle handle.
 *
 * Every router/service module imports `getDb()` lazily (never at module top
 * level) so importing the router graph in tests/tools does not require a live
 * database — the pool is only created on first use.
 *
 * Connection string: DATABASE_URL (mysql://user:pass@host:port/db), loaded
 * from .env via dotenv. This is the single source of truth also used by
 * drizzle.config.ts and db/seed.ts.
 */
import "dotenv/config";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "@db/schema";

let pool: mysql.Pool | null = null;
let db: MySql2Database<typeof schema> | null = null;
let isMock = false;

// Mock query builder that returns empty results for all operations
const mockDb = new Proxy({} as MySql2Database<typeof schema>, {
  get(_target, prop) {
    // Return a chainable mock for any property access
    const chainable = new Proxy(() => {}, {
      get() { return chainable; },
      apply() { return Promise.resolve([]); }
    });
    return chainable;
  }
});

export function getDb(): MySql2Database<typeof schema> {
  if (db) return db;
  if (isMock) return mockDb;

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn("[db] DATABASE_URL not set — using mock DB (calls work, no persistence)");
    isMock = true;
    return mockDb;
  }

  pool = mysql.createPool({
    uri: url,
    connectionLimit: 10,
    enableKeepAlive: true,
  });
  db = drizzle(pool, { schema, mode: "default" });
  return db;
}

/** Graceful shutdown hook for scripts (seed, fire-test). */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}
