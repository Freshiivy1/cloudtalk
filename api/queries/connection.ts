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
