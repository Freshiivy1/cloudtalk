/**
 * CallVerify port — state machine tests (api/verification.ts).
 *
 * Runs against the real dev database with fake session rows. The `twilio`
 * module is mocked: calls.create returns mock Call SIDs and calls().update is
 * a recorded no-op, so no Twilio network calls are made and no real calls are
 * placed. Mock REST interactions (createdCalls / updatedCalls) are asserted
 * for timeouts, redirects and verdict announcements.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, like, or } from "drizzle-orm";
import * as schema from "@db/schema";
import type { VerificationSession } from "@db/schema";
import { getDb } from "./queries/connection";
import * as vs from "./verification";

// Webhook URL builders require a public base URL; originate() requires Twilio
// REST credentials (satisfied here by the mock below).
process.env.PUBLIC_BASE_URL ??= "https://verify-test.example.com";
process.env.TWILIO_ACCOUNT_SID ??= "AC_test_mock";
process.env.TWILIO_AUTH_TOKEN ??= "test_auth_token";
process.env.TWILIO_CALLER_ID ??= "+61400000001";

/** Recorded Twilio REST interactions from the mocked client. */
const twilioMock = vi.hoisted(() => ({
  createdCalls: [] as Array<Record<string, unknown>>,
  updatedCalls: [] as Array<{ sid: string; url?: string; status?: string }>,
  participantUpdates: [] as Array<{
    conference: string;
    participant: string;
    announceUrl?: string;
    announceMethod?: string;
  }>,
}));

vi.mock("twilio", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = (await importOriginal()) as any;
  const realTwilio = actual.default ?? actual;
  const fakeClient = {
    calls: Object.assign(
      (sid: string) => ({
        update: async (opts: { url?: string; method?: string; status?: string }) => {
          twilioMock.updatedCalls.push({ sid, ...opts });
          return {};
        },
      }),
      {
        create: async (opts: Record<string, unknown>) => {
          twilioMock.createdCalls.push(opts);
          return { sid: `CA_mock_${twilioMock.createdCalls.length}` };
        },
      },
    ),
    conferences: Object.assign(
      (name: string) => ({
        participants: (participantSid: string) => ({
          update: async (opts: { announceUrl?: string; announceMethod?: string }) => {
            twilioMock.participantUpdates.push({
              conference: name,
              participant: participantSid,
              ...opts,
            });
            return {};
          },
        }),
      }),
      {
        // Engine resolves the live conference SID by friendly name first
        // (conferences are addressable by SID only on the real API).
        list: async (opts?: { friendlyName?: string }) => [
          { sid: opts?.friendlyName ?? "CF_mock" },
        ],
      },
    ),
  };
  const factory = (() => fakeClient) as unknown as typeof realTwilio;
  // verification-webhooks.ts uses twilio.twiml.VoiceResponse for real TwiML.
  Object.assign(factory, { twiml: realTwilio.twiml, jwt: realTwilio.jwt });
  return { ...actual, default: factory };
});

const { createdCalls, updatedCalls, participantUpdates } = twilioMock;

const RUN = `t${Date.now().toString(36)}`;
const createdIds: string[] = [];

async function makeSession(
  state: string,
  overrides: Partial<typeof schema.verificationSessions.$inferInsert> = {},
): Promise<VerificationSession> {
  const sessionId = `${RUN}-${createdIds.length}`;
  createdIds.push(sessionId);
  await getDb().insert(schema.verificationSessions).values({
    sessionId,
    callerNumber: null,
    calleeNumber: "+61400000000",
    legBNumber: "+61400000000",
    ringTestNumber: "+61400000000",
    state,
    ...overrides,
  });
  return (await vs.findSession(sessionId))!;
}

async function events(sessionId: string) {
  return getDb()
    .select()
    .from(schema.verificationEvents)
    .where(eq(schema.verificationEvents.sessionId, sessionId));
}

afterAll(async () => {
  const db = getDb();
  const where =
    createdIds.length > 0
      ? or(
          like(schema.verificationSessions.sessionId, `${RUN}%`),
          inArray(schema.verificationSessions.sessionId, createdIds),
        )
      : like(schema.verificationSessions.sessionId, `${RUN}%`);
  // Delete child events for the same sessions first.
  const evtWhere =
    createdIds.length > 0
      ? or(
          like(schema.verificationEvents.sessionId, `${RUN}%`),
          inArray(schema.verificationEvents.sessionId, createdIds),
        )
      : like(schema.verificationEvents.sessionId, `${RUN}%`);
  await db.delete(schema.verificationEvents).where(evtWhere);
  await db.delete(schema.verificationSessions).where(where);
});

describe("normalizeE164", () => {
  it("accepts and normalises valid numbers", () => {
    expect(vs.normalizeE164("+61 412 345 678")).toBe("+61412345678");
    expect(vs.normalizeE164("0061 412 345 678")).toBe("+61412345678");
    expect(vs.normalizeE164("+1 (415) 555-0132")).toBe("+14155550132");
  });
  it("rejects invalid numbers", () => {
    expect(vs.normalizeE164("abc")).toBeNull();
    expect(vs.normalizeE164("+0123")).toBeNull();
    expect(vs.normalizeE164("123")).toBeNull();
    expect(vs.normalizeE164("")).toBeNull();
  });
});

describe("merge watch window", () => {
  it("defaults to 60s so the callee has time to merge (env-overridable)", () => {
    const saved = process.env.VERIFY_MERGE_WATCH_MS;
    delete process.env.VERIFY_MERGE_WATCH_MS;
    try {
      expect(vs.mergeWatchMs()).toBe(60_000);
      process.env.VERIFY_MERGE_WATCH_MS = "5000";
      expect(vs.mergeWatchMs()).toBe(5_000);
    } finally {
      if (saved === undefined) delete process.env.VERIFY_MERGE_WATCH_MS;
      else process.env.VERIFY_MERGE_WATCH_MS = saved;
    }
  });
});

