/**
 * recentEvents resilience: with DATABASE_URL set but the database unreachable,
 * the query rejects — the event feed must degrade to [] instead of throwing
 * (tRPC 500 on the Live Analysis dock).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./queries/connection", () => ({
  getDbOrNull: vi.fn(),
}));

import { getDbOrNull } from "./queries/connection";
import { recentEvents } from "./simulator";

/** Minimal drizzle-shaped chain whose terminal .limit() rejects. */
function rejectingDb() {
  const chain: Record<string, (...args: never[]) => unknown> = {};
  for (const m of ["select", "from", "innerJoin", "orderBy"]) {
    chain[m] = () => chain;
  }
  chain.limit = () => Promise.reject(new Error("connect ECONNREFUSED"));
  return chain;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recentEvents", () => {
  it("resolves to [] when the db query rejects (unreachable database)", async () => {
    vi.mocked(getDbOrNull).mockReturnValue(rejectingDb() as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(recentEvents()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("resolves to [] when no database is configured", async () => {
    vi.mocked(getDbOrNull).mockReturnValue(null);
    await expect(recentEvents()).resolves.toEqual([]);
  });
});
