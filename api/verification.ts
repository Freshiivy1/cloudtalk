/**
 * CallVerify port — verification session state machine (Twilio edition).
 *
 * Method-by-method port of piecebyte's SessionService.java. Asterisk AMI
 * originate/redirect/hangup are replaced by Twilio REST calls
 * (`calls.create`, `calls(sid).update({ url })`, `calls(sid).update({ status:
 * "completed" })`); Asterisk channels are replaced by Twilio Call SIDs stored
 * on the session row. All state transitions + the event timeline are
 * persisted via Drizzle (verificationSessions / verificationEvents).
 *
 * Webhook wiring lives in api/verification-webhooks.ts; the TwiML documents
 * reference these endpoints:
 *   POST {PUBLIC_BASE_URL}/api/verify/twiml/:kind?sid=...
 *   POST {PUBLIC_BASE_URL}/api/verify/status/:leg?sid=...
 *   POST {PUBLIC_BASE_URL}/api/verify/gather/merge?sid=...
 *   POST {PUBLIC_BASE_URL}/api/verify/gather/leg-a-accept?sid=...
 *   POST {PUBLIC_BASE_URL}/api/verify/gather/leg-a-ready?sid=...
 */
import { TRPCError } from "@trpc/server";
import { and, eq, lt, notInArray } from "drizzle-orm";
import * as schema from "@db/schema";
import type { VerificationSession } from "@db/schema";
import { getDb } from "./queries/connection";
import {
  getTwilioClient,
  twilioCallerId,
  twilioRestConfigured,
} from "./twilio-voice";

/* -------------------------------------------------------------------------- */
/* States                                                                      */
/* -------------------------------------------------------------------------- */

export const VState = {
  INITIATED: "INITIATED",
  CALLER_HOLDING: "CALLER_HOLDING",
  LEG_A_DIALING: "LEG_A_DIALING",
  CALL_ACCEPTED: "CALL_ACCEPTED",
  CALLEE_READY: "CALLEE_READY",
  LEG_B_DIALING: "LEG_B_DIALING",
  LEG_B_ANSWERED: "LEG_B_ANSWERED",
  COMPLETED: "COMPLETED",
  MERGE_DETECTED: "MERGE_DETECTED",
  VOIP_DETECTED: "VOIP_DETECTED",
  CALL_WAITING_OFF: "CALL_WAITING_OFF",
  FAILED: "FAILED",
} as const;
export type VerificationState = (typeof VState)[keyof typeof VState];

export const TERMINAL_STATES: readonly VerificationState[] = [
  VState.COMPLETED,
  VState.MERGE_DETECTED,
  VState.VOIP_DETECTED,
  VState.CALL_WAITING_OFF,
  VState.FAILED,
];

/** Port of SessionState.canTransitionTo — illegal transitions are rejected. */
const ALLOWED: Record<VerificationState, readonly VerificationState[]> = {
  INITIATED: [VState.CALLER_HOLDING, VState.LEG_A_DIALING, VState.FAILED],
  CALLER_HOLDING: [VState.LEG_A_DIALING, VState.FAILED],
  LEG_A_DIALING: [VState.CALL_ACCEPTED, VState.FAILED],
  CALL_ACCEPTED: [VState.CALLEE_READY, VState.FAILED],
  CALLEE_READY: [VState.LEG_B_DIALING, VState.FAILED],
  LEG_B_DIALING: [
    VState.LEG_B_ANSWERED,
    VState.VOIP_DETECTED,
    VState.CALL_WAITING_OFF,
    VState.COMPLETED,
    VState.FAILED,
  ],
  LEG_B_ANSWERED: [
    VState.COMPLETED,
    VState.MERGE_DETECTED,
    VState.VOIP_DETECTED,
    VState.CALL_WAITING_OFF,
    VState.FAILED,
  ],
  COMPLETED: [],
  MERGE_DETECTED: [],
  VOIP_DETECTED: [],
  CALL_WAITING_OFF: [],
  FAILED: [],
};

export type VerifyLeg = "caller" | "legA" | "legB" | "ringTest";

const SMS_WINDOW_SECONDS = 15;
/**
 * The merge-test tone on Leg A is ONE continuous in-band DTMF stream of this
 * digit (852+1336 Hz for '9'). Leg B's silent <Gather numDigits=1> fires the
 * instant it leaks across a merge — single digit, no inter-digit delay.
 */
export const MERGE_TONE_DIGIT = "9";
const STALE_TIMEOUT_MS = 10 * 60 * 1000; // mirrors StaleSessionCleanupJob (10min)

/* -------------------------------------------------------------------------- */
/* Config                                                                      */
/* -------------------------------------------------------------------------- */

/** Public base URL webhooks are built from. Null when the site isn't published. */
let runtimeBaseUrl: string | null = null;