describe("state machine", () => {
  it("COMPLETED: Leg B hangs up during LEG_B_ANSWERED", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED);
    await vs.onCallCompleted(s.sessionId, "legB", "CA_test", "duration=12s");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.COMPLETED);
    expect(after.completedAt).not.toBeNull();
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("HANGUP_LEGB");
    expect(types).toContain(vs.VState.COMPLETED);
  });

  it("MERGE_DETECTED: tone leak transitions terminal + flags toneDetected", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED);
    await vs.onMergeDetected(s.sessionId);
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.MERGE_DETECTED);
    expect(after.toneDetected).toBe(true);
    expect(after.toneDetectedAt).not.toBeNull();
  });

  it("VOIP_DETECTED: ring test answered by human during LEG_B_DIALING", async () => {
    const s = await makeSession(vs.VState.LEG_B_DIALING);
    await vs.onVoipDetected(s.sessionId);
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.VOIP_DETECTED);
  });

  it("CELLULAR_CONFIRMED: machine AMD on ring test is log-only (no state change)", async () => {
    const s = await makeSession(vs.VState.LEG_B_DIALING);
    await vs.onCellularConfirmed(s.sessionId, "machine_end_beep");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.LEG_B_DIALING);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("CELLULAR_CONFIRMED");
  });

  it("CALL_WAITING_OFF: Leg B AMD voicemail", async () => {
    const s = await makeSession(vs.VState.LEG_B_DIALING);
    await vs.onVoicemailDetected(s.sessionId, "machine_start");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.CALL_WAITING_OFF);
    // no caller leg → detection treated as confirmed, SMS queued once
    expect(after.smsSent).toBe(true);
  });

  it("guarded: late async-AMD machine verdict after Leg B answer is log-only", async () => {
    // With asyncAmd the machine verdict arrives AFTER the answer callback took
    // the human path — and the call-waiting switch beep is a classic AMD
    // false positive. The second call must NOT be killed mid-verification.
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
      guarded: true,
      callerCallSid: "CA_amd_caller",
      legACallSid: "CA_amd_legA",
      legBCallSid: "CA_amd_legB",
    });
    await vs.onVoicemailDetected(s.sessionId, "machine_end_beep");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.LEG_B_ANSWERED);
    // Leg B stays up — no hangup, no redirect, no call-waiting announcements.
    expect(updatedCalls.some((u) => u.sid === "CA_amd_legB")).toBe(false);
    expect(updatedCalls.some((u) => u.sid === "CA_amd_legA")).toBe(false);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("AMD_LATE_MACHINE_IGNORED");
  });

  it("non-guarded: AMD machine verdict still ends the call (legacy)", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
      callerCallSid: "CA_amdn_caller",
      legACallSid: "CA_amdn_legA",
      legBCallSid: "CA_amdn_legB",
    });
    await vs.onVoicemailDetected(s.sessionId, "machine_end_beep");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.CALL_WAITING_OFF);
    expect(updatedCalls.some((u) => u.sid === "CA_amdn_legB" && u.status === "completed")).toBe(
      true,
    );
  });

  it("CALL_WAITING_OFF: caller hangs up during LEG_B_ANSWERED (SMS queued)", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
      callerNumber: "+61411111111",
    });
    await vs.onCallCompleted(s.sessionId, "caller", "CA_caller", "duration=30s");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.CALL_WAITING_OFF);
    expect(after.smsSent).toBe(true);
  });

  it("confirmVoicemail: admin confirmation → CALL_WAITING_OFF + SMS (Java DTMF-00 port)", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
      callerNumber: "+61411111111",
    });
    await vs.confirmVoicemail(s.sessionId);
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.CALL_WAITING_OFF);
    expect(after.smsSent).toBe(true);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("SMS_QUEUED");
  });

  it("FAILED: caller hangs up early", async () => {
    const s = await makeSession(vs.VState.LEG_A_DIALING, {
      callerNumber: "+61411111111",
    });
    await vs.onCallCompleted(s.sessionId, "caller", "CA_caller", "");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.FAILED);
    expect(after.failureReason).toBe("Caller hung up");
  });

  it("FAILED: callee hangs up during the Leg A IVR", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED);
    await vs.onCallCompleted(s.sessionId, "legA", "CA_lega", "");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.FAILED);
    expect(after.failureReason).toBe("Callee hung up during IVR");
  });

  it("rejects illegal transitions (LEG_B_ANSWERED from INITIATED)", async () => {
    const s = await makeSession(vs.VState.INITIATED);
    await vs.onLegBAnswered(s.sessionId, "CA_legb");
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.INITIATED);
  });

  it("ignores events on terminal sessions", async () => {
    const s = await makeSession(vs.VState.COMPLETED, { completedAt: new Date() });
    await vs.onVoipDetected(s.sessionId);
    await vs.onMergeDetected(s.sessionId);
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.COMPLETED);
  });

  it("terminate: manual termination fails the session", async () => {
    const s = await makeSession(vs.VState.LEG_B_DIALING);
    await vs.terminate(s.sessionId);
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.FAILED);
    expect(after.failureReason).toBe("Manual termination");
  });

  it("sweepStaleSessions: fails non-terminal sessions older than 10min only", async () => {
    const stale = await makeSession(vs.VState.LEG_A_DIALING, {
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    const fresh = await makeSession(vs.VState.LEG_A_DIALING);
    const done = await makeSession(vs.VState.COMPLETED, {
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
      completedAt: new Date(),
    });
    await vs.sweepStaleSessions();
    expect((await vs.findSession(stale.sessionId))!.state).toBe(vs.VState.FAILED);
    expect((await vs.findSession(stale.sessionId))!.failureReason).toContain("Stale");
    expect((await vs.findSession(fresh.sessionId))!.state).toBe(vs.VState.LEG_A_DIALING);
    expect((await vs.findSession(done.sessionId))!.state).toBe(vs.VState.COMPLETED);
  });
});

describe("injectChallengeNoise (outer speakerphone → callee leg)", () => {
  it("targets the Leg A (callee) conference participant and never hangs up/redirects", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_noise_caller",
      legACallSid: "CA_noise_legA",
    });
    const updBefore = updatedCalls.length;
    const partBefore = participantUpdates.length;
    await vs.injectChallengeNoise(s.sessionId, "score=0.90 test");
    // Exactly one announce, on the verify-<sid> conference, to Leg A only.
    const added = participantUpdates.slice(partBefore);
    expect(added).toHaveLength(1);
    expect(added[0].conference).toBe(`verify-${s.sessionId}`);
    expect(added[0].participant).toBe("CA_noise_legA");
    expect(added[0].participant).not.toBe("CA_noise_caller");
    expect(added[0].announceUrl).toContain("/api/verify/challenge-noise.wav");
    // No hangup/redirect of any leg — the call continues.
    expect(updatedCalls.slice(updBefore)).toHaveLength(0);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("SPEAKERPHONE_SUSPECTED");
    const sp = (await events(s.sessionId)).find((e) => e.eventType === "SPEAKERPHONE_SUSPECTED");
    expect(sp?.details).toContain("target=legA-callee");
  });

  it("repeated injections are counted + timestamped in the SPEAKERPHONE_SUSPECTED payload", async () => {
    process.env.VERIFY_NOISE_EVENT_THROTTLE_MS = "0"; // disable write throttle
    try {
      const s = await makeSession(vs.VState.BRIDGED, {
        guarded: true,
        callerCallSid: "CA_rn_caller",
        legACallSid: "CA_rn_legA",
      });
      const partBefore = participantUpdates.length;
      await vs.injectChallengeNoise(s.sessionId, "score=0.90 first");
      await vs.injectChallengeNoise(s.sessionId, "score=0.91 second");
      // Sustained masking: each repeat still announces to the callee only.
      const added = participantUpdates.slice(partBefore);
      expect(added).toHaveLength(2);
      expect(added.every((p) => p.participant === "CA_rn_legA")).toBe(true);
      const sp = (await events(s.sessionId)).filter(
        (e) => e.eventType === "SPEAKERPHONE_SUSPECTED",
      );
      expect(sp).toHaveLength(2);
      expect(sp[0].details).toContain("injection #1");
      expect(sp[1].details).toContain("injection #2");
      expect(sp[1].details).toMatch(/at \d{4}-\d{2}-\d{2}T/);
    } finally {
      delete process.env.VERIFY_NOISE_EVENT_THROTTLE_MS;
    }
  });

  it("throttles SPEAKERPHONE_SUSPECTED event writes to 1/30s while re-announcing every time", async () => {
    // Default throttle (30s) applies — VERIFY_NOISE_EVENT_THROTTLE_MS unset.
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_th_caller",
      legACallSid: "CA_th_legA",
    });
    const partBefore = participantUpdates.length;
    await vs.injectChallengeNoise(s.sessionId, "score=0.90 first");
    await vs.injectChallengeNoise(s.sessionId, "score=0.91 second");
    await vs.injectChallengeNoise(s.sessionId, "score=0.92 third");
    // Noise (conference announce to the callee) re-injects on EVERY call…
    const added = participantUpdates.slice(partBefore);
    expect(added).toHaveLength(3);
    expect(added.every((p) => p.participant === "CA_th_legA")).toBe(true);
    // …but the DB event stream sees only the first suspicion in the window.
    const sp = (await events(s.sessionId)).filter(
      (e) => e.eventType === "SPEAKERPHONE_SUSPECTED",
    );
    expect(sp).toHaveLength(1);
    expect(sp[0].details).toContain("injection #1");
  });

  it("skips (no caller-leg fallback) when legACallSid is missing", async () => {
    const s = await makeSession(vs.VState.CALLER_HOLDING, {
      callerCallSid: "CA_noise_caller2",
      legACallSid: null,
    });
    const updBefore = updatedCalls.length;
    const partBefore = participantUpdates.length;
    await vs.injectChallengeNoise(s.sessionId, "score=0.90 test");
    expect(participantUpdates.slice(partBefore)).toHaveLength(0);
    expect(updatedCalls.slice(updBefore)).toHaveLength(0);
  });
});

