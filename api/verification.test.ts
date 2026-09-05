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
// Strike-3 warning timing is completion-driven from the MEASURED asset
// duration (speakerphoneWarningAudioMs) + buffer; ladder tests shorten both
// via VERIFY_SPEAKERPHONE_WARNING_AUDIO_MS / *_UNMUTE_BUFFER_MS.

/** Recorded Twilio REST interactions from the mocked client. */
const twilioMock = vi.hoisted(() => ({
  createdCalls: [] as Array<Record<string, unknown>>,
  updatedCalls: [] as Array<{ sid: string; url?: string; status?: string }>,
  participantUpdates: [] as Array<{
    conference: string;
    participant: string;
    announceUrl?: string;
    announceMethod?: string;
    muted?: boolean;
  }>,
  conferenceUpdates: [] as Array<{
    conference: string;
    status?: string;
    announceUrl?: string;
    announceMethod?: string;
  }>,
  // Ordered telephony-op journal (participant mute/unmute/announce and
  // conference announce/complete) — the strike-3 contract "the inmate mute
  // is confirmed BEFORE warning playback" is asserted from this sequence.
  opLog: [] as string[],
  // Optional fault injection: when set, participants().update throws this
  // error (e.g. { status: 500 } to fail the strike-3 inmate mute/unmute).
  participantUpdateError: null as { status?: number; code?: number } | null,
  // Optional fault injection for conference-LEVEL updates (the strike-3
  // warning announce to the conference / conference completion).
  conferenceUpdateError: null as { status?: number; code?: number } | null,
  /** SMS sent via the Messages API (SMS_PROVIDER=twilio transport). */
  sentMessages: [] as Array<{ to: string; from: string; body: string }>,
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
          update: async (opts: { announceUrl?: string; announceMethod?: string; muted?: boolean }) => {
            twilioMock.opLog.push(
              `p:${participantSid}:${opts.muted === true ? "mute" : opts.muted === false ? "unmute" : "announce"}`,
            );
            if (twilioMock.participantUpdateError) {
              const e = twilioMock.participantUpdateError;
              throw Object.assign(new Error("mock participant update failure"), e);
            }
            twilioMock.participantUpdates.push({
              conference: name,
              participant: participantSid,
              ...opts,
            });
            return {};
          },
        }),
        update: async (opts: { status?: string; announceUrl?: string; announceMethod?: string }) => {
          twilioMock.opLog.push(
            `c:${name}:${opts.status === "completed" ? "complete" : "announce"}`,
          );
          if (twilioMock.conferenceUpdateError) {
            const e = twilioMock.conferenceUpdateError;
            throw Object.assign(new Error("mock conference update failure"), e);
          }
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
    messages: {
      create: async (opts: { to: string; from: string; body: string }) => {
        twilioMock.sentMessages.push(opts);
        return { sid: `SM_mock_${twilioMock.sentMessages.length}` };
      },
    },
  };
  const factory = (() => fakeClient) as unknown as typeof realTwilio;
  // verification-webhooks.ts uses twilio.twiml.VoiceResponse for real TwiML,
  // and the SMS-inbound webhook uses validateRequest for signed posts.
  Object.assign(factory, {
    twiml: realTwilio.twiml,
    jwt: realTwilio.jwt,
    validateRequest: realTwilio.validateRequest,
  });
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

describe("two-phase challenge config (corrected architecture)", () => {
  it("stream readiness timeout defaults to 45s (env-overridable)", () => {
    const saved = process.env.VERIFY_STREAM_READY_TIMEOUT_MS;
    delete process.env.VERIFY_STREAM_READY_TIMEOUT_MS;
    try {
      // 45s default: outlives a Render free-tier cold start (~22s) so a
      // sleeping relay cannot independently break first-call monitoring.
      expect(vs.streamReadyTimeoutMs()).toBe(45_000);
      process.env.VERIFY_STREAM_READY_TIMEOUT_MS = "5000";
      expect(vs.streamReadyTimeoutMs()).toBe(5_000);
    } finally {
      if (saved === undefined) delete process.env.VERIFY_STREAM_READY_TIMEOUT_MS;
      else process.env.VERIFY_STREAM_READY_TIMEOUT_MS = saved;
    }
  });

  it("transition tolerance defaults to 1000ms (env-overridable)", () => {
    const saved = process.env.VERIFY_TRANSITION_TOLERANCE_MS;
    delete process.env.VERIFY_TRANSITION_TOLERANCE_MS;
    try {
      expect(vs.transitionToleranceMs()).toBe(1_000);
      process.env.VERIFY_TRANSITION_TOLERANCE_MS = "2500";
      expect(vs.transitionToleranceMs()).toBe(2_500);
    } finally {
      if (saved === undefined) delete process.env.VERIFY_TRANSITION_TOLERANCE_MS;
      else process.env.VERIFY_TRANSITION_TOLERANCE_MS = saved;
    }
  });

  it("currentDetectionPhase derives from persisted timestamps (restart-safe)", () => {
    // No challenge started: only the armed readiness phase is visible.
    expect(
      vs.currentDetectionPhase({
        challengeStartedAt: null,
        promptEndsAt: null,
        detectionPhase: vs.DetectionPhase.AWAITING_STREAM_READY,
      }),
    ).toBe(vs.DetectionPhase.AWAITING_STREAM_READY);
    expect(
      vs.currentDetectionPhase({
        challengeStartedAt: null,
        promptEndsAt: null,
        detectionPhase: null,
      }),
    ).toBeNull();
    // Phase 1 while now < promptEndsAt + tolerance.
    const started = new Date(Date.now() - 1_000);
    expect(
      vs.currentDetectionPhase({
        challengeStartedAt: started,
        promptEndsAt: new Date(Date.now() + 5_000),
        detectionPhase: vs.DetectionPhase.PROMPT_LIGHT,
      }),
    ).toBe(vs.DetectionPhase.PROMPT_LIGHT);
    // Phase 2 once promptEndsAt + tolerance has passed.
    expect(
      vs.currentDetectionPhase({
        challengeStartedAt: new Date(Date.now() - 60_000),
        promptEndsAt: new Date(Date.now() - 30_000),
        detectionPhase: vs.DetectionPhase.PROMPT_LIGHT,
      }),
    ).toBe(vs.DetectionPhase.LOUD_DTMF);
  });

  it("detectionIsLive requires BOTH stream-ready and a started challenge", () => {
    expect(vs.detectionIsLive({ streamReadyAt: null, challengeStartedAt: null })).toBe(false);
    expect(vs.detectionIsLive({ streamReadyAt: new Date(), challengeStartedAt: null })).toBe(false);
    expect(vs.detectionIsLive({ streamReadyAt: new Date(), challengeStartedAt: new Date() })).toBe(true);
  });

  it("merge tone pair 852+1336 Hz is DTMF-8 (frequencies unchanged)", () => {
    expect(vs.MERGE_TONE_DIGIT).toBe("8");
  });
});

describe("forensic precision config", () => {
  it("forensics warm-up defaults to 2000ms (env-overridable)", () => {
    const saved = process.env.VERIFY_FORENSICS_WARMUP_MS;
    delete process.env.VERIFY_FORENSICS_WARMUP_MS;
    try {
      expect(vs.forensicsWarmupMs()).toBe(2_000);
      process.env.VERIFY_FORENSICS_WARMUP_MS = "12000";
      expect(vs.forensicsWarmupMs()).toBe(12_000);
      process.env.VERIFY_FORENSICS_WARMUP_MS = "not-a-number";
      expect(vs.forensicsWarmupMs()).toBe(2_000);
    } finally {
      if (saved === undefined) delete process.env.VERIFY_FORENSICS_WARMUP_MS;
      else process.env.VERIFY_FORENSICS_WARMUP_MS = saved;
    }
  });

  it("strike-3 unmute is completion-driven: MEASURED warning-asset duration (16 656ms) + buffer, env-overridable", () => {
    const savedAudio = process.env.VERIFY_SPEAKERPHONE_WARNING_AUDIO_MS;
    const savedBuf = process.env.VERIFY_SPEAKERPHONE_WARNING_UNMUTE_BUFFER_MS;
    delete process.env.VERIFY_SPEAKERPHONE_WARNING_AUDIO_MS;
    delete process.env.VERIFY_SPEAKERPHONE_WARNING_UNMUTE_BUFFER_MS;
    try {
      // Not a guessed fixed timer: derived from the exact rendered asset we
      // serve (266 496 frames @ 16 kHz = 16 656ms) plus a delivery buffer.
      expect(vs.speakerphoneWarningAudioMs()).toBe(16_656);
      expect(vs.speakerphoneWarningUnmuteBufferMs()).toBe(1_500);
      process.env.VERIFY_SPEAKERPHONE_WARNING_AUDIO_MS = "300";
      process.env.VERIFY_SPEAKERPHONE_WARNING_UNMUTE_BUFFER_MS = "250";
      expect(vs.speakerphoneWarningAudioMs()).toBe(300);
      expect(vs.speakerphoneWarningUnmuteBufferMs()).toBe(250);
      process.env.VERIFY_SPEAKERPHONE_WARNING_AUDIO_MS = "not-a-number";
      expect(vs.speakerphoneWarningAudioMs()).toBe(16_656);
    } finally {
      if (savedAudio === undefined) delete process.env.VERIFY_SPEAKERPHONE_WARNING_AUDIO_MS;
      else process.env.VERIFY_SPEAKERPHONE_WARNING_AUDIO_MS = savedAudio;
      if (savedBuf === undefined) delete process.env.VERIFY_SPEAKERPHONE_WARNING_UNMUTE_BUFFER_MS;
      else process.env.VERIFY_SPEAKERPHONE_WARNING_UNMUTE_BUFFER_MS = savedBuf;
    }
  });

  it("save-only voice ID: capture is fresh only on the same UTC calendar day", () => {
    const noon = new Date(Date.UTC(2025, 5, 15, 12, 0, 0));
    expect(vs.voiceIdFreshForToday(null, noon)).toBe(false);
    expect(vs.voiceIdFreshForToday(new Date(Date.UTC(2025, 5, 15, 0, 0, 0)), noon)).toBe(true);
    expect(vs.voiceIdFreshForToday(new Date(Date.UTC(2025, 5, 15, 23, 59, 59)), noon)).toBe(true);
    // Prior/next UTC day → never reused, even by a second.
    expect(vs.voiceIdFreshForToday(new Date(Date.UTC(2025, 5, 14, 23, 59, 59)), noon)).toBe(false);
    expect(
      vs.voiceIdFreshForToday(new Date(Date.UTC(2025, 5, 16, 0, 0, 0)), new Date(Date.UTC(2025, 5, 15, 23, 59, 59))),
    ).toBe(false);
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

  it("machine/voicemail AMD NEVER human-confirms: late verdict after Leg B answer is DETECTION_INCONCLUSIVE", async () => {
    // With asyncAmd the machine verdict arrives AFTER the answer callback.
    // A machine answer cannot confirm a human took the call — the old
    // log-only ignore (an effective human-confirmation) is gone; the session
    // is torn down as inconclusive, never a pass.
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
      guarded: true,
      callerCallSid: "CA_amd_caller",
      legACallSid: "CA_amd_legA",
      legBCallSid: "CA_amd_legB",
    });
    await vs.onVoicemailDetected(s.sessionId, "machine_end_beep");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.DETECTION_INCONCLUSIVE);
    // Full teardown: every leg hung up (a REST status=completed pulls legs
    // out of <Dial><Conference>) and the conference completed by SID.
    expect(updatedCalls.some((u) => u.sid === "CA_amd_legB" && u.status === "completed")).toBe(true);
    expect(updatedCalls.some((u) => u.sid === "CA_amd_legA" && u.status === "completed")).toBe(true);
    expect(conferenceUpdates.some((u) => u.status === "completed")).toBe(true);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("AMD_MACHINE_AFTER_ANSWER");
    expect(types).toContain("DETECTION_INCONCLUSIVE");
    expect(types).not.toContain("AMD_LATE_MACHINE_IGNORED");
  });

  it("non-guarded: machine verdict after Leg B answer is also DETECTION_INCONCLUSIVE (never human-confirmed)", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
      callerCallSid: "CA_amdn_caller",
      legACallSid: "CA_amdn_legA",
      legBCallSid: "CA_amdn_legB",
    });
    await vs.onVoicemailDetected(s.sessionId, "machine_end_beep");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.DETECTION_INCONCLUSIVE);
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

/* -------------------------------------------------------------------------- */
/* Speakerphone strike ladder (2026-09-05 spec) + Call Waiting state tests     */
/*                                                                            */
/* STRIKE SEMANTICS: ONE strike per DISTINCT confirmed episode, recorded at    */
/* episode ONSET (confirmation). Repeated detector frames inside ONE           */
/* continuous suspicious period are refires — never extra strikes. A new       */
/* strike requires the previous episode to end, audio to be normal for the     */
/* recovery period (the detector's fingerprint-clean clear streak), and the    */
/* detector to rearm. Strike 1-2: record only. Strike 3: WARNING FLAG (mute    */
/* the inmate FIRST → play the warning to the conference → unmute on measured  */
/* playback completion → resume; count stays 3). Strike 4: SUPREME FLAG, only  */
/* after a DELIVERED warning. Leg B NEVER gets a detection tone — the legacy   */
/* merge-tone/challenge-noise injection path was removed on 2026-09-05.        */
/* -------------------------------------------------------------------------- */

const ladderSession = (tag: string) =>
  makeSession(vs.VState.BRIDGED, {
    guarded: true,
    callerCallSid: `CA_${tag}_caller`,
    legACallSid: `CA_${tag}_legA`,
    legBCallSid: `CA_${tag}_legB`,
  });
const epOnset = (sid: string, detail: string) =>
  handleSpeakerphoneSuspicious(sid, 0.9, detail, true);
const epRefire = (sid: string, detail: string) =>
  handleSpeakerphoneSuspicious(sid, 0.91, detail, false);
const strikesOf = async (sid: string) =>
  (await events(sid)).filter((e) => e.eventType === "SPEAKERPHONE_STRIKE");
const eventTypesOf = async (sid: string) => (await events(sid)).map((e) => e.eventType);
const partOpsOf = (sid: string) =>
  participantUpdates.filter((p) => p.conference === `verify-${sid}`);
const confOpsOf = (sid: string) =>
  conferenceUpdates.filter((u) => u.conference === `verify-${sid}`);

