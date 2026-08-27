/**
 * Env-based password login (api/local-auth.ts).
 *
 * The credential-comparison paths run without a database (the constant-time
 * check short-circuits before getDb()). The successful-login cases run against
 * the real dev database (MariaDB at 127.0.0.1:3306, DATABASE_URL from .env)
 * with a dedicated `local:vitest-admin` user row that is cleaned up after.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@db/schema";
import { closeDb, getDb } from "./queries/connection";
import {
  getLocalAdminCredentials,
  isLocalLoginConfigured,
  localUnionId,
  passwordsEqual,
  verifyLocalLogin,
} from "./local-auth";

const TEST_USER = "vitest-admin";
const TEST_PASS = "s3cret-vitest-password";

beforeEach(() => {
  process.env.ADMIN_USERNAME = TEST_USER;
  process.env.ADMIN_PASSWORD = TEST_PASS;
});

afterAll(async () => {
  try {
    await getDb()
      .delete(schema.users)
      .where(eq(schema.users.unionId, localUnionId(TEST_USER)));
  } catch {
    // DB unavailable (e.g. CI without MariaDB) — nothing was written anyway.
  } finally {
    await closeDb();
  }
});

describe("configuration", () => {
  it("is configured only when both ADMIN_USERNAME and ADMIN_PASSWORD are set", () => {
    expect(isLocalLoginConfigured()).toBe(true);
    expect(getLocalAdminCredentials()).toEqual({
      username: TEST_USER,
      password: TEST_PASS,
    });

    delete process.env.ADMIN_USERNAME;
    expect(isLocalLoginConfigured()).toBe(false);
    process.env.ADMIN_USERNAME = TEST_USER;

    delete process.env.ADMIN_PASSWORD;
    expect(isLocalLoginConfigured()).toBe(false);
    process.env.ADMIN_PASSWORD = TEST_PASS;

    process.env.ADMIN_USERNAME = "";
    expect(isLocalLoginConfigured()).toBe(false);
    process.env.ADMIN_USERNAME = TEST_USER;
  });

  it("throws when verifyLocalLogin is called unconfigured", async () => {
    delete process.env.ADMIN_USERNAME;
    await expect(verifyLocalLogin("x", "y")).rejects.toThrow(/not configured/);
  });
});

describe("passwordsEqual (constant-time)", () => {
  it("accepts identical strings", () => {
    expect(passwordsEqual("hunter2", "hunter2")).toBe(true);
    expect(passwordsEqual("", "")).toBe(true);
  });

  it("rejects different strings, including length-only differences", () => {
    expect(passwordsEqual("hunter2", "hunter3")).toBe(false);
    expect(passwordsEqual("hunter2", "hunter2extra")).toBe(false);
    expect(passwordsEqual("", "x")).toBe(false);
  });
});

describe("verifyLocalLogin", () => {
  it("rejects a wrong password without touching the database", async () => {
    await expect(verifyLocalLogin(TEST_USER, "wrong-password")).resolves.toBeUndefined();
  });

  it("rejects a wrong username", async () => {
    await expect(verifyLocalLogin("not-the-admin", TEST_PASS)).resolves.toBeUndefined();
  });

  it("creates an admin users row keyed by local:<username> on first login", async () => {
    const user = await verifyLocalLogin(TEST_USER, TEST_PASS);
    expect(user).toBeDefined();
    expect(user!.unionId).toBe(localUnionId(TEST_USER));
    expect(user!.name).toBe(TEST_USER);
    expect(user!.role).toBe("admin");
  });

  it("reuses the existing row on subsequent logins", async () => {
    const first = await verifyLocalLogin(TEST_USER, TEST_PASS);
    const second = await verifyLocalLogin(TEST_USER, TEST_PASS);
    expect(second!.id).toBe(first!.id);
  });
});