describe("guarded live bridge (verification pass → BRIDGED)", () => {
  it("guarded: bridges caller + Leg A live once the merge watch elapses with no merge", async () => {
    process.env.VERIFY_MERGE_WATCH_MS = "0";
    try {
      const s = await makeSession(vs.VState.LEG_B_DIALING, {
        guarded: true,
        callerCallSid: "CA_g_caller",
        legACallSid: "CA_g_legA",
        ringTestCallSid: "CA_g_rt",
      });
      const updBefore = updatedCalls.length;
      // Leg B answered by a human → LEG_B_ANSWERED arms the merge watch.
      await vs.onLegBAnswered(s.sessionId, "CA_g_legB");
      expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_ANSWERED);
      // Watch window (0ms here) elapses with no merge → PASS → live bridge.
      await tick(150);
      const after = (await vs.findSession(s.sessionId))!;
      expect(after.state).toBe(vs.VState.BRIDGED);
      const added = updatedCalls.slice(updBefore);
      // Caller + Leg A redirected into the live two-way conference…
      expect(added.some((u) => u.sid === "CA_g_caller" && String(u.url).includes("guarded-bridge"))).toBe(true);
      expect(added.some((u) => u.sid === "CA_g_legA" && String(u.url).includes("guarded-bridge"))).toBe(true);
      // …the ring-test leg is hung up, but Leg B (answered by a human) is
      // left to end naturally — NOT hung up by the engine.
      expect(added.some((u) => u.sid === "CA_g_rt" && u.status === "completed")).toBe(true);
      expect(added.some((u) => u.sid === "CA_g_legB" && u.status === "completed")).toBe(false);
      // …and the caller is NEVER sent to the legacy verdict announcement.
      expect(added.some((u) => u.sid === "CA_g_caller" && String(u.url).includes("notify-"))).toBe(false);
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).toContain("GUARDED_MERGE_WATCH_ARMED");
      expect(types).toContain(vs.VState.BRIDGED);
      expect(types).toContain("GUARDED_BRIDGED");
    } finally {
      delete process.env.VERIFY_MERGE_WATCH_MS;
    }
  });

  it("non-guarded: watch never bridges — LEG_B_ANSWERED behavior bit-for-bit unchanged", async () => {
    process.env.VERIFY_MERGE_WATCH_MS = "0";
    try {
      const s = await makeSession(vs.VState.LEG_B_DIALING, {
        callerCallSid: "CA_ng_caller",
        legACallSid: "CA_ng_legA",
      });
      await vs.onLegBAnswered(s.sessionId, "CA_ng_legB");
      await tick(200);
      // No bridge, no guarded events, no hangups — session waits for the
      // legacy merge/verdict outcomes exactly as before.
      expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_ANSWERED);
      expect(updatedCalls.some((u) => String(u.url).includes("guarded-bridge"))).toBe(false);
      expect(await vs.maybeBridgeGuarded(s.sessionId)).toBe(false);
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).not.toContain("GUARDED_MERGE_WATCH_ARMED");
      expect(types).not.toContain("GUARDED_BRIDGED");
    } finally {
      delete process.env.VERIFY_MERGE_WATCH_MS;
    }
  });

  it("maybeBridgeGuarded(legAInline): redirects the caller only (Leg A is served inline)", async () => {
    process.env.VERIFY_MERGE_WATCH_MS = "0";
    try {
      const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
        guarded: true,
        callerCallSid: "CA_i_caller",
        legACallSid: "CA_i_legA",
      });
      // First sight in this process arms the watch and defers one cycle.
      expect(await vs.maybeBridgeGuarded(s.sessionId, { legAInline: true })).toBe(false);
      const updBefore = updatedCalls.length;
      expect(await vs.maybeBridgeGuarded(s.sessionId, { legAInline: true })).toBe(true);
      const added = updatedCalls.slice(updBefore);
      expect(added.some((u) => u.sid === "CA_i_caller" && String(u.url).includes("guarded-bridge"))).toBe(true);
      // Leg A must NOT be REST-redirected — the TwiML fetch serves it inline.
      expect(added.some((u) => u.sid === "CA_i_legA" && String(u.url).includes("guarded-bridge"))).toBe(false);
      expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.BRIDGED);
      // Idempotent: a second pass is a no-op.
      expect(await vs.maybeBridgeGuarded(s.sessionId)).toBe(false);
    } finally {
      delete process.env.VERIFY_MERGE_WATCH_MS;
    }
  });

  it("guarded: Leg B hangup during LEG_B_ANSWERED bridges (no notify-completed)", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
      guarded: true,
      callerCallSid: "CA_lbh_caller",
      legACallSid: "CA_lbh_legA",
      ringTestCallSid: "CA_lbh_rt",
    });
    const updBefore = updatedCalls.length;
    await vs.onCallCompleted(s.sessionId, "legB", "CA_lbh_legB", "duration=12s");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.BRIDGED);
    const added = updatedCalls.slice(updBefore);
    // BOTH caller and Leg A are redirected into the live conference…
    expect(added.some((u) => u.sid === "CA_lbh_caller" && String(u.url).includes("guarded-bridge"))).toBe(true);
    expect(added.some((u) => u.sid === "CA_lbh_legA" && String(u.url).includes("guarded-bridge"))).toBe(true);
    // …the caller is NOT sent to the legacy verdict announcement, Leg A is
    // NOT hung up, and only the ring-test leg is terminated.
    expect(added.some((u) => String(u.url).includes("notify-"))).toBe(false);
    expect(added.some((u) => u.sid === "CA_lbh_legA" && u.status === "completed")).toBe(false);
    expect(added.some((u) => u.sid === "CA_lbh_rt" && u.status === "completed")).toBe(true);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("GUARDED_BRIDGED");
    expect(types).toContain(vs.VState.BRIDGED);
  });

  it("non-guarded: Leg B hangup still completes with notify-completed + hangupAll (legacy)", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
      callerCallSid: "CA_lgn_caller",
      legACallSid: "CA_lgn_legA",
      ringTestCallSid: "CA_lgn_rt",
    });
    const updBefore = updatedCalls.length;
    await vs.onCallCompleted(s.sessionId, "legB", "CA_lgn_legB", "duration=12s");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.COMPLETED);
    const added = updatedCalls.slice(updBefore);
    // Legacy verdict announcement for the caller + all remaining legs dropped.
    expect(added.some((u) => u.sid === "CA_lgn_caller" && String(u.url).includes("notify-completed"))).toBe(true);
    expect(added.some((u) => u.sid === "CA_lgn_legA" && u.status === "completed")).toBe(true);
    expect(added.some((u) => u.sid === "CA_lgn_rt" && u.status === "completed")).toBe(true);
    expect(added.some((u) => String(u.url).includes("guarded-bridge"))).toBe(false);
  });

  it("BRIDGED: post-bridge merge detection via the stream path still hangs up", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_pm_caller",
      legACallSid: "CA_pm_legA",
      ringTestCallSid: "CA_pm_rt",
    });
    await vs.onMergeDetected(s.sessionId);
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.MERGE_DETECTED);
    // Existing behavior preserved: caller verdict + Leg A / ring test hangups.
    expect(updatedCalls.some((u) => u.sid === "CA_pm_caller" && String(u.url).includes("notify-merge"))).toBe(true);
    expect(updatedCalls.some((u) => u.sid === "CA_pm_legA" && u.status === "completed")).toBe(true);
  });

  it("BRIDGED: caller hangup → COMPLETED with timestamps + Leg A dropped", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_b_caller",
      legACallSid: "CA_b_legA",
    });
    await vs.onCallCompleted(s.sessionId, "caller", "CA_b_caller", "duration=120s");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.COMPLETED);
    expect(after.completedAt).not.toBeNull();
    expect(updatedCalls.some((u) => u.sid === "CA_b_legA" && u.status === "completed")).toBe(true);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("GUARDED_CALL_ENDED");
    expect(types).toContain(vs.VState.COMPLETED);
  });

  it("BRIDGED: callee (Leg A) hangup → COMPLETED + caller told the first call ended", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_b2_caller",
      legACallSid: "CA_b2_legA",
    });
    await vs.onCallCompleted(s.sessionId, "legA", "CA_b2_legA", "duration=45s");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.COMPLETED);
    // The caller is NOT silently dropped — they're redirected to the
    // "first call ended" announcement, whose TwiML then hangs up.
    expect(
      updatedCalls.some(
        (u) => u.sid === "CA_b2_caller" && String(u.url).includes("notify-first-call-ended"),
      ),
    ).toBe(true);
    expect(updatedCalls.some((u) => u.sid === "CA_b2_caller" && u.status === "completed")).toBe(
      false,
    );
  });

  it("guarded: callee ends the first call during LEG_B_DIALING → FAILED + caller told", async () => {
    const s = await makeSession(vs.VState.LEG_B_DIALING, {
      guarded: true,
      callerCallSid: "CA_lbd_caller",
      legACallSid: "CA_lbd_legA",
      legBCallSid: "CA_lbd_legB",
    });
    await vs.onCallCompleted(s.sessionId, "legA", "CA_lbd_legA", "duration=20s");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.FAILED);
    expect(after.failureReason).toBe("Callee ended the first call");
    expect(
      updatedCalls.some(
        (u) => u.sid === "CA_lbd_caller" && String(u.url).includes("notify-first-call-ended"),
      ),
    ).toBe(true);
    // The second call is torn down too.
    expect(updatedCalls.some((u) => u.sid === "CA_lbd_legB" && u.status === "completed")).toBe(
      true,
    );
  });

  it("guarded: callee ends the first call during LEG_B_ANSWERED → FAILED + caller told", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
      guarded: true,
      callerCallSid: "CA_lba_caller",
      legACallSid: "CA_lba_legA",
      legBCallSid: "CA_lba_legB",
    });
    await vs.onCallCompleted(s.sessionId, "legA", "CA_lba_legA", "duration=35s");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.FAILED);
    expect(after.failureReason).toBe("Callee ended the first call");
    expect(
      updatedCalls.some(
        (u) => u.sid === "CA_lba_caller" && String(u.url).includes("notify-first-call-ended"),
      ),
    ).toBe(true);
    expect(updatedCalls.some((u) => u.sid === "CA_lba_legB" && u.status === "completed")).toBe(
      true,
    );
  });

  it("non-guarded: Leg A drop during LEG_B_DIALING is still tolerated (legacy)", async () => {
    const s = await makeSession(vs.VState.LEG_B_DIALING, {
      callerCallSid: "CA_ng_caller",
      legACallSid: "CA_ng_legA",
    });
    await vs.onCallCompleted(s.sessionId, "legA", "CA_ng_legA", "duration=10s");
    const after = (await vs.findSession(s.sessionId))!;
    // Legacy: the carrier may release the first call when the second connects —
    // non-guarded sessions keep going and let Leg B decide.
    expect(after.state).toBe(vs.VState.LEG_B_DIALING);
    expect(
      updatedCalls.some(
        (u) => u.sid === "CA_ng_caller" && String(u.url).includes("notify-first-call-ended"),
      ),
    ).toBe(false);
  });

  it("guarded-bridge TwiML joins the live conference (no beep, ends on exit)", async () => {
    const res = await postForm("/api/verify/twiml/guarded-bridge?sid=abc123");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<Dial>");
    expect(body).toContain("<Conference");
    expect(body).toContain("verify-abc123");
    expect(body).toContain('beep="false"');
    expect(body).toContain('startConferenceOnEnter="true"');
    expect(body).toContain('endConferenceOnExit="true"');
    // No verdict announcement, no hangup — this is a LIVE bridge.
    expect(body).not.toContain("<Say");
    expect(body).not.toContain("<Hangup");
  });

  it("guarded-bridge TwiML records the conference for call review", async () => {
    const res = await postForm("/api/verify/twiml/guarded-bridge?sid=abc123");
    const body = await res.text();
    expect(body).toContain('record="record-from-start"');
    expect(body).toContain("/api/verify/recording/bridge?sid=abc123");
  });

  it("leg-a-tone loop serves the bridge inline once a guarded session is BRIDGED", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_t_caller",
      legACallSid: "CA_t_legA",
    });
    const res = await postForm(`/api/verify/twiml/leg-a-tone?sid=${s.sessionId}`);
    const body = await res.text();
    expect(body).toContain("<Conference");
    expect(body).toContain(`verify-${s.sessionId}`);
    expect(body).not.toContain("<Play");
  });

  it("leg-a-tone loop keeps the guarded merge test on a short (loop=1) poll while watching", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
      guarded: true,
      legACallSid: "CA_w_legA",
    });
    const res = await postForm(`/api/verify/twiml/leg-a-tone?sid=${s.sessionId}`);
    const body = await res.text();
    expect(body).toContain("<Play");
    expect(body).toContain('loop="1"');
    // Watch not elapsed → still in the merge test, not bridged.
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_ANSWERED);
  });
});

