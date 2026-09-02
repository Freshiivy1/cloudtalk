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
// The merge-tone beep rearm cadence defaults to 2s; tests that arm
// the tone set VERIFY_MERGE_TONE_REARM_MS explicitly (or disarm at the end),
// so no re-announce fires incidentally mid-suite.

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
  conferenceUpdates: [] as Array<{ conference: string; status?: string }>,
  // Optional override for conferences.list: null (default) = a live
  // conference always exists for any friendly name; set to [] to simulate
  // "no in-progress conference" (the pre-start-lobby case).
  listResult: null as Array<{ sid: string }> | null,
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
        update: async (opts: { status?: string }) => {
          twilioMock.conferenceUpdates.push({ conference: name, ...opts });
          return {};
        },
      }),
      {
        // Engine resolves the live conference SID by friendly name first
        // (conferences are addressable by SID only on the real API).
        list: async (opts?: { friendlyName?: string }) =>
          twilioMock.listResult ?? [{ sid: opts?.friendlyName ?? "CF_mock" }],
      },
    ),
  };
  const factory = (() => fakeClient) as unknown as typeof realTwilio;
  // verification-webhooks.ts uses twilio.twiml.VoiceResponse for real TwiML.
  Object.assign(factory, { twiml: realTwilio.twiml, jwt: realTwilio.jwt });
  return { ...actual, default: factory };
});

const { createdCalls, updatedCalls, participantUpdates, conferenceUpdates } = twilioMock;

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

describe("forensic precision config", () => {
  it("forensics warm-up defaults to 8000ms (env-overridable)", () => {
    const saved = process.env.VERIFY_FORENSICS_WARMUP_MS;
    delete process.env.VERIFY_FORENSICS_WARMUP_MS;
    try {
      expect(vs.forensicsWarmupMs()).toBe(8_000);
      process.env.VERIFY_FORENSICS_WARMUP_MS = "12000";
      expect(vs.forensicsWarmupMs()).toBe(12_000);
      process.env.VERIFY_FORENSICS_WARMUP_MS = "not-a-number";
      expect(vs.forensicsWarmupMs()).toBe(8_000);
    } finally {
      if (saved === undefined) delete process.env.VERIFY_FORENSICS_WARMUP_MS;
      else process.env.VERIFY_FORENSICS_WARMUP_MS = saved;
    }
  });

  it("merge tone is a 0.5s BEEP every 2s by default (announce never stomps the callee)", () => {
    const savedSec = process.env.VERIFY_MERGE_TONE_SEC;
    const savedRearm = process.env.VERIFY_MERGE_TONE_REARM_MS;
    delete process.env.VERIFY_MERGE_TONE_SEC;
    delete process.env.VERIFY_MERGE_TONE_REARM_MS;
    try {
      // Beeps: 0.5s tone, 2s re-announce cadence — the participant announce
      // replaces the callee's conference audio only 25% of the armed time.
      expect(vs.mergeToneSec()).toBe(0.5);
      expect(vs.mergeToneRearmMs()).toBe(2_000);
      // Detection budget still closes in 1-3s: worst case ~2s to the next
      // beep + one 300ms Goertzel streak (fits inside a single 0.5s beep).
      expect(vs.mergeToneSec()).toBeGreaterThanOrEqual(0.3);
      expect(vs.mergeToneRearmMs() + 300).toBeLessThanOrEqual(3_000);
      process.env.VERIFY_MERGE_TONE_SEC = "1.5";
      process.env.VERIFY_MERGE_TONE_REARM_MS = "4000";
      expect(vs.mergeToneSec()).toBe(1.5);
      expect(vs.mergeToneRearmMs()).toBe(4_000);
    } finally {
      if (savedSec === undefined) delete process.env.VERIFY_MERGE_TONE_SEC;
      else process.env.VERIFY_MERGE_TONE_SEC = savedSec;
      if (savedRearm === undefined) delete process.env.VERIFY_MERGE_TONE_REARM_MS;
      else process.env.VERIFY_MERGE_TONE_REARM_MS = savedRearm;
    }
  });

  it("voice-ID transcript timeout defaults to 15s (env-overridable)", () => {
    const saved = process.env.VERIFY_VOICE_ID_TRANSCRIPT_TIMEOUT_MS;
    delete process.env.VERIFY_VOICE_ID_TRANSCRIPT_TIMEOUT_MS;
    try {
      expect(vs.voiceIdTranscriptTimeoutMs()).toBe(15_000);
      process.env.VERIFY_VOICE_ID_TRANSCRIPT_TIMEOUT_MS = "5000";
      expect(vs.voiceIdTranscriptTimeoutMs()).toBe(5_000);
    } finally {
      if (saved === undefined) delete process.env.VERIFY_VOICE_ID_TRANSCRIPT_TIMEOUT_MS;
      else process.env.VERIFY_VOICE_ID_TRANSCRIPT_TIMEOUT_MS = saved;
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

describe("injectChallengeNoise (outer speakerphone → caller leg)", () => {
  it("targets the CALLER (inmate) conference participant ONLY — never Leg A — and never hangs up/redirects", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_noise_caller",
      legACallSid: "CA_noise_legA",
    });
    const updBefore = updatedCalls.length;
    const partBefore = participantUpdates.length;
    await vs.injectChallengeNoise(s.sessionId, "score=0.90 test");
    // Exactly one announce, on the verify-<sid> conference, to the CALLER only.
    const added = participantUpdates.slice(partBefore);
    expect(added).toHaveLength(1);
    expect(added[0].conference).toBe(`verify-${s.sessionId}`);
    expect(added[0].participant).toBe("CA_noise_caller");
    expect(added[0].participant).not.toBe("CA_noise_legA");
    expect(added[0].announceUrl).toContain("/api/verify/challenge-noise.wav");
    // The Leg A (callee) participant NEVER receives the noise announce — its
    // announce channel belongs to the DTMF merge tone.
    expect(
      added.some(
        (p) =>
          p.participant === "CA_noise_legA" &&
          p.announceUrl?.includes("/api/verify/challenge-noise.wav"),
      ),
    ).toBe(false);
    // No hangup/redirect of any leg — the call continues.
    expect(updatedCalls.slice(updBefore)).toHaveLength(0);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("SPEAKERPHONE_SUSPECTED");
    const sp = (await events(s.sessionId)).find((e) => e.eventType === "SPEAKERPHONE_SUSPECTED");
    expect(sp?.details).toContain("target=caller-inmate");
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
      // Sustained masking: each repeat still announces to the caller only.
      const added = participantUpdates.slice(partBefore);
      expect(added).toHaveLength(2);
      expect(added.every((p) => p.participant === "CA_rn_caller")).toBe(true);
      expect(added.some((p) => p.participant === "CA_rn_legA")).toBe(false);
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
    // Noise (conference announce to the caller) re-injects on EVERY call…
    const added = participantUpdates.slice(partBefore);
    expect(added).toHaveLength(3);
    expect(added.every((p) => p.participant === "CA_th_caller")).toBe(true);
    expect(added.some((p) => p.participant === "CA_th_legA")).toBe(false);
    // …but the DB event stream sees only the first suspicion in the window.
    const sp = (await events(s.sessionId)).filter(
      (e) => e.eventType === "SPEAKERPHONE_SUSPECTED",
    );
    expect(sp).toHaveLength(1);
    expect(sp[0].details).toContain("injection #1");
  });

  it("noise repeat is UNCAPPED — every suspicion emission re-announces, no injection ceiling", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_uc_caller",
      legACallSid: "CA_uc_legA",
    });
    const partBefore = participantUpdates.length;
    // 8 back-to-back injections (the detector's refire cadence runs unbounded
    // while suspicion persists — nothing on this path caps the repeats; only
    // the merge-system mutual exclusion or SPEAKERPHONE_CLEARED stops them).
    for (let i = 1; i <= 8; i++) {
      await vs.injectChallengeNoise(s.sessionId, `score=0.9 uncapped #${i}`);
    }
    const added = participantUpdates.slice(partBefore);
    expect(added).toHaveLength(8);
    expect(
      added.every(
        (p) =>
          p.participant === "CA_uc_caller" &&
          p.announceUrl?.includes("/api/verify/challenge-noise.wav"),
      ),
    ).toBe(true);
    expect(added.some((p) => p.participant === "CA_uc_legA")).toBe(false);
  });

  it("skips (no Leg A fallback) when callerCallSid is missing", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: null,
      legACallSid: "CA_noise_legA2",
    });
    const updBefore = updatedCalls.length;
    const partBefore = participantUpdates.length;
    await vs.injectChallengeNoise(s.sessionId, "score=0.90 test");
    // No caller leg → skipped (logged) — NEVER falls back to the Leg A leg.
    expect(participantUpdates.slice(partBefore)).toHaveLength(0);
    expect(updatedCalls.slice(updBefore)).toHaveLength(0);
  });

  it("is a no-op once the session is not BRIDGED (e.g. after MERGE_DETECTED)", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
      callerCallSid: "CA_nt_caller",
      legACallSid: "CA_nt_legA",
      ringTestCallSid: "CA_nt_rt",
    });
    await vs.onMergeDetected(s.sessionId); // pre-bridge verdict → terminal
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.MERGE_DETECTED);
    const partBefore = participantUpdates.length;
    // A late speakerphone suspicion (e.g. detector refire racing the verdict)
    // must NOT inject noise on a non-BRIDGED / terminal session.
    await vs.injectChallengeNoise(s.sessionId, "score=0.95 late suspicion");
    expect(participantUpdates.slice(partBefore)).toHaveLength(0);
    const sp = (await events(s.sessionId)).filter(
      (e) => e.eventType === "SPEAKERPHONE_SUSPECTED",
    );
    expect(sp).toHaveLength(0);
  });
});