describe("speakerphone strike ladder (2026-09-05 spec)", () => {
  it("strikes 1 and 2 are recorded ONCE each (timestamp + evidence) and the call continues with NO audio, mute, flag, admin alert or teardown", async () => {
    const s = await ladderSession("s12");
    const sid = s.sessionId;
    const partBefore = participantUpdates.length;
    const confBefore = conferenceUpdates.length;

    epOnset(sid, "ep1");
    await tick(200);
    let strikes = await strikesOf(sid);
    expect(strikes).toHaveLength(1);
    expect(strikes[0].details).toContain("strike 1");
    expect(strikes[0].details).toContain("confirmed at"); // timestamp persisted
    expect(strikes[0].details).toContain("ep1"); // detector evidence persisted
    await vs.onSpeakerphoneCleared(sid, "ep1 cleared");

    epOnset(sid, "ep2");
    await tick(200);
    strikes = await strikesOf(sid);
    expect(strikes).toHaveLength(2);
    expect(strikes[1].details).toContain("strike 2");
    await vs.onSpeakerphoneCleared(sid, "ep2 cleared");

    // The call continues UNCHANGED: still BRIDGED, and nothing was played,
    // announced, muted, flagged, SMS'd or hung up anywhere.
    expect((await vs.findSession(sid))!.state).toBe(vs.VState.BRIDGED);
    expect(participantUpdates.slice(partBefore)).toHaveLength(0);
    expect(conferenceUpdates.slice(confBefore)).toHaveLength(0);
    const types = await eventTypesOf(sid);
    expect(types).not.toContain("SPEAKERPHONE_WARNING");
    expect(types).not.toContain("SPEAKERPHONE_CALLER_MUTED");
    expect(types).not.toContain("SPEAKERPHONE_SUPREME");
    expect(twilioMock.sentMessages.some((m) => m.body.includes(sid))).toBe(false);
    // The recovery event between the episodes documents the rearm contract.
    const cleared = (await events(sid)).filter((e) => e.eventType === "SPEAKERPHONE_CLEARED");
    expect(cleared).toHaveLength(2);
    expect(cleared[0].details).toContain("recovery");
    expect(cleared[0].details).toContain("detector rearmed");
  });

  it("repeated detector frames inside ONE continuous suspicious period never multiply strikes (one episode = one strike)", async () => {
    const s = await ladderSession("rf");
    const sid = s.sessionId;
    epOnset(sid, "ep onset");
    await tick(150);
    for (let i = 0; i < 6; i++) epRefire(sid, `refire ${i}`);
    await tick(250);
    expect(await strikesOf(sid)).toHaveLength(1);
    // A duplicate non-onset callback injected directly is a no-op too.
    await vs.injectSpeakerphoneChallenge(sid, "duplicate callback", false);
    expect(await strikesOf(sid)).toHaveLength(1);
    // Only AFTER the clear (recovery complete, detector rearmed) can the
    // next independently confirmed episode record the next strike.
    await vs.onSpeakerphoneCleared(sid, "cleared");
    epOnset(sid, "ep2");
    await tick(150);
    expect(await strikesOf(sid)).toHaveLength(2);
  });

  it("a new strike REQUIRES recovery: no clear streak → no new episode → no new strike", async () => {
    const s = await ladderSession("rec");
    const sid = s.sessionId;
    epOnset(sid, "ep1");
    await tick(150);
    epRefire(sid, "still the same active episode");
    await tick(150);
    expect(await strikesOf(sid)).toHaveLength(1); // no recovery → no strike 2
    await vs.onSpeakerphoneCleared(sid, "audio normal for the recovery period");
    const cleared = (await events(sid)).filter((e) => e.eventType === "SPEAKERPHONE_CLEARED");
    expect(cleared).toHaveLength(1);
    expect(cleared[0].details).toContain("detector rearmed");
    epOnset(sid, "ep2 after recovery");
    await tick(150);
    expect(await strikesOf(sid)).toHaveLength(2);
  });

  it("FULL LADDER: ep1-2 recorded silently, ep3 = WARNING FLAG (mute→warning→unmute→resume, count stays 3), ep4 = SUPREME FLAG (flag once + admin SMS once + full teardown)", async () => {
    process.env.VERIFY_SPEAKERPHONE_WARNING_AUDIO_MS = "300";
    process.env.VERIFY_SPEAKERPHONE_WARNING_UNMUTE_BUFFER_MS = "200";
    process.env.ADMIN_ALERT_NUMBER = "+61400000999";
    process.env.SMS_ENABLED = "true";
    try {
      const s = await ladderSession("ld");
      const sid = s.sessionId;
      const opBefore = twilioMock.opLog.length;

      epOnset(sid, "ep1");
      await tick(150);
      await vs.onSpeakerphoneCleared(sid, "ep1 cleared");
      epOnset(sid, "ep2");
      await tick(150);
      await vs.onSpeakerphoneCleared(sid, "ep2 cleared");
      expect(await strikesOf(sid)).toHaveLength(2);
      // Strikes 1-2: ZERO telephony side effects on this conference.
      expect(partOpsOf(sid)).toHaveLength(0);
      expect(confOpsOf(sid)).toHaveLength(0);

      // EPISODE 3 → WARNING FLAG (NOT supreme; the call must not end).
      epOnset(sid, "ep3");
      await tick(300);
      expect(await strikesOf(sid)).toHaveLength(3);
      // The inmate was MUTED FIRST and the mute confirmed BEFORE playback:
      // the recorded op sequence proves mute precedes the conference announce.
      let ops = twilioMock.opLog.slice(opBefore);
      const muteIdx = ops.findIndex((o) => o === "p:CA_ld_caller:mute");
      const announceIdx = ops.findIndex((o) => o === `c:verify-${sid}:announce`);
      expect(muteIdx).toBeGreaterThanOrEqual(0);
      expect(announceIdx).toBeGreaterThan(muteIdx);
      // The warning plays to the CONFERENCE: the recipient hears it directly
      // and the muted inmate hears it receive-only (not disconnected).
      const announce = confOpsOf(sid)[0];
      expect(announce.announceUrl).toContain("/api/verify/speakerphone-warning.wav");
      expect(announce.announceMethod).toBe("GET");
      let types = await eventTypesOf(sid);
      expect(types).toContain("SPEAKERPHONE_CALLER_MUTED");
      expect(types).toContain("SPEAKERPHONE_WARNING");
      expect(types).not.toContain("SPEAKERPHONE_SUPREME");
      expect((await vs.findSession(sid))!.state).toBe(vs.VState.BRIDGED);

      // While the warning plays, detector callbacks are coalesced: the
      // warning audio itself can NEVER create strike 4, and the warning
      // plays EXACTLY ONCE (no second mute, no second announce).
      epRefire(sid, "warning audio leaking back into the mic");
      await vs.injectSpeakerphoneChallenge(sid, "pathological duplicate onset", true);
      await tick(200);
      expect(await strikesOf(sid)).toHaveLength(3);
      ops = twilioMock.opLog.slice(opBefore);
      expect(ops.filter((o) => o === "p:CA_ld_caller:mute")).toHaveLength(1);
      expect(ops.filter((o) => o === `c:verify-${sid}:announce`)).toHaveLength(1);

      // UNMUTE on playback completion (measured 300ms asset + 200ms buffer):
      await tick(700);
      const unmuteIdx = twilioMock.opLog
        .slice(opBefore)
        .findIndex((o) => o === "p:CA_ld_caller:unmute");
      expect(unmuteIdx).toBeGreaterThan(announceIdx);
      types = await eventTypesOf(sid);
      expect(types).toContain("SPEAKERPHONE_CALLER_UNMUTED");
      expect(types).toContain("SPEAKERPHONE_WARNING_DELIVERED");
      // The conversation RESUMED: still BRIDGED, count retained at strike 3,
      // still no supreme / admin alert / teardown.
      expect((await vs.findSession(sid))!.state).toBe(vs.VState.BRIDGED);
      expect(await strikesOf(sid)).toHaveLength(3);
      expect(types).not.toContain("SPEAKERPHONE_SUPREME");
      expect(twilioMock.sentMessages.some((m) => m.body.includes(sid))).toBe(false);
      await vs.onSpeakerphoneCleared(sid, "ep3 cleared — recovery");

      // EPISODE 4 → SUPREME FLAG: the next distinct confirmed episode after
      // the DELIVERED warning + recovery.
      epOnset(sid, "ep4");
      await tick(300);
      expect(await strikesOf(sid)).toHaveLength(4);
      const after = (await vs.findSession(sid))!;
      expect(after.state).toBe(vs.VState.SPEAKERPHONE_TERMINATED);
      expect(after.failureReason).toContain(
        "repeated speakerphone-like audio or excessive background noise after a delivered warning",
      );
      types = await eventTypesOf(sid);
      // Exactly ONE supreme flag and exactly ONE admin notification.
      expect(types.filter((t) => t === "SPEAKERPHONE_SUPREME")).toHaveLength(1);
      expect(types.filter((t) => t === "ADMIN_ALERT_SENT")).toHaveLength(1);
      const adminSms = twilioMock.sentMessages.filter(
        (m) => m.to === "+61400000999" && m.body.includes("SUPREME FLAG") && m.body.includes(sid),
      );
      expect(adminSms).toHaveLength(1);
      // Termination prompt whispered to BOTH live parties before teardown.
      const termAnn = partOpsOf(sid).filter((p) =>
        p.announceUrl?.includes("speakerphone-terminated.wav"),
      );
      expect(termAnn.some((p) => p.participant === "CA_ld_caller")).toBe(true);
      expect(termAnn.some((p) => p.participant === "CA_ld_legB")).toBe(true);
      // At NO point was a detection tone ever announced into Leg B.
      expect(
        partOpsOf(sid).some((p) => p.announceUrl?.includes("merge-tone")),
      ).toBe(false);
      expect(
        confOpsOf(sid).some((u) => u.announceUrl?.includes("merge-tone")),
      ).toBe(false);

      // Duplicate / late callbacks are idempotent no-ops.
      await vs.onSpeakerphoneSupreme(sid, "duplicate supreme callback");
      expect(
        (await events(sid)).filter((e) => e.eventType === "SPEAKERPHONE_SUPREME"),
      ).toHaveLength(1);
      epOnset(sid, "late detector frame on a terminated call");
      await tick(150);
      expect(await strikesOf(sid)).toHaveLength(4);

      // Full teardown after the termination prompt (~8.5s): every leg hung
      // up and the conference completed (streams die with the legs).
      await tick(9_000);
      const hungUp = updatedCalls.filter((u) => u.status === "completed").map((u) => u.sid);
      expect(hungUp).toContain("CA_ld_caller");
      expect(hungUp).toContain("CA_ld_legA");
      expect(hungUp).toContain("CA_ld_legB");
      expect(
        conferenceUpdates.some((u) => u.conference === `verify-${sid}` && u.status === "completed"),
      ).toBe(true);
    } finally {
      delete process.env.VERIFY_SPEAKERPHONE_WARNING_AUDIO_MS;
      delete process.env.VERIFY_SPEAKERPHONE_WARNING_UNMUTE_BUFFER_MS;
      delete process.env.ADMIN_ALERT_NUMBER;
      delete process.env.SMS_ENABLED;
    }
  }, 25_000);

  it("mute FAILURE → warning NOT played, nothing marked delivered, inmate never left muted; the next distinct episode retries the warning (supreme is impossible without a delivered warning)", async () => {
    process.env.VERIFY_SPEAKERPHONE_WARNING_AUDIO_MS = "300";
    process.env.VERIFY_SPEAKERPHONE_WARNING_UNMUTE_BUFFER_MS = "200";
    try {
      const s = await ladderSession("mf");
      const sid = s.sessionId;
      epOnset(sid, "ep1");
      await tick(120);
      await vs.onSpeakerphoneCleared(sid, "c1");
      epOnset(sid, "ep2");
      await tick(120);
      await vs.onSpeakerphoneCleared(sid, "c2");

      twilioMock.participantUpdateError = { status: 500, code: 20003 };
      epOnset(sid, "ep3");
      await tick(250);
      twilioMock.participantUpdateError = null;
      let types = await eventTypesOf(sid);
      expect(types).toContain("SPEAKERPHONE_WARNING_FAILED");
      expect(types).not.toContain("SPEAKERPHONE_WARNING");
      expect(types).not.toContain("SPEAKERPHONE_CALLER_MUTED");
      // The mute comes FIRST, so a mute failure means no announce was ever
      // attempted — and no mute state can linger.
      expect(confOpsOf(sid)).toHaveLength(0);
      expect(partOpsOf(sid)).toHaveLength(0);
      expect((await vs.findSession(sid))!.state).toBe(vs.VState.BRIDGED);
      await vs.onSpeakerphoneCleared(sid, "c3");

      // Strike 4 onset RETRIES the warning — it must NOT jump to supreme,
      // because no warning was ever delivered.
      epOnset(sid, "ep4");
      await tick(300);
      expect(await strikesOf(sid)).toHaveLength(4);
      types = await eventTypesOf(sid);
      expect(types).toContain("SPEAKERPHONE_WARNING");
      expect(types).not.toContain("SPEAKERPHONE_SUPREME");
      expect(confOpsOf(sid)[0].announceUrl).toContain("speakerphone-warning.wav");
      await tick(700); // let the retried warning unmute cleanly
      types = await eventTypesOf(sid);
      expect(types).toContain("SPEAKERPHONE_WARNING_DELIVERED");
      expect((await vs.findSession(sid))!.state).toBe(vs.VState.BRIDGED);
    } finally {
      twilioMock.participantUpdateError = null;
      delete process.env.VERIFY_SPEAKERPHONE_WARNING_AUDIO_MS;
      delete process.env.VERIFY_SPEAKERPHONE_WARNING_UNMUTE_BUFFER_MS;
    }
  }, 15_000);

  it("announce failure AFTER a confirmed mute → delivery failure recorded + inmate safely unmuted immediately (explicit warning-delivery-failed state); retried next episode", async () => {
    process.env.VERIFY_SPEAKERPHONE_WARNING_AUDIO_MS = "300";
    process.env.VERIFY_SPEAKERPHONE_WARNING_UNMUTE_BUFFER_MS = "200";
    try {
      const s = await ladderSession("af");
      const sid = s.sessionId;
      epOnset(sid, "ep1");
      await tick(120);
      await vs.onSpeakerphoneCleared(sid, "c1");
      epOnset(sid, "ep2");
      await tick(120);
      await vs.onSpeakerphoneCleared(sid, "c2");

      twilioMock.conferenceUpdateError = { status: 500, code: 20003 };
      epOnset(sid, "ep3");
      await tick(300);
      twilioMock.conferenceUpdateError = null;
      await tick(200);
      const types = await eventTypesOf(sid);
      expect(types).toContain("SPEAKERPHONE_CALLER_MUTED"); // mute DID land
      expect(types).toContain("SPEAKERPHONE_WARNING_FAILED"); // failure recorded
      expect(types).not.toContain("SPEAKERPHONE_WARNING"); // delivery NOT claimed
      // Failure safety: the inmate was SAFELY UNMUTED right after the failed
      // announce — never left muted.
      const muteIdx = twilioMock.opLog.findIndex((o) => o === "p:CA_af_caller:mute");
      const unmuteIdx = twilioMock.opLog.findIndex((o) => o === "p:CA_af_caller:unmute");
      expect(muteIdx).toBeGreaterThanOrEqual(0);
      expect(unmuteIdx).toBeGreaterThan(muteIdx);
      expect(types).toContain("SPEAKERPHONE_CALLER_UNMUTED");
      expect(confOpsOf(sid).some((u) => u.announceUrl)).toBe(false);

      // Not marked warned → the next distinct episode retries the warning.
      await vs.onSpeakerphoneCleared(sid, "c3");
      epOnset(sid, "ep4");
      await tick(300);
      const types2 = await eventTypesOf(sid);
      expect(types2).toContain("SPEAKERPHONE_WARNING");
      expect(types2).not.toContain("SPEAKERPHONE_SUPREME");
      await tick(700); // let the retried warning unmute cleanly
    } finally {
      twilioMock.conferenceUpdateError = null;
      delete process.env.VERIFY_SPEAKERPHONE_WARNING_AUDIO_MS;
      delete process.env.VERIFY_SPEAKERPHONE_WARNING_UNMUTE_BUFFER_MS;
    }
  }, 15_000);

  it("unmute is CONFIRMED with retries — transient unmute failures never leave the inmate permanently muted; total failure raises SPEAKERPHONE_UNMUTE_FAILED", async () => {
    process.env.VERIFY_SPEAKERPHONE_WARNING_AUDIO_MS = "400";
    process.env.VERIFY_SPEAKERPHONE_WARNING_UNMUTE_BUFFER_MS = "200";
    try {
      // Part 1: two transient unmute failures, the third attempt succeeds.
      const s = await ladderSession("ur");
      const sid = s.sessionId;
      epOnset(sid, "ep1");
      await tick(120);
      await vs.onSpeakerphoneCleared(sid, "c1");
      epOnset(sid, "ep2");
      await tick(120);
      await vs.onSpeakerphoneCleared(sid, "c2");
      epOnset(sid, "ep3");
      await tick(200); // mute + conference announce done; unmute timer pending
      expect(await eventTypesOf(sid)).toContain("SPEAKERPHONE_WARNING");
      twilioMock.participantUpdateError = { status: 500, code: 20003 };
      await tick(700); // unmute attempt 1 (at ~600ms) fails
      await tick(2_100); // unmute attempt 2 (+2s) fails
      twilioMock.participantUpdateError = null;
      await tick(2_500); // unmute attempt 3 (+2s) succeeds
      let types = await eventTypesOf(sid);
      expect(types).toContain("SPEAKERPHONE_CALLER_UNMUTED");
      expect(types).toContain("SPEAKERPHONE_WARNING_DELIVERED");
      expect(types).not.toContain("SPEAKERPHONE_UNMUTE_FAILED");
      expect(
        partOpsOf(sid).some((p) => p.participant === "CA_ur_caller" && p.muted === false),
      ).toBe(true);
      expect((await vs.findSession(sid))!.state).toBe(vs.VState.BRIDGED);

      // Part 2: ALL unmute attempts fail → loud ops event, delivery never
      // claimed (and still no supreme without a delivered warning).
      const s2 = await ladderSession("uf");
      const sid2 = s2.sessionId;
      epOnset(sid2, "ep1");
      await tick(120);
      await vs.onSpeakerphoneCleared(sid2, "c1");
      epOnset(sid2, "ep2");
      await tick(120);
      await vs.onSpeakerphoneCleared(sid2, "c2");
      epOnset(sid2, "ep3");
      await tick(200);
      expect(await eventTypesOf(sid2)).toContain("SPEAKERPHONE_WARNING");
      twilioMock.participantUpdateError = { status: 500, code: 20003 };
      await tick(700); // attempt 1 fails
      await tick(2_100); // attempt 2 fails
      await tick(2_500); // attempt 3 fails → ops event
      twilioMock.participantUpdateError = null;
      types = await eventTypesOf(sid2);
      expect(types).toContain("SPEAKERPHONE_UNMUTE_FAILED");
      expect(types).not.toContain("SPEAKERPHONE_WARNING_DELIVERED");
      expect(types).not.toContain("SPEAKERPHONE_SUPREME");
    } finally {
      twilioMock.participantUpdateError = null;
      delete process.env.VERIFY_SPEAKERPHONE_WARNING_AUDIO_MS;
      delete process.env.VERIFY_SPEAKERPHONE_WARNING_UNMUTE_BUFFER_MS;
    }
  }, 25_000);
});

