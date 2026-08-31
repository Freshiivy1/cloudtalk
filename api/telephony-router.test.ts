/**
 * Telephony router no-database resilience regression test.
 *
 * Production (Render) runs in "no-history mode": AUTH_DISABLED=true and no
 * reachable MySQL. Every agent-facing telephony procedure must degrade to its
 * explicit safeDb fallback instead of throwing a tRPC INTERNAL_SERVER_ERROR
 * (HTTP 500 on the batched /api/trpc/telephony.calls.* requests).
 *
 * These cases run with getDbOrNull() === null (DATABASE_URL unset) and call
 * the procedures through a real router caller, asserting none of them throw
 * and each returns its documented degraded shape.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./router";
import { getDbOrNull } from "./queries/connection";
import { syntheticOpenAccessUser } from "./local-auth";

beforeAll(() => {
  delete process.env.DATABASE_URL;
  delete process.env.DB_HOST;
});

function noDbCaller() {
  if (getDbOrNull() !== null) {
    throw new Error("test requires no database (DATABASE_URL must be unset)");
  }
  return appRouter.createCaller({
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user: syntheticOpenAccessUser(),
  });
}

describe("telephony.calls.* without a database", () => {
  it("originate returns the unpersisted fallback", async () => {
    const caller = noDbCaller();
    await expect(
      caller.telephony.calls.originate({
        direction: "outbound",
        fromNumber: "softphone",
        toNumber: "+15557654321",
        clientCallId: "local-1",
        speakerphoneAttempted: true,
      }),
    ).resolves.toEqual({ id: 0, persisted: false });
  });

  it("event/addNote return ok unpersisted fallbacks", async () => {
    const caller = noDbCaller();
    await expect(
      caller.telephony.calls.event({ callId: 1, type: "call_ended" }),
    ).resolves.toEqual({ ok: true, persisted: false });
    await expect(
      caller.telephony.calls.addNote({ callId: 1, note: "hi" }),
    ).resolves.toEqual({ ok: true, persisted: false });
  });

  it("listMine/getById/myStatsToday return empty fallbacks", async () => {
    const caller = noDbCaller();
    await expect(
      caller.telephony.calls.listMine({ page: 1, pageSize: 25 }),
    ).resolves.toEqual({ rows: [], total: 0, page: 1, pageSize: 25 });
    await expect(
      caller.telephony.calls.getById({ id: 1 }),
    ).resolves.toBeNull();
    await expect(caller.telephony.calls.myStatsToday()).resolves.toEqual({
      total: 0,
      completed: 0,
      missed: 0,
      talkSec: 0,
    });
  });
});

describe("remaining telephony surface without a database", () => {
  it("contacts/presence degrade without throwing", async () => {
    const caller = noDbCaller();
    await expect(caller.telephony.contacts.list({})).resolves.toEqual([]);
    await expect(
      caller.telephony.contacts.create({ name: "A", phone: "+1555" }),
    ).resolves.toEqual({ id: 0, persisted: false });
    await expect(
      caller.telephony.contacts.toggleFavorite({ id: 1 }),
    ).resolves.toEqual({ ok: true, persisted: false });
    await expect(
      caller.telephony.contacts.remove({ id: 1 }),
    ).resolves.toEqual({ ok: true, persisted: false });
    const mine = await caller.telephony.presence.mine();
    expect(mine.id).toBe(0);
    expect(mine.presence).toBe("offline");
    await expect(
      caller.telephony.presence.set({ presence: "available" }),
    ).resolves.toEqual({ ok: true, presence: "available", persisted: false });
  });

  it("events.recent degrades to an empty feed (simulator never throws)", async () => {
    const caller = noDbCaller();
    await expect(caller.telephony.events.recent({ limit: 30 })).resolves.toEqual(
      [],
    );
  });

  it("voice.status stays public and false when Twilio is unconfigured", async () => {
    const caller = noDbCaller();
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_API_KEY_SID;
    await expect(caller.telephony.voice.status()).resolves.toEqual({
      enabled: false,
    });
  });
});