describe("onVoiceMismatch (detection only — challenge noise stays forensic-gated)", () => {
  it("logs the throttled VOICE_MISMATCH event but NEVER injects challenge noise", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_vm_caller",
      legACallSid: "CA_vm_legA",
    });
    const partBefore = participantUpdates.length;
    const updBefore = updatedCalls.length;
    await vs.onVoiceMismatch(s.sessionId, "consensus=different test");
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("VOICE_MISMATCH");
    // No conference announce, no redirect, no hangup — detection only.
    expect(participantUpdates.slice(partBefore)).toHaveLength(0);
    expect(updatedCalls.slice(updBefore)).toHaveLength(0);
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.BRIDGED);
    // Throttled: a second mismatch inside the window writes no duplicate event.
    await vs.onVoiceMismatch(s.sessionId, "consensus=different again");
    const vm = (await events(s.sessionId)).filter((e) => e.eventType === "VOICE_MISMATCH");
    expect(vm).toHaveLength(1);
  });
});

describe("BRIDGED in-call merge detection (continuous armed tone)", () => {
  it("second-call engage while BRIDGED announces the merge tone to the Leg A participant only and re-announces on the rearm cadence", async () => {
    process.env.VERIFY_MERGE_TONE_REARM_MS = "60";
    try {
      const s = await makeSession(vs.VState.BRIDGED, {
        guarded: true,
        callerCallSid: "CA_sc_caller",
        legACallSid: "CA_sc_legA",
      });
      const partBefore = participantUpdates.length;
      await vs.onSecondCallEngaged(s.sessionId);
      expect(vs.isMergeToneArmed(s.sessionId)).toBe(true);
      // Immediate announce: Leg A (callee) participant ONLY, on this
      // session's live conference.
      const added = participantUpdates.slice(partBefore);
      expect(added).toHaveLength(1);
      expect(added[0].participant).toBe("CA_sc_legA");
      expect(added[0].participant).not.toBe("CA_sc_caller");
      expect(added[0].conference).toBe(`verify-${s.sessionId}`);
      expect(added[0].announceUrl).toContain("/api/verify/merge-tone.wav");
      expect(added[0].announceMethod).toBe("GET");
      // Effectively continuous: re-announced on the rearm cadence.
      await tick(200); // several 60ms rearms
      const rearmed = participantUpdates.slice(partBefore);
      expect(rearmed.length).toBeGreaterThanOrEqual(3);
      expect(rearmed.every((p) => p.participant === "CA_sc_legA")).toBe(true);
      expect(rearmed.every((p) => p.announceUrl?.includes("/api/verify/merge-tone.wav"))).toBe(true);
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).toContain("SECOND_CALL_ENGAGED");
      // Disengage stops the re-announces.
      await vs.onSecondCallDisengaged(s.sessionId);
      expect(vs.isMergeToneArmed(s.sessionId)).toBe(false);
      expect((await events(s.sessionId)).map((e) => e.eventType)).toContain(
        "SECOND_CALL_DISENGAGED",
      );
      const count = participantUpdates.length;
      await tick(200);
      expect(participantUpdates.length).toBe(count);
    } finally {
      delete process.env.VERIFY_MERGE_TONE_REARM_MS;
    }
  });

  it("terminal transition disarms the tone and clears its re-announce timer", async () => {
    process.env.VERIFY_MERGE_TONE_REARM_MS = "50";
    try {
      const s = await makeSession(vs.VState.BRIDGED, {
        guarded: true,
        callerCallSid: "CA_tm_caller",
        legACallSid: "CA_tm_legA",
      });
      await vs.armMergeTone(s.sessionId);
      expect(vs.isMergeToneArmed(s.sessionId)).toBe(true);
      await vs.onCallCompleted(s.sessionId, "caller", "CA_tm_caller", "duration=5s");
      expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.COMPLETED);
      expect(vs.isMergeToneArmed(s.sessionId)).toBe(false);
      const count = participantUpdates.length;
      await tick(200); // several 50ms rearms would have fired otherwise
      expect(participantUpdates.length).toBe(count);
    } finally {
      delete process.env.VERIFY_MERGE_TONE_REARM_MS;
    }
  });

  it("engage on a non-BRIDGED session is a no-op (no arm, no event, no announce)", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
      callerCallSid: "CA_nb_caller",
      legACallSid: "CA_nb_legA",
    });
    const partBefore = participantUpdates.length;
    await vs.onSecondCallEngaged(s.sessionId);
    expect(vs.isMergeToneArmed(s.sessionId)).toBe(false);
    expect(participantUpdates.slice(partBefore)).toHaveLength(0);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).not.toContain("SECOND_CALL_ENGAGED");
  });

  it("ARMED tone fire while BRIDGED → MERGE_DETECTED + full conference teardown", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_og_caller",
      legACallSid: "CA_og_legA",
      legBCallSid: "CA_og_legB",
    });
    await vs.armMergeTone(s.sessionId);
    expect(vs.isMergeToneArmed(s.sessionId)).toBe(true);
    expect(await handleMergeToneFire(s.sessionId)).toBe("merge");
    expect(vs.isMergeToneArmed(s.sessionId)).toBe(false); // cleanupSessionMaps
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.MERGE_DETECTED);
    expect(
      updatedCalls.some(
        (u) => u.sid === "CA_og_caller" && String(u.url).includes("notify-conference-merge"),
      ),
    ).toBe(true);
    expect(
      updatedCalls.some(
        (u) => u.sid === "CA_og_legA" && String(u.url).includes("notify-conference-merge"),
      ),
    ).toBe(true);
    expect(
      updatedCalls.some(
        (u) => u.sid === "CA_og_legB" && String(u.url).includes("notify-conference-merge"),
      ),
    ).toBe(true);
    expect(
      conferenceUpdates.some(
        (u) => u.conference === `verify-${s.sessionId}` && u.status === "completed",
      ),
    ).toBe(true);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("MERGE_STREAM_DETECTED");
  });

  it("UNARMED tone fire while BRIDGED is ignored (self-echo/ambient guard)", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_ua_caller",
      legACallSid: "CA_ua_legA",
    });
    expect(vs.isMergeToneArmed(s.sessionId)).toBe(false);
    expect(await handleMergeToneFire(s.sessionId)).toBe("ignored");
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.BRIDGED);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("MERGE_TONE_UNARMED");
  });

  it("speakerphone suspicion NEVER arms the merge tone — caller-only challenge noise, no hangup path", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_bb_caller",
      legACallSid: "CA_bb_legA",
    });
    expect(vs.isMergeToneArmed(s.sessionId)).toBe(false);
    const updBefore = updatedCalls.length;
    const partBefore = participantUpdates.length;
    handleSpeakerphoneSuspicious(s.sessionId, 0.9, "no-backstop test");
    await tick(150); // let the REST path settle
    // The suspicion path must NOT arm the merge tone: an armed recognizer +
    // loud acoustic tone loopback would be a false-MERGE hangup path from
    // pure relay detection, and the family would hear DTMF beeping.
    expect(vs.isMergeToneArmed(s.sessionId)).toBe(false);
    const added = participantUpdates.slice(partBefore);
    // The ONLY announce is the challenge noise → CALLER (inmate) participant.
    expect(added).toHaveLength(1);
    expect(added[0].participant).toBe("CA_bb_caller");
    expect(added[0].announceUrl).toContain("/api/verify/challenge-noise.wav");
    // NO merge-tone announce to ANYONE from the suspicion path.
    expect(added.some((p) => p.announceUrl?.includes("/api/verify/merge-tone.wav"))).toBe(false);
    // The Leg A (callee) participant gets NOTHING — its announce channel is
    // reserved for the in-call merge system.
    expect(added.some((p) => p.participant === "CA_bb_legA")).toBe(false);
    // No hangup/redirect of any leg — the call continues.
    expect(updatedCalls.slice(updBefore)).toHaveLength(0);
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.BRIDGED);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("SPEAKERPHONE_SUSPECTED");
    expect(types).not.toContain("NOISE_SUPPRESSED_MERGE_ACTIVE");
  });

  it("sustained masking: repeated suspicion emissions (tone NOT armed) re-announce the noise to the caller every time", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_sm_caller",
      legACallSid: "CA_sm_legA",
    });
    const partBefore = participantUpdates.length;
    // Simulates the detector's refire cadence (every refireMs ~4s while
    // suspicion persists). With the tone NOT armed, none of these are
    // suppressed — the masking is sustained for the whole episode.
    handleSpeakerphoneSuspicious(s.sessionId, 0.9, "refire #1");
    await tick(100);
    handleSpeakerphoneSuspicious(s.sessionId, 0.91, "refire #2");
    await tick(100);
    handleSpeakerphoneSuspicious(s.sessionId, 0.92, "refire #3");
    await tick(100);
    expect(vs.isMergeToneArmed(s.sessionId)).toBe(false);
    const added = participantUpdates.slice(partBefore);
    // Every emission re-announced the challenge noise to the CALLER only.
    expect(added).toHaveLength(3);
    expect(
      added.every(
        (p) =>
          p.participant === "CA_sm_caller" &&
          p.announceUrl?.includes("/api/verify/challenge-noise.wav"),
      ),
    ).toBe(true);
    expect(added.some((p) => p.participant === "CA_sm_legA")).toBe(false);
    expect(added.some((p) => p.announceUrl?.includes("/api/verify/merge-tone.wav"))).toBe(false);
    // No suppression events on the pure forensic path.
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).not.toContain("NOISE_SUPPRESSED_MERGE_ACTIVE");
  });

  it("armed tone with NO active engagement disarms on SPEAKERPHONE_CLEARED while BRIDGED", async () => {
    process.env.VERIFY_MERGE_TONE_REARM_MS = "50";
    try {
      const s = await makeSession(vs.VState.BRIDGED, {
        guarded: true,
        callerCallSid: "CA_sd_caller",
        legACallSid: "CA_sd_legA",
      });
      // Tone armed but NO HoldDetector engagement recorded (e.g. a disengage
      // that fired while suspicion was active deferred the disarm to this
      // path — the suspicion path itself never arms the tone).
      await vs.armMergeTone(s.sessionId);
      await tick(150); // let a few 50ms re-announces settle
      expect(vs.isMergeToneArmed(s.sessionId)).toBe(true);
      expect(vs.isSecondCallEngaged(s.sessionId)).toBe(false);
      // Suspicion clears with no active engagement → the tone disarms.
      await vs.onSpeakerphoneCleared(s.sessionId, "clear-disarm test");
      expect(vs.isMergeToneArmed(s.sessionId)).toBe(false);
      const count = participantUpdates.length;
      await tick(200); // several 50ms rearms would have fired otherwise
      expect(participantUpdates.length).toBe(count);
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).toContain("SPEAKERPHONE_CLEARED");
      expect(types).toContain("MERGE_TONE_DISARMED");
    } finally {
      delete process.env.VERIFY_MERGE_TONE_REARM_MS;
    }
  });

  it("SPEAKERPHONE_CLEARED does NOT disarm while a hold engagement is active", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_hd_caller",
      legACallSid: "CA_hd_legA",
    });
    // HoldDetector engagement arms the tone and marks the engagement active.
    await vs.onSecondCallEngaged(s.sessionId);
    expect(vs.isMergeToneArmed(s.sessionId)).toBe(true);
    expect(vs.isSecondCallEngaged(s.sessionId)).toBe(true);
    // Suspicion clearing mid-engagement must NOT disarm — the disengage path
    // owns that disarm.
    await vs.onSpeakerphoneCleared(s.sessionId, "hold-active test");
    expect(vs.isMergeToneArmed(s.sessionId)).toBe(true);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("SPEAKERPHONE_CLEARED");
    expect(types).not.toContain("MERGE_TONE_DISARMED");
    // The disengage path still owns the disarm.
    await vs.onSecondCallDisengaged(s.sessionId);
    expect(vs.isMergeToneArmed(s.sessionId)).toBe(false);
    expect(vs.isSecondCallEngaged(s.sessionId)).toBe(false);
  });

  it("non-BRIDGED tone fire keeps the legacy instant verdict (no arm consulted)", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
      callerCallSid: "CA_lg_caller",
      legACallSid: "CA_lg_legA",
      legBCallSid: "CA_lg_legB",
    });
    expect(await handleMergeToneFire(s.sessionId)).toBe("merge");
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.MERGE_DETECTED);
    // Pre-bridge path: notify-merge (not the conference teardown).
    expect(
      updatedCalls.some((u) => u.sid === "CA_lg_caller" && String(u.url).includes("twiml/notify-merge")),
    ).toBe(true);
    expect(conferenceUpdates.some((u) => u.conference === `verify-${s.sessionId}`)).toBe(false);
  });
});