describe("Call Waiting engagement is state-only — Leg B stays clean (legacy tone-injection path removed)", () => {
  it("the legacy Leg B tone-injection API no longer exists (no arm/announce/suppression/fire/deferral exports remain)", () => {
    const vsAny = vs as unknown as Record<string, unknown>;
    for (const gone of [
      "armMergeTone",
      "disarmMergeTone",
      "announceMergeTone",
      "isMergeToneArmed",
      "isMergeToneEffective",
      "mergeToneSec",
      "mergeToneRearmMs",
      "mergeToneEnergyFloor",
      "injectChallengeNoise",
      "onSpeakerphoneWarningGraceExpired",
      "holdToneArmingEnabled",
      "secondCallConfirmMs",
    ]) {
      expect(vsAny[gone]).toBeUndefined();
    }
    const streamAny = vstream as unknown as Record<string, unknown>;
    for (const gone of ["handleMergeToneFire", "resolveDeferredEngagement", "MergeToneDetector"]) {
      expect(streamAny[gone]).toBeUndefined();
    }
  });

  it("normal Call Waiting (hold engage → disengage) produces ZERO audio into any leg and NO speakerphone strike", async () => {
    const s = await ladderSession("cw");
    const sid = s.sessionId;
    const partBefore = participantUpdates.length;
    const confBefore = conferenceUpdates.length;
    handleSecondCallEngaged(sid);
    await tick(200);
    expect(vs.isSecondCallEngaged(sid)).toBe(true);
    expect(await eventTypesOf(sid)).toContain("SECOND_CALL_ENGAGED");
    handleSecondCallDisengaged(sid);
    await tick(200);
    expect(vs.isSecondCallEngaged(sid)).toBe(false);
    expect(await eventTypesOf(sid)).toContain("SECOND_CALL_DISENGAGED");
    // No participant announce, no conference announce, no mute, no beep —
    // Leg B remained completely clean through ordinary Call Waiting.
    expect(participantUpdates.slice(partBefore)).toHaveLength(0);
    expect(conferenceUpdates.slice(confBefore)).toHaveLength(0);
    // Normal Call Waiting NEVER counts as a speakerphone strike.
    expect(await strikesOf(sid)).toHaveLength(0);
    expect((await vs.findSession(sid))!.state).toBe(vs.VState.BRIDGED);
  });

  it("a hold engagement DURING a speakerphone episode still drives no audio and adds no strike (state separation)", async () => {
    const s = await ladderSession("cwe");
    const sid = s.sessionId;
    const partBefore = participantUpdates.length;
    const confBefore = conferenceUpdates.length;
    epOnset(sid, "ep1");
    await tick(150);
    handleSecondCallEngaged(sid);
    await tick(150);
    expect(vs.isSecondCallEngaged(sid)).toBe(true);
    handleSecondCallDisengaged(sid);
    await tick(150);
    epRefire(sid, "still ep1");
    await vs.onSpeakerphoneCleared(sid, "cleared");
    // Exactly one strike (the episode); Call Waiting state changes are mute.
    expect(await strikesOf(sid)).toHaveLength(1);
    expect(participantUpdates.slice(partBefore)).toHaveLength(0);
    expect(conferenceUpdates.slice(confBefore)).toHaveLength(0);
  });

  it("silenceCanaryLoudTone redirects Leg A to leg-a-hold exactly once (idempotent) and logs CANARY_TONE_SILENCED", async () => {
    const s = await ladderSession("cs");
    const sid = s.sessionId;
    const updBefore = updatedCalls.length;
    await vs.silenceCanaryLoudTone(sid);
    const redirects = updatedCalls.slice(updBefore).filter((u) => u.sid === "CA_cs_legA");
    expect(redirects).toHaveLength(1);
    expect(redirects[0].url).toContain("leg-a-hold");
    expect(await eventTypesOf(sid)).toContain("CANARY_TONE_SILENCED");
    // Idempotent — a later refire / stream-ready restart must not redirect again.
    await vs.silenceCanaryLoudTone(sid);
    expect(updatedCalls.slice(updBefore).filter((u) => u.sid === "CA_cs_legA")).toHaveLength(1);
  });

  it("episode onset silences the canary loud tone FIRST, while strike 1 itself stays silent (no audio into any conference participant)", async () => {
    const s = await ladderSession("co");
    const sid = s.sessionId;
    const updBefore = updatedCalls.length;
    const partBefore = participantUpdates.length;
    const confBefore = conferenceUpdates.length;
    epOnset(sid, "onset");
    await tick(250);
    const redirects = updatedCalls.slice(updBefore).filter((u) => u.sid === "CA_co_legA");
    expect(redirects).toHaveLength(1);
    expect(redirects[0].url).toContain("leg-a-hold");
    expect(await eventTypesOf(sid)).toContain("CANARY_TONE_SILENCED");
    // The strike-1 path injects NOTHING into the conference (the old
    // challenge-noise announce is gone with the legacy path).
    expect(participantUpdates.slice(partBefore)).toHaveLength(0);
    expect(conferenceUpdates.slice(confBefore)).toHaveLength(0);
  });

  it("the AUTHORISED A→B merge detector is intact — a relay-detected merge still ends the call (MERGE_DETECTED + toneDetected)", async () => {
    const s = await ladderSession("ab");
    // The relay's stream-detected callback is the live in-call merge path.
    expect(typeof fireMergeDetected).toBe("function");
    await vs.onMergeDetected(s.sessionId);
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.MERGE_DETECTED);
    expect(after.toneDetected).toBe(true);
    expect(after.toneDetectedAt).not.toBeNull();
  });

  it("the inmate hears the COMPLETE waiting message ONCE, then neutral hold silence (never repeated continuously)", async () => {
    const s = await makeSession(vs.VState.INITIATED, { guarded: true });
    const res = await postForm("/api/voice/twiml", {
      guarded: s.sessionId,
      CallSid: "CA_wait_sdk",
      To: "+61400000000",
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    // The exact spec message: connection notice + full speakerphone policy.
    expect(body).toContain("Please wait while we connect your call.");
    expect(body).toContain(
      "Speakerphone is permitted, but please tell the person receiving your call to use a quiet room, keep the phone close, and remove all background voices and noise.",
    );
    expect(body).toContain(
      "Repeated speakerphone-like audio or excessive background noise may cause a warning or end the call.",
    );
    // Played ONCE — each clause appears in exactly one <Say>.
    expect(body.match(/Please wait while we connect your call\./g)).toHaveLength(1);
    expect(body.match(/Speakerphone is permitted/g)).toHaveLength(1);
    // …then neutral hold: the self-refreshing caller-wait loop is SILENCE.
    const wait = await postForm(`/api/verify/twiml/caller-wait?sid=${s.sessionId}`);
    const waitBody = await wait.text();
    expect(waitBody).not.toContain("<Say");
    expect(waitBody).toContain("<Pause");
    expect(waitBody).toContain("/api/verify/twiml/caller-wait");
  });
});

describe("speakerphoneArmWindows (2-hop forensic arming)", () => {
  it("defaults to 2 consecutive suspicious hops, env-overridable, floored at 1", () => {
    const saved = process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS;
    delete process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS;
    try {
      expect(vs.speakerphoneArmWindows()).toBe(2);
      process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS = "5";
      expect(vs.speakerphoneArmWindows()).toBe(5);
      process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS = "1";
      expect(vs.speakerphoneArmWindows()).toBe(1);
      process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS = "0"; // floored to 1
      expect(vs.speakerphoneArmWindows()).toBe(1);
      process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS = "-4"; // floored to 1
      expect(vs.speakerphoneArmWindows()).toBe(1);
      process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS = "bogus"; // safe default
      expect(vs.speakerphoneArmWindows()).toBe(2);
      process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS = ""; // set-but-empty → default
      expect(vs.speakerphoneArmWindows()).toBe(2);
    } finally {
      if (saved === undefined) delete process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS;
      else process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS = saved;
    }
  });
});

describe("guarded live bridge (verification pass → BRIDGED)", () => {
  it("guarded: bridges the browser caller into the conference IMMEDIATELY at Leg B answer (no watch pass)", async () => {
    process.env.VERIFY_STREAM_URL = "wss://relay.example.com/stream";
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    try {
      const s = await makeSession(vs.VState.LEG_B_DIALING, {
        guarded: true,
        callerCallSid: "CA_g_caller",
        legACallSid: "CA_g_legA",
        ringTestCallSid: "CA_g_rt",
      });
      const updBefore = updatedCalls.length;
      // Leg B answered → LEG_B_ANSWERED arms the readiness deadline, and the
      // guarded bridge happens at once (Leg B's own TwiML dials the
      // conference as anchor; the caller is redirected in as joiner).
      await vs.onLegBAnswered(s.sessionId, "CA_g_legB");
      const after = (await vs.findSession(s.sessionId))!;
      expect(after.state).toBe(vs.VState.BRIDGED);
      // Readiness armed (persisted): no stream-ready by the deadline is
      // DETECTION_FAILED — never a silent pass.
      expect(after.streamReadyBy).not.toBeNull();
      expect(after.detectionPhase).toBe(vs.DetectionPhase.AWAITING_STREAM_READY);
      const added = updatedCalls.slice(updBefore);
      // The CALLER is redirected into the live conference as joiner…
      expect(added.some((u) => u.sid === "CA_g_caller" && String(u.url).includes("guarded-bridge") && String(u.url).includes("leg=caller"))).toBe(true);
      // …Leg A is the canary and is NEVER redirected into the conference…
      expect(added.some((u) => u.sid === "CA_g_legA" && String(u.url).includes("guarded-bridge"))).toBe(false);
      // …Leg B is the live leg and is NOT torn down at bridge time…
      expect(added.some((u) => u.sid === "CA_g_legB" && u.status === "completed")).toBe(false);
      // …the ring-test leg is hung up…
      expect(added.some((u) => u.sid === "CA_g_rt" && u.status === "completed")).toBe(true);
      // …and the caller is NEVER sent to a legacy verdict announcement.
      expect(added.some((u) => u.sid === "CA_g_caller" && String(u.url).includes("notify-"))).toBe(false);
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).toContain("STREAM_READINESS_ARMED");
      expect(types).toContain(vs.VState.BRIDGED);
      expect(types).toContain("GUARDED_BRIDGED");
      expect(types).not.toContain("GUARDED_MERGE_WATCH_ARMED");
      expect(types).not.toContain("LEG_B_PASS_TEARDOWN");
    } finally {
      delete process.env.VERIFY_STREAM_URL;
      delete process.env.VERIFY_STREAM_SECRET;
    }
  });

  it("guarded without a configured relay fails CLOSED at Leg B answer (DETECTION_FAILED)", async () => {
    delete process.env.VERIFY_STREAM_URL;
    const s = await makeSession(vs.VState.LEG_B_DIALING, {
      guarded: true,
      callerCallSid: "CA_norel_caller",
      legACallSid: "CA_norel_legA",
    });
    await vs.onLegBAnswered(s.sessionId, "CA_norel_legB");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.DETECTION_FAILED);
    // An unmonitored call never bridges the caller.
    expect(
      updatedCalls.some((u) => u.sid === "CA_norel_caller" && String(u.url).includes("guarded-bridge")),
    ).toBe(false);
  });

  it("non-guarded: Leg B answer arms readiness, never bridges the caller", async () => {
    process.env.VERIFY_STREAM_URL = "wss://relay.example.com/stream";
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    try {
      const s = await makeSession(vs.VState.LEG_B_DIALING, {
        callerCallSid: "CA_ng_caller",
        legACallSid: "CA_ng_legA",
      });
      const updBefore = updatedCalls.length;
      await vs.onLegBAnswered(s.sessionId, "CA_ng_legB");
      await tick(100);
      const after = (await vs.findSession(s.sessionId))!;
      expect(after.state).toBe(vs.VState.LEG_B_ANSWERED);
      expect(after.streamReadyBy).not.toBeNull();
      expect(after.detectionPhase).toBe(vs.DetectionPhase.AWAITING_STREAM_READY);
      const added = updatedCalls.slice(updBefore);
      expect(added.some((u) => String(u.url).includes("guarded-bridge"))).toBe(false);
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).toContain("STREAM_READINESS_ARMED");
      expect(types).not.toContain("GUARDED_BRIDGED");
    } finally {
      delete process.env.VERIFY_STREAM_URL;
      delete process.env.VERIFY_STREAM_SECRET;
    }
  });

  it("D2: the bridge flips the event-driven registry flag synchronously (no DB poll needed)", async () => {
    process.env.VERIFY_STREAM_URL = "wss://relay.example.com/stream";
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    try {
      const s = await makeSession(vs.VState.LEG_B_DIALING, {
        guarded: true,
        callerCallSid: "CA_reg_caller",
        legACallSid: "CA_reg_legA",
      });
      expect(vs.isBridgedSession(s.sessionId)).toBe(false);
      await vs.onLegBAnswered(s.sessionId, "CA_reg_legB");
      expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.BRIDGED);
      expect(vs.isBridgedSession(s.sessionId)).toBe(true);
      // A terminal transition clears the flag (maps can't grow unboundedly).
      await vs.onMergeDetected(s.sessionId, { inCall: true });
      expect(vs.isBridgedSession(s.sessionId)).toBe(false);
    } finally {
      delete process.env.VERIFY_STREAM_URL;
      delete process.env.VERIFY_STREAM_SECRET;
    }
  });

  it("guarded: Leg B hangup without confirmed readiness is DETECTION_INCONCLUSIVE — never a forced pass", async () => {
    // The old force:true bridge-on-hangup is gone: a Leg B completion without
    // a verified live outcome (no stream-ready, no challenge) is inconclusive.
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
      guarded: true,
      callerCallSid: "CA_lbh_caller",
      legACallSid: "CA_lbh_legA",
      ringTestCallSid: "CA_lbh_rt",
      streamReadyBy: new Date(Date.now() + 60_000),
      detectionPhase: vs.DetectionPhase.AWAITING_STREAM_READY,
    });
    const updBefore = updatedCalls.length;
    await vs.onCallCompleted(s.sessionId, "legB", "CA_lbh_legB", "duration=12s");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.DETECTION_INCONCLUSIVE);
    const added = updatedCalls.slice(updBefore);
    // No bridge redirect, no verdict announcements; full teardown.
    expect(added.some((u) => String(u.url).includes("guarded-bridge"))).toBe(false);
    expect(added.some((u) => u.sid === "CA_lbh_caller" && String(u.url).includes("notify-completed"))).toBe(false);
    expect(added.some((u) => u.sid === "CA_lbh_legA" && u.status === "completed")).toBe(true);
    expect(added.some((u) => u.sid === "CA_lbh_caller" && u.status === "completed")).toBe(true);
    expect(added.some((u) => u.sid === "CA_lbh_rt" && u.status === "completed")).toBe(true);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("DETECTION_INCONCLUSIVE");
    expect(types).not.toContain("GUARDED_BRIDGED");
  });

  it("guarded: Leg B hangup while BRIDGED with live detection completes COMPLETED", async () => {
    // Verified live outcome: the relay confirmed stream-ready and the
    // challenge started, so a normal Leg B end is a clean COMPLETED.
    process.env.VERIFY_BRIDGE_RECALL = "false";
    try {
      const s = await makeSession(vs.VState.BRIDGED, {
        guarded: true,
        callerCallSid: "CA_lbm_caller",
        legACallSid: "CA_lbm_legA",
        legBCallSid: "CA_lbm_legB",
        streamReadyAt: new Date(Date.now() - 30_000),
        challengeStartedAt: new Date(Date.now() - 30_000),
        promptLightDurationMs: 21_360,
        promptEndsAt: new Date(Date.now() - 11_000),
        detectionPhase: vs.DetectionPhase.LOUD_DTMF,
      });
      await vs.onCallCompleted(s.sessionId, "legB", "CA_lbm_legB", "duration=95s");
      const after = (await vs.findSession(s.sessionId))!;
      expect(after.state).toBe(vs.VState.COMPLETED);
      // Canary + remaining legs torn down; no recall, no inconclusive verdict.
      expect(updatedCalls.some((u) => u.sid === "CA_lbm_legA" && u.status === "completed")).toBe(true);
      // The caller must NOT be stranded in the conference: endConferenceOnExit
      // lives only on the caller leg, so the engine completes the conference
      // by SID — the caller's Dial returns into notify-partner-ended.
      expect(
        conferenceUpdates.some(
          (u) => u.conference === `verify-${s.sessionId}` && u.status === "completed",
        ),
      ).toBe(true);
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).toContain("GUARDED_CALL_ENDED");
    } finally {
      delete process.env.VERIFY_BRIDGE_RECALL;
    }
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

  it("BRIDGED: caller hangup on a monitored call → COMPLETED + Leg B released by the conference", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_b_caller",
      legACallSid: "CA_b_legA",
      legBCallSid: "CA_b_legB",
      streamReadyAt: new Date(Date.now() - 30_000),
      challengeStartedAt: new Date(Date.now() - 30_000),
    });
    const updBefore = updatedCalls.length;
    await vs.onCallCompleted(s.sessionId, "caller", "CA_b_caller", "duration=120s");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.COMPLETED);
    expect(after.completedAt).not.toBeNull();
    // The surviving Leg B is inside an active <Dial><Conference> — a REST
    // redirect cannot reach them. endConferenceOnExit on the caller leg ends
    // the conference; Leg B's Dial returns and its post-Dial <Redirect> plays
    // notify-partner-ended and hangs up. The engine additionally releases the
    // callee leg via REST (race-safe). The canary (Leg A) is hung up.
    const added = updatedCalls.slice(updBefore);
    expect(added.some((u) => u.sid === "CA_b_legA" && u.status === "completed")).toBe(true);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("GUARDED_CALL_ENDED");
    expect(types).toContain(vs.VState.COMPLETED);
  });

  it("BRIDGED: caller hangup on an UNMONITORED call is DETECTION_INCONCLUSIVE (never a pass)", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_bu_caller",
      legACallSid: "CA_bu_legA",
      legBCallSid: "CA_bu_legB",
      streamReadyBy: new Date(Date.now() + 60_000),
      detectionPhase: vs.DetectionPhase.AWAITING_STREAM_READY,
    });
    await vs.onCallCompleted(s.sessionId, "caller", "CA_bu_caller", "duration=8s");
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.DETECTION_INCONCLUSIVE);
  });

  it("BRIDGED: canary (Leg A) lost mid-call → DETECTION_INCONCLUSIVE + full teardown", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_b2_caller",
      legACallSid: "CA_b2_legA",
      legBCallSid: "CA_b2_legB",
      streamReadyAt: new Date(Date.now() - 30_000),
      challengeStartedAt: new Date(Date.now() - 30_000),
    });
    await vs.onCallCompleted(s.sessionId, "legA", "CA_b2_legA", "duration=45s");
    const after = (await vs.findSession(s.sessionId))!;
    // The canary carried the challenge — without it the call can no longer be
    // verified: inconclusive, never a pass.
    expect(after.state).toBe(vs.VState.DETECTION_INCONCLUSIVE);
    expect(updatedCalls.some((u) => u.sid === "CA_b2_legB" && u.status === "completed")).toBe(true);
    expect(updatedCalls.some((u) => u.sid === "CA_b2_caller" && u.status === "completed")).toBe(true);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("CANARY_LOST");
  });

  it("BRIDGED: a survivor stuck OUTSIDE the conference (lobby) is hung up by REST", async () => {
    // The caller joins with startConferenceOnEnter: false — if the anchor
    // (Leg B) dies before ever starting the conference, the caller is stuck
    // in a pre-start lobby with no end trigger. With NO live conference the
    // engine must hang the survivor up directly.
    process.env.VERIFY_BRIDGE_RECALL = "false";
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_lob_caller",
      legACallSid: "CA_lob_legA",
      legBCallSid: "CA_lob_legB",
      streamReadyAt: new Date(Date.now() - 30_000),
      challengeStartedAt: new Date(Date.now() - 30_000),
    });
    twilioMock.listResult = []; // no in-progress conference
    try {
      await vs.onCallCompleted(s.sessionId, "legB", "CA_lob_legB", "duration=5s");
      expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.COMPLETED);
      expect(
        updatedCalls.some((u) => u.sid === "CA_lob_caller" && u.status === "completed"),
      ).toBe(true);
    } finally {
      twilioMock.listResult = null;
      delete process.env.VERIFY_BRIDGE_RECALL;
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
    // Callee (anchor) exit must NOT end the room — the supervisor re-dials a
    // dropped callee back into this same conference (BRIDGE_RECALL).
    expect(body).toContain('endConferenceOnExit="false"');
    // Bridge supervisor: participant join/leave events flow to the timeline.
    expect(body).toContain(`/api/verify/conference?sid=abc123`);
    expect(body).toContain('statusCallbackEvent="start end join leave"');
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

  it("leg-a-hold keeps the canary OUT of the conference even when BRIDGED", async () => {
    // Corrected architecture: Leg A is the Call Waiting canary — it plays the
    // two-phase challenge and NEVER joins the live conference.
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_lah_caller",
      legACallSid: "CA_lah_legA",
      legBCallSid: "CA_lah_legB",
    });
    const res = await postForm(`/api/verify/twiml/leg-a-hold?sid=${s.sessionId}`);
    const body = await res.text();
    expect(body).not.toContain("<Conference");
    expect(body).toContain("<Pause");
  });

  it("leg-a-hold enforces the persisted readiness deadline (restart-safe fallback)", async () => {
    // No background timers after a restart: the Leg A hold poll notices the
    // missed stream-ready deadline and fails the detection — never a pass.
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
      legACallSid: "CA_rd_legA",
      legBCallSid: "CA_rd_legB",
      streamReadyBy: new Date(Date.now() - 5_000), // deadline already missed
      detectionPhase: vs.DetectionPhase.AWAITING_STREAM_READY,
    });
    const res = await postForm(`/api/verify/twiml/leg-a-hold?sid=${s.sessionId}`);
    const body = await res.text();
    expect(body).toContain("<Hangup");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.DETECTION_FAILED);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("DETECTION_FAILED");
  });

  it("checkStreamReadiness is a no-op before the deadline and after stream-ready", async () => {
    const pending = await makeSession(vs.VState.LEG_B_ANSWERED, {
      streamReadyBy: new Date(Date.now() + 60_000),
      detectionPhase: vs.DetectionPhase.AWAITING_STREAM_READY,
    });
    await vs.checkStreamReadiness(pending.sessionId);
    expect((await vs.findSession(pending.sessionId))!.state).toBe(vs.VState.LEG_B_ANSWERED);
    const ready = await makeSession(vs.VState.LEG_B_ANSWERED, {
      streamReadyBy: new Date(Date.now() - 5_000),
      streamReadyAt: new Date(),
      detectionPhase: vs.DetectionPhase.PROMPT_LIGHT,
    });
    await vs.checkStreamReadiness(ready.sessionId);
    expect((await vs.findSession(ready.sessionId))!.state).toBe(vs.VState.LEG_B_ANSWERED);
  });

  it("guarded-bridge TwiML records the conference for call review", async () => {
    const res = await postForm("/api/verify/twiml/guarded-bridge?sid=abc123");
    const body = await res.text();
    expect(body).toContain('record="record-from-start"');
    expect(body).toContain("/api/verify/recording/bridge?sid=abc123");
  });

  it("leg-a-challenge waits (no prompt) until the challenge has started", async () => {
    // The prompt-light asset must NEVER play before stream-ready — otherwise
    // the relay would count Phase 1 against an untimed prompt.
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
      legACallSid: "CA_chw_legA",
      detectionPhase: vs.DetectionPhase.AWAITING_STREAM_READY,
    });
    const res = await postForm(`/api/verify/twiml/leg-a-challenge?sid=${s.sessionId}`);
    const body = await res.text();
    expect(body).not.toContain("prompt-light.wav");
    expect(body).not.toContain("<Play");
    expect(body).toContain("<Pause");
    expect(body).toContain(`/api/verify/twiml/leg-a-challenge?sid=${s.sessionId}`);
  });

  it("leg-a-challenge plays the prompt-light asset exactly once, then hands off to the loud-tone phase", async () => {
    const started = new Date();
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
      legACallSid: "CA_ch_legA",
      challengeStartedAt: started,
      promptLightDurationMs: 21_360,
      promptEndsAt: new Date(started.getTime() + 21_360),
      detectionPhase: vs.DetectionPhase.PROMPT_LIGHT,
    });
    const res = await postForm(`/api/verify/twiml/leg-a-challenge?sid=${s.sessionId}`);
    const body = await res.text();
    // Phase 1: the pre-rendered prompt + light watermark, exactly once.
    expect(body).toContain('<Play loop="1">');
    expect(body).toContain("/api/verify/prompt-light.wav");
    // Phase 2 hand-off: the loud tone loop document.
    expect(body).toContain(`/api/verify/twiml/leg-a-challenge-tone?sid=${s.sessionId}`);
    // The loud tone itself does NOT play in Phase 1.
    expect(body).not.toContain("/api/verify/tone.wav");
  });

  it("leg-a-challenge-tone loops the loud merge tone (Phase 2)", async () => {
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, { legACallSid: "CA_ct_legA" });
    const res = await postForm(`/api/verify/twiml/leg-a-challenge-tone?sid=${s.sessionId}`);
    const body = await res.text();
    expect(body).toContain("<Play");
    expect(body).toContain("/api/verify/tone.wav");
    expect(body).toContain('loop="10"');
    expect(body).not.toContain("digits=");
    expect(body).toContain(`/api/verify/twiml/leg-a-challenge-tone?sid=${s.sessionId}`);
  });

  it("challenge documents hang up on terminal sessions", async () => {
    const s = await makeSession(vs.VState.MERGE_DETECTED, {
      legACallSid: "CA_ctt_legA",
      completedAt: new Date(),
    });
    for (const kind of ["leg-a-challenge", "leg-a-challenge-tone", "leg-a-hold", "leg-b-hold"]) {
      const res = await postForm(`/api/verify/twiml/${kind}?sid=${s.sessionId}`);
      expect(await res.text()).toContain("<Hangup");
    }
  });

  it("prompt-light.wav endpoint serves the Phase 1 asset with the measured duration header", async () => {
    const res = await hookApp.request("/api/verify/prompt-light.wav");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/wav");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("X-Prompt-Light-Duration-Ms")).toBe("21360");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4).toString("ascii")).toBe("RIFF");
    // 8 kHz mono PCM16, exactly 21.360s: 170880 frames * 2 bytes + 44 header.
    expect(buf.length).toBe(44 + 170_880 * 2);
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
import * as vstream from "./verification-stream";
import {
  __testSetSpeakerphoneSuspicion,
  activeStreams,
  attachVerificationStreamServer,
  authenticateStreamStart,
  fireMergeDetected,
  handleSecondCallDisengaged,
  handleSecondCallEngaged,
  handleSpeakerphoneSuspicious,
  inProcessStreamUrl,
  isSpeakerphoneSuspecting,
  verificationStreamDetectedHandler,
  verificationStreamFailedHandler,
  verificationStreamReadyHandler,
  relayStreamUrl,
  setRelayWarmupFetch,
  streamToken,
  streamTokenValid,
  wakeRelay,
} from "./verification-stream";
import { SpeakerphoneDetector } from "./relayguard/speakerphone-detector";
import { HoldDetector } from "./relayguard/hold-detector";
import {
  promptLightHandler,
  speakerphoneTerminatedHandler,
  speakerphoneWarningHandler,
  verificationConferenceHandler,
  verificationSmsInboundHandler,
  verificationStatusHandler,
  verificationTwimlHandler,
  verificationVersionHandler,
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
hookApp.get("/api/verify/prompt-light.wav", promptLightHandler);
hookApp.get("/api/verify/speakerphone-warning.wav", speakerphoneWarningHandler);
hookApp.get("/api/verify/speakerphone-terminated.wav", speakerphoneTerminatedHandler);
hookApp.post("/api/verify/recording/merge", verificationRecordingHandler);
hookApp.post("/api/verify/recording/bridge", verificationBridgeRecordingHandler);
hookApp.get("/api/verify/recording/:sid/:kind", verificationRecordingAudioHandler);
hookApp.post("/api/verify/stream-detected", verificationStreamDetectedHandler);
hookApp.post("/api/verify/stream-ready", verificationStreamReadyHandler);
hookApp.post("/api/verify/stream-failed", verificationStreamFailedHandler);
hookApp.post("/api/verify/sms/inbound", verificationSmsInboundHandler);
hookApp.post("/api/verify/conference", verificationConferenceHandler);
hookApp.get("/api/verify/version", verificationVersionHandler);
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

  it("leg-b TwiML (guarded): non-blocking inbound Start>Stream + Dial>Conference, no prompt/gather/record", async () => {
    process.env.VERIFY_STREAM_URL = "wss://relay.example.com/stream";
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    try {
      const s = await makeSession(vs.VState.LEG_B_DIALING, {
        guarded: true,
        callerCallSid: "CA_lb_caller",
      });
      const res = await postForm(`/api/verify/twiml/leg-b?sid=${s.sessionId}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      // NON-BLOCKING inbound-only detection stream (Start — not Connect).
      expect(body).toContain("<Start>");
      expect(body).toContain("<Stream");
      expect(body).toContain('track="inbound_track"');
      expect(body).toContain("wss://relay.example.com/stream");
      // Stream identity ONLY via customParameters: sid / leg=legB /
      // mode=merge-detection / HMAC token. The URL carries no session id.
      expect(body).toContain(`<Parameter name="sid" value="${s.sessionId}"`);
      expect(body).toContain('<Parameter name="leg" value="legB"');
      expect(body).toContain('<Parameter name="mode" value="merge-detection"');
      expect(body).toContain(`<Parameter name="token" value="${streamToken(s.sessionId)}"`);
      // Only the Stream URL itself is forbidden from carrying the session id;
      // unrelated conference/recording callback URLs legitimately use ?sid=.
      const streamUrl = body.match(/<Stream[^>]*url="([^"]+)"/)?.[1];
      expect(streamUrl).toBe("wss://relay.example.com/stream");
      expect(streamUrl).not.toContain("?sid=");
      // SECOND inbound stream: in-process SPEAKERPHONE detection on Leg B,
      // attached AT ORIGINATION (same document) so the detector warm-up
      // overlaps ring/setup. Bare in-process URL + customParameters identity
      // (sid / leg=legB / purpose=speakerphone / HMAC token).
      const streamUrls = [...body.matchAll(/<Stream[^>]*url="([^"]+)"/g)].map((m) => m[1]);
      expect(streamUrls).toEqual([
        "wss://relay.example.com/stream",
        "wss://verify-test.example.com/api/verify/stream",
      ]);
      expect(streamUrls[1]).not.toContain("?");
      expect(body).toContain('<Parameter name="purpose" value="speakerphone"');
      expect(body.match(/<Parameter name="leg" value="legB"/g)).toHaveLength(2);
      expect(body.match(new RegExp(`<Parameter name="token" value="${streamToken(s.sessionId)}"`, "g"))).toHaveLength(2);
      // Immediately continues into the live conference with the browser
      // caller (Leg B = anchor; caller joiner exits end the room).
      expect(body).toContain("<Dial>");
      expect(body).toContain("<Conference");
      expect(body).toContain(`verify-${s.sessionId}`);
      expect(body).toContain('startConferenceOnEnter="true"');
      expect(body).toContain('endConferenceOnExit="false"');
      // NO Leg B prompt/Gather/keypress/tone, no blocking Connect, no Record.
      expect(body).not.toContain("<Say");
      expect(body).not.toContain("<Play");
      expect(body).not.toContain("<Gather");
      expect(body).not.toContain("<Record");
      expect(body).not.toContain("<Connect");
      expect(body).not.toContain("/api/verify/recording/merge");
    } finally {
      delete process.env.VERIFY_STREAM_URL;
      delete process.env.VERIFY_STREAM_SECRET;
    }
  });

  it("leg-b TwiML (non-guarded): detection stream + silent hold loop (no conference)", async () => {
    process.env.VERIFY_STREAM_URL = "wss://relay.example.com/stream";
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    try {
      const s = await makeSession(vs.VState.LEG_B_DIALING, { legACallSid: "CA_lbn_legA" });
      const res = await postForm(`/api/verify/twiml/leg-b?sid=${s.sessionId}`);
      const body = await res.text();
      expect(body).toContain("<Start>");
      expect(body).toContain('<Parameter name="mode" value="merge-detection"');
      // Second inbound stream: in-process speakerphone detection (Leg B).
      expect(body).toContain('<Parameter name="purpose" value="speakerphone"');
      expect(body).toContain("wss://verify-test.example.com/api/verify/stream");
      expect(body).not.toContain("/api/verify/stream?sid=");
      expect(body).not.toContain("<Conference");
      expect(body).toContain("<Pause");
      expect(body).toContain(`/api/verify/twiml/leg-b-hold?sid=${s.sessionId}`);
      expect(body).not.toContain("<Say");
      expect(body).not.toContain("<Gather");
      expect(body).not.toContain("<Record");
      expect(body).not.toContain("<Connect");
    } finally {
      delete process.env.VERIFY_STREAM_URL;
      delete process.env.VERIFY_STREAM_SECRET;
    }
  });

  it("leg-b TwiML without a configured relay fails CLOSED (DETECTION_FAILED, hangup)", async () => {
    delete process.env.VERIFY_STREAM_URL;
    delete process.env.VERIFY_STREAM_SECRET;
    const s = await makeSession(vs.VState.LEG_B_DIALING, { legACallSid: "CA_lbf_legA" });
    const res = await postForm(`/api/verify/twiml/leg-b?sid=${s.sessionId}`);
    const body = await res.text();
    expect(body).toContain("<Hangup");
    expect(body).not.toContain("<Stream");
    expect(body).not.toContain("<Record");
    await tick(200); // onStreamFailed is fire-and-forget from the TwiML fetch
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.DETECTION_FAILED);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("DETECTION_FAILED");
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

  it("legacy Leg B tone-injection endpoints are GONE (merge-tone.wav / challenge-noise.wav → 404)", async () => {
    // The legacy reverse-detection path was removed on 2026-09-05: no route
    // may serve a tone whose only purpose was to be announced INTO Leg B.
    expect((await hookApp.request("/api/verify/merge-tone.wav")).status).toBe(404);
    expect((await hookApp.request("/api/verify/challenge-noise.wav")).status).toBe(404);
  });

  it("speakerphone-warning.wav serves the COMPLETE measured warning asset (the full warning text)", async () => {
    const res = await hookApp.request("/api/verify/speakerphone-warning.wav");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/wav");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4).toString("ascii")).toBe("RIFF");
    // 266 496 samples × 2 bytes (+ RIFF headers) = the FULL 16 656ms warning
    // message — a truncated asset would cut the warning text short.
    expect(buf.length).toBeGreaterThan(266496 * 2);
    expect(vs.speakerphoneWarningAudioMs()).toBe(16_656);
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
      expect(relayStreamUrl()).toBeNull(); // VERIFY_STREAM_URL unset in tests
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

  it("stream token is the relay contract HMAC: hex(HMAC-SHA256(secret, 'merge-relay-stream:' + sid))", async () => {
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    try {
      const { createHmac } = await import("crypto");
      const expected = createHmac("sha256", "test-secret")
        .update("merge-relay-stream:abc123")
        .digest("hex");
      expect(streamToken("abc123")).toBe(expected);
      expect(streamToken("abc123")).toMatch(/^[0-9a-f]{64}$/);
      // Per-session: different sid → different token.
      expect(streamToken("other")).not.toBe(expected);
    } finally {
      delete process.env.VERIFY_STREAM_SECRET;
    }
  });

  it("relay stream-ready: 403 without secret; starts the challenge ONLY then (persisted + Leg A redirect + relay challenge-start)", async () => {
    process.env.VERIFY_STREAM_URL = "wss://relay.example.com/stream";
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    const relayPosts: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      relayPosts.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("{}", { status: 200 });
    });
    try {
      const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
        legACallSid: "CA_sr_legA",
        legBCallSid: "CA_sr_legB",
        streamReadyBy: new Date(Date.now() + 60_000),
        detectionPhase: vs.DetectionPhase.AWAITING_STREAM_READY,
      });
      const updBefore = updatedCalls.length;

      // No/wrong secret → forbidden, nothing starts.
      const bad = await hookApp.request("/api/verify/stream-ready", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-verify-secret": "wrong" },
        body: JSON.stringify({ sid: s.sessionId, streamSid: "MZ_bad" }),
      });
      expect(bad.status).toBe(403);
      expect((await vs.findSession(s.sessionId))!.challengeStartedAt).toBeNull();

      const good = await hookApp.request("/api/verify/stream-ready", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-verify-secret": "test-secret" },
        body: JSON.stringify({ sid: s.sessionId, streamSid: "MZ_ready_1", readyAt: new Date().toISOString() }),
      });
      expect(good.status).toBe(200);
      expect(((await good.json()) as { ok: boolean }).ok).toBe(true);

      const after = (await vs.findSession(s.sessionId))!;
      // Restart-safe persistence: exact challenge timeline + phase.
      expect(after.streamSid).toBe("MZ_ready_1");
      expect(after.streamReadyAt).not.toBeNull();
      expect(after.challengeStartedAt).not.toBeNull();
      expect(after.promptLightDurationMs).toBe(21_360);
      expect(after.promptEndsAt!.getTime()).toBe(after.challengeStartedAt!.getTime() + 21_360);
      expect(after.detectionPhase).toBe(vs.DetectionPhase.PROMPT_LIGHT);

      // Leg A canary redirected to the challenge TwiML (Phase 1 starts here).
      const added = updatedCalls.slice(updBefore);
      expect(added.some((u) => u.sid === "CA_sr_legA" && String(u.url).includes("leg-a-challenge"))).toBe(true);

      // cloudtalk → relay /challenge-start with the exact window. Timestamp
      // fields are EPOCH MILLISECONDS (numbers) — the relay's persisted-state
      // schema — not ISO strings.
      const cs = relayPosts.find((r) => r.url === "https://relay.example.com/challenge-start");
      expect(cs).toBeTruthy();
      expect(cs!.body.sid).toBe(s.sessionId);
      expect(cs!.body.promptLightDurationMs).toBe(21_360);
      expect(typeof cs!.body.challengeStartedAt).toBe("number");
      expect(typeof cs!.body.promptEndsAt).toBe("number");
      expect(cs!.body.challengeStartedAt).toBe(after.challengeStartedAt!.getTime());
      expect(cs!.body.promptEndsAt).toBe(after.promptEndsAt!.getTime());
      expect(typeof cs!.body.transitionToleranceMs).toBe("number");

      // Idempotent: a duplicate stream-ready does not restart the challenge.
      const upd2 = updatedCalls.length;
      const again = await hookApp.request("/api/verify/stream-ready", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-verify-secret": "test-secret" },
        body: JSON.stringify({ sid: s.sessionId, streamSid: "MZ_ready_1" }),
      });
      expect(again.status).toBe(200);
      expect(updatedCalls.length).toBe(upd2);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.VERIFY_STREAM_URL;
      delete process.env.VERIFY_STREAM_SECRET;
    }
  });

  it("relay stream-ready BEFORE Leg B answer is buffered (never rejected) and drained at answer", async () => {
    // Leg B's TwiML opens the relay stream the instant the call connects, so
    // the relay's stream-ready can beat the answered status callback that
    // drives the FSM to LEG_B_ANSWERED. The readiness signal must be accepted
    // and recorded — a 500 would burn the relay's bounded retries.
    process.env.VERIFY_STREAM_URL = "wss://relay.example.com/stream";
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    const relayPosts: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      relayPosts.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("{}", { status: 200 });
    });
    try {
      const s = await makeSession(vs.VState.LEG_B_DIALING, {
        legACallSid: "CA_esr_legA",
        legBCallSid: "CA_esr_legB",
      });
      const res = await hookApp.request("/api/verify/stream-ready", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-verify-secret": "test-secret" },
        body: JSON.stringify({ sid: s.sessionId, streamSid: "MZ_early_1", readyAt: new Date().toISOString() }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
      // Readiness is recorded but the challenge has NOT started yet — the FSM
      // has not reached LEG_B_ANSWERED.
      let cur = (await vs.findSession(s.sessionId))!;
      expect(cur.state).toBe(vs.VState.LEG_B_DIALING);
      expect(cur.challengeStartedAt).toBeNull();
      expect(cur.streamReadyAt).toBeNull();
      expect((await events(s.sessionId)).map((e) => e.eventType)).toContain("STREAM_READY_EARLY");

      // The Leg B answer drains the buffered readiness: the challenge starts
      // immediately — persisted timeline, Leg A redirect, relay challenge-start.
      await vs.onLegBAnswered(s.sessionId, "CA_esr_legB");
      cur = (await vs.findSession(s.sessionId))!;
      expect(cur.state).toBe(vs.VState.LEG_B_ANSWERED);
      expect(cur.streamSid).toBe("MZ_early_1");
      expect(cur.streamReadyAt).not.toBeNull();
      expect(cur.challengeStartedAt).not.toBeNull();
      expect(cur.detectionPhase).toBe(vs.DetectionPhase.PROMPT_LIGHT);
      expect(
        updatedCalls.some((u) => u.sid === "CA_esr_legA" && String(u.url).includes("leg-a-challenge")),
      ).toBe(true);
      expect(relayPosts.some((r) => r.url === "https://relay.example.com/challenge-start")).toBe(true);
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).toContain("STREAM_READY_EARLY_DRAINED");
      expect(types).toContain("CHALLENGE_STARTED");
    } finally {
      vi.unstubAllGlobals();
      delete process.env.VERIFY_STREAM_URL;
      delete process.env.VERIFY_STREAM_SECRET;
    }
  });

  it("relay stream-ready is 500 (retryable) when the challenge redirect cannot be confirmed", async () => {
    process.env.VERIFY_STREAM_URL = "wss://relay.example.com/stream";
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    try {
      // No Leg A call leg → the challenge redirect cannot be confirmed… but a
      // headless session has no canary either. Use a session whose leg A
      // exists but force the redirect to fail via the mock.
      const s = await makeSession(vs.VState.LEG_B_ANSWERED, {
        legACallSid: "CA_srf_legA",
        legBCallSid: "CA_srf_legB",
        streamReadyBy: new Date(Date.now() + 60_000),
        detectionPhase: vs.DetectionPhase.AWAITING_STREAM_READY,
      });
      // …however with no relay fetch stub the challenge-start POST would hit
      // the network, so stub fetch to fail — delivery failure after retries
      // must flip the session to DETECTION_FAILED (never a pass).
      vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
      const res = await hookApp.request("/api/verify/stream-ready", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-verify-secret": "test-secret" },
        body: JSON.stringify({ sid: s.sessionId, streamSid: "MZ_fail_1" }),
      });
      expect(res.status).toBe(500);
      const after = (await vs.findSession(s.sessionId))!;
      expect(after.state).toBe(vs.VState.DETECTION_FAILED);
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).toContain("CHALLENGE_START_FAILED");
      expect(types).toContain("DETECTION_FAILED");
      // Never a pass: no bridge, no COMPLETED.
      expect(after.state).not.toBe(vs.VState.COMPLETED);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.VERIFY_STREAM_URL;
      delete process.env.VERIFY_STREAM_SECRET;
    }
  });

  it("relay stream-failed: DETECTION_FAILED with full teardown; wrong secret 403", async () => {
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    try {
      const s = await makeSession(vs.VState.BRIDGED, {
        guarded: true,
        callerCallSid: "CA_sf_caller",
        legACallSid: "CA_sf_legA",
        legBCallSid: "CA_sf_legB",
        ringTestCallSid: "CA_sf_rt",
        streamReadyBy: new Date(Date.now() + 60_000),
        detectionPhase: vs.DetectionPhase.AWAITING_STREAM_READY,
      });
      const bad = await hookApp.request("/api/verify/stream-failed", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-verify-secret": "nope" },
        body: JSON.stringify({ sid: s.sessionId, verdict: "DETECTION_FAILED", reason: "x" }),
      });
      expect(bad.status).toBe(403);

      const good = await hookApp.request("/api/verify/stream-failed", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-verify-secret": "test-secret" },
        body: JSON.stringify({
          sid: s.sessionId,
          verdict: "DETECTION_FAILED",
          reason: "websocket dropped mid-call",
          failedAt: new Date().toISOString(),
        }),
      });
      expect(good.status).toBe(200);
      const after = (await vs.findSession(s.sessionId))!;
      expect(after.state).toBe(vs.VState.DETECTION_FAILED);
      expect(after.failureReason).toContain("websocket dropped mid-call");
      // End Leg A, stop the stream/conference — everything exactly once.
      expect(updatedCalls.some((u) => u.sid === "CA_sf_legA" && u.status === "completed")).toBe(true);
      expect(updatedCalls.some((u) => u.sid === "CA_sf_legB" && u.status === "completed")).toBe(true);
      expect(updatedCalls.some((u) => u.sid === "CA_sf_caller" && u.status === "completed")).toBe(true);
      expect(conferenceUpdates.some((u) => u.status === "completed")).toBe(true);
      // Idempotent: a duplicate failure callback is a 200 no-op.
      const again = await hookApp.request("/api/verify/stream-failed", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-verify-secret": "test-secret" },
        body: JSON.stringify({ sid: s.sessionId, verdict: "DETECTION_FAILED", reason: "retry" }),
      });
      expect(again.status).toBe(200);
      expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.DETECTION_FAILED);
    } finally {
      delete process.env.VERIFY_STREAM_SECRET;
    }
  });

  it("relay stream-detected accepts the two-phase body (phase + evidence) via JSON", async () => {
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    try {
      const s = await makeSession(vs.VState.BRIDGED, {
        guarded: true,
        callerCallSid: "CA_sd_caller",
        legACallSid: "CA_sd_legA",
        legBCallSid: "CA_sd_legB",
        streamReadyAt: new Date(),
        challengeStartedAt: new Date(),
      });
      const res = await hookApp.request("/api/verify/stream-detected", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-verify-secret": "test-secret" },
        body: JSON.stringify({
          sid: s.sessionId,
          verdict: "MERGE_DETECTED",
          phase: "LOUD_DTMF",
          detectedAt: new Date().toISOString(),
          evidence: { goertzelStreakMs: 320 },
        }),
      });
      expect(res.status).toBe(200);
      await tick(200);
      const after = (await vs.findSession(s.sessionId))!;
      expect(after.state).toBe(vs.VState.MERGE_DETECTED);
      expect(after.toneDetected).toBe(true);
      const evts = (await events(s.sessionId)).map((e) => `${e.eventType}:${e.details}`);
      expect(evts.some((e) => e.startsWith("STREAM_DETECTED_CALLBACK:phase=LOUD_DTMF"))).toBe(true);
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
      Digits: "8", // the merge-tone pair 852+1336 Hz is DTMF-8
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
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    try {
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
      // Hold-canary forensics: non-blocking <Start><Stream> of the callee's
      // uplink to the in-process stream endpoint (first prompt only). The
      // Stream URL is BARE — Twilio strips query strings on Stream URLs, so
      // identity travels ONLY in customParameters.
      expect(body).toContain("<Start>");
      const streamUrl = body.match(/<Stream[^>]*url="([^"]+)"/)?.[1];
      expect(streamUrl).toBe("wss://verify-test.example.com/api/verify/stream");
      expect(streamUrl).not.toContain("?");
      expect(body).not.toContain("/api/verify/stream?sid=");
      expect(body).toContain('<Parameter name="sid" value="abc123"');
      expect(body).toContain('<Parameter name="leg" value="legA"');
      expect(body).toContain('<Parameter name="purpose" value="hold-canary"');
      expect(body).toContain(`<Parameter name="token" value="${streamToken("abc123")}"`);
      expect(body).toContain('track="inbound_track"');
    } finally {
      delete process.env.VERIFY_STREAM_SECRET;
    }
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
      Digits: "8", // 852+1336 Hz = DTMF-8
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
    // …and the stream-readiness deadline is armed (missing stream-ready is
    // DETECTION_FAILED, never a silent pass).
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("STREAM_READINESS_ARMED");

    // Terminal state → the parked caller is redirected to the verdict TwiML.
    await postForm(`/api/verify/gather/merge?sid=${s.sessionId}`, {
      CallSid: "CA_legb_p",
      Digits: "8", // 852+1336 Hz = DTMF-8
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
      "Speakerphone is permitted, but please tell the person receiving your call to use a quiet room, keep the phone close, and remove all background voices and noise. Repeated speakerphone-like audio or excessive background noise may cause a warning or end the call.",
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
    process.env.VERIFY_STREAM_SECRET = "test-secret";
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
    // Media stream attached on the first fetch (inbound callee uplink) —
    // bare URL + customParameters identity (no query-string sid).
    expect(gBody).toContain("<Start>");
    const gStreamUrl = gBody.match(/<Stream[^>]*url="([^"]+)"/)?.[1];
    expect(gStreamUrl).toBe("wss://verify-test.example.com/api/verify/stream");
    expect(gBody).not.toContain("/api/verify/stream?sid=");
    expect(gBody).toContain(`<Parameter name="sid" value="${g.sessionId}"`);
    expect(gBody).toContain('<Parameter name="leg" value="legA"');
    expect(gBody).toContain('<Parameter name="purpose" value="hold-canary"');
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
    delete process.env.VERIFY_STREAM_SECRET;
  });

  it("guarded press-1 records the save-only voice-ID phrase and falls forward to the ready gather", async () => {
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
    // Save-only: the phrase is captured as evidence, NEVER verified — no
    // transcription, no wait loop. The failed-action fallback lands on the
    // second press-1 step (leg-a-ready), the same place the action goes.
    expect(body).not.toContain('transcribe="true"');
    expect(body).not.toContain("/api/verify/voiceprint-transcription");
    expect(body).not.toContain("/api/verify/twiml/voice-id-wait");
    expect(body).toContain(`/api/verify/twiml/leg-a-ready?sid=${s.sessionId}`);
    expect(body).not.toContain("/api/verify/gather/leg-a-ready?sid=");
    expect(body).not.toContain("/api/verify/twiml/leg-a-hold?sid=");
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.CALL_ACCEPTED);
    // Leg B starts only from the SECOND press-1.
    expect(
      createdCalls.slice(before).some((c) => String(c.url).includes("/twiml/leg-b")),
    ).toBe(false);
    expect((await vs.findSession(s.sessionId))!.legBCallSid).toBeNull();
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("GUARDED_VOICEPRINT_STEP");
  });

  it("voiceprint action stamps the save-only capture and serves the ready gather IMMEDIATELY (no wait loop, no Leg B)", async () => {
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
      RecordingSid: "RE_vp_1",
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    // The capture is stamped on the session right away (save-only).
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.voiceIdRecordingSid).toBe("RE_vp_1");
    expect(after.voiceIdCapturedAt).not.toBeNull();
    expect(vs.voiceIdFreshForToday(after.voiceIdCapturedAt)).toBe(true);
    // …and the callee proceeds STRAIGHT to the second press-1 gather — no
    // voice-id-wait verdict gating, even with an empty/failed recording.
    expect(body).toContain("<Gather");
    expect(body).toContain(`/api/verify/gather/leg-a-ready?sid=${s.sessionId}`);
    expect(body).toContain("When you are ready, press 1.");
    expect(body).not.toContain("/api/verify/twiml/voice-id-wait");
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.CALL_ACCEPTED);
    // Leg B is still only originated by the second press-1 itself.
    expect(
      createdCalls.slice(before).some((c) => String(c.url).includes("/twiml/leg-b")),
    ).toBe(false);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("VOICE_ID_CAPTURED");
  });

  it("guarded second press-1 (after the save-only voice-ID) originates Leg B and parks Leg A", async () => {
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
    expect(body).not.toContain("/api/verify/twiml/voice-id-wait");
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
/* GUARDED MODE ONLY: save-only voice ID — capture + stamp, NO verification   */
/* -------------------------------------------------------------------------- */

describe("save-only voice ID (guarded)", () => {
  it("voiceprint action stamps voiceIdCapturedAt + voiceIdRecordingSid on the session", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_svid_caller",
      legACallSid: "CA_svid_legA",
    });
    const res = await postForm(`/api/verify/voiceprint?sid=${s.sessionId}`, {
      CallSid: "CA_svid_legA",
      RecordingUrl: "",
      RecordingDuration: "0",
      RecordingSid: "RE_save_1",
    });
    expect(res.status).toBe(200);
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.voiceIdRecordingSid).toBe("RE_save_1");
    expect(after.voiceIdCapturedAt).not.toBeNull();
    expect(vs.voiceIdFreshForToday(after.voiceIdCapturedAt)).toBe(true);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("VOICE_ID_CAPTURED");
  });

  it("a stamped capture is fresh only for the same UTC calendar day as the call", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, { guarded: true });
    await vs.markVoiceIdCaptured(s.sessionId, "RE_day_1");
    const after = (await vs.findSession(s.sessionId))!;
    expect(vs.voiceIdFreshForToday(after.voiceIdCapturedAt)).toBe(true);
    const yesterday = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect(vs.voiceIdFreshForToday(after.voiceIdCapturedAt, yesterday)).toBe(false);
  });

  it("markVoiceIdCaptured is a no-op for terminal/unknown sessions", async () => {
    const s = await makeSession(vs.VState.COMPLETED, { guarded: true });
    await vs.markVoiceIdCaptured(s.sessionId, "RE_late");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.voiceIdCapturedAt).toBeNull();
    expect(after.voiceIdRecordingSid).toBeNull();
    await vs.markVoiceIdCaptured("no-such-session", "RE_none"); // no throw
  });

  it("NO verdict: the voiceprint action proceeds even with an empty recording, and the ready press is never gated", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_sv2_caller",
      legACallSid: "CA_sv2_legA",
    });
    const before = createdCalls.length;
    // Empty recording (record step failed) — save-only flow still proceeds.
    const res = await postForm(`/api/verify/voiceprint?sid=${s.sessionId}`, {
      CallSid: "CA_sv2_legA",
      RecordingUrl: "",
      RecordingDuration: "0",
    });
    const body = await res.text();
    expect(body).toContain(`/api/verify/gather/leg-a-ready?sid=${s.sessionId}`);
    expect(body).not.toContain("/api/verify/twiml/voice-id-wait");
    // …and the ready press originates Leg B WITHOUT any voice-ID pass.
    await postForm(`/api/verify/gather/leg-a-ready?sid=${s.sessionId}&a=0`, {
      CallSid: "CA_sv2_legA",
      Digits: "1",
    });
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_B_DIALING);
    expect(
      createdCalls.slice(before).some((c) => String(c.url).includes("/twiml/leg-b")),
    ).toBe(true);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).not.toContain("VOICE_ID_GATE_BLOCKED");
    expect(types).not.toContain("VOICE_ID_FAILED");
    expect(types).not.toContain("VOICE_MISMATCH");
  });

  it("voice-id-wait TwiML no longer exists (unknown kind → polite hangup, not a wait loop)", async () => {
    const s = await makeSession(vs.VState.CALL_ACCEPTED, {
      guarded: true,
      callerCallSid: "CA_svw_caller",
      legACallSid: "CA_svw_legA",
    });
    const res = await postForm(`/api/verify/twiml/voice-id-wait?sid=${s.sessionId}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Unknown verification step.");
    expect(body).toContain("<Hangup");
    expect(body).not.toContain("<Pause");
    expect(body).not.toContain("voice-id-wait?sid=");
  });

  it("the transcription callback route is gone (save-only records are never transcribed)", async () => {
    const res = await postForm("/api/verify/voiceprint-transcription?sid=abc", {
      TranscriptionStatus: "completed",
      TranscriptionText: "my voice identifies me",
    });
    expect(res.status).toBe(404);
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

/* -------------------------------------------------------------------------- */
/* Smart SMS notifications (Crazytel) — Asterisk parity + upgrades            */
/* -------------------------------------------------------------------------- */

interface CapturedFetch {
  url: string;
  init?: RequestInit;
}

/** Save/restore the SMS env vars a test mutates. */
function smsEnvSnapshot() {
  const keys = ["SMS_ENABLED", "SMS_API_TOKEN", "SMS_MAX_ATTEMPTS", "SMS_INBOUND_TOKEN", "SMS_PROVIDER", "SMS_FROM"];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

describe("smart SMS notifications (Crazytel)", () => {
  it("wire contract: Authorization Bearer header, token NEVER in the JSON body (SmsService.java parity)", async () => {
    const restore = smsEnvSnapshot();
    process.env.SMS_ENABLED = "true";
    process.env.SMS_API_TOKEN = "ct_test_token";
    process.env.SMS_PROVIDER = "crazytel";
    const calls: CapturedFetch[] = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      // Ignore stray non-Crazytel fetches from earlier tests' fire-and-forget work.
      if (!String(url).includes("crazytel")) return new Response("{}", { status: 200 });
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "msg_abc" }), { status: 200 });
    });
    try {
      // No caller leg → detection itself triggers the confirmed SMS.
      const s = await makeSession(vs.VState.LEG_B_DIALING, { calleeNumber: "+61499990001" });
      await vs.onVoicemailDetected(s.sessionId, "machine_start");
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain("crazytel");
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer ct_test_token");
      const body = JSON.parse(String(calls[0].init?.body));
      expect(body).not.toHaveProperty("token");
      expect(body.to).toBe("+61499990001");
      expect(body.from).toBe("CallVerify");
      expect(body.message).toContain("call waiting");
      const evts = await events(s.sessionId);
      const sent = evts.find((e) => e.eventType === "SMS_SENT");
      expect(sent?.details).toContain("providerId=msg_abc");
      expect(sent?.details).toContain("template=confirmed");
    } finally {
      vi.unstubAllGlobals();
      restore();
    }
  });

  it("retries transient 5xx with backoff, then succeeds (delivery audit)", async () => {
    const restore = smsEnvSnapshot();
    process.env.SMS_ENABLED = "true";
    process.env.SMS_API_TOKEN = "ct_test_token";
    process.env.SMS_PROVIDER = "crazytel";
    process.env.SMS_MAX_ATTEMPTS = "3";
    const calls: CapturedFetch[] = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes("crazytel")) return new Response("{}", { status: 200 });
      calls.push({ url: String(url), init });
      // Fail twice, succeed on the third attempt.
      return calls.length < 3
        ? new Response("gateway error", { status: 502 })
        : new Response(JSON.stringify({ id: "msg_retry" }), { status: 200 });
    });
    try {
      const s = await makeSession(vs.VState.LEG_B_DIALING, { calleeNumber: "+61499990011" });
      await vs.onVoicemailDetected(s.sessionId, "machine_start");
      expect(calls).toHaveLength(3);
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).toContain("SMS_SENT");
      expect(types).not.toContain("SMS_FAILED");
    } finally {
      vi.unstubAllGlobals();
      restore();
    }
  }, 20_000);

  it("4xx is permanent — no retry, SMS_FAILED carries the status", async () => {
    const restore = smsEnvSnapshot();
    process.env.SMS_ENABLED = "true";
    process.env.SMS_API_TOKEN = "ct_bad_token";
    process.env.SMS_PROVIDER = "crazytel";
    const calls: CapturedFetch[] = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes("crazytel")) return new Response("{}", { status: 200 });
      calls.push({ url: String(url), init });
      return new Response("unauthorized", { status: 401 });
    });
    try {
      const s = await makeSession(vs.VState.LEG_B_DIALING, { calleeNumber: "+61499990012" });
      await vs.onVoicemailDetected(s.sessionId, "machine_start");
      expect(calls).toHaveLength(1);
      const failed = (await events(s.sessionId)).find((e) => e.eventType === "SMS_FAILED");
      expect(failed?.details).toContain("http=401");
    } finally {
      vi.unstubAllGlobals();
      restore();
    }
  });

  it("SMS_SKIPPED + no HTTP when disabled or token missing (default env)", async () => {
    const restore = smsEnvSnapshot();
    delete process.env.SMS_ENABLED;
    delete process.env.SMS_API_TOKEN;
    const calls: CapturedFetch[] = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes("crazytel")) return new Response("{}", { status: 200 });
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    });
    try {
      const s = await makeSession(vs.VState.LEG_B_DIALING, { calleeNumber: "+61499990013" });
      await vs.onVoicemailDetected(s.sessionId, "machine_start");
      expect(calls).toHaveLength(0);
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).toContain("SMS_QUEUED");
      expect(types).toContain("SMS_SKIPPED");
    } finally {
      vi.unstubAllGlobals();
      restore();
    }
  });

  it("SMART ESCALATION: repeat offender gets the *43# template + SMS_REPEAT_OFFENDER event", async () => {
    const restore = smsEnvSnapshot();
    process.env.SMS_ENABLED = "true";
    process.env.SMS_API_TOKEN = "ct_test_token";
    process.env.SMS_PROVIDER = "crazytel";
    const calls: CapturedFetch[] = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes("crazytel")) return new Response("{}", { status: 200 });
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "msg_rep" }), { status: 200 });
    });
    try {
      // Seed a prior terminal CALL_WAITING_OFF failure for this callee.
      await makeSession(vs.VState.CALL_WAITING_OFF, { calleeNumber: "+61499990014" });
      const s = await makeSession(vs.VState.LEG_B_DIALING, { calleeNumber: "+61499990014" });
      await vs.onVoicemailDetected(s.sessionId, "machine_start");
      expect(calls).toHaveLength(1);
      const body = JSON.parse(String(calls[0].init?.body));
      expect(body.message).toContain("*43#");
      const evts = await events(s.sessionId);
      expect(evts.map((e) => e.eventType)).toContain("SMS_REPEAT_OFFENDER");
      const sent = evts.find((e) => e.eventType === "SMS_SENT");
      expect(sent?.details).toContain("template=repeat");
    } finally {
      vi.unstubAllGlobals();
      restore();
    }
  });

  it("first-time callee gets the base template (no false escalation)", async () => {
    const restore = smsEnvSnapshot();
    process.env.SMS_ENABLED = "true";
    process.env.SMS_API_TOKEN = "ct_test_token";
    process.env.SMS_PROVIDER = "crazytel";
    const calls: CapturedFetch[] = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes("crazytel")) return new Response("{}", { status: 200 });
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    try {
      const s = await makeSession(vs.VState.LEG_B_DIALING, { calleeNumber: "+61499990015" });
      await vs.onVoicemailDetected(s.sessionId, "machine_start");
      const body = JSON.parse(String(calls[0].init?.body));
      expect(body.message).not.toContain("*43#");
      expect(body.message).toContain("AI SMS");
    } finally {
      vi.unstubAllGlobals();
      restore();
    }
  });

  it("CALL_WAITING_ANALYSIS: structured evidence trail event on detection", async () => {
    const s = await makeSession(vs.VState.LEG_B_DIALING, {
      calleeNumber: "+61499990016",
      guarded: true,
      legBOriginatedAt: new Date(Date.now() - 7000),
    });
    await vs.onVoicemailDetected(s.sessionId, "machine_start");
    const evt = (await events(s.sessionId)).find((e) => e.eventType === "CALL_WAITING_ANALYSIS");
    expect(evt).toBeDefined();
    const j = JSON.parse(evt!.details!);
    expect(j.reason).toContain("voicemail");
    expect(j.reason).toContain("machine_start");
    expect(j.stateAtDetection).toBe(vs.VState.LEG_B_DIALING);
    expect(j.guarded).toBe(true);
    expect(j.legBAgeMs).toBeGreaterThanOrEqual(6000);
    expect(j.priorCallWaitingOff).toBe(0);
    expect(j.smsWindowSec).toBe(0); // no caller leg
    expect(j.smsPlan).toContain("confirmed");
  });

  it("buildSmsMessage: repeat > confirmed > hangup precedence", () => {
    const cfg = { messageConfirmed: "C", messageHangup: "H", messageRepeat: "R" };
    expect(vs.buildSmsMessage(cfg, true, 0)).toBe("C");
    expect(vs.buildSmsMessage(cfg, false, 0)).toBe("H");
    expect(vs.buildSmsMessage(cfg, true, 2)).toBe("R");
    expect(vs.buildSmsMessage(cfg, false, 1)).toBe("R");
  });

  it("deliverSms: per-attempt timeout surfaces as an error result", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    try {
      const result = await vs.deliverSms(
        {
          provider: "crazytel",
          baseUrl: "https://sms.example.com/send",
          token: "t",
          from: "CallVerify",
          maxAttempts: 2,
          timeoutMs: 1000,
        },
        "+61499990017",
        "hello",
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("timeout");
    } finally {
      vi.unstubAllGlobals();
    }
  }, 20_000);
});