describe("initiate preconditions", () => {
  it("throws a clear error when PUBLIC_BASE_URL is unset", async () => {
    const saved = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    try {
      await expect(
        vs.initiate({ calleeNumber: "+61400000000" }),
      ).rejects.toThrow(
        "Site must be published and PUBLIC_BASE_URL set before running verification",
      );
    } finally {
      if (saved) process.env.PUBLIC_BASE_URL = saved;
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Webhook handlers (Hono) — TwiML rendering + status-callback mapping          */
/* -------------------------------------------------------------------------- */

import { Hono } from "hono";
import {
  verificationGatherHandler,
  verificationGatherLegAAcceptHandler,
  verificationGatherLegAReadyHandler,
  verificationToneHandler,
} from "./verification-webhooks";
import {
  verificationBridgeRecordingHandler,
  verificationRecordingAudioHandler,
  verificationRecordingHandler,
} from "./verification-record";
import { verificationStreamDetectedHandler, relayStreamUrl } from "./verification-stream";
import {
  verificationStatusHandler,
  verificationTwimlHandler,
  verificationVoiceprintHandler,
} from "./verification-webhooks";
import { voiceWebhookHandler } from "./twilio-voice";

const hookApp = new Hono();
hookApp.post("/api/verify/twiml/:kind", verificationTwimlHandler);
hookApp.post("/api/verify/status/:leg", verificationStatusHandler);
hookApp.post("/api/verify/gather/merge", verificationGatherHandler);
hookApp.post("/api/verify/gather/leg-a-accept", verificationGatherLegAAcceptHandler);
hookApp.post("/api/verify/gather/leg-a-ready", verificationGatherLegAReadyHandler);
hookApp.post("/api/verify/voiceprint", verificationVoiceprintHandler);
hookApp.get("/api/verify/tone.wav", verificationToneHandler);
hookApp.post("/api/verify/recording/merge", verificationRecordingHandler);
hookApp.post("/api/verify/recording/bridge", verificationBridgeRecordingHandler);
hookApp.get("/api/verify/recording/:sid/:kind", verificationRecordingAudioHandler);
hookApp.post("/api/verify/stream-detected", verificationStreamDetectedHandler);
// TwiML App voice webhook (SDK outbound calls — guarded branch keys off the
// `guarded` custom param).
hookApp.post("/api/voice/twiml", voiceWebhookHandler);

function postForm(url: string, data: Record<string, string> = {}) {
  return hookApp.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data),
  });
}

/** Minimal 8 kHz 16-bit mono WAV builder (for recording-callback tests). */
function buildWav(pcm: Int16Array): Buffer {
  const dataSize = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

describe("webhooks", () => {
  it("caller-hold TwiML parks the caller in the session conference", async () => {
    const res = await postForm("/api/verify/twiml/caller-hold?sid=abc123");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<Conference");
    expect(body).toContain("verify-abc123");
    expect(body).toContain("<Say>");
  });

  it("leg-b TwiML runs the silent record-chunk loop for merge detection", async () => {
    for (const kind of ["leg-b", "leg-b-record"]) {
      const res = await postForm(`/api/verify/twiml/${kind}?sid=abc123`);
      const body = await res.text();
      expect(body).toContain("<Record");
      expect(body).toContain('maxLength="1"');
      expect(body).toContain("/api/verify/recording/merge?sid=abc123");
      expect(body).toContain("/api/verify/twiml/leg-b-record?sid=abc123");
      // SILENT on Leg B — no prompts, no beep, no stream, no gather
      expect(body).not.toContain("<Say");
      expect(body).not.toContain("<Stream");
      expect(body).not.toContain("<Gather");
      expect(body).not.toContain('playBeep="true"');
    }
  });

  it("stray non-tone digit re-arms the listener without a verdict", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED);
    const res = await postForm(`/api/verify/gather/merge?sid=${s.sessionId}`, {
      CallSid: "CA_legb_stray",
      Digits: "5",
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("<Gather"); // re-armed, still listening
    expect(body).not.toContain("Merge detected");
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_ANSWERED);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("MERGE_LISTEN_STRAY_DIGIT");
  });

  it("leg-a-tone TwiML loops the in-band audio tone (1400Hz port)", async () => {
    const res = await postForm("/api/verify/twiml/leg-a-tone?sid=abc123");
    const body = await res.text();
    expect(body).toContain("<Play");
    expect(body).toContain("/api/verify/tone.wav");
    expect(body).not.toContain("digits=");
  });

  it("tone endpoint serves the wav as audio/wav (Twilio requires it)", async () => {
    const res = await hookApp.request("/api/verify/tone.wav");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/wav");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(100000); // real audio, not empty
    expect(buf.subarray(0, 4).toString("ascii")).toBe("RIFF"); // valid WAV header
  });

  it("recording chunk WITH merge tone → MERGE_DETECTED + Leg B redirected to verdict", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, { legBCallSid: "CA_legb_rec" });
    const tonePcm = new Int16Array(8000 * 2);
    for (let i = 0; i < tonePcm.length; i++) {
      tonePcm[i] = Math.round(
        12000 * Math.sin((2 * Math.PI * 852 * i) / 8000) +
          12000 * Math.sin((2 * Math.PI * 1336 * i) / 8000),
      );
    }
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(buildWav(tonePcm)), { status: 200 }));
    try {
      const res = await postForm(`/api/verify/recording/merge?sid=${s.sessionId}`, {
        CallSid: "CA_legb_rec",
        RecordingSid: "RE_test_tone",
        RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC_test/Recordings/RE_test_tone",
      });
      expect(res.status).toBe(200);
      await tick(300);
      const after = (await vs.findSession(s.sessionId))!;
      expect(after.state).toBe(vs.VState.MERGE_DETECTED);
      expect(after.toneDetected).toBeTruthy();
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).toContain("MERGE_RECORD_DETECTED");
      // Leg B is broken out of the record loop → verdict announcement
      expect(
        updatedCalls.some((u) => u.sid === "CA_legb_rec" && String(u.url).includes("notify-merge")),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("recording chunk WITHOUT tone → session keeps listening (no verdict)", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, { legBCallSid: "CA_legb_quiet" });
    const silence = new Int16Array(8000 * 2);
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(buildWav(silence)), { status: 200 }));
    try {
      const res = await postForm(`/api/verify/recording/merge?sid=${s.sessionId}`, {
        CallSid: "CA_legb_quiet",
        RecordingSid: "RE_test_silence",
        RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC_test/Recordings/RE_test_silence",
      });
      expect(res.status).toBe(200);
      await tick(300);
      expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_ANSWERED);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("relay stream-detected callback: 403 without secret, MERGE_DETECTED with it", async () => {
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    try {
      expect(relayStreamUrl("abc")).toBeNull(); // VERIFY_STREAM_URL unset in tests
      const s = await makeSession(vs.VState.LEG_B_ANSWERED, { legBCallSid: "CA_legb_relay" });

      // No/wrong secret → forbidden, no state change
      const bad = await hookApp.request(`/api/verify/stream-detected?sid=${s.sessionId}`, {
        method: "POST",
        headers: { "x-verify-secret": "wrong" },
      });
      expect(bad.status).toBe(403);
      expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_ANSWERED);

      // Correct secret → instant merge verdict
      const good = await hookApp.request(`/api/verify/stream-detected?sid=${s.sessionId}`, {
        method: "POST",
        headers: { "x-verify-secret": "test-secret" },
      });
      expect(good.status).toBe(200);
      await tick(300);
      const after = (await vs.findSession(s.sessionId))!;
      expect(after.state).toBe(vs.VState.MERGE_DETECTED);
      expect(
        updatedCalls.some((u) => u.sid === "CA_legb_relay" && String(u.url).includes("notify-merge")),
      ).toBe(true);
    } finally {
      delete process.env.VERIFY_STREAM_SECRET;
    }
  });

  it("status callback drives Leg B answered → LEG_B_ANSWERED", async () => {
    const s = await makeSession(vs.VState.LEG_B_DIALING);
    const res = await postForm(`/api/verify/status/legB?sid=${s.sessionId}`, {
      CallSid: "CA_legb_test",
      CallStatus: "in-progress",
    });
    expect(res.status).toBe(200);
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.LEG_B_ANSWERED);
    expect(after.legBCallSid).toBe("CA_legb_test");
  });

  it("status callback maps Leg B busy → CALL_WAITING_OFF", async () => {
    const s = await makeSession(vs.VState.LEG_B_DIALING);
    await postForm(`/api/verify/status/legB?sid=${s.sessionId}`, {
      CallSid: "CA_legb_test",
      CallStatus: "busy",
    });
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.CALL_WAITING_OFF);
  });

  it("gather callback with leaked digits → MERGE_DETECTED", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED);
    const res = await postForm(`/api/verify/gather/merge?sid=${s.sessionId}`, {
      CallSid: "CA_legb_test",
      Digits: "9",
    });
    expect(res.status).toBe(200);
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.MERGE_DETECTED);
  });

  it("ring-test TwiML with machine AMD → CELLULAR_CONFIRMED (log-only)", async () => {
    const s = await makeSession(vs.VState.LEG_B_DIALING);
    const res = await postForm(`/api/verify/twiml/ring-test?sid=${s.sessionId}`, {
      CallSid: "CA_rt_test",
      AnsweredBy: "machine_start",
    });
    expect(res.status).toBe(200);
    // fire-and-forget handler — give it a tick
    await new Promise((r) => setTimeout(r, 300));
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_DIALING);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("CELLULAR_CONFIRMED");
  });

  it("ring-test TwiML with human AMD → VOIP_DETECTED", async () => {
    const s = await makeSession(vs.VState.LEG_B_DIALING);
    await postForm(`/api/verify/twiml/ring-test?sid=${s.sessionId}`, {
      CallSid: "CA_rt_test",
      AnsweredBy: "human",
    });
    await new Promise((r) => setTimeout(r, 300));
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.VOIP_DETECTED);
  });
});

