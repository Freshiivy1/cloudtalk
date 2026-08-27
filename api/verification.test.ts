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
  };
  const factory = (() => fakeClient) as unknown as typeof realTwilio;
  // verification-webhooks.ts uses twilio.twiml.VoiceResponse for real TwiML.
  Object.assign(factory, { twiml: realTwilio.twiml, jwt: realTwilio.jwt });
  return { ...actual, default: factory };
});

const { createdCalls, updatedCalls } = twilioMock;

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
import { verificationRecordingHandler } from "./verification-record";
import { verificationStreamDetectedHandler, relayStreamUrl } from "./verification-stream";
import {
  verificationStatusHandler,
  verificationTwimlHandler,
} from "./verification-webhooks";

const hookApp = new Hono();
hookApp.post("/api/verify/twiml/:kind", verificationTwimlHandler);
hookApp.post("/api/verify/status/:leg", verificationStatusHandler);
hookApp.post("/api/verify/gather/merge", verificationGatherHandler);
hookApp.post("/api/verify/gather/leg-a-accept", verificationGatherLegAAcceptHandler);
hookApp.post("/api/verify/gather/leg-a-ready", verificationGatherLegAReadyHandler);
hookApp.get("/api/verify/tone.wav", verificationToneHandler);
hookApp.post("/api/verify/recording/merge", verificationRecordingHandler);
hookApp.post("/api/verify/stream-detected", verificationStreamDetectedHandler);

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
    expect(body).toContain("Press 1 when you are ready to proceed");
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