/* -------------------------------------------------------------------------- */
/* Inbound AI SMS — two-way reply channel (beyond the Asterisk version)       */
/* -------------------------------------------------------------------------- */

function postJson(url: string, data: Record<string, unknown>) {
  return hookApp.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

describe("inbound AI SMS", () => {
  it("buildAiSmsReply: model-specific walkthroughs", () => {
    expect(vs.buildAiSmsReply("iPhone 13")).toContain("Settings");
    expect(vs.buildAiSmsReply("iphone")).toContain("Call Waiting");
    expect(vs.buildAiSmsReply("Samsung Galaxy S23")).toContain("Supplementary services");
    expect(vs.buildAiSmsReply("google pixel 8")).toContain("Calls");
    expect(vs.buildAiSmsReply("oppo a57")).toContain("Calling accounts");
    // Unknown model → ask again + universal *43# fallback.
    const unknown = vs.buildAiSmsReply("hello");
    expect(unknown).toContain("didn't catch");
    expect(unknown).toContain("*43#");
    // Every reply carries the universal fallback.
    expect(vs.buildAiSmsReply("iPhone")).toContain("*43#");
  });

  it("end-to-end: callee replies with a model → AI walkthrough sent + event trail", async () => {
    const restore = smsEnvSnapshot();
    process.env.SMS_ENABLED = "true";
    process.env.SMS_API_TOKEN = "ct_test_token";
    process.env.SMS_PROVIDER = "crazytel";
    delete process.env.SMS_INBOUND_TOKEN;
    const calls: CapturedFetch[] = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes("crazytel")) return new Response("{}", { status: 200 });
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "msg_ai" }), { status: 200 });
    });
    try {
      const s = await makeSession(vs.VState.CALL_WAITING_OFF, { calleeNumber: "+61499990020" });
      const res = await postJson("/api/verify/sms/inbound", {
        from: "+61499990020",
        to: "+61400000099",
        text: "iPhone 13",
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; result: string };
      expect(json.result).toBe("replied");
      expect(calls).toHaveLength(1);
      const body = JSON.parse(String(calls[0].init?.body));
      expect(body.to).toBe("+61499990020");
      expect(body.message).toContain("iPhone");
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).toContain("SMS_INBOUND");
      expect(types).toContain("SMS_AI_REPLY");
    } finally {
      vi.unstubAllGlobals();
      restore();
    }
  });

  it("cooldown: a second inbound within 60s is not re-answered", async () => {
    const restore = smsEnvSnapshot();
    process.env.SMS_ENABLED = "true";
    process.env.SMS_API_TOKEN = "ct_test_token";
    process.env.SMS_PROVIDER = "crazytel";
    delete process.env.SMS_INBOUND_TOKEN;
    const calls: CapturedFetch[] = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes("crazytel")) return new Response("{}", { status: 200 });
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    try {
      await makeSession(vs.VState.CALL_WAITING_OFF, { calleeNumber: "+61499990021" });
      const r1 = await postJson("/api/verify/sms/inbound", { from: "+61499990021", text: "samsung" });
      expect(((await r1.json()) as { result: string }).result).toBe("replied");
      const r2 = await postJson("/api/verify/sms/inbound", { from: "+61499990021", text: "samsung s23" });
      expect(((await r2.json()) as { result: string }).result).toBe("cooldown");
      expect(calls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      restore();
    }
  });

  it("unknown sender (no session) still gets the walkthrough", async () => {
    const restore = smsEnvSnapshot();
    process.env.SMS_ENABLED = "true";
    process.env.SMS_API_TOKEN = "ct_test_token";
    process.env.SMS_PROVIDER = "crazytel";
    delete process.env.SMS_INBOUND_TOKEN;
    const calls: CapturedFetch[] = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes("crazytel")) return new Response("{}", { status: 200 });
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    try {
      const res = await postJson("/api/verify/sms/inbound", { from: "+61499990099", text: "pixel" });
      const json = (await res.json()) as { result: string };
      expect(json.result).toBe("replied");
      expect(calls).toHaveLength(1);
      expect(JSON.parse(String(calls[0].init?.body)).message).toContain("Pixel");
    } finally {
      vi.unstubAllGlobals();
      restore();
    }
  });

  it("shared-secret auth: wrong/missing token → 401 when SMS_INBOUND_TOKEN is set", async () => {
    const restore = smsEnvSnapshot();
    process.env.SMS_INBOUND_TOKEN = "secret123";
    try {
      const noToken = await postJson("/api/verify/sms/inbound", { from: "+61499990098", text: "hi" });
      expect(noToken.status).toBe(401);
      const wrong = await postJson("/api/verify/sms/inbound?token=nope", { from: "+61499990098", text: "hi" });
      expect(wrong.status).toBe(401);
    } finally {
      restore();
    }
  });

  it("validation: missing from/text → 400", async () => {
    const restore = smsEnvSnapshot();
    delete process.env.SMS_INBOUND_TOKEN;
    try {
      const res = await postJson("/api/verify/sms/inbound", { from: "+61499990097" });
      expect(res.status).toBe(400);
    } finally {
      restore();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Twilio SMS provider — same account as voice, no second vendor              */
/* -------------------------------------------------------------------------- */

describe("Twilio SMS provider", () => {
  it("sends via the Twilio Messages API (auto-selected when Twilio creds exist)", async () => {
    const restore = smsEnvSnapshot();
    process.env.SMS_ENABLED = "true";
    delete process.env.SMS_PROVIDER; // auto-select → twilio (creds are set globally)
    delete process.env.SMS_FROM; // falls back to TWILIO_CALLER_ID
    delete process.env.SMS_API_TOKEN;
    const calls: CapturedFetch[] = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes("crazytel")) return new Response("{}", { status: 200 });
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    });
    twilioMock.sentMessages.length = 0;
    try {
      const s = await makeSession(vs.VState.LEG_B_DIALING, { calleeNumber: "+61499990030" });
      await vs.onVoicemailDetected(s.sessionId, "machine_start");
      // Went through the Twilio SDK — NOT the Crazytel HTTP endpoint.
      expect(calls).toHaveLength(0);
      expect(twilioMock.sentMessages).toHaveLength(1);
      expect(twilioMock.sentMessages[0].to).toBe("+61499990030");
      expect(twilioMock.sentMessages[0].from).toBe("+61400000001"); // TWILIO_CALLER_ID fallback
      expect(twilioMock.sentMessages[0].body).toContain("call waiting");
      const sent = (await events(s.sessionId)).find((e) => e.eventType === "SMS_SENT");
      expect(sent?.details).toContain("via=twilio");
      expect(sent?.details).toContain("providerId=SM_mock_1");
    } finally {
      vi.unstubAllGlobals();
      restore();
    }
  });

  it("SMS_FROM overrides the caller-ID fallback on the twilio provider", async () => {
    const restore = smsEnvSnapshot();
    process.env.SMS_ENABLED = "true";
    process.env.SMS_PROVIDER = "twilio";
    process.env.SMS_FROM = "+61477778888";
    twilioMock.sentMessages.length = 0;
    try {
      const s = await makeSession(vs.VState.LEG_B_DIALING, { calleeNumber: "+61499990031" });
      await vs.onVoicemailDetected(s.sessionId, "machine_start");
      expect(twilioMock.sentMessages[0].from).toBe("+61477778888");
    } finally {
      restore();
    }
  });

  it("twilio provider: repeat-offender escalation also applies", async () => {
    const restore = smsEnvSnapshot();
    process.env.SMS_ENABLED = "true";
    process.env.SMS_PROVIDER = "twilio";
    delete process.env.SMS_FROM;
    twilioMock.sentMessages.length = 0;
    try {
      await makeSession(vs.VState.CALL_WAITING_OFF, { calleeNumber: "+61499990032" });
      const s = await makeSession(vs.VState.LEG_B_DIALING, { calleeNumber: "+61499990032" });
      await vs.onVoicemailDetected(s.sessionId, "machine_start");
      expect(twilioMock.sentMessages[0].body).toContain("*43#");
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).toContain("SMS_REPEAT_OFFENDER");
    } finally {
      restore();
    }
  });

  it("SMS_SKIPPED when twilio REST creds are absent and provider=twilio", async () => {
    const restore = smsEnvSnapshot();
    process.env.SMS_ENABLED = "true";
    process.env.SMS_PROVIDER = "twilio";
    const savedSid = process.env.TWILIO_ACCOUNT_SID;
    const savedTok = process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    twilioMock.sentMessages.length = 0;
    try {
      const s = await makeSession(vs.VState.LEG_B_DIALING, { calleeNumber: "+61499990033" });
      await vs.onVoicemailDetected(s.sessionId, "machine_start");
      expect(twilioMock.sentMessages).toHaveLength(0);
      const skipped = (await events(s.sessionId)).find((e) => e.eventType === "SMS_SKIPPED");
      expect(skipped?.details).toContain("provider=twilio");
    } finally {
      process.env.TWILIO_ACCOUNT_SID = savedSid;
      process.env.TWILIO_AUTH_TOKEN = savedTok;
      restore();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Twilio-format inbound SMS (From/Body form post + signature validation)     */
/* -------------------------------------------------------------------------- */

import nodeCrypto from "crypto";

/** Twilio request signature: base64 HMAC-SHA1 of url + sorted params. */
function twilioSign(authToken: string, url: string, params: Record<string, string>): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  return nodeCrypto.createHmac("sha1", authToken).update(data).digest("base64");
}

describe("Twilio-format inbound SMS", () => {
  it("accepts Twilio's From/Body form post and replies with the walkthrough", async () => {
    const restore = smsEnvSnapshot();
    process.env.SMS_ENABLED = "true";
    process.env.SMS_PROVIDER = "twilio";
    delete process.env.SMS_FROM;
    delete process.env.SMS_INBOUND_TOKEN;
    twilioMock.sentMessages.length = 0;
    try {
      const s = await makeSession(vs.VState.CALL_WAITING_OFF, { calleeNumber: "+61499990040" });
      const res = await postForm("/api/verify/sms/inbound", {
        From: "+61499990040",
        To: "+61400000001",
        Body: "iPhone 15",
      });
      expect(res.status).toBe(200);
      // Twilio gets empty TwiML (no auto-reply) — we reply via REST ourselves.
      expect(await res.text()).toContain("<Response/>");
      expect(twilioMock.sentMessages).toHaveLength(1);
      expect(twilioMock.sentMessages[0].to).toBe("+61499990040");
      expect(twilioMock.sentMessages[0].body).toContain("iPhone");
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).toContain("SMS_INBOUND");
      expect(types).toContain("SMS_AI_REPLY");
    } finally {
      restore();
    }
  });

  it("valid signed Twilio request passes; bad signature → 403", async () => {
    const restore = smsEnvSnapshot();
    process.env.SMS_ENABLED = "true";
    process.env.SMS_PROVIDER = "twilio";
    delete process.env.SMS_FROM;
    delete process.env.SMS_INBOUND_TOKEN;
    twilioMock.sentMessages.length = 0;
    const url = "https://verify-test.example.com/api/verify/sms/inbound";
    const params = { From: "+61499990041", To: "+61400000001", Body: "pixel 8" };
    try {
      await makeSession(vs.VState.CALL_WAITING_OFF, { calleeNumber: "+61499990041" });
      const good = twilioSign("test_auth_token", url, params);
      const res = await hookApp.request("/api/verify/sms/inbound", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Twilio-Signature": good,
        },
        body: new URLSearchParams(params),
      });
      expect(res.status).toBe(200);
      expect(twilioMock.sentMessages).toHaveLength(1);

      const bad = await hookApp.request("/api/verify/sms/inbound", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Twilio-Signature": "forged-signature",
        },
        body: new URLSearchParams(params),
      });
      expect(bad.status).toBe(403);
      expect(twilioMock.sentMessages).toHaveLength(1); // forged request never replied
    } finally {
      restore();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Bridge supervisor — conference events, join watchdog, callee drop recall   */
/* -------------------------------------------------------------------------- */

describe("bridge supervisor", () => {
  it("conference status callback logs join/leave with leg identification", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_cs_caller",
      legBCallSid: "CA_cs_legB",
    });
    const base = `/api/verify/conference?sid=${s.sessionId}`;
    await postForm(base, {
      StatusCallbackEvent: "conference-start",
      ConferenceSid: "CF_test_1",
    });
    await postForm(base, { StatusCallbackEvent: "participant-join", CallSid: "CA_cs_legB", ConferenceSid: "CF_test_1" });
    await postForm(base, { StatusCallbackEvent: "participant-join", CallSid: "CA_cs_caller", ConferenceSid: "CF_test_1" });
    await postForm(base, { StatusCallbackEvent: "participant-leave", CallSid: "CA_cs_legB", ConferenceSid: "CF_test_1" });
    const evts = (await events(s.sessionId)).map((e) => `${e.eventType}:${e.details}`);
    expect(evts.some((e) => e.startsWith("CONF_STARTED:"))).toBe(true);
    expect(evts.some((e) => e.startsWith("CONF_PARTICIPANT_JOINED:leg=legB"))).toBe(true);
    expect(evts.some((e) => e.startsWith("CONF_PARTICIPANT_JOINED:leg=caller"))).toBe(true);
    expect(evts.some((e) => e.startsWith("CONF_PARTICIPANT_LEFT:leg=legB"))).toBe(true);
  });

  it("join watchdog re-redirects bridge legs (caller + legB) that never JOINED the conference", async () => {
    const saved = process.env.VERIFY_BRIDGE_WATCHDOG_MS;
    process.env.VERIFY_STREAM_URL = "wss://relay.example.com/stream";
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    process.env.VERIFY_BRIDGE_WATCHDOG_MS = "50";
    try {
      const s = await makeSession(vs.VState.LEG_B_DIALING, {
        guarded: true,
        callerCallSid: "CA_wd_caller",
        legACallSid: "CA_wd_legA",
      });
      // Bridge happens at Leg B answer; the watchdog proves BOTH live parties
      // (caller + legB — never the canary legA) actually joined.
      await vs.onLegBAnswered(s.sessionId, "CA_wd_legB");
      expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.BRIDGED);
      // No participant-join events arrive → the watchdog must notice BOTH legs.
      await tick(400);
      const evts = (await events(s.sessionId)).map((e) => `${e.eventType}:${e.details}`);
      expect(evts.some((e) => e.startsWith("BRIDGE_JOIN_MISSING:leg=caller"))).toBe(true);
      expect(evts.some((e) => e.startsWith("BRIDGE_JOIN_MISSING:leg=legB"))).toBe(true);
      expect(evts.some((e) => e.startsWith("BRIDGE_JOIN_MISSING:leg=legA"))).toBe(false);
      // Each missing leg is re-redirected into the bridge.
      expect(updatedCalls.filter((u) => String(u.url).includes("guarded-bridge") && u.sid === "CA_wd_caller").length).toBeGreaterThanOrEqual(2);
      expect(updatedCalls.filter((u) => String(u.url).includes("guarded-bridge") && u.sid === "CA_wd_legB").length).toBeGreaterThanOrEqual(1);
    } finally {
      delete process.env.VERIFY_STREAM_URL;
      delete process.env.VERIFY_STREAM_SECRET;
      if (saved === undefined) delete process.env.VERIFY_BRIDGE_WATCHDOG_MS;
      else process.env.VERIFY_BRIDGE_WATCHDOG_MS = saved;
    }
  });

  it("join watchdog is silent when both legs provably joined", async () => {
    const saved = process.env.VERIFY_BRIDGE_WATCHDOG_MS;
    process.env.VERIFY_STREAM_URL = "wss://relay.example.com/stream";
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    process.env.VERIFY_BRIDGE_WATCHDOG_MS = "50";
    try {
      const s = await makeSession(vs.VState.LEG_B_DIALING, {
        guarded: true,
        callerCallSid: "CA_ok_caller",
        legACallSid: "CA_ok_legA",
      });
      await vs.onLegBAnswered(s.sessionId, "CA_ok_legB");
      expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.BRIDGED);
      // Simulate Twilio's participant-join callbacks for BOTH live parties.
      await postForm(`/api/verify/conference?sid=${s.sessionId}`, { StatusCallbackEvent: "participant-join", CallSid: "CA_ok_legB" });
      await postForm(`/api/verify/conference?sid=${s.sessionId}`, { StatusCallbackEvent: "participant-join", CallSid: "CA_ok_caller" });
      await tick(400);
      const types = (await events(s.sessionId)).map((e) => e.eventType);
      expect(types).not.toContain("BRIDGE_JOIN_MISSING");
    } finally {
      delete process.env.VERIFY_STREAM_URL;
      delete process.env.VERIFY_STREAM_SECRET;
      if (saved === undefined) delete process.env.VERIFY_BRIDGE_WATCHDOG_MS;
      else process.env.VERIFY_BRIDGE_WATCHDOG_MS = saved;
    }
  });

  it("BRIDGE_RECALL: callee live leg (Leg B) drops mid-call → re-dialled straight into the conference", async () => {
    const createsBefore = createdCalls.length;
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_rc_caller",
      legACallSid: "CA_rc_legA",
      legBCallSid: "CA_rc_legB",
      streamReadyAt: new Date(Date.now() - 30_000),
      challengeStartedAt: new Date(Date.now() - 30_000),
    });
    await vs.onCallCompleted(s.sessionId, "legB", "CA_rc_legB", "duration=95s");
    const after = (await vs.findSession(s.sessionId))!;
    // Session STAYS BRIDGED and a fresh callee live leg was originated
    // (legB role) with the readiness deadline re-armed.
    expect(after.state).toBe(vs.VState.BRIDGED);
    expect(after.legBCallSid).not.toBe("CA_rc_legB");
    expect(after.detectionPhase).toBe(vs.DetectionPhase.AWAITING_STREAM_READY);
    expect(after.streamReadyBy).not.toBeNull();
    const created = createdCalls.slice(createsBefore);
    expect(created).toHaveLength(1);
    expect(created[0].to).toBe("+61400000000");
    expect(String(created[0].url)).toContain("bridge-recall");
    expect(String(created[0].statusCallback)).toContain("/api/verify/status/legB");
    // Caller was told we're reconnecting (conference announce to caller only).
    expect(
      participantUpdates.some(
        (p) => p.participant === "CA_rc_caller" && String(p.announceUrl).includes("notify-reconnecting"),
      ),
    ).toBe(true);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("BRIDGE_RECALL");
    expect(types).toContain("BRIDGE_RECALL_DIALED");
    expect(types).not.toContain("GUARDED_CALL_ENDED");
  });

  it("bridge recall RE-GATES stream readiness: stale sid rejected, only the NEW stream restarts the challenge", async () => {
    process.env.VERIFY_STREAM_URL = "wss://relay.example.com/stream";
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    const relayPosts: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      relayPosts.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("{}", { status: 200 });
    });
    try {
      const s = await makeSession(vs.VState.BRIDGED, {
        guarded: true,
        callerCallSid: "CA_rg_caller",
        legACallSid: "CA_rg_legA",
        legBCallSid: "CA_rg_legB",
        streamSid: "MZ_old_stream",
        streamReadyAt: new Date(Date.now() - 60_000),
        challengeStartedAt: new Date(Date.now() - 60_000),
        promptLightDurationMs: 21_360,
        promptEndsAt: new Date(Date.now() - 41_000),
        detectionPhase: vs.DetectionPhase.LOUD_DTMF,
      });
      // Callee drops → auto-recall: readiness is reset (streamReadyAt=null,
      // deadline re-armed) while the old streamSid is KEPT as the stale guard.
      await vs.onCallCompleted(s.sessionId, "legB", "CA_rg_legB", "duration=95s");
      const mid = (await vs.findSession(s.sessionId))!;
      expect(mid.state).toBe(vs.VState.BRIDGED);
      expect(mid.streamReadyAt).toBeNull();
      expect(mid.streamSid).toBe("MZ_old_stream");
      expect(mid.detectionPhase).toBe(vs.DetectionPhase.AWAITING_STREAM_READY);
      expect(mid.streamReadyBy).not.toBeNull();
      // The relay was re-armed for the new leg (no terminal verdict from the
      // old attempt blocks it).
      expect(relayPosts.some((r) => r.url === "https://relay.example.com/arm")).toBe(true);

      // A LATE stream-ready for the OLD (dead) stream must NOT re-open the
      // challenge against it.
      const stale = await vs.onStreamReady(s.sessionId, "MZ_old_stream", new Date().toISOString());
      expect(stale.ok).toBe(false);
      let cur = (await vs.findSession(s.sessionId))!;
      expect(cur.streamReadyAt).toBeNull();
      expect(cur.challengeStartedAt!.getTime()).toBeLessThan(Date.now() - 30_000); // untouched
      expect((await events(s.sessionId)).map((e) => e.eventType)).toContain("STREAM_READY_SUPERSEDED");

      // The NEW stream's ready re-gates readiness and restarts the challenge:
      // fresh timestamps, Leg A back into Phase 1, relay /challenge-start with
      // epoch-ms numbers.
      const updBefore = updatedCalls.length;
      const fresh = await vs.onStreamReady(s.sessionId, "MZ_new_stream", new Date().toISOString());
      expect(fresh.ok).toBe(true);
      cur = (await vs.findSession(s.sessionId))!;
      expect(cur.streamSid).toBe("MZ_new_stream");
      expect(cur.streamReadyAt).not.toBeNull();
      expect(cur.challengeStartedAt!.getTime()).toBeGreaterThan(Date.now() - 10_000);
      expect(cur.promptEndsAt!.getTime()).toBe(cur.challengeStartedAt!.getTime() + 21_360);
      expect(cur.detectionPhase).toBe(vs.DetectionPhase.PROMPT_LIGHT);
      expect(
        updatedCalls
          .slice(updBefore)
          .some((u) => u.sid === "CA_rg_legA" && String(u.url).includes("leg-a-challenge")),
      ).toBe(true);
      const cs = relayPosts.filter((r) => r.url === "https://relay.example.com/challenge-start");
      expect(cs.length).toBeGreaterThanOrEqual(1);
      expect(typeof cs.at(-1)!.body.challengeStartedAt).toBe("number");
      expect(cs.at(-1)!.body.challengeStartedAt).toBe(cur.challengeStartedAt!.getTime());

      // Duplicate ready for the now-live stream stays an idempotent no-op.
      const upd2 = updatedCalls.length;
      const dup = await vs.onStreamReady(s.sessionId, "MZ_new_stream");
      expect(dup.ok).toBe(true);
      expect(updatedCalls.length).toBe(upd2);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.VERIFY_STREAM_URL;
      delete process.env.VERIFY_STREAM_SECRET;
    }
  });

  it("bridge recall happens ONCE — a second callee drop is DETECTION_INCONCLUSIVE (recalled leg unmonitored)", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_rc2_caller",
      legACallSid: "CA_rc2_legA",
      legBCallSid: "CA_rc2_legB",
      streamReadyAt: new Date(Date.now() - 30_000),
      challengeStartedAt: new Date(Date.now() - 30_000),
    });
    await vs.onCallCompleted(s.sessionId, "legB", "CA_rc2_legB", "duration=60s");
    const mid = (await vs.findSession(s.sessionId))!;
    expect(mid.state).toBe(vs.VState.BRIDGED);
    const createsBefore = createdCalls.length;
    // The recalled leg drops too → no second recall. The recall never
    // re-confirmed readiness, so the outcome is inconclusive, never a pass.
    await vs.onCallCompleted(s.sessionId, "legB", mid.legBCallSid!, "duration=20s");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.DETECTION_INCONCLUSIVE);
    expect(createdCalls.slice(createsBefore)).toHaveLength(0);
    // The caller is not stranded either: the conference is completed by SID so
    // the surviving caller leg drops into its post-Dial notify-partner-ended.
    expect(
      conferenceUpdates.some(
        (u) => u.conference === `verify-${s.sessionId}` && u.status === "completed",
      ),
    ).toBe(true);
  });

  it("bridge recall unanswered → conference ended, session COMPLETED, caller released", async () => {
    const s = await makeSession(vs.VState.BRIDGED, {
      guarded: true,
      callerCallSid: "CA_rc3_caller",
      legACallSid: "CA_rc3_legA",
      legBCallSid: "CA_rc3_legB",
      streamReadyAt: new Date(Date.now() - 30_000),
      challengeStartedAt: new Date(Date.now() - 30_000),
    });
    await vs.onCallCompleted(s.sessionId, "legB", "CA_rc3_legB", "duration=60s");
    expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.BRIDGED);
    // The recall call rings out / is declined → legB failure while BRIDGED.
    await vs.onLegFailed(s.sessionId, "legB", "no-answer");
    const after = (await vs.findSession(s.sessionId))!;
    expect(after.state).toBe(vs.VState.COMPLETED);
    expect(conferenceUpdates.some((u) => u.status === "completed")).toBe(true);
    const types = (await events(s.sessionId)).map((e) => e.eventType);
    expect(types).toContain("BRIDGE_RECALL_UNANSWERED");
  });

  it("bridge-recall TwiML reconnects straight into the conference with a fresh detection stream", async () => {
    process.env.VERIFY_STREAM_URL = "wss://relay.example.com/stream";
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    try {
      const res = await postForm("/api/verify/twiml/bridge-recall?sid=abc123");
      const body = await res.text();
      expect(body).toContain("Reconnecting your call");
      expect(body).toContain("<Conference");
      expect(body).toContain("verify-abc123");
      // Recall leg re-opens the inbound-only relay stream (monitoring resumes).
      expect(body).toContain("<Start>");
      expect(body).toContain('track="inbound_track"');
      expect(body).toContain('<Parameter name="leg" value="legB"');
      expect(body).toContain('<Parameter name="mode" value="merge-detection"');
      // ...AND the in-process speakerphone stream (the old call's stream died
      // with it): bare in-process URL + customParameters identity.
      expect(body).toContain('<Parameter name="purpose" value="speakerphone"');
      expect(body).toContain("wss://verify-test.example.com/api/verify/stream");
      expect(body).not.toContain("/api/verify/stream?sid=");
      // Recall leg can start the room (caller may have left) but never ends it.
      expect(body).toContain('startConferenceOnEnter="true"');
      expect(body).toContain('endConferenceOnExit="false"');
    } finally {
      delete process.env.VERIFY_STREAM_URL;
      delete process.env.VERIFY_STREAM_SECRET;
    }
  });

  it("notify-reconnecting TwiML is a caller-only announce doc", async () => {
    const res = await postForm("/api/verify/twiml/notify-reconnecting?sid=abc123");
    const body = await res.text();
    expect(body).toContain("Reconnecting");
    expect(body).toContain("<Hangup");
  });

  it("version endpoint reports the deployed commit marker", async () => {
    const res = await hookApp.request("/api/verify/version", { method: "GET" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { commit: string; time: string };
    expect(json).toHaveProperty("commit");
    expect(json).toHaveProperty("time");
  });
});