const tick = (ms = 300) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/* Gap 1+2: Leg A callee IVR — press-1 accept / ready sequencing (Phase 2)      */
/* -------------------------------------------------------------------------- */

describe("Leg A press-1 IVR", () => {
  it("leg-a TwiML serves the accept prompt in a numDigits=1 Gather", async () => {
    const res = await postForm("/api/verify/twiml/leg-a?sid=abc123");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<Gather");
    expect(body).toContain('numDigits="1"');
    expect(body).toContain("Press 1 to accept");
    expect(body).toContain("/api/verify/gather/leg-a-accept?sid=abc123");
    // timeout falls through to a re-prompt redirect (attempt incremented)
    expect(body).toContain("&amp;a=1");
    // Outer speakerphone detection: non-blocking <Start><Stream> of the
    // callee's uplink to the in-process stream endpoint (first prompt only).
    expect(body).toContain("<Start>");
    expect(body).toContain("/api/verify/stream?sid=abc123");
    expect(body).toContain('track="inbound_track"');
  });

  it("leg-a re-prompt (a>0) does not start a duplicate media stream", async () => {
    const res = await postForm("/api/verify/twiml/leg-a?sid=abc123&a=1");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<Gather");
    expect(body).not.toContain("<Start>");
  });

  it("press 1 to accept → Leg B PRE-ORIGINATED (already dialing), serves ready gather", async () => {
    const s = await makeSession(vs.VState.LEG_A_DIALING);
    const res = await postForm(`/api/verify/gather/leg-a-accept?sid=${s.sessionId}&a=0`, {
      CallSid: "CA_lega_ivr",
      Digits: "1",
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    // Pre-origination: first press-1 immediately starts Leg B ringing so the
    // second call arrives instantly after the ready press.
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.LEG_B_DIALING);
    expect(after.legBCallSid).toMatch(/^CA_mock_/);
    const legB = createdCalls.find(
      (c) => String(c.url).includes("/twiml/leg-b") && String(c.url).includes(s.sessionId),
    );
    expect(legB?.timeout).toBe(15);
    expect(body).toContain("Do not end this call. You will receive a second call. Please press 1.");
    expect(body).toContain("/api/verify/gather/leg-a-ready?sid=");
  });

  it("second press-1 is idempotent — never double-originates Leg B", async () => {
    const s = await makeSession(vs.VState.LEG_A_DIALING);
    // press 1 (accept) → pre-originates Leg B
    await postForm(`/api/verify/gather/leg-a-accept?sid=${s.sessionId}&a=0`, {
      CallSid: "CA_lega_ivr",
      Digits: "1",
    });
    const legBCount = createdCalls.filter((c) =>
      String(c.url).includes("/twiml/leg-b"),
    ).length;
    // press 1 (ready) → must NOT originate again
    await postForm(`/api/verify/gather/leg-a-ready?sid=${s.sessionId}&a=0`, {
      CallSid: "CA_lega_ivr",
      Digits: "1",
    });
    expect(
      createdCalls.filter((c) => String(c.url).includes("/twiml/leg-b")).length,
    ).toBe(legBCount);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("CALLEE_READY_CONFIRMED");
  });

  it("press 1 when ready → CALLEE_READY → LEG_B_DIALING, Leg A served hold TwiML", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED);
    const res = await postForm(`/api/verify/gather/leg-a-ready?sid=${s.sessionId}&a=0`, {
      CallSid: "CA_lega_ivr",
      Digits: "1",
    });
    const body = await res.text();
    // hold TwiML: long <Pause> + self-redirect keeps Leg A alive (Wait(300) port)
    expect(body).toContain("<Pause");
    expect(body).toContain("/api/verify/twiml/leg-a-hold?sid=");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.LEG_B_DIALING);
    expect(after.legBCallSid).toMatch(/^CA_mock_/);
    // Leg B originate: 15s timeout per CALL-FLOW.md
    const legB = createdCalls.find(
      (c) => String(c.url).includes("/twiml/leg-b") && String(c.url).includes(s.sessionId),
    );
    expect(legB?.timeout).toBe(15);
  });

  it("ring test is DISABLED — no 3rd call is originated", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED);
    await vs.onCalleeReady(s.sessionId);
    await tick(1400);
    const rt = createdCalls.find(
      (c) => String(c.url).includes("/twiml/ring-test") && String(c.url).includes(s.sessionId),
    );
    expect(rt).toBeUndefined();
    expect((await vs.findSession(s.sessionId))!.ringTestCallSid).toBeNull();
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("RING_TEST_DISABLED");
  });

  it("wrong digit re-prompts (attempt incremented) without changing state", async () => {
    const s = await makeSession(vs.VState.LEG_A_DIALING);
    const res = await postForm(`/api/verify/gather/leg-a-accept?sid=${s.sessionId}&a=0`, {
      CallSid: "CA_lega_ivr",
      Digits: "2",
    });
    const body = await res.text();
    expect(body).toContain("/api/verify/twiml/leg-a?sid=");
    expect(body).toContain("&amp;a=1");
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_A_DIALING);
  });

  it("reject path: 3 timeouts with no input → callee rejected → FAILED", async () => {
    const s = await makeSession(vs.VState.LEG_A_DIALING);
    const res = await postForm(
      `/api/verify/twiml/leg-a?sid=${s.sessionId}&a=${vs.LEG_A_MAX_ATTEMPTS}`,
    );
    const body = await res.text();
    expect(body).toContain("<Hangup");
    await tick(1500); // onLegFailed is fire-and-forget from the TwiML handler
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.FAILED);
    expect(after.failureReason).toContain("callee rejected/no input");
  });

  it("leg-a-hold loops while active, hangs up on terminal state", async () => {
    const s = await makeSession(vs.VState.LEG_B_DIALING);
    const active = await (await postForm(`/api/verify/twiml/leg-a-hold?sid=${s.sessionId}`)).text();
    expect(active).toContain("<Pause");
    const done = await makeSession(vs.VState.MERGE_DETECTED, { completedAt: new Date() });
    const term = await (await postForm(`/api/verify/twiml/leg-a-hold?sid=${done.sessionId}`)).text();
    expect(term).toContain("<Hangup");
    expect(term).not.toContain("<Pause");
  });
});