describe("challenge noise / merge system mutual exclusion", () => {
  it("suspicion while the merge tone is ARMED → NO noise announce + NOISE_SUPPRESSED_MERGE_ACTIVE event; the Leg A merge tone is unaffected", async () => {
    process.env.VERIFY_MERGE_TONE_REARM_MS = "50"; // fast rearms (fixed at arm time)
    let armedSid: string | null = null;
    try {
      const s = await makeSession(vs.VState.BRIDGED, {
        guarded: true,
        callerCallSid: "CA_mx_caller",
        legACallSid: "CA_mx_legA",
      });
      // Merge system already active (second-call engagement path).
      await vs.armMergeTone(s.sessionId);
      armedSid = s.sessionId;
      expect(vs.isMergeToneArmed(s.sessionId)).toBe(true);
      const partBefore = participantUpdates.length;
      handleSpeakerphoneSuspicious(s.sessionId, 0.9, "suppression test");
      await tick(200); // let any (suppressed) REST path + several rearms settle
      const added = participantUpdates.slice(partBefore);
      // NO challenge-noise announce to ANYONE while the merge system is active.
      expect(added.some((p) => p.announceUrl?.includes("/api/verify/challenge-noise.wav"))).toBe(
        false,
      );
      // …and the suppression is event-logged.
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).toContain("NOISE_SUPPRESSED_MERGE_ACTIVE");
      expect(types).not.toContain("SPEAKERPHONE_SUSPECTED");
      // The merge tone keeps re-announcing to the Leg A participant, unaffected.
      expect(
        added.some(
          (p) =>
            p.participant === "CA_mx_legA" &&
            p.announceUrl?.includes("/api/verify/merge-tone.wav"),
        ),
      ).toBe(true);
      expect(added.every((p) => p.participant === "CA_mx_legA")).toBe(true);
    } finally {
      delete process.env.VERIFY_MERGE_TONE_REARM_MS;
      if (armedSid) vs.disarmMergeTone(armedSid);
    }
  });

  it("suspicion on a MERGE_DETECTED (terminal) session → suppressed, no noise announce", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_mt_caller",
      legACallSid: "CA_mt_legA",
    });
    await vs.onMergeDetected(s.sessionId, { inCall: true }); // terminal
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.MERGE_DETECTED);
    const partBefore = participantUpdates.length;
    handleSpeakerphoneSuspicious(s.sessionId, 0.9, "late suspicion after verdict");
    await tick(150);
    expect(
      participantUpdates
        .slice(partBefore)
        .some((p) => p.announceUrl?.includes("/api/verify/challenge-noise.wav")),
    ).toBe(false);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("NOISE_SUPPRESSED_MERGE_ACTIVE");
    expect(types).not.toContain("SPEAKERPHONE_SUSPECTED");
  });

  it("merge flow (armed tone fire → notify-conference-merge → teardown) never emits a challenge-noise announce to anyone", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_mf_caller",
      legACallSid: "CA_mf_legA",
      legBCallSid: "CA_mf_legB",
    });
    const partBefore = participantUpdates.length;
    await vs.armMergeTone(s.sessionId);
    expect(await handleMergeToneFire(s.sessionId)).toBe("merge");
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.MERGE_DETECTED);
    // Every leg routed to the conference-ending announcement; the only
    // participant announce in the whole flow is the merge tone to Leg A.
    const added = participantUpdates.slice(partBefore);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((p) => p.announceUrl?.includes("/api/verify/merge-tone.wav"))).toBe(true);
    expect(added.every((p) => p.participant === "CA_mf_legA")).toBe(true);
    expect(added.some((p) => p.announceUrl?.includes("/api/verify/challenge-noise.wav"))).toBe(
      false,
    );
  });
});