/* -------------------------------------------------------------------------- */
/* In-process media stream: customParameters identity, auth, purpose routing   */
/* -------------------------------------------------------------------------- */

import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";

describe("in-process stream identity (customParameters, no query string)", () => {
  it("inProcessStreamUrl is a BARE wss URL (Twilio strips Stream query strings)", () => {
    const url = inProcessStreamUrl();
    expect(url).toBe("wss://verify-test.example.com/api/verify/stream");
    expect(url).not.toContain("?");
  });

  it("streamTokenValid accepts the per-session HMAC, rejects bad/missing tokens", () => {
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    try {
      expect(streamTokenValid("abc123", streamToken("abc123"))).toBe(true);
      expect(streamTokenValid("abc123", streamToken("other"))).toBe(false);
      expect(streamTokenValid("abc123", "deadbeef")).toBe(false);
      expect(streamTokenValid("abc123", "")).toBe(false);
      expect(streamTokenValid("abc123", undefined)).toBe(false);
      expect(streamTokenValid("", streamToken("abc123"))).toBe(false);
    } finally {
      delete process.env.VERIFY_STREAM_SECRET;
    }
    // No secret configured → nothing validates.
    expect(streamTokenValid("abc123", streamToken("abc123"))).toBe(false);
  });

  it("authenticateStreamStart routes by purpose and rejects bad identity", () => {
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    try {
      const good = authenticateStreamStart({
        customParameters: {
          sid: "abc123",
          leg: "legB",
          purpose: "speakerphone",
          token: streamToken("abc123"),
        },
      });
      expect(good).toEqual({
        ok: true,
        identity: { sid: "abc123", leg: "legB", purpose: "speakerphone" },
      });
      const canary = authenticateStreamStart({
        customParameters: {
          sid: "abc123",
          leg: "legA",
          purpose: "hold-canary",
          token: streamToken("abc123"),
        },
      });
      expect(canary).toEqual({
        ok: true,
        identity: { sid: "abc123", leg: "legA", purpose: "hold-canary" },
      });
      // Missing customParameters entirely (the old query-string-only stream).
      const none = authenticateStreamStart(undefined);
      expect(none.ok).toBe(false);
      if (!none.ok) expect(none.code).toBe(4400);
      // leg/purpose mismatch and unknown purpose.
      for (const p of [
        { sid: "abc123", leg: "legB", purpose: "hold-canary", token: streamToken("abc123") },
        { sid: "abc123", leg: "legA", purpose: "speakerphone", token: streamToken("abc123") },
        { sid: "abc123", leg: "legA", purpose: "bogus", token: streamToken("abc123") },
        { sid: "", leg: "legA", purpose: "hold-canary", token: streamToken("abc123") },
      ]) {
        const r = authenticateStreamStart({ customParameters: p });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe(4400);
      }
      // Valid shape, bad token → 4403.
      const badToken = authenticateStreamStart({
        customParameters: {
          sid: "abc123",
          leg: "legA",
          purpose: "hold-canary",
          token: streamToken("attacker"),
        },
      });
      expect(badToken.ok).toBe(false);
      if (!badToken.ok) expect(badToken.code).toBe(4403);
    } finally {
      delete process.env.VERIFY_STREAM_SECRET;
    }
  });
});