/* -------------------------------------------------------------------------- */
/* Gap 3+4: ring-test busy / AMD not-sure rules                                 */
/* -------------------------------------------------------------------------- */

describe("ring test + AMD rules", () => {
  it("ring-test busy → CELLULAR_CONFIRMED event, session continues", async () => {
    const s = await makeSession(vs.VState.LEG_B_DIALING);
    const res = await postForm(`/api/verify/status/ringTest?sid=${s.sessionId}`, {
      CallSid: "CA_rt_busy",
      CallStatus: "busy",
    });
    expect(res.status).toBe(200);
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_DIALING);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("CELLULAR_CONFIRMED");
  });

  it.each(["no-answer", "failed", "canceled"])(
    "ring-test %s → inconclusive log only, never terminates",
    async (status) => {
      const s = await makeSession(vs.VState.LEG_B_DIALING);
      await postForm(`/api/verify/status/ringTest?sid=${s.sessionId}`, {
        CallSid: "CA_rt_inc",
        CallStatus: status,
      });
      expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_DIALING);
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).toContain("RING_TEST_INCONCLUSIVE");
    },
  );

  it("AMD unknown/notsure on Leg B → human path (LEG_B_ANSWERED)", async () => {
    const s = await makeSession(vs.VState.LEG_B_DIALING);
    await postForm(`/api/verify/status/legB?sid=${s.sessionId}`, {
      CallSid: "CA_legb_notsure",
      CallStatus: "answered",
      AnsweredBy: "unknown",
    });
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_ANSWERED);
  });

  it("AMD machine on Leg B → voicemail → CALL_WAITING_OFF", async () => {
    const s = await makeSession(vs.VState.LEG_B_DIALING);
    await postForm(`/api/verify/status/legB?sid=${s.sessionId}`, {
      CallSid: "CA_legb_vm",
      CallStatus: "answered",
      AnsweredBy: "machine_start",
    });
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.CALL_WAITING_OFF);
  });
});

/* -------------------------------------------------------------------------- */
/* Gap 5: Leg A hangup ignored while Leg B is connecting                        */
/* -------------------------------------------------------------------------- */

describe("Leg A carrier drop", () => {
  it("Leg A hangup during LEG_B_DIALING is ignored", async () => {
    const s = await makeSession(vs.VState.LEG_B_DIALING, { legACallSid: "CA_lega_drop" });
    await vs.onCallCompleted(s.sessionId, "legA", "CA_lega_drop", "");
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_DIALING);
  });

  it("Leg A hangup during LEG_B_ANSWERED is ignored", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, { legACallSid: "CA_lega_drop" });
    await vs.onCallCompleted(s.sessionId, "legA", "CA_lega_drop", "");
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_ANSWERED);
  });
});

/* -------------------------------------------------------------------------- */
/* Gap 6+7+8: merge-detection priority, headless mode, timeouts                 */
/* -------------------------------------------------------------------------- */