/** Capture the origin of an incoming request (e.g. the published domain) as fallback. */
export function setRuntimeBaseUrl(origin: string): void {
  const o = origin.trim().replace(/\/+$/, "");
  if (/^https:\/\//.test(o)) runtimeBaseUrl = o;
}

export function getPublicBaseUrl(): string | null {
  const u = process.env.PUBLIC_BASE_URL?.trim();
  if (u) return u.replace(/\/+$/, "");
  return runtimeBaseUrl;
}

export function requirePublicBaseUrl(): string {
  const base = getPublicBaseUrl();
  if (!base) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Site must be published and PUBLIC_BASE_URL set before running verification",
    });
  }
  return base;
}

export function twimlUrl(kind: string, sessionId: string): string {
  return `${requirePublicBaseUrl()}/api/verify/twiml/${kind}?sid=${sessionId}`;
}

export function statusUrl(leg: VerifyLeg, sessionId: string): string {
  return `${requirePublicBaseUrl()}/api/verify/status/${leg}?sid=${sessionId}`;
}

export function gatherMergeUrl(sessionId: string): string {
  return `${requirePublicBaseUrl()}/api/verify/gather/merge?sid=${sessionId}`;
}

/** Per-chunk <Record> status callback for merge-tone analysis. */
export function recordingMergeUrl(sessionId: string): string {
  return `${requirePublicBaseUrl()}/api/verify/recording/merge?sid=${sessionId}`;
}

/** Leg A callee-IVR gather endpoints (CALL-FLOW.md Phase 2). */
export function gatherLegAAcceptUrl(sessionId: string, attempt: number): string {
  return `${requirePublicBaseUrl()}/api/verify/gather/leg-a-accept?sid=${sessionId}&a=${attempt}`;
}

export function gatherLegAReadyUrl(sessionId: string, attempt: number): string {
  return `${requirePublicBaseUrl()}/api/verify/gather/leg-a-ready?sid=${sessionId}&a=${attempt}`;
}

/** Self-redirecting hold TwiML that keeps Leg A alive after CALLEE_READY. */
export function legAHoldUrl(sessionId: string): string {
  return twimlUrl("leg-a-hold", sessionId);
}

/** Max press-1 re-prompts before the callee is treated as rejecting the call. */
export const LEG_A_MAX_ATTEMPTS = 3;

/**
 * Spoken prompts (CALL-FLOW.md Phase 2 + Phase 7 notify contexts).
 * Every default is env-overridable via VERIFY_PROMPT_*.
 */
export function verifyPrompts() {
  const e = process.env;
  return {
    accept:
      e.VERIFY_PROMPT_ACCEPT ??
      "You are about to receive a call from an inmate. Do not merge or transfer this call. Press 1 to accept.",
    ready:
      e.VERIFY_PROMPT_READY ??
      "Thank you. Press 1 when you are ready to proceed.",
    callerHold:
      e.VERIFY_PROMPT_CALLER_HOLD ??
      "Please hold. Your call is being connected. You will hear updates as the line is verified.",
    reject:
      e.VERIFY_PROMPT_REJECT ??
      "No response received. This verification call will now end. Goodbye.",
    mergeDetected:
      e.VERIFY_PROMPT_MERGE_DETECTED ??
      "Merge detected. Verification complete. This line is confirmed as a cellular phone.",
    voipCallee:
      e.VERIFY_PROMPT_VOIP_CALLEE ??
      "This call cannot be completed. This line appears to be a VoIP or multi-line service.",
    voipCaller:
      e.VERIFY_PROMPT_VOIP_CALLER ??
      "Verification result: the number answered a second simultaneous call — VoIP or multi-line service detected. Call terminated.",
    callWaitingCallee:
      e.VERIFY_PROMPT_CALLWAITING_CALLEE ??
      "Your call waiting is switched off. Please turn on call waiting to receive this type of call.",
    callWaitingCaller:
      e.VERIFY_PROMPT_CALLWAITING_CALLER ??
      "Verification result: call waiting is off on this number. The call cannot be completed as dialed.",
    failed:
      e.VERIFY_PROMPT_FAILED ??
      "Verification failed. The number could not be reached.",
    completed:
      e.VERIFY_PROMPT_COMPLETED ??
      "Verification complete. The call has ended. Goodbye.",
  };
}

export function conferenceName(sessionId: string): string {
  return `verify-${sessionId}`;
}

/** SMS (Crazytel HTTP API) — ported from application.yml `sms:` block. */
function smsCfg() {
  const e = process.env;
  return {
    enabled: (e.SMS_ENABLED ?? "false") === "true",
    token: e.SMS_API_TOKEN ?? "",
    from: e.SMS_FROM ?? "CallVerify",
    baseUrl: e.SMS_BASE_URL ?? "https://sms.crazytel.net.au/api/v1/sms/send",
    messageConfirmed:
      e.SMS_MESSAGE_CONFIRMED ??
      "Your call waiting is off. Please turn it on to receive calls. If you need assistance I am AI SMS — just tell me your phone model and I can walk you through the settings to turn it on.",
    messageHangup:
      e.SMS_MESSAGE_HANGUP ??
      "How was your call? If your call didn't go through and you heard a weird sound it means your call waiting is off. Please turn call waiting on. If you need assistance I am AI SMS — I can help.",
  };
}