describe("in-process stream WebSocket (auth + detector routing)", () => {
  let server: HttpServer | undefined;
  let wsUrl = "";

  const SILENCE_FRAME = Buffer.alloc(160, 0xff).toString("base64");

  async function connect(): Promise<WebSocket> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    return ws;
  }

  function sendStart(ws: WebSocket, params: Record<string, string> | null): void {
    ws.send(
      JSON.stringify({
        event: "start",
        sequenceNumber: "1",
        start: {
          streamSid: "MZ_test_stream",
          callSid: "CA_test_call",
          tracks: ["inbound"],
          ...(params ? { customParameters: params } : {}),
        },
      }),
    );
  }

  function sendMedia(ws: WebSocket, n = 3): void {
    for (let i = 0; i < n; i++) {
      ws.send(
        JSON.stringify({
          event: "media",
          sequenceNumber: String(i + 2),
          media: { track: "inbound", payload: SILENCE_FRAME },
        }),
      );
    }
  }

  function closeCode(ws: WebSocket): Promise<number> {
    return new Promise((resolve) => ws.on("close", (code) => resolve(code)));
  }

  /** Wait until the stream is registered AND its detectors are attached. */
  async function waitAttached(sid: string) {
    for (let i = 0; i < 200; i++) {
      const st = [...activeStreams].find(
        (s) => s.sid === sid && (s.sp !== null || s.hold !== null),
      );
      if (st) return st;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`stream ${sid} never attached detectors`);
  }

  async function boot() {
    if (server) return;
    const srv = createServer();
    attachVerificationStreamServer(srv);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    server = srv;
    wsUrl = `ws://127.0.0.1:${(srv.address() as AddressInfo).port}/api/verify/stream`;
  }

  afterAll(async () => {
    if (server) await new Promise((r) => server!.close(r));
  });

  it("rejects a start without customParameters (old ?sid= scheme) with 4400", async () => {
    await boot();
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    try {
      // Even with the legacy ?sid= query param on the URL, identity is never
      // taken from the query string.
      const ws = new WebSocket(`${wsUrl}?sid=abc123`);
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      sendStart(ws, null);
      expect(await closeCode(ws)).toBe(4400);
    } finally {
      delete process.env.VERIFY_STREAM_SECRET;
    }
  });

  it("rejects a bad token with 4403", async () => {
    await boot();
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    try {
      const ws = await connect();
      sendStart(ws, {
        sid: "abc123",
        leg: "legB",
        purpose: "speakerphone",
        token: streamToken("forged"),
      });
      expect(await closeCode(ws)).toBe(4403);
    } finally {
      delete process.env.VERIFY_STREAM_SECRET;
    }
  });

  it("purpose=speakerphone (legB): frames feed the SpeakerphoneDetector ONLY", async () => {
    await boot();
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    const s = await makeSession(vs.VState.LEG_B_ANSWERED, { guarded: true });
    const spPush = vi.spyOn(SpeakerphoneDetector.prototype, "push");
    const holdPush = vi.spyOn(HoldDetector.prototype, "push");
    try {
      const ws = await connect();
      sendStart(ws, {
        sid: s.sessionId,
        leg: "legB",
        purpose: "speakerphone",
        token: streamToken(s.sessionId),
      });
      const st = await waitAttached(s.sessionId);
      expect(st.purpose).toBe("speakerphone");
      expect(st.sp).toBeInstanceOf(SpeakerphoneDetector);
      expect(st.hold).toBeNull();
      // No in-call merge recognizer on ANY stream — in-call merge detection
      // is the authorised relay A→B path (Leg B inbound).
      expect((st as unknown as Record<string, unknown>).merge).toBeUndefined();
      sendMedia(ws, 3);
      await vi.waitFor(() => expect(spPush).toHaveBeenCalledTimes(3));
      expect(holdPush).not.toHaveBeenCalled();
      expect(st.frames).toBe(3);
      expect(isSpeakerphoneSuspecting(s.sessionId)).toBe(false);
      ws.close();
    } finally {
      spPush.mockRestore();
      holdPush.mockRestore();
      delete process.env.VERIFY_STREAM_SECRET;
    }
  });

  it("purpose=hold-canary (legA): frames feed the HoldDetector ONLY (Call Waiting state telemetry), NEVER speakerphone", async () => {
    await boot();
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    const s = await makeSession(vs.VState.BRIDGED, { guarded: true });
    const spPush = vi.spyOn(SpeakerphoneDetector.prototype, "push");
    const holdPush = vi.spyOn(HoldDetector.prototype, "push");
    try {
      const ws = await connect();
      sendStart(ws, {
        sid: s.sessionId,
        leg: "legA",
        purpose: "hold-canary",
        token: streamToken(s.sessionId),
      });
      const st = await waitAttached(s.sessionId);
      expect(st.purpose).toBe("hold-canary");
      expect(st.hold).toBeInstanceOf(HoldDetector);
      expect(st.sp).toBeNull(); // speakerphone analysis moved to Leg B
      // The in-call armed merge-tone recognizer is GONE (removed with the
      // legacy Leg B tone-injection path on 2026-09-05).
      expect((st as unknown as Record<string, unknown>).merge).toBeUndefined();
      sendMedia(ws, 3);
      await vi.waitFor(() => expect(holdPush).toHaveBeenCalledTimes(3));
      expect(spPush).not.toHaveBeenCalled();
      expect(st.frames).toBe(3);
      ws.close();
    } finally {
      spPush.mockRestore();
      holdPush.mockRestore();
      delete process.env.VERIFY_STREAM_SECRET;
    }
  });

  it("drops media that arrives before an authenticated start", async () => {
    await boot();
    process.env.VERIFY_STREAM_SECRET = "test-secret";
    try {
      // Earlier tests' sockets may still be finishing their close handshake
      // — wait for the registry to drain first so sizes are comparable.
      await vi.waitFor(() => expect(activeStreams.size).toBe(0));
      const ws = await connect();
      sendMedia(ws, 2); // unidentified — must be dropped, not crash
      await new Promise((r) => setTimeout(r, 50));
      expect(activeStreams.size).toBe(0); // no stream registered
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    } finally {
      delete process.env.VERIFY_STREAM_SECRET;
    }
  });
});