describe("speakerphoneArmWindows (3s forensic arming)", () => {
  it("defaults to 3 consecutive suspicious windows, env-overridable, floored at 1", () => {
    const saved = process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS;
    delete process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS;
    try {
      expect(vs.speakerphoneArmWindows()).toBe(3);
      process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS = "5";
      expect(vs.speakerphoneArmWindows()).toBe(5);
      process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS = "1";
      expect(vs.speakerphoneArmWindows()).toBe(1);
      process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS = "0"; // floored to 1
      expect(vs.speakerphoneArmWindows()).toBe(1);
      process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS = "-4"; // floored to 1
      expect(vs.speakerphoneArmWindows()).toBe(1);
      process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS = "bogus"; // safe default
      expect(vs.speakerphoneArmWindows()).toBe(3);
      process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS = ""; // set-but-empty → default
      expect(vs.speakerphoneArmWindows()).toBe(3);
    } finally {
      if (saved === undefined) delete process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS;
      else process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS = saved;
    }
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
      // Caller + Leg A redirected into the live two-way conference, each with
      // its conference role in the URL (caller=joiner, legA=anchor)…
      expect(added.some((u) => u.sid === "CA_g_caller" && String(u.url).includes("guarded-bridge") && String(u.url).includes("leg=caller"))).toBe(true);
      expect(added.some((u) => u.sid === "CA_g_legA" && String(u.url).includes("guarded-bridge") && String(u.url).includes("leg=legA"))).toBe(true);
      // …the ring-test leg is hung up, AND Leg B is torn down at bridge time:
      // the callee answered it via call waiting (Leg A went on hold on their
      // handset), so ending Leg B server-side returns the handset to Leg A —
      // now the live conference. Leaving Leg B up was the both-sides-deaf bug.
      expect(added.some((u) => u.sid === "CA_g_rt" && u.status === "completed")).toBe(true);
      expect(added.some((u) => u.sid === "CA_g_legB" && u.status === "completed")).toBe(true);
      // …and the caller is NEVER sent to the legacy verdict announcement.
      expect(added.some((u) => u.sid === "CA_g_caller" && String(u.url).includes("notify-"))).toBe(false);
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).toContain("GUARDED_MERGE_WATCH_ARMED");
      expect(types).toContain(vs.VState.BRIDGED);
      expect(types).toContain("GUARDED_BRIDGED");
      expect(types).toContain("LEG_B_PASS_TEARDOWN");
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
      // Assert only on THIS test's REST updates — earlier guarded-bridge
      // tests legitimately redirect to guarded-bridge, so the global array
      // must not be consulted whole.
      const updBefore = updatedCalls.length;
      await vs.onLegBAnswered(s.sessionId, "CA_ng_legB");
      await tick(200);
      // No bridge, no guarded events, no hangups — session waits for the
      // legacy merge/verdict outcomes exactly as before.
      expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_ANSWERED);
      const added = updatedCalls.slice(updBefore);
      expect(added.some((u) => String(u.url).includes("guarded-bridge"))).toBe(false);
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

  it("D2: the bridge flips the event-driven registry flag synchronously (no DB poll needed)", async () => {
    process.env.VERIFY_MERGE_WATCH_MS = "0";
    try {
      const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
        guarded: true,
        callerCallSid: "CA_reg_caller",
        legACallSid: "CA_reg_legA",
      });
      expect(vs.isBridgedSession(s.sessionId)).toBe(false);
      // First sight arms the watch and defers one cycle.
      expect(await vs.maybeBridgeGuarded(s.sessionId)).toBe(false);
      expect(vs.isBridgedSession(s.sessionId)).toBe(false);
      // The successful bridge sets the flag on return — the media-stream
      // analyzer path sees BRIDGED on the next audio window, before any
      // DB refresh poll could run.
      expect(await vs.maybeBridgeGuarded(s.sessionId)).toBe(true);
      expect(vs.isBridgedSession(s.sessionId)).toBe(true);
      // A terminal transition clears the flag (maps can't grow unboundedly).
      await vs.onMergeDetected(s.sessionId, { inCall: true });
      expect(vs.isBridgedSession(s.sessionId)).toBe(false);
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
    // …the caller is NOT sent to the legacy verdict announcement and Leg A
    // is NOT hung up. (Leg B already ended — that completion is what fired
    // the force-bridge — and the ring-test leg is terminated.)
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

  it("BRIDGED: in-call merge detection tears down the whole conference", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_pm_caller",
      legACallSid: "CA_pm_legA",
      legBCallSid: "CA_pm_legB",
      ringTestCallSid: "CA_pm_rt",
    });
    await vs.onMergeDetected(s.sessionId);
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.MERGE_DETECTED);
    // In-call verdict: BOTH bridge legs (and Leg B) are redirected to the
    // conference-ending announcement (say + hangup), the ring test is hung
    // up, and the live conference is completed by SID (belt-and-braces — a
    // REST redirect cannot pull a leg out of an active <Dial><Conference>).
    expect(
      updatedCalls.some(
        (u) => u.sid === "CA_pm_caller" && String(u.url).includes("notify-conference-merge"),
      ),
    ).toBe(true);
    expect(
      updatedCalls.some(
        (u) => u.sid === "CA_pm_legA" && String(u.url).includes("notify-conference-merge"),
      ),
    ).toBe(true);
    expect(
      updatedCalls.some(
        (u) => u.sid === "CA_pm_legB" && String(u.url).includes("notify-conference-merge"),
      ),
    ).toBe(true);
    expect(updatedCalls.some((u) => u.sid === "CA_pm_rt" && u.status === "completed")).toBe(true);
    expect(
      conferenceUpdates.some(
        (u) => u.conference === `verify-${s.sessionId}` && u.status === "completed",
      ),
    ).toBe(true);
    // Idempotent: a second detection is a no-op on a terminal session.
    const updCount = updatedCalls.length;
    await vs.onMergeDetected(s.sessionId, { inCall: true });
    expect(updatedCalls.length).toBe(updCount);
  });

  it("BRIDGED: caller hangup → COMPLETED + Leg A released by the conference, not a REST redirect", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_b_caller",
      legACallSid: "CA_b_legA",
    });
    const updBefore = updatedCalls.length;
    await vs.onCallCompleted(s.sessionId, "caller", "CA_b_caller", "duration=120s");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.COMPLETED);
    expect(after.completedAt).not.toBeNull();
    // The surviving party is inside an active <Dial><Conference> — a REST
    // redirect cannot reach them, so NONE is attempted. endConferenceOnExit
    // on the departed leg ends the conference; the survivor's Dial returns
    // and its post-Dial <Redirect> plays notify-partner-ended and hangs up
    // (asserted in the bridge-TwiML tests below). With a live conference
    // (mock default) the survivor is NOT REST-hung-up either.
    const added = updatedCalls.slice(updBefore);
    expect(added.some((u) => u.sid === "CA_b_legA")).toBe(false);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("GUARDED_CALL_ENDED");
    expect(types).toContain(vs.VState.COMPLETED);
  });

  it("BRIDGED: callee (Leg A) hangup → COMPLETED + caller released by the conference, not a REST redirect", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_b2_caller",
      legACallSid: "CA_b2_legA",
    });
    const updBefore = updatedCalls.length;
    await vs.onCallCompleted(s.sessionId, "legA", "CA_b2_legA", "duration=45s");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.COMPLETED);
    // Same contract as the caller-hangup direction: no REST redirect/hangup
    // against a leg that is inside the (mock-live) conference.
    const added = updatedCalls.slice(updBefore);
    expect(added.some((u) => u.sid === "CA_b2_caller")).toBe(false);
  });

  it("BRIDGED: a survivor stuck OUTSIDE the conference (lobby) is hung up by REST", async () => {
    // The caller joins with startConferenceOnEnter: false — if the anchor
    // (Leg A) dies before ever starting the conference, the caller is stuck
    // in a pre-start lobby with no end trigger. With NO live conference the
    // engine must hang the survivor up directly.
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_lob_caller",
      legACallSid: "CA_lob_legA",
    });
    twilioMock.listResult = []; // no in-progress conference
    try {
      await vs.onCallCompleted(s.sessionId, "legA", "CA_lob_legA", "duration=5s");
      expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.COMPLETED);
      expect(
        updatedCalls.some((u) => u.sid === "CA_lob_caller" && u.status === "completed"),
      ).toBe(true);
    } finally {
      twilioMock.listResult = null;
    }
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
    // No leg param → backwards-compatible anchor role.
    expect(body).toContain('startConferenceOnEnter="true"');
    expect(body).toContain('endConferenceOnExit="true"');
    // No verdict announcement, no hangup — this is a LIVE bridge.
    expect(body).not.toContain("<Say");
    expect(body).not.toContain("<Hangup");
    // …but a post-Dial <Redirect> so the SURVIVING leg hears the
    // partner-ended notice when the conference ends (a REST redirect cannot
    // reach a call inside an active <Dial><Conference>).
    expect(body).toContain("/api/verify/twiml/notify-partner-ended?sid=abc123");
  });

  it("guarded-bridge TwiML: the caller leg is the JOINER (never duplicates the conference)", async () => {
    const res = await postForm("/api/verify/twiml/guarded-bridge?sid=abc123&leg=caller");
    const body = await res.text();
    // startConferenceOnEnter=false: a caller arriving before the anchor waits
    // in the lobby instead of spawning a duplicate same-name conference.
    expect(body).toContain('startConferenceOnEnter="false"');
    expect(body).toContain('endConferenceOnExit="true"');
    expect(body).toContain("verify-abc123");
    expect(body).toContain("/api/verify/twiml/notify-partner-ended?sid=abc123");
  });

  it("notify-partner-ended TwiML announces and hangs up", async () => {
    const res = await postForm("/api/verify/twiml/notify-partner-ended?sid=abc123");
    const body = await res.text();
    expect(body).toContain("The other party has ended the call.");
    expect(body).toContain("<Hangup");
  });

  it("caller-wait self-heals into the bridge conference once BRIDGED", async () => {
    // The REST redirect is the fast path; if it raced/failed, the parked
    // caller's next poll must join the conference itself (as JOINER) instead
    // of sitting in silence forever.
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_cw_caller",
      legACallSid: "CA_cw_legA",
    });
    const res = await postForm(`/api/verify/twiml/caller-wait?sid=${s.sessionId}`);
    const body = await res.text();
    expect(body).toContain("<Conference");
    expect(body).toContain(`verify-${s.sessionId}`);
    expect(body).toContain('startConferenceOnEnter="false"');
    expect(body).not.toContain("<Pause");
  });

  it("caller-wait keeps parking (short cadence) while verification runs", async () => {
    const s = await makeSession(vs.VState.CALLER_HOLDING, {
      guarded: true,
      callerCallSid: "CA_cw2_caller",
    });
    const res = await postForm(`/api/verify/twiml/caller-wait?sid=${s.sessionId}`);
    const body = await res.text();
    expect(body).toContain('<Pause length="10"');
    expect(body).toContain(`/api/verify/twiml/caller-wait?sid=${s.sessionId}`);
    expect(body).not.toContain("<Conference");
  });

  it("leg-a-hold self-heals into the bridge conference once BRIDGED (anchor role)", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_lah_caller",
      legACallSid: "CA_lah_legA",
    });
    const res = await postForm(`/api/verify/twiml/leg-a-hold?sid=${s.sessionId}`);
    const body = await res.text();
    expect(body).toContain("<Conference");
    expect(body).toContain('startConferenceOnEnter="true"');
    expect(body).not.toContain("<Pause");
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
import {
  handleMergeToneFire,
  handleSpeakerphoneSuspicious,
  verificationStreamDetectedHandler,
  relayStreamUrl,
} from "./verification-stream";
import {
  mergeToneHandler,
  verificationStatusHandler,
  verificationTwimlHandler,
  verificationVoiceprintHandler,
  verificationVoiceprintTranscriptionHandler,
} from "./verification-webhooks";
import { voiceWebhookHandler } from "./twilio-voice";