/* -------------------------------------------------------------------------- */
/* Phone number normalisation (mirror of src/lib/telephony normalizePhoneNumber, */
/* reimplemented server-side to avoid pulling browser modules into the API)     */
/* -------------------------------------------------------------------------- */

export function normalizeE164(input: string): string | null {
  let s = input.replace(/[\s\-().]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!/^\+?\d{7,15}$/.test(s)) return null;
  if (!s.startsWith("+")) s = `+${s}`;
  if (!/^\+[1-9]\d{6,14}$/.test(s)) return null;
  return s;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

export function isTerminal(
  session: Pick<VerificationSession, "state">,
): boolean {
  return TERMINAL_STATES.includes(session.state as VerificationState);
}

export async function findSession(
  sessionId: string,
): Promise<VerificationSession | null> {
  const rows = await getDb()
    .select()
    .from(schema.verificationSessions)
    .where(eq(schema.verificationSessions.sessionId, sessionId))
    .limit(1);
  if (!rows[0]) {
    console.warn(`[verify] SESSION_NOT_FOUND sessionId=${sessionId}`);
    return null;
  }
  return rows[0];
}

export async function logEvent(
  sessionId: string,
  eventType: string,
  details?: string,
): Promise<void> {
  await getDb().insert(schema.verificationEvents).values({
    sessionId,
    eventType: eventType.slice(0, 64),
    details: details?.slice(0, 512),
  });
}

async function save(session: VerificationSession): Promise<void> {
  await getDb()
    .update(schema.verificationSessions)
    .set({
      state: session.state,
      callerCallSid: session.callerCallSid,
      legACallSid: session.legACallSid,
      legBCallSid: session.legBCallSid,
      ringTestCallSid: session.ringTestCallSid,
      legBOriginatedAt: session.legBOriginatedAt,
      toneDetected: session.toneDetected,
      toneDetectedAt: session.toneDetectedAt,
      smsSent: session.smsSent,
      completedAt: session.completedAt,
      failureReason: session.failureReason,
    })
    .where(eq(schema.verificationSessions.sessionId, session.sessionId));
}

/** Port of SessionService.transition — rejects illegal transitions. */
async function transition(
  session: VerificationSession,
  newState: VerificationState,
  detail: string,
): Promise<boolean> {
  const old = session.state as VerificationState;
  if (!ALLOWED[old]?.includes(newState)) {
    console.warn(
      `[verify] ILLEGAL_TRANSITION ${old} → ${newState} rejected | ${detail}`,
    );
    return false;
  }
  session.state = newState;
  await save(session);
  console.log(`[verify] STATE ${old} → ${newState} | ${detail}`);
  await logEvent(session.sessionId, newState, `${old} → ${newState} | ${detail}`);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Twilio leg primitives (AMI originate/redirect/hangup equivalents)           */
/* -------------------------------------------------------------------------- */

const STATUS_EVENTS = ["initiated", "ringing", "answered", "completed"];

async function originate(
  session: VerificationSession,
  leg: VerifyLeg,
  number: string,
  twimlKind: string,
  opts: { timeoutSec?: number; machineDetection?: boolean; asyncAmd?: boolean } = {},
): Promise<string | null> {
  try {
    const call = await getTwilioClient().calls.create({
      to: number,
      from: twilioCallerId(),
      url: twimlUrl(twimlKind, session.sessionId),
      method: "POST",
      statusCallback: statusUrl(leg, session.sessionId),
      statusCallbackMethod: "POST",
      statusCallbackEvent: STATUS_EVENTS,
      timeout: opts.timeoutSec ?? 30,
      ...(opts.machineDetection
        ? {
            machineDetection: "Enable",
            machineDetectionTimeout: 8,
            asyncAmd: opts.asyncAmd === false ? "false" : "true",
          }
        : {}),
    });
    console.log(
      `[verify] ORIGINATE leg=${leg} to=${number} sid=${call.sid} session=${session.sessionId}`,
    );
    return call.sid;
  } catch (err) {
    console.error(`[verify] ORIGINATE_FAILED leg=${leg} to=${number}`, err);
    await logEvent(
      session.sessionId,
      "ORIGINATE_FAILED",
      `leg=${leg} to=${number} err=${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** AMI RedirectAction equivalent — point a live call at new TwiML. */
async function redirectCall(
  callSid: string | null,
  twimlKind: string,
  sessionId: string,
): Promise<void> {
  if (!callSid) return;
  try {
    await getTwilioClient()
      .calls(callSid)
      .update({ url: twimlUrl(twimlKind, sessionId), method: "POST" });
    console.log(`[verify] REDIRECT sid=${callSid} kind=${twimlKind}`);
  } catch (err) {
    console.error(`[verify] REDIRECT_FAILED sid=${callSid}`, err);
  }
}

/** AMI HangupAction equivalent — best effort, never throws. */
async function hangupCall(callSid: string | null): Promise<void> {
  if (!callSid) return;
  try {
    await getTwilioClient().calls(callSid).update({ status: "completed" });
    console.log(`[verify] HANGUP sid=${callSid}`);
  } catch {
    // call already gone — mirrors AmiService.hangup's trace-level tolerance
  }
}

type LegSet = Partial<Record<VerifyLeg, boolean>>;

async function hangupAll(
  session: VerificationSession,
  legs: LegSet,
): Promise<void> {
  const jobs: Promise<void>[] = [];
  if (legs.caller) jobs.push(hangupCall(session.callerCallSid));
  if (legs.legA) jobs.push(hangupCall(session.legACallSid));
  if (legs.legB) jobs.push(hangupCall(session.legBCallSid));
  if (legs.ringTest) jobs.push(hangupCall(session.ringTestCallSid));
  await Promise.all(jobs);
}

/* -------------------------------------------------------------------------- */
/* Session creation / initiation (VerificationController + initiateFromApi)    */
/* -------------------------------------------------------------------------- */

export interface InitiateInput {
  calleeNumber: string;
  callerNumber?: string | null;
  legBNumber?: string | null;
  ringTestNumber?: string | null;
}

export async function initiate(
  input: InitiateInput,
): Promise<VerificationSession> {
  const base = requirePublicBaseUrl();
  if (!twilioRestConfigured()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Twilio is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN required)",
    });
  }
  if (!twilioCallerId()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "TWILIO_CALLER_ID is required to place verification calls",
    });
  }
  console.log(`[verify] initiate via ${base}`);

  const sessionId = crypto.randomUUID().replace(/-/g, "");
  const session: InsertSession = {
    sessionId,
    callerNumber: input.callerNumber ?? null,
    calleeNumber: input.calleeNumber,
    legBNumber: input.legBNumber ?? input.calleeNumber,
    ringTestNumber: input.ringTestNumber ?? input.calleeNumber,
    state: VState.INITIATED,
  };
  await getDb().insert(schema.verificationSessions).values(session);
  await logEvent(
    sessionId,
    "SESSION_CREATED_API",
    `caller=${input.callerNumber ?? "(none)"} callee=${input.calleeNumber}`,
  );

  const created = (await findSession(sessionId))!;

  if (input.callerNumber) {
    // Caller leg: park the caller in a conference with instructions.
    // CALL-FLOW.md originate timeouts: caller = 30s.
    await logEvent(sessionId, "ORIGINATING_CALLER", `Originating caller: ${input.callerNumber}`);
    const callSid = await originate(created, "caller", input.callerNumber, "caller-hold", {
      timeoutSec: 30,
    });
    if (!callSid) {
      await failSession(created, "Caller origination failed");
    } else {
      created.callerCallSid = callSid;
      await save(created);
    }
  } else {
    // No caller leg — skip caller states, admin watches the dashboard.
    await originateAndDialLegA(created);
  }
  return (await findSession(sessionId))!;
}

type InsertSession = typeof schema.verificationSessions.$inferInsert;

async function originateAndDialLegA(
  session: VerificationSession,
): Promise<void> {
  if (
    await transition(
      session,
      VState.LEG_A_DIALING,
      `Originating Leg A to ${session.calleeNumber}`,
    )
  ) {
    // CALL-FLOW.md originate timeouts: Leg A = 30s (callee needs time to answer).
    const callSid = await originate(session, "legA", session.calleeNumber, "leg-a", {
      timeoutSec: 30,
    });
    if (!callSid) {
      await onLegFailed(session.sessionId, "legA", "origination failed");
    } else {
      session.legACallSid = callSid;
      await save(session);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* AGI-equivalent callbacks (driven by Twilio status callbacks / TwiML fetches) */
/* -------------------------------------------------------------------------- */

/** Caller answered the parked call → CALLER_HOLDING → dial Leg A. */
export async function onCallerAnswered(
  sessionId: string,
  callSid: string,
): Promise<void> {
  const session = await findSession(sessionId);
  if (!session) return;
  if (
    await transition(session, VState.CALLER_HOLDING, `Caller answered, sid=${callSid}`)
  ) {
    session.callerCallSid = callSid;
    await save(session);
    await originateAndDialLegA(session);
  }
}

/** Leg A answered (callee picked up) → CALL_ACCEPTED. */
export async function onCallAccepted(
  sessionId: string,
  callSid: string,
): Promise<void> {
  const session = await findSession(sessionId);
  if (!session) return;
  if (
    await transition(session, VState.CALL_ACCEPTED, `Callee accepted, legA=${callSid}`)
  ) {
    session.legACallSid = callSid;
    await save(session);
    // SPEED: pre-originate Leg B NOW, at the first press-1 — by the time the
    // callee presses the second "ready" 1, the second call is already ringing
    // and arrives effectively instantly.
    await originateLegB(sessionId);
  }
}

/**
 * Second press-1 ("ready"). Leg B was already pre-originated at the first
 * press, so this is just a confirmation — originate only as a fallback if the
 * pre-origination didn't happen (e.g. racing webhook ordering).
 */
export async function onCalleeReady(sessionId: string): Promise<void> {
  const session = await findSession(sessionId);
  if (!session) return;
  if (session.state === VState.CALL_ACCEPTED) {
    await originateLegB(sessionId);
    return;
  }
  await logEvent(
    sessionId,
    "CALLEE_READY_CONFIRMED",
    `state=${session.state} — Leg B already ringing (pre-originated at accept)`,
  );
}

/**
 * CALLEE_READY → LEG_B_DIALING and originate the second call.
 * Ring test (3rd call) disabled per user request.
 */
async function originateLegB(sessionId: string): Promise<void> {
  const session = await findSession(sessionId);
  if (!session) return;
  // Idempotency guard: skip if Leg B already originated (pre-origination).
  if (session.legBCallSid || session.state === VState.LEG_B_DIALING || session.state === VState.LEG_B_ANSWERED) {
    return;
  }

  if (
    (await transition(
      session,
      VState.CALLEE_READY,
      "Callee ready, originating Leg B, caller will listen",
    )) &&
    (await transition(session, VState.LEG_B_DIALING, "Leg B originated (ring test disabled)"))
  ) {
    session.legBOriginatedAt = new Date();
    await save(session);

    // Leg B — stays in the DTMF Gather loop on answer (merge detection takes
    // priority over live listen-in). machineDetection catches voicemail
    // (call waiting OFF). CALL-FLOW.md originate timeout: Leg B = 15s.
    const legBSid = await originate(session, "legB", session.legBNumber ?? session.calleeNumber, "leg-b", {
      timeoutSec: 15,
      machineDetection: true,
      asyncAmd: true,
    });
    if (legBSid) {
      session.legBCallSid = legBSid;
      await save(session);
    } else {
      await onLegFailed(sessionId, "legB", "origination failed");
      return;
    }

    // Ring test (3rd call) DISABLED per user request — it confused the
    // call-waiting merge step on the callee's phone. VoIP detection via the
    // ring test is dropped; merge detection (Leg B record-chunk analysis)
    // remains the primary signal. The ring-test TwiML/status handlers stay
    // wired for backwards compatibility but no call is ever originated.
    await logEvent(sessionId, "RING_TEST_DISABLED", "Ring test call skipped (disabled by configuration)");
  }
}

/** Leg B answered → LEG_B_ANSWERED, arm the merge test. */
export async function onLegBAnswered(
  sessionId: string,
  callSid: string,
): Promise<void> {
  const session = await findSession(sessionId);
  if (!session) return;

  if (isTerminal(session)) {
    console.log(
      `[verify] LEG_B_ANSWERED_TERMINAL session=${sessionId} state=${session.state} — hanging up sid=${callSid}`,
    );
    await hangupCall(callSid);
    return;
  }

  if (await transition(session, VState.LEG_B_ANSWERED, `Leg B answered, sid=${callSid}`)) {
    session.legBCallSid = callSid;
    await save(session);

    // Twilio constraint: a call inside a <Conference> cannot also run a
    // <Gather>, so merge detection takes priority over live listen-in —
    // Leg B STAYS in the Gather loop listening for leaked DTMF tones from
    // Leg A (the "conference-leg-b" TwiML is kept but unused), and the
    // caller leg stays parked on hold; when the session reaches any terminal
    // state the caller is redirected to the matching notify-* verdict TwiML.
    await logEvent(
      sessionId,
      "LEG_B_ANSWERED_NOTE",
      "Merge-detection priority over live audio: Leg B remains in the DTMF " +
        "Gather loop; caller hears the verdict announcement at the end " +
        "(also shown live on the dashboard) instead of listening in.",
    );

    // Always redirect Leg A to the DTMF tone loop — a 3-way merge leaks the
    // tones into Leg B's <Gather> (replaces the Asterisk 1400Hz TONE_DETECT).
    if (session.legACallSid) {
      await redirectCall(session.legACallSid, "leg-a-tone", sessionId);
      console.log(`[verify] Redirected Leg A to DTMF tone loop, sid=${session.legACallSid}`);
    }
  }
}

/** Merge detected — Leg A's DTMF tones leaked into Leg B's Gather. */
export async function onMergeDetected(sessionId: string): Promise<void> {
  const session = await findSession(sessionId);
  if (!session || isTerminal(session)) return;

  if (await transition(session, VState.MERGE_DETECTED, "DTMF tone leak — callee merged calls")) {
    session.toneDetected = true;
    session.toneDetectedAt = new Date();
    session.completedAt = new Date();
    await save(session);

    // All terminations in parallel — speed matters (merge must die instantly).
    await Promise.allSettled([
      redirectCall(session.callerCallSid, "notify-merge", sessionId),
      hangupCall(session.legACallSid),
      hangupCall(session.ringTestCallSid),
    ]);
  }
}

/** Ring-test AMD returned HUMAN — a second simultaneous call was answered. */
export async function onVoipDetected(sessionId: string): Promise<void> {
  const session = await findSession(sessionId);
  if (!session || isTerminal(session)) return;

  if (await transition(session, VState.VOIP_DETECTED, "Ring test HUMAN — VoIP/multi-line")) {
    session.completedAt = new Date();
    await save(session);

    await redirectCall(session.legBCallSid, "notify-voip-contact", sessionId);
    await hangupCall(session.legACallSid);
    await redirectCall(session.callerCallSid, "notify-voip-caller", sessionId);
    await hangupCall(session.ringTestCallSid);
  }
}

/** Ring-test AMD returned MACHINE — single cellular line confirmed (log only). */
export async function onCellularConfirmed(
  sessionId: string,
  amdStatus: string,
): Promise<void> {
  const session = await findSession(sessionId);
  if (!session || isTerminal(session)) return;
  console.log(`[verify] CELLULAR_CONFIRMED ring test MACHINE — cellular phone. amd=${amdStatus}`);
  await logEvent(sessionId, "CELLULAR_CONFIRMED", `amd=${amdStatus}`);
}

/**
 * Call waiting OFF (generic reason: Leg B failed/busy, etc.).
 * Port of SessionService.onCallWaitingOff.
 */
export async function onCallWaitingOff(
  sessionId: string,
  reason: string,
): Promise<void> {
  const session = await findSession(sessionId);
  if (!session || isTerminal(session)) return;

  console.warn(`[verify] CALL_WAITING_OFF ${reason} — notifying caller, SMS on caller hangup`);
  if (await transition(session, VState.CALL_WAITING_OFF, `Call waiting OFF (${reason})`)) {
    session.completedAt = new Date();
    await save(session);

    // Phase 7: callee (Leg A) hears "turn on call waiting"; caller hears
    // "cannot complete as dialed" (verdict announcement replaces listen-in).
    await redirectCall(session.legACallSid, "notify-callwaiting-callee", sessionId);
    await redirectCall(session.callerCallSid, "notify-callwaiting-caller", sessionId);
    await hangupCall(session.legBCallSid);
    await hangupCall(session.ringTestCallSid);

    // Without a caller leg there is no hangup to trigger the SMS window —
    // treat the detection itself as confirmed. Leg A was redirected to the
    // "turn on call waiting" announcement above, which ends with <Hangup/>.
    if (!session.callerCallSid) {
      await sendSmsOnce(session, `${reason} (no caller leg)`, true);
      await save(session);
    }
  }
}

/** Leg B AMD returned MACHINE — voicemail → call waiting OFF. */
export async function onVoicemailDetected(
  sessionId: string,
  amdStatus: string,
): Promise<void> {
  const session = await findSession(sessionId);
  if (!session || isTerminal(session)) return;
  console.warn(`[verify] VOICEMAIL_DETECTED — call waiting OFF. amd=${amdStatus}`);
  await onCallWaitingOff(sessionId, `Leg B voicemail — amd=${amdStatus}`);
}

/** Port of onCallerFailed / onLegAFailed / onLegBFailed (+ ring-test rule). */
export async function onLegFailed(
  sessionId: string,
  leg: VerifyLeg,
  reason: string,
): Promise<void> {
  const session = await findSession(sessionId);
  if (!session || isTerminal(session)) return;

  if (leg === "caller") {
    console.warn(`[verify] CALLER_FAILED caller unreachable. reason=${reason}`);
    await failSession(session, `Caller not available: ${reason}`);
    return;
  }

  if (leg === "legA") {
    console.warn(`[verify] LEG_A_FAILED callee unavailable. reason=${reason}`);
    if (
      await transition(session, VState.FAILED, `Leg A failed (${reason}) — callee unavailable`)
    ) {
      session.failureReason = `Callee not available: ${reason}`;
      session.completedAt = new Date();
      await save(session);
      await redirectCall(session.callerCallSid, "notify-failed", sessionId);
      await hangupAll(session, { legB: true, ringTest: true });
    }
    return;
  }

  if (leg === "ringTest") {
    // Ring test failures NEVER terminate the session (CALL-FLOW.md Phase 4 +
    // design decision 2): reason=5 (busy) = cellular confirmed; everything
    // else (no-answer/failed/canceled/congestion) is inconclusive — log only
    // and let Leg B decide.
    if (reason === "busy") {
      console.log(`[verify] RING_TEST_BUSY — phone busy on second call = cellular confirmed`);
      await onCellularConfirmed(sessionId, "busy");
    } else {
      console.log(`[verify] RING_TEST_INCONCLUSIVE reason=${reason} — ignoring, Leg B decides`);
      await logEvent(sessionId, "RING_TEST_INCONCLUSIVE", `reason=${reason}`);
    }
    return;
  }

  // Leg B failed — can't reliably distinguish rejection vs call waiting OFF
  // vs carrier issue via the trunk, so treat as call waiting OFF
  // (same rule as the Java onLegBFailed).
  console.warn(`[verify] LEG_B_FAILED reason=${reason} — call waiting OFF`);
  await onCallWaitingOff(sessionId, `Leg B failed (${reason})`);
}

/**
 * Port of SessionService.onHangup — a leg's call ended (Twilio status
 * `completed`). Drives COMPLETED / CALL_WAITING_OFF / FAILED + the SMS window.
 */
export async function onCallCompleted(
  sessionId: string,
  leg: VerifyLeg,
  callSid: string,
  statusDetail: string,
): Promise<void> {
  const session = await findSession(sessionId);
  if (!session) return;

  // Caller dropped while session is CALL_WAITING_OFF — SMS within 15s window.
  if (session.state === VState.CALL_WAITING_OFF && leg === "caller") {
    await hangupCall(session.legACallSid);
    await hangupCall(session.ringTestCallSid);
    if (
      !session.smsSent &&
      session.completedAt &&
      Date.now() - session.completedAt.getTime() < SMS_WINDOW_SECONDS * 1000
    ) {
      console.log(
        `[verify] CALLER_HANGUP_CALL_WAITING_OFF sessionId=${sessionId} — within ${SMS_WINDOW_SECONDS}s window, queuing SMS`,
      );
      await sendSmsOnce(session, `caller hung up within ${SMS_WINDOW_SECONDS}s`, false);
      await save(session);
    }
  }

  if (isTerminal(session)) return;

  await logEvent(sessionId, `HANGUP_${leg.toUpperCase()}`, `sid=${callSid} ${statusDetail}`);

  if (leg === "caller") {
    if (session.state === VState.LEG_B_ANSWERED) {
      // Caller heard Leg B (likely voicemail) and hung up — call waiting OFF.
      console.log(
        `[verify] CALLER_HANGUP_LEG_B_ANSWERED sessionId=${sessionId} — caller heard voicemail and hung up`,
      );
      if (
        await transition(
          session,
          VState.CALL_WAITING_OFF,
          "Caller hung up during LEG_B_ANSWERED — call waiting OFF",
        )
      ) {
        session.completedAt = new Date();
        await sendSmsOnce(session, "caller hung up after hearing Leg B", false);
        await save(session);
        await hangupAll(session, { legA: true, legB: true, ringTest: true });
      }
    } else {
      await failSession(session, "Caller hung up");
    }
    return;
  }

  if (
    leg === "legA" &&
    session.state !== VState.LEG_B_ANSWERED &&
    session.state !== VState.LEG_B_DIALING
  ) {
    // Callee hung up during the Leg A IVR (during LEG_B_DIALING a Leg A drop
    // is expected — the carrier releases the first call when the second connects).
    console.warn(`[verify] LEG_A_HANGUP_IVR — callee hung up during ${session.state}`);
    if (await transition(session, VState.FAILED, `Callee hung up during ${session.state}`)) {
      session.failureReason = "Callee hung up during IVR";
      session.completedAt = new Date();
      await save(session);
      await redirectCall(session.callerCallSid, "notify-failed", sessionId);
      await hangupAll(session, { legB: true, ringTest: true });
    }
    return;
  }

  if (leg === "legB" && session.state === VState.LEG_B_ANSWERED) {
    if (await transition(session, VState.COMPLETED, "Leg B hung up — call completed normally")) {
      session.completedAt = new Date();
      await save(session);
      // Verdict announcement replaces live listen-in: the parked caller hears
      // the completion notice, then the TwiML hangs up.
      await redirectCall(session.callerCallSid, "notify-completed", sessionId);
      await hangupAll(session, { legA: true, ringTest: true });
    }
  }
}

/**
 * Admin "Confirm voicemail" — replaces the Java DTMF-00 caller flow
 * (onCallerConfirmedVoicemail). Immediate CALL_WAITING_OFF + SMS.
 */
export async function confirmVoicemail(sessionId: string): Promise<void> {
  const session = await findSession(sessionId);
  if (!session) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
  }
  if (isTerminal(session)) return;

  console.log(`[verify] CALLER_CONFIRMED_VOICEMAIL sessionId=${sessionId} — admin confirmed`);
  if (
    await transition(
      session,
      VState.CALL_WAITING_OFF,
      "Admin confirmed voicemail — call waiting OFF",
    )
  ) {
    session.completedAt = new Date();
    // Send SMS immediately — voicemail explicitly confirmed.
    await sendSmsOnce(session, "admin confirmed voicemail", true);
    await save(session);

    await redirectCall(session.legACallSid, "notify-callwaiting-callee", sessionId);
    await redirectCall(session.callerCallSid, "notify-callwaiting-caller", sessionId);
    await hangupCall(session.legBCallSid);
    await hangupCall(session.ringTestCallSid);
  }
}

/** Port of terminateSession — manual termination → FAILED + hangup all legs. */
export async function terminate(sessionId: string): Promise<void> {
  const session = await findSession(sessionId);
  if (!session) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
  }
  await failSession(session, "Manual termination");
}

/**
 * Lazy stale-session sweep (replaces StaleSessionCleanupJob — no background
 * timers are guaranteed in this runtime, so we sweep on list/initiate).
 */
export async function sweepStaleSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_TIMEOUT_MS);
  const stale = await getDb()
    .select()
    .from(schema.verificationSessions)
    .where(
      and(
        notInArray(schema.verificationSessions.state, [...TERMINAL_STATES]),
        lt(schema.verificationSessions.createdAt, cutoff),
      ),
    );
  for (const s of stale) {
    console.warn(
      `[verify] STALE_CLEANUP terminating sessionId=${s.sessionId} state=${s.state} created=${s.createdAt.toISOString()}`,
    );
    await failSession(s, "Stale session cleanup (>10min)");
  }
  return stale.length;
}

/* -------------------------------------------------------------------------- */
/* Internal                                                                    */
/* -------------------------------------------------------------------------- */

async function failSession(
  session: VerificationSession,
  reason: string,
): Promise<void> {
  if (isTerminal(session)) return;

  session.state = VState.FAILED;
  session.failureReason = reason;
  session.completedAt = new Date();
  await save(session);

  console.warn(`[verify] SESSION_FAILED sessionId=${session.sessionId} reason=${reason}`);
  await logEvent(session.sessionId, "SESSION_FAILED", reason);

  // Caller hears the failure verdict (no-op if the caller already hung up or
  // the session is headless — redirectCall/hangupCall are best-effort).
  await redirectCall(session.callerCallSid, "notify-failed", session.sessionId);
  await hangupAll(session, { legA: true, legB: true, ringTest: true });
}

/**
 * Sends the SMS appropriate to the trigger and marks smsSent.
 * Port of SessionService.sendSmsOnce + the SmsEvent listener (Crazytel HTTP).
 *
 * @param confirmed true = explicit confirmation (definitive template),
 *                  false = caller hung up within the 15s window
 */
async function sendSmsOnce(
  session: VerificationSession,
  trigger: string,
  confirmed: boolean,
): Promise<void> {
  if (session.smsSent) {
    console.log(`[verify] SMS_ALREADY_SENT sessionId=${session.sessionId} — skipping (trigger=${trigger})`);
    return;
  }
  session.smsSent = true;
  await logEvent(session.sessionId, "SMS_QUEUED", `trigger=${trigger} to=${session.calleeNumber}`);

  const cfg = smsCfg();
  if (!cfg.enabled || !cfg.token) {
    await logEvent(session.sessionId, "SMS_SKIPPED", "SMS disabled or missing SMS_API_TOKEN");
    return;
  }
  const message = confirmed ? cfg.messageConfirmed : cfg.messageHangup;

  // Fire-and-forget — HTTP call happens outside any DB unit of work.
  void fetch(cfg.baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: cfg.token,
      to: session.calleeNumber,
      from: cfg.from,
      message,
    }),
  })
    .then(async (res) => {
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[verify] SMS_HTTP_${res.status} ${body.slice(0, 200)}`);
        await logEvent(session.sessionId, "SMS_FAILED", `http=${res.status}`).catch(() => {});
      } else {
        await logEvent(session.sessionId, "SMS_SENT", `to=${session.calleeNumber}`).catch(() => {});
      }
    })
    .catch(async (err) => {
      console.error("[verify] SMS_FAILED", err);
      await logEvent(
        session.sessionId,
        "SMS_FAILED",
        err instanceof Error ? err.message : String(err),
      ).catch(() => {});
    });
}

/** Store a call SID on the session if not already set (storeChannel port). */
export async function storeCallSid(
  sessionId: string,
  leg: VerifyLeg,
  callSid: string,
): Promise<void> {
  const session = await findSession(sessionId);
  if (!session) return;
  const col = `${leg}CallSid` as const;
  if (leg === "ringTest" || !session[col]) {
    (session as Record<string, unknown>)[col] = callSid;
    await save(session);
    console.log(`[verify] SID_STORED leg=${leg} sessionId=${sessionId} sid=${callSid}`);
  }
}