describe("relay cold-start warm-up ping", () => {
  it("wakeRelay GETs the relay /health (base derived from VERIFY_STREAM_URL)", async () => {
    process.env.VERIFY_STREAM_URL = "wss://relay.example.com/stream";
    const calls: string[] = [];
    setRelayWarmupFetch((async (url: unknown) => {
      calls.push(String(url));
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch);
    try {
      wakeRelay();
      await vi.waitFor(() => expect(calls).toEqual(["https://relay.example.com/health"]));
    } finally {
      setRelayWarmupFetch(null);
      delete process.env.VERIFY_STREAM_URL;
    }
  });

  it("wakeRelay is a no-op when the relay is not configured", async () => {
    delete process.env.VERIFY_STREAM_URL;
    const calls: string[] = [];
    setRelayWarmupFetch((async (url: unknown) => {
      calls.push(String(url));
      return { ok: true };
    }) as unknown as typeof fetch);
    try {
      wakeRelay();
      await new Promise((r) => setTimeout(r, 50));
      expect(calls).toEqual([]);
    } finally {
      setRelayWarmupFetch(null);
    }
  });

  it("wakeRelay swallows failures (logged, never thrown)", async () => {
    process.env.VERIFY_STREAM_URL = "wss://relay.example.com/stream";
    setRelayWarmupFetch((async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch);
    try {
      expect(() => wakeRelay()).not.toThrow();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      setRelayWarmupFetch(null);
      delete process.env.VERIFY_STREAM_URL;
    }
  });

  it("session INITIATION fires the warm-up ping (best-effort, before Leg A)", async () => {
    process.env.VERIFY_STREAM_URL = "wss://relay.example.com/stream";
    const calls: string[] = [];
    setRelayWarmupFetch((async (url: unknown) => {
      calls.push(String(url));
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch);
    try {
      const s = await vs.initiate({ calleeNumber: "+61400000000" });
      createdIds.push(s.sessionId);
      expect(s.state).toBe(vs.VState.LEG_A_DIALING);
      await vi.waitFor(() =>
        expect(calls).toContain("https://relay.example.com/health"),
      );
    } finally {
      setRelayWarmupFetch(null);
      delete process.env.VERIFY_STREAM_URL;
    }
  });

  it("a failed warm-up ping NEVER blocks or fails session initiation", async () => {
    process.env.VERIFY_STREAM_URL = "wss://relay.example.com/stream";
    setRelayWarmupFetch((async () => {
      throw new Error("relay unreachable");
    }) as unknown as typeof fetch);
    try {
      const s = await vs.initiate({ calleeNumber: "+61400000000" });
      createdIds.push(s.sessionId);
      expect(s.state).toBe(vs.VState.LEG_A_DIALING);
      await new Promise((r) => setTimeout(r, 50));
      expect((await vs.findSession(s.sessionId))!.state).toBe(vs.VState.LEG_A_DIALING);
    } finally {
      setRelayWarmupFetch(null);
      delete process.env.VERIFY_STREAM_URL;
    }
  });
});