const hookApp = new Hono();
hookApp.post("/api/verify/twiml/:kind", verificationTwimlHandler);
hookApp.post("/api/verify/status/:leg", verificationStatusHandler);
hookApp.post("/api/verify/gather/merge", verificationGatherHandler);
hookApp.post("/api/verify/gather/leg-a-accept", verificationGatherLegAAcceptHandler);
hookApp.post("/api/verify/gather/leg-a-ready", verificationGatherLegAReadyHandler);
hookApp.post("/api/verify/voiceprint", verificationVoiceprintHandler);
hookApp.post("/api/verify/voiceprint-transcription", verificationVoiceprintTranscriptionHandler);
hookApp.get("/api/verify/tone.wav", verificationToneHandler);
hookApp.get("/api/verify/merge-tone.wav", mergeToneHandler);
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

  it("notify-conference-merge TwiML plays the conference-ending prompt + <Hangup/>", async () => {
    const res = await postForm("/api/verify/twiml/notify-conference-merge?sid=abc123");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("We've identified a conference call. This call is ending now.");
    expect(body).toContain("<Hangup");
  });

  it("notify-conference-merge prompt is env-overridable (VERIFY_PROMPT_CONFERENCE_ENDING)", async () => {
    process.env.VERIFY_PROMPT_CONFERENCE_ENDING = "Custom conference ending notice.";
    try {
      const res = await postForm("/api/verify/twiml/notify-conference-merge?sid=abc123");
      const body = await res.text();
      expect(body).toContain("Custom conference ending notice.");
      expect(body).toContain("<Hangup");
    } finally {
      delete process.env.VERIFY_PROMPT_CONFERENCE_ENDING;
    }
  });

  it("merge-tone.wav endpoint serves the armed DTMF-9 tone as audio/wav", async () => {
    const res = await hookApp.request("/api/verify/merge-tone.wav");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/wav");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4).toString("ascii")).toBe("RIFF");
    // Default 0.5s beep @ 8 kHz 16-bit mono = 8000 data bytes + 44 header.
    expect(buf.length).toBe(44 + Math.round(0.5 * 8000) * 2);
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
    // Current acceptance prompt (verifyPrompts().accept — CALL-FLOW.md Phase 2).
    expect(body).toContain(
      "You are receiving a call from an inmate. Do not merge or transfer this call. Please press 1 if you accept.",
    );
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

  it("press 1 to accept → Leg B PRE-ORIGINATED (already dialing), Leg A parked on hold loop", async () => {
    const s = await makeSession(vs.VState.LEG_A_DIALING);
    const res = await postForm(`/api/verify/gather/leg-a-accept?sid=${s.sessionId}&a=0`, {
      CallSid: "CA_lega_ivr",
      Digits: "1",
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    // Pre-origination: first press-1 immediately starts Leg B ringing so the
    // second call arrives instantly (single-press flow — the ready-press step
    // is bypassed for non-guarded sessions; Leg A is parked on the hold loop).
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.LEG_B_DIALING);
    expect(after.legBCallSid).toMatch(/^CA_mock_/);
    const legB = createdCalls.find(
      (c) => String(c.url).includes("/twiml/leg-b") && String(c.url).includes(s.sessionId),
    );
    expect(legB?.timeout).toBe(15);
    expect(body).toContain("Thank you. Please stay on the line while your call is connected.");
    expect(body).toContain("/api/verify/twiml/leg-a-hold?sid=");
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
    // Current merge verdict (verifyPrompts().mergeDetected) + hangup.
    expect(await res.text()).toContain(
      "We detected a potential speakerphone or merged call on this line. This call will now end. Goodbye.",
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

  it("voice webhook guarded branch parks the caller in the non-blocking caller-wait loop", async () => {
    const s = await makeSession(vs.VState.INITIATED, { guarded: true });
    const res = await postForm("/api/voice/twiml", {
      guarded: s.sessionId,
      CallSid: "CA_sdk_wh",
      To: "+61400000000",
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("Please wait while we connect your call.");
    // Non-blocking park: <Pause> + self-redirect — NEVER <Dial><Conference>
    // (a REST redirect cannot pull a call out of an active Dial, and a second
    // leg dialling the same not-yet-started conference would spawn a
    // duplicate conference with both parties alone). The engine moves this
    // leg into the bridge conference at bridge time.
    expect(body).toContain("<Pause");
    expect(body).toContain(`/api/verify/twiml/caller-wait?sid=${s.sessionId}`);
    expect(body).not.toContain("<Conference");
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
    // TwiML is XML — query-string '&' is emitted correctly escaped as '&amp;'.
    expect(gBody).toContain(`/api/verify/gather/leg-a-accept?sid=${g.sessionId}&amp;a=0`);
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

  it("guarded press-1 records the voice-ID phrase (transcribed) and holds in the voice-ID wait loop", async () => {
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
    expect(body).toContain("<Record");
    expect(body).toContain(`/api/verify/voiceprint?sid=${s.sessionId}`);
    // Phrase verification: the recording is transcribed and the transcript is
    // posted back for the fuzzy match.
    expect(body).toContain('transcribe="true"');
    expect(body).toContain(`/api/verify/voiceprint-transcription?sid=${s.sessionId}`);
    // Failed-action fallback: the voice-ID wait loop — NOT the ready gather
    // (no bridge without a passing voice-ID).
    expect(body).toContain(`/api/verify/twiml/voice-id-wait?sid=${s.sessionId}`);
    expect(body).not.toContain("/api/verify/gather/leg-a-ready?sid=");
    expect(body).not.toContain("/api/verify/twiml/leg-a-hold?sid=");
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.CALL_ACCEPTED);
    // Leg B starts only from the SECOND press-1 after a PASSING voice-ID.
    expect(
      createdCalls.slice(before).some((c) => String(c.url).includes("/twiml/leg-b")),
    ).toBe(false);
    expect((await vs.findSession(s.sessionId))!.legBCallSid).toBeNull();
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("GUARDED_VOICEPRINT_STEP");
  });

  it("voiceprint action starts the voice-ID attempt and holds in the wait loop (no Leg B)", async () => {
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
    // The action hands the callee to the voice-ID wait loop — the second
    // press-1 gather is only served from there AFTER the voice-ID passes.
    expect(body).toContain(`/api/verify/twiml/voice-id-wait?sid=${s.sessionId}`);
    expect(body).not.toContain("/api/verify/gather/leg-a-ready?sid=");
    expect(body).not.toContain("/api/verify/twiml/leg-a-hold?sid=");
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.CALL_ACCEPTED);
    expect(
      createdCalls.slice(before).some((c) => String(c.url).includes("/twiml/leg-b")),
    ).toBe(false);
  });

  it("guarded second press-1 after a PASSING voice-ID originates Leg B and parks Leg A", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_vp2_caller",
      legACallSid: "CA_vp2_legA",
    });
    // Simulate a passing voice-ID: recording noted strong + matching transcript.
    vs.voiceIdBeginAttempt(s.sessionId);
    vs.voiceIdNoteRecording(s.sessionId, { usable: true, strong: true, detail: "test" });
    await vs.voiceIdNoteTranscript(s.sessionId, {
      status: "completed",
      text: "My voice identifies me",
    });
    expect(await vs.isVoiceIdPassed(s.sessionId)).toBe(true);
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

/* GUARDED MODE ONLY: voice-ID enforcement — phrase transcription + voiceprint */
/* -------------------------------------------------------------------------- */

describe("voice-ID phrase matcher", () => {
  it("matches the expected phrase and the 'my name' variant, case-insensitive", () => {
    expect(vs.voiceIdPhraseMatches("my voice identifies me")).toBe(true);
    expect(vs.voiceIdPhraseMatches("My Voice Identifies Me.")).toBe(true);
    expect(vs.voiceIdPhraseMatches("my name identifies me")).toBe(true);
    expect(vs.voiceIdPhraseMatches("MY NAME IDENTIFIES ME")).toBe(true);
  });

  it("tolerates small STT substitutions (>=3 of 4 content tokens)", () => {
    expect(vs.voiceIdPhraseMatches("my voice identify me")).toBe(true); // identify≈identifies
    expect(vs.voiceIdPhraseMatches("voice identifies me")).toBe(true); // "my" dropped
    expect(vs.voiceIdPhraseMatches("uh, my voice identifies me")).toBe(true);
    expect(vs.voiceIdPhraseMatches("my voice identified me")).toBe(true);
  });

  it("rejects wrong and empty transcripts", () => {
    expect(vs.voiceIdPhraseMatches("")).toBe(false);
    expect(vs.voiceIdPhraseMatches("hello world")).toBe(false);
    expect(vs.voiceIdPhraseMatches("my name is john")).toBe(false); // only my+name
    expect(vs.voiceIdPhraseMatches("yes I accept the call")).toBe(false);
  });
});

describe("voice-ID enforcement (guarded)", () => {
  /** Drive one full voice-ID attempt through the state machine. */
  async function driveAttempt(
    sid: string,
    opts: { strong?: boolean; transcript?: string | null },
  ): Promise<void> {
    vs.voiceIdBeginAttempt(sid);
    vs.voiceIdNoteRecording(sid, {
      usable: true,
      strong: opts.strong ?? true,
      detail: "test",
    });
    if (opts.transcript != null) {
      await vs.voiceIdNoteTranscript(sid, { status: "completed", text: opts.transcript });
    }
  }

  it("good transcript + strong voiceprint → wait loop serves the ready gather, press-1 bridges the flow", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_vid_caller",
      legACallSid: "CA_vid_legA",
    });
    await driveAttempt(s.sessionId, { strong: true, transcript: "my voice identifies me" });
    expect(await vs.isVoiceIdPassed(s.sessionId)).toBe(true);
    // The wait loop now serves the second press-1 gather.
    const wait = await postForm(`/api/verify/twiml/voice-id-wait?sid=${s.sessionId}`);
    const waitBody = await wait.text();
    expect(waitBody).toContain(
      "Do not end this call. You will receive a second call — please answer it. It will end by itself and return you to this call. Press 1 to continue.",
    );
    expect(waitBody).toContain(`/api/verify/gather/leg-a-ready?sid=${s.sessionId}`);
    // …and that press-1 originates Leg B (the only bridge path).
    const before = createdCalls.length;
    await postForm(`/api/verify/gather/leg-a-ready?sid=${s.sessionId}&a=0`, {
      CallSid: "CA_vid_legA",
      Digits: "1",
    });
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_DIALING);
    expect(
      createdCalls.slice(before).some((c) => String(c.url).includes("/twiml/leg-b")),
    ).toBe(true);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("VOICE_ID_PASSED");
  });

  it("transcription callback feeds the phrase match (webhook path)", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_vidc_caller",
      legACallSid: "CA_vidc_legA",
    });
    vs.voiceIdBeginAttempt(s.sessionId);
    vs.voiceIdNoteRecording(s.sessionId, { usable: true, strong: true, detail: "test" });
    const res = await postForm(`/api/verify/voiceprint-transcription?sid=${s.sessionId}`, {
      CallSid: "CA_vidc_legA",
      TranscriptionStatus: "completed",
      TranscriptionText: "My voice identifies me",
    });
    expect(res.status).toBe(200);
    expect(await vs.isVoiceIdPassed(s.sessionId)).toBe(true);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("VOICE_ID_TRANSCRIPT");
  });

  it("wrong transcript → wait loop re-prompts and re-records (transcribed), no ready gather", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_vw_caller",
      legACallSid: "CA_vw_legA",
    });
    await driveAttempt(s.sessionId, { strong: true, transcript: "sure thing buddy" });
    expect(await vs.isVoiceIdPassed(s.sessionId)).toBe(false);
    const res = await postForm(`/api/verify/twiml/voice-id-wait?sid=${s.sessionId}`);
    const body = await res.text();
    expect(body).toContain("That didn't match. Please try again.");
    expect(body).toContain("<Record");
    expect(body).toContain('transcribe="true"');
    expect(body).toContain(`/api/verify/voiceprint?sid=${s.sessionId}`);
    expect(body).not.toContain("/api/verify/gather/leg-a-ready?sid=");
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("VOICE_ID_FAILED");
  });

  it("empty transcript → re-records (no fallback accept for a received-but-useless transcript)", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_ve_caller",
      legACallSid: "CA_ve_legA",
    });
    await driveAttempt(s.sessionId, { strong: true, transcript: "" });
    const res = await postForm(`/api/verify/twiml/voice-id-wait?sid=${s.sessionId}`);
    const body = await res.text();
    expect(body).toContain("<Record"); // re-record, not the ready gather
    expect(body).not.toContain("/api/verify/gather/leg-a-ready?sid=");
  });

  it("3 failed attempts → polite failure prompt, session FAILED, caller notified, NO bridge", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_v3_caller",
      legACallSid: "CA_v3_legA",
    });
    const before = createdCalls.length;
    for (let i = 0; i < vs.VOICE_ID_MAX_ATTEMPTS; i++) {
      await driveAttempt(s.sessionId, { strong: true, transcript: "not the phrase" });
    }
    const res = await postForm(`/api/verify/twiml/voice-id-wait?sid=${s.sessionId}`);
    const body = await res.text();
    expect(body).toContain("We could not verify your voice. This call will now end. Goodbye.");
    expect(body).toContain("<Hangup");
    expect(body).not.toContain("<Record");
    await tick(150); // let onVoiceIdFailed settle
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.FAILED);
    expect(after.failureReason).toBe("Voice-ID verification failed");
    expect(
      updatedCalls.some(
        (u) => u.sid === "CA_v3_caller" && String(u.url).includes("notify-failed"),
      ),
    ).toBe(true);
    // Leg B was never originated — no bridge is possible.
    expect(
      createdCalls.slice(before).some((c) => String(c.url).includes("/twiml/leg-b")),
    ).toBe(false);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("VOICE_ID_EXHAUSTED");
  });

  it("transcript timeout + strong voiceprint → fallback accept (VOICE_ID_TRANSCRIPT_MISSING logged), flow bridges", async () => {
    const saved = process.env.VERIFY_VOICE_ID_TRANSCRIPT_TIMEOUT_MS;
    process.env.VERIFY_VOICE_ID_TRANSCRIPT_TIMEOUT_MS = "1"; // instant timeout
    try {
      const s = await makeSession(vs.VState.CALL_ACCEPTED, {
        guarded: true,
        callerCallSid: "CA_vt_caller",
        legACallSid: "CA_vt_legA",
      });
      // Recording noted strong; NO transcript ever arrives.
      await driveAttempt(s.sessionId, { strong: true, transcript: null });
      await tick(20);
      const res = await postForm(`/api/verify/twiml/voice-id-wait?sid=${s.sessionId}`);
      const body = await res.text();
      expect(body).toContain(`/api/verify/gather/leg-a-ready?sid=${s.sessionId}`);
      expect(await vs.isVoiceIdPassed(s.sessionId)).toBe(true);
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).toContain("VOICE_ID_TRANSCRIPT_MISSING");
      expect(types).toContain("VOICE_ID_PASSED");
    } finally {
      if (saved === undefined) delete process.env.VERIFY_VOICE_ID_TRANSCRIPT_TIMEOUT_MS;
      else process.env.VERIFY_VOICE_ID_TRANSCRIPT_TIMEOUT_MS = saved;
    }
  });

  it("transcript timeout + unusable voiceprint → re-records", async () => {
    const saved = process.env.VERIFY_VOICE_ID_TRANSCRIPT_TIMEOUT_MS;
    process.env.VERIFY_VOICE_ID_TRANSCRIPT_TIMEOUT_MS = "1";
    try {
      const s = await makeSession(vs.VState.CALL_ACCEPTED, {
        guarded: true,
        callerCallSid: "CA_vtu_caller",
        legACallSid: "CA_vtu_legA",
      });
      await driveAttempt(s.sessionId, { strong: false, transcript: null });
      await tick(20);
      const res = await postForm(`/api/verify/twiml/voice-id-wait?sid=${s.sessionId}`);
      const body = await res.text();
      expect(body).toContain("<Record"); // re-record
      expect(body).not.toContain("/api/verify/gather/leg-a-ready?sid=");
    } finally {
      if (saved === undefined) delete process.env.VERIFY_VOICE_ID_TRANSCRIPT_TIMEOUT_MS;
      else process.env.VERIFY_VOICE_ID_TRANSCRIPT_TIMEOUT_MS = saved;
    }
  });

  it("missing/failed recording → attempt fails, wait loop re-records", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_vnr_caller",
      legACallSid: "CA_vnr_legA",
    });
    // Voiceprint action with NO recording (record step failed/timed out).
    const res = await postForm(`/api/verify/voiceprint?sid=${s.sessionId}`, {
      CallSid: "CA_vnr_legA",
      RecordingUrl: "",
      RecordingDuration: "0",
    });
    expect(res.status).toBe(200);
    await tick(400); // processVoiceprint notes the unusable recording
    const wait = await postForm(`/api/verify/twiml/voice-id-wait?sid=${s.sessionId}`);
    const body = await wait.text();
    expect(body).toContain("That didn't match. Please try again.");
    expect(body).toContain("<Record");
    expect(body).not.toContain("/api/verify/gather/leg-a-ready?sid=");
  });

  it("NO BRIDGE without a passing voice-ID: ready press is gated back to the wait loop", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_vg_caller",
      legACallSid: "CA_vg_legA",
    });
    const before = createdCalls.length;
    const res = await postForm(`/api/verify/gather/leg-a-ready?sid=${s.sessionId}&a=0`, {
      CallSid: "CA_vg_legA",
      Digits: "1",
    });
    const body = await res.text();
    // Bounced to the voice-ID wait loop — not parked, no Leg B originated.
    expect(body).toContain(`/api/verify/twiml/voice-id-wait?sid=${s.sessionId}`);
    expect(body).not.toContain("/api/verify/twiml/leg-a-hold?sid=");
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.CALL_ACCEPTED);
    expect(
      createdCalls.slice(before).some((c) => String(c.url).includes("/twiml/leg-b")),
    ).toBe(false);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("VOICE_ID_GATE_BLOCKED");
  });

  it("pending verdict → wait loop holds the callee (short pause + re-poll)", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_vpnd_caller",
      legACallSid: "CA_vpnd_legA",
    });
    vs.voiceIdBeginAttempt(s.sessionId); // recording not yet noted → pending
    const res = await postForm(`/api/verify/twiml/voice-id-wait?sid=${s.sessionId}`);
    const body = await res.text();
    expect(body).toContain("<Pause");
    expect(body).toContain(`/api/verify/twiml/voice-id-wait?sid=${s.sessionId}`);
    expect(body).not.toContain("/api/verify/gather/leg-a-ready?sid=");
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.CALL_ACCEPTED);
  });

  it("D1: pending wait carries the poll counter on the self-redirect", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_d1w_caller",
      legACallSid: "CA_d1w_legA",
    });
    // No attempt begun (the <Record> action never fired) — still waiting.
    const res = await postForm(`/api/verify/twiml/voice-id-wait?sid=${s.sessionId}&w=4`);
    const body = await res.text();
    expect(body).toContain("<Pause");
    expect(body).toContain(`voice-id-wait?sid=${s.sessionId}&amp;w=5`);
  });

  it("D1: no <Record> action + poll cap → failed attempt counted, wait loop re-records (no infinite silence)", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_d1_caller",
      legACallSid: "CA_d1_legA",
    });
    // Below the cap with no attempt begun: keep holding (counter advances).
    const early = await postForm(
      `/api/verify/twiml/voice-id-wait?sid=${s.sessionId}&w=${vs.VOICE_ID_WAIT_MAX_POLLS - 1}`,
    );
    const earlyBody = await early.text();
    expect(earlyBody).toContain("<Pause");
    expect(earlyBody).toContain(`&amp;w=${vs.VOICE_ID_WAIT_MAX_POLLS}`);
    // At the cap the miss is counted as a FAILED attempt → the normal
    // re-record path (NOT an endless pause/redirect loop).
    const capped = await postForm(
      `/api/verify/twiml/voice-id-wait?sid=${s.sessionId}&w=${vs.VOICE_ID_WAIT_MAX_POLLS}`,
    );
    const cappedBody = await capped.text();
    expect(cappedBody).toContain("That didn't match. Please try again.");
    expect(cappedBody).toContain("<Record");
    expect(cappedBody).not.toContain("/api/verify/gather/leg-a-ready?sid=");
    const verdict = await vs.voiceIdVerdict(s.sessionId);
    expect(verdict.attempts).toBe(1);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("VOICE_ID_NO_ATTEMPT");
  });

  it("D1: 3 missed attempts (action never fires) → polite goodbye + session FAILED", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_d13_caller",
      legACallSid: "CA_d13_legA",
    });
    for (let i = 0; i < vs.VOICE_ID_MAX_ATTEMPTS; i++) {
      const v = await vs.voiceIdNoteMissedAttempt(s.sessionId);
      expect(v.status).toBe("failed");
      expect(v.attempts).toBe(i + 1);
      // The re-record TwiML served for failures 1-2 clears the latched
      // attempt so the NEXT miss can be counted (poll-cap path); the third
      // failure routes straight to the polite-goodbye branch instead.
      if (i < vs.VOICE_ID_MAX_ATTEMPTS - 1) vs.voiceIdAcknowledgeFailure(s.sessionId);
    }
    const res = await postForm(`/api/verify/twiml/voice-id-wait?sid=${s.sessionId}`);
    const body = await res.text();
    expect(body).toContain("We could not verify your voice. This call will now end. Goodbye.");
    expect(body).toContain("<Hangup");
    await tick(150); // let onVoiceIdFailed settle
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.FAILED);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types.filter((t) => t === "VOICE_ID_NO_ATTEMPT")).toHaveLength(3);
    expect(types).toContain("VOICE_ID_EXHAUSTED");
  });

  it("D3: stale transcript for attempt N is ignored once attempt N+1 has begun (VOICE_ID_TRANSCRIPT_STALE)", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_d3t_caller",
      legACallSid: "CA_d3t_legA",
    });
    vs.voiceIdBeginAttempt(s.sessionId, "RE_old");
    vs.voiceIdBeginAttempt(s.sessionId, "RE_new"); // re-record began
    // The OLD recording's transcript lands late — it must never decide the
    // new attempt (not even a passing phrase).
    await vs.voiceIdNoteTranscript(s.sessionId, {
      status: "completed",
      text: "my voice identifies me",
      recordingSid: "RE_old",
    });
    const verdict = await vs.voiceIdVerdict(s.sessionId);
    expect(verdict.status).toBe("pending");
    expect(verdict.attempts).toBe(2);
    // The CURRENT recording's transcript still lands normally.
    await vs.voiceIdNoteTranscript(s.sessionId, {
      status: "completed",
      text: "sure thing buddy",
      recordingSid: "RE_new",
    });
    const after = await vs.voiceIdVerdict(s.sessionId);
    expect(after.status).toBe("failed"); // phrase mismatch decides attempt 2
    expect(after.attempts).toBe(2);
  });

  it("D3: stale profiling note/baseline for attempt N ignored after attempt N+1 begins", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_d3n_caller",
      legACallSid: "CA_d3n_legA",
    });
    vs.voiceIdBeginAttempt(s.sessionId, "RE_old");
    vs.voiceIdBeginAttempt(s.sessionId, "RE_new"); // re-record began
    // Attempt N's slow processVoiceprint fetch finally finishes — its note
    // must NOT fail the new attempt, and its baseline must not install.
    vs.voiceIdNoteRecording(s.sessionId, {
      usable: false,
      strong: false,
      detail: "stale fetch from attempt N",
      recordingSid: "RE_old",
    });
    const verdict = await vs.voiceIdVerdict(s.sessionId);
    expect(verdict.status).toBe("pending"); // NOT failed by the stale note
    expect(verdict.attempts).toBe(2);
    expect(vs.voiceIdIsCurrentRecording(s.sessionId, "RE_old")).toBe(false);
    expect(vs.voiceIdIsCurrentRecording(s.sessionId, "RE_new")).toBe(true);
    // The CURRENT attempt's note lands normally and decides it.
    vs.voiceIdNoteRecording(s.sessionId, {
      usable: false,
      strong: false,
      detail: "attempt N+1 note",
      recordingSid: "RE_new",
    });
    const after = await vs.voiceIdVerdict(s.sessionId);
    expect(after.status).toBe("failed"); // unusable recording → re-record
    expect(after.attempts).toBe(2);
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