describe("full flows (mocked Twilio)", () => {
  it("headless happy path: no caller → press-1 ×2 → Leg B human → MERGE_DETECTED", async () => {
    const s = await vs.initiate({ calleeNumber: "+61400000000" });
    createdIds.push(s.sessionId);
    // No caller leg is originated; Leg A starts immediately (30s timeout).
    expect(s.state).toBe(vs.VState.LEG_A_DIALING);
    expect(s.callerCallSid).toBeNull();
    const legA = createdCalls.find(
      (c) => String(c.url).includes("/twiml/leg-a?") && String(c.url).includes(s.sessionId),
    );
    expect(legA?.timeout).toBe(30);

    // Phase 2 IVR: press 1 to accept (Leg B pre-originates here — by design),
    // then press 1 when ready (confirmation only; no second origination).
    await postForm(`/api/verify/gather/leg-a-accept?sid=${s.sessionId}&a=0`, {
      CallSid: s.legACallSid ?? "CA_mock_lega",
      Digits: "1",
    });
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_DIALING);
    await postForm(`/api/verify/gather/leg-a-ready?sid=${s.sessionId}&a=0`, {
      CallSid: s.legACallSid ?? "CA_mock_lega",
      Digits: "1",
    });
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_DIALING);

    // Leg B answered by a human → stays in the Gather loop.
    await postForm(`/api/verify/status/legB?sid=${s.sessionId}`, {
      CallSid: "CA_legb_headless",
      CallStatus: "in-progress",
      AnsweredBy: "human",
    });
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_ANSWERED);

    // Callee merges → leaked digits in Leg B's Gather → MERGE_DETECTED.
    const res = await postForm(`/api/verify/gather/merge?sid=${s.sessionId}`, {
      CallSid: "CA_legb_headless",
      Digits: "9",
    });
    expect(await res.text()).toContain(
      "Merge detected. Verification complete. This line is confirmed as a cellular phone.",
    );
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.MERGE_DETECTED);
  });

  it("caller present: parked with hold music, never bridged live, verdict announced at end", async () => {
    const s = await vs.initiate({
      calleeNumber: "+61400000000",
      callerNumber: "+61411111111",
    });
    createdIds.push(s.sessionId);
    // Caller leg: 30s timeout, parked in caller-hold.
    const callerCall = createdCalls.find((c) => c.to === "+61411111111");
    expect(callerCall?.timeout).toBe(30);
    expect(String(callerCall?.url)).toContain("/twiml/caller-hold");

    // Caller answers → CALLER_HOLDING → Leg A dialed.
    await postForm(`/api/verify/status/caller?sid=${s.sessionId}`, {
      CallSid: "CA_caller_p",
      CallStatus: "answered",
    });
    const s2 = (await vs.findSession(s.sessionId))!;
    expect(s2.state).toBe(vs.VState.LEG_A_DIALING);

    // Callee IVR: press 1, press 1.
    await postForm(`/api/verify/gather/leg-a-accept?sid=${s.sessionId}&a=0`, {
      CallSid: s2.legACallSid ?? "CA_mock_lega",
      Digits: "1",
    });
    await postForm(`/api/verify/gather/leg-a-ready?sid=${s.sessionId}&a=0`, {
      CallSid: s2.legACallSid ?? "CA_mock_lega",
      Digits: "1",
    });

    // Leg B answered by a human.
    await postForm(`/api/verify/status/legB?sid=${s.sessionId}`, {
      CallSid: "CA_legb_p",
      CallStatus: "answered",
      AnsweredBy: "human",
    });
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_ANSWERED);

    // Merge-detection priority: Leg B is NEVER redirected into the conference…
    expect(
      updatedCalls.some(
        (u) => u.sid === "CA_legb_p" && String(u.url).includes("conference-leg-b"),
      ),
    ).toBe(false);
    // …and the trade-off is logged as an event note on LEG_B_ANSWERED.
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("LEG_B_ANSWERED_NOTE");

    // Terminal state → the parked caller is redirected to the verdict TwiML.
    await postForm(`/api/verify/gather/merge?sid=${s.sessionId}`, {
      CallSid: "CA_legb_p",
      Digits: "9",
    });
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.MERGE_DETECTED);
    expect(
      updatedCalls.some((u) => u.sid === "CA_caller_p" && String(u.url).includes("notify-merge")),
    ).toBe(true);
  });

  it("caller-hold TwiML parks the caller with hold music and the hold prompt", async () => {
    const res = await postForm("/api/verify/twiml/caller-hold?sid=abc123");
    const body = await res.text();
    expect(body).toContain(
      "Please hold. Your call is being connected. You will hear updates as the line is verified.",
    );
    expect(body).toContain("<Conference");
    expect(body).toContain('startConferenceOnEnter="false"');
  });

  it("gather timeout with no digits keeps Leg B in the Gather loop (never conferences)", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
      callerNumber: "+61411111111",
      callerCallSid: "CA_caller_q",
    });
    const res = await postForm(`/api/verify/gather/merge?sid=${s.sessionId}`, {
      CallSid: "CA_legb_q",
      Digits: "",
    });
    const body = await res.text();
    expect(body).toContain("<Gather");
    expect(body).not.toContain("<Conference");
  });
});


/* -------------------------------------------------------------------------- */
/* Guarded single-call flow: outbound SDK caller, voice-ID prompt, voiceprint  */
/* -------------------------------------------------------------------------- */

describe("guarded single-call flow", () => {
  it("initiate(callerClient) creates the session only — NO REST caller leg", async () => {
    const before = createdCalls.length;
    const s = await vs.initiate({ calleeNumber: "+61400000000", callerClient: "user-1" });
    createdIds.push(s.sessionId);
    expect(s.state).toBe(vs.VState.INITIATED);
    expect(s.guarded).toBe(true);
    expect(s.callerCallSid).toBeNull();
    // No outbound REST call at all — the browser dials in via the SDK.
    expect(
      createdCalls.slice(before).some((c) => String(c.url).includes(s.sessionId)),
    ).toBe(false);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("GUARDED_AWAITING_CALLER");
  });

  it("onGuardedCallerConnected: INITIATED → Leg A dialed, callerCallSid stored", async () => {
    const s = await makeSession(vs.VState.INITIATED, { guarded: true });
    expect(await vs.onGuardedCallerConnected(s.sessionId, "CA_sdk_caller")).toBe(true);
    const after = (await vs.findSession(s.sessionId))!;
    // CALLER_HOLDING then straight into Leg A origination.
    expect(after.state).toBe(vs.VState.LEG_A_DIALING);
    expect(after.callerCallSid).toBe("CA_sdk_caller");
    expect(after.legACallSid).toMatch(/^CA_mock_/);
    const legA = createdCalls.find(
      (c) => String(c.url).includes("/twiml/leg-a?") && String(c.url).includes(s.sessionId),
    );
    expect(legA?.timeout).toBe(30);
  });

  it("onGuardedCallerConnected rejects non-guarded and wrong-state sessions", async () => {
    const plain = await makeSession(vs.VState.INITIATED);
    expect(await vs.onGuardedCallerConnected(plain.sessionId, "CA_x")).toBe(false);
    expect((await vs.findSession(plain.sessionId))!.state).toBe(vs.VState.INITIATED);
    const already = await makeSession(vs.VState.BRIDGED, { guarded: true });
    expect(await vs.onGuardedCallerConnected(already.sessionId, "CA_y")).toBe(false);
    expect((await vs.findSession(already.sessionId))!.state).toBe(vs.VState.BRIDGED);
  });

  it("voice webhook guarded branch parks the caller in the session conference", async () => {
    const s = await makeSession(vs.VState.INITIATED, { guarded: true });
    const res = await postForm("/api/voice/twiml", {
      guarded: s.sessionId,
      CallSid: "CA_sdk_wh",
      To: "+61400000000",
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("Please wait while we connect your call.");
    expect(body).toContain("<Conference");
    expect(body).toContain(`verify-${s.sessionId}`);
    expect(body).toContain('startConferenceOnEnter="false"');
    // Engine advanced: caller stored, Leg A airborne.
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.callerCallSid).toBe("CA_sdk_wh");
    expect(after.state).toBe(vs.VState.LEG_A_DIALING);
  });

  it("voice webhook guarded branch fails closed for unknown sessions", async () => {
    const res = await postForm("/api/voice/twiml", {
      guarded: "no-such-session",
      CallSid: "CA_bad",
    });
    const body = await res.text();
    expect(body).toContain("Verification failed");
    expect(body).toContain("<Hangup");
  });

  it("voice webhook without the guarded param keeps the normal PSTN dial", async () => {
    const res = await postForm("/api/voice/twiml", { To: "+61400000000" });
    const body = await res.text();
    expect(body).toContain("<Dial");
    expect(body).toContain("+61400000000");
    expect(body).not.toContain("<Conference");
  });

  it("guarded leg-a TwiML serves the inmate acceptance gather plus the Leg A media stream", async () => {
    const g = await makeSession(vs.VState.LEG_A_DIALING, { guarded: true });
    const gRes = await postForm(`/api/verify/twiml/leg-a?sid=${g.sessionId}`);
    expect(gRes.status).toBe(200);
    const gBody = await gRes.text();
    expect(gBody).toContain("<Gather");
    expect(gBody).toContain(
      "You are receiving a call from an inmate. Do not merge or transfer this call. Please press 1 if you accept.",
    );
    expect(gBody).toContain(`/api/verify/gather/leg-a-accept?sid=${g.sessionId}&a=0`);
    // Media stream attached on the first fetch (inbound callee uplink).
    expect(gBody).toContain("<Start>");
    expect(gBody).toContain(`/api/verify/stream?sid=${g.sessionId}`);
    expect(gBody).toContain('track="inbound_track"');
    // No direct bridge and no voice-ID recording before press-1.
    expect(gBody).not.toContain("<Dial>");
    expect(gBody).not.toContain("<Conference");
    expect(gBody).not.toContain("<Record");
    expect((await vs.findSession(g.sessionId))!.state).toBe(vs.VState.LEG_A_DIALING);

    // Non-guarded keeps the same explicit acceptance IVR.
    const p = await makeSession(vs.VState.LEG_A_DIALING);
    const pBody = await (
      await postForm(`/api/verify/twiml/leg-a?sid=${p.sessionId}`)
    ).text();
    expect(pBody).toContain("<Gather");
    expect(pBody).toContain("You are receiving a call from an inmate");
    expect((await vs.findSession(p.sessionId))!.state).toBe(vs.VState.LEG_A_DIALING);
  });

  it("guarded press-1 records the voice-ID phrase and waits for the second-call handoff", async () => {
    const s = await makeSession(vs.VState.LEG_A_DIALING, { guarded: true });
    const before = createdCalls.length;
    const res = await postForm(`/api/verify/gather/leg-a-accept?sid=${s.sessionId}&a=0`, {
      CallSid: "CA_lega_g",
      Digits: "1",
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain(
      "Please identify your voice. After the beep, say: my voice identifies me.",
    );
    expect(body).toContain(
      "Do not end this call. You will receive a second call. Please press 1.",
    );
    expect(body).toContain("<Record");
    expect(body).toContain(`/api/verify/voiceprint?sid=${s.sessionId}`);
    // Failed-action fallback: ask for the second press-1; do NOT park/hold or
    // originate Leg B from the initial accept press.
    expect(body).toContain("/api/verify/gather/leg-a-ready?sid=");
    expect(body).not.toContain("/api/verify/twiml/leg-a-hold?sid=");
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.CALL_ACCEPTED);
    // Leg B starts only from the SECOND press-1 after voice-ID, not here.
    expect(
      createdCalls.slice(before).some((c) => String(c.url).includes("/twiml/leg-b")),
    ).toBe(false);
    expect((await vs.findSession(s.sessionId))!.legBCallSid).toBeNull();
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("GUARDED_VOICEPRINT_STEP");
  });

  it("voiceprint action asks for a second press-1 and does NOT originate Leg B", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_vp_caller",
      legACallSid: "CA_vp_legA",
    });
    const before = createdCalls.length;
    const res = await postForm(`/api/verify/voiceprint?sid=${s.sessionId}`, {
      CallSid: "CA_vp_legA",
      RecordingUrl: "",
      RecordingDuration: "0",
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain(
      "Do not end this call. You will receive a second call. Please press 1.",
    );
    expect(body).toContain("<Gather");
    expect(body).toContain(`/api/verify/gather/leg-a-ready?sid=${s.sessionId}&a=0`);
    expect(body).not.toContain("/api/verify/twiml/leg-a-hold?sid=");
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.CALL_ACCEPTED);
    expect(
      createdCalls.slice(before).some((c) => String(c.url).includes("/twiml/leg-b")),
    ).toBe(false);
  });

  it("guarded second press-1 after voice-ID originates Leg B and parks Leg A", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_vp2_caller",
      legACallSid: "CA_vp2_legA",
    });
    const before = createdCalls.length;
    const res = await postForm(`/api/verify/gather/leg-a-ready?sid=${s.sessionId}&a=0`, {
      CallSid: "CA_vp2_legA",
      Digits: "1",
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    // The callee is told the bridge is being set up before being parked.
    expect(body).toContain("Please wait while we connect your call.");
    expect(body).toContain("<Pause");
    expect(body).toContain("/api/verify/twiml/leg-a-hold?sid=");
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_DIALING);
    expect(
      createdCalls.slice(before).some((c) => String(c.url).includes("/twiml/leg-b")),
    ).toBe(true);
  });

  it("notify-first-call-ended TwiML explains the termination and hangs up", async () => {
    const res = await postForm("/api/verify/twiml/notify-first-call-ended?sid=abc123");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(
      "The first call has ended, so this guarded call will now be terminated. Goodbye.",
    );
    expect(body).toContain("<Hangup");
  });

  it("guarded callee no-answer still fails the session (status callback → FAILED)", async () => {
    const s = await makeSession(vs.VState.LEG_A_DIALING, {
      guarded: true,
      callerCallSid: "CA_na_caller",
    });
    await postForm(`/api/verify/status/legA?sid=${s.sessionId}`, {
      CallSid: "CA_na_legA",
      CallStatus: "no-answer",
    });
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.FAILED);
    expect(after.failureReason).toContain("Callee not available");
    expect(
      updatedCalls.some((u) => u.sid === "CA_na_caller" && String(u.url).includes("notify-failed")),
    ).toBe(true);
  });

  it("sweep fails guarded INITIATED sessions whose caller never connected (>2min)", async () => {
    const staleGuarded = await makeSession(vs.VState.INITIATED, {
      guarded: true,
      createdAt: new Date(Date.now() - 3 * 60 * 1000),
    });
    const freshGuarded = await makeSession(vs.VState.INITIATED, { guarded: true });
    await vs.sweepStaleSessions();
    const after = (await vs.findSession(staleGuarded.sessionId))!;
    expect(after.state).toBe(vs.VState.FAILED);
    expect(after.failureReason).toContain("never connected");
    expect((await vs.findSession(freshGuarded.sessionId))!.state).toBe(vs.VState.INITIATED);
  });
});

describe("call review recordings", () => {
  it("bridge recording callback stores the conference recording on the session", async () => {
    const s = await makeSession(vs.VState.BRIDGED, { guarded: true });
    const res = await postForm(`/api/verify/recording/bridge?sid=${s.sessionId}`, {
      RecordingSid: "RE_bridge_1",
      RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC_test/Recordings/RE_bridge_1",
      RecordingDuration: "87",
    });
    expect(res.status).toBe(200);
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.bridgeRecordingSid).toBe("RE_bridge_1");
    expect(after.bridgeRecordingUrl).toContain("RE_bridge_1");
    expect(after.bridgeRecordingDurationSec).toBe(87);
    expect(after.bridgeRecordedAt).not.toBeNull();
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("BRIDGE_RECORDING_STORED");
  });

  it("voice recording is stored even when relayguard profiling fails", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_vr_caller",
      legACallSid: "CA_vr_legA",
    });
    // Unreachable recording URL → profiling throws, but the clip is still
    // persisted for call-review playback.
    const res = await postForm(`/api/verify/voiceprint?sid=${s.sessionId}`, {
      CallSid: "CA_vr_legA",
      RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC_test/Recordings/RE_voice_1",
      RecordingDuration: "3",
    });
    expect(res.status).toBe(200);
    // processVoiceprint runs fire-and-forget — give it a beat.
    await tick(1500);
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.voiceRecordingUrl).toContain("RE_voice_1");
    expect(after.voiceRecordingDurationSec).toBe(3);
    expect(after.voiceRecordedAt).not.toBeNull();
  });

  it("audio proxy rejects anonymous requests (no session cookie)", async () => {
    const res = await hookApp.request(
      "/api/verify/recording/somesid/bridge",
      { method: "GET" },
    );
    expect(res.status).toBe(403);
  });

  it("audio proxy 404s for authed-looking requests on unknown sessions", async () => {
    // AUTH_DISABLED open-access mode skips the cookie check, then the unknown
    // session yields 404 (no Twilio network call is made).
    const saved = process.env.AUTH_DISABLED;
    process.env.AUTH_DISABLED = "true";
    try {
      const res = await hookApp.request(
        "/api/verify/recording/definitely-not-a-session/bridge",
        { method: "GET" },
      );
      expect(res.status).toBe(404);
    } finally {
      if (saved === undefined) delete process.env.AUTH_DISABLED;
      else process.env.AUTH_DISABLED = saved;
    }
  });
});
