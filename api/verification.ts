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
 *   POST {PUBLIC_BASE_URL}/api/verify/voiceprint?sid=...        (guarded only)
 */
import { TRPCError } from "@trpc/server";
import { and, eq, lt, notInArray, or } from "drizzle-orm";
import * as schema from "@db/schema";
import type { VerificationSession } from "@db/schema";
import type { ClipProfile } from "./relayguard/features";
import { getDb } from "./queries/connection";
import {
  getTwilioClient,
  twilioCallerId,
  twilioCallerIdFor,
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
  /**
   * GUARDED MODE ONLY: verification passed (callee accepted + merge-detection
   * watch window elapsed with no merge) and the caller (inmate softphone) +
   * callee (Leg A) are bridged LIVE in conference verify-<sid>. Non-guarded
   * sessions never enter this state. Not terminal — ends as COMPLETED when
   * either party hangs up (or FAILED via manual termination).
   */
  BRIDGED: "BRIDGED",
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
  // CALL_WAITING_OFF is reachable from the dialing/accept states because Leg B
  // can be originated while Leg A is still in the IVR — so a Leg B busy/fail/
  // voicemail verdict can legitimately arrive before the callee finishes the
  // voice-ID step. Guarded sessions now use the same second-call verification
  // path as the legacy flow and only bridge after LEG_B_ANSWERED + merge watch.
  LEG_A_DIALING: [VState.CALL_ACCEPTED, VState.CALL_WAITING_OFF, VState.FAILED],
  CALL_ACCEPTED: [VState.CALLEE_READY, VState.CALL_WAITING_OFF, VState.FAILED],
  CALLEE_READY: [VState.LEG_B_DIALING, VState.CALL_WAITING_OFF, VState.FAILED],
  LEG_B_DIALING: [
    VState.LEG_B_ANSWERED,
    VState.VOIP_DETECTED,
    VState.CALL_WAITING_OFF,
    VState.COMPLETED,
    VState.FAILED,
  ],
  LEG_B_ANSWERED: [
    VState.BRIDGED,
    VState.COMPLETED,
    VState.MERGE_DETECTED,
    VState.VOIP_DETECTED,
    VState.CALL_WAITING_OFF,
    VState.FAILED,
  ],
  // Post-bridge merge/voip detection via the media-stream path keeps the
  // existing hang-up-everything behavior (those flows are unchanged).
  BRIDGED: [
    VState.COMPLETED,
    VState.MERGE_DETECTED,
    VState.VOIP_DETECTED,
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
/** Guarded INITIATED sessions whose caller SDK call never arrived (2min). */
const GUARDED_CALLER_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Early Leg B answer buffer. Leg B is pre-originated the moment Leg A is
 * ANSWERED (zero ring latency at the ready press), so on PSTN it can be
 * answered while the callee is still listening to prompt 1 — before the FSM
 * reaches LEG_B_DIALING. Those answers are buffered here and drained by
 * originateLegB() the instant the FSM catches up. Short-lived, in-process —
 * mirrors the Asterisk original's in-memory session fields.
 */
const pendingLegBAnswer = new Map<string, string>();

/**
 * Merge-detection watch window (ms). A GUARDED session is deemed PASSED —
 * and the live bridge is allowed — only after Leg B was answered by a human
 * (LEG_B_ANSWERED: the callee's line did NOT take the second call, so it is
 * a single cellular line) AND this much time has elapsed with no merge-tone
 * leak. The engine otherwise has no "no merge" pass point (COMPLETED only
 * fires when Leg B hangs up), so this window defines it cleanly.
 * Env-overridable via VERIFY_MERGE_WATCH_MS (mainly for tests).
 *
 * Default 60s: the callee must be able to reach their phone's merge button
 * and have the tone leak across BEFORE the watch elapses — 15s proved too
 * short in live testing (the bridge fired and the second call became
 * irrelevant before a merge could be attempted). The tone keeps playing on
 * Leg A for the whole window; a detected merge still terminates everything
 * within ~3-4s.
 */
export function mergeWatchMs(): number {
  const v = Number(process.env.VERIFY_MERGE_WATCH_MS);
  return Number.isFinite(v) && v >= 0 ? v : 60_000;
}

/**
 * In-process record of when the merge watch was armed per session (LEG_B_
 * ANSWERED). Short-lived, mirrors the pendingLegBAnswer pattern. Used by the
 * leg-a-tone TwiML poll fallback so the bridge also happens on runtimes
 * where setTimeout callbacks are not guaranteed to run.
 */
const mergeWatchArmedAt = new Map<string, number>();

/** Per-session challenge-noise injection counter (event payload enrichment). */
const noiseInjectionCount = new Map<string, number>();

/**
 * Per-session wall-clock of the last SPEAKERPHONE_SUSPECTED event WRITE.
 * The noise itself re-injects every refire interval (~4s) but the DB event
 * stream is throttled to one row per noiseEventThrottleMs() so a sustained
 * suspicion doesn't flood verification_events.
 */
const lastNoiseEventAt = new Map<string, number>();

/** Min ms between SPEAKERPHONE_SUSPECTED event writes (default 30s). */
export function noiseEventThrottleMs(): number {
  const v = Number(process.env.VERIFY_NOISE_EVENT_THROTTLE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 30_000;
}

/**
 * GUARDED MODE ONLY: session-scoped callee voice baseline. Captured from the
 * post-press-1 voiceprint <Record> ("my voice identifies me") by the
 * /api/verify/voiceprint webhook and compared against live Leg A audio
 * in-call (verification-stream.ts). In-memory only — the recording itself
 * persists on Twilio and is referenced by the VOICEPRINT_CAPTURED event.
 */
const voiceBaselineBySession = new Map<string, ClipProfile>();

/** Per-session wall-clock of the last VOICE_MISMATCH event write (throttle). */
const lastVoiceMismatchAt = new Map<string, number>();

/** Min ms between VOICE_MISMATCH event writes (default 30s). */
export function voiceMismatchThrottleMs(): number {
  const v = Number(process.env.VERIFY_VOICE_MISMATCH_THROTTLE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 30_000;
}

export function setVoiceBaseline(sessionId: string, profile: ClipProfile): void {
  voiceBaselineBySession.set(sessionId, profile);
}

export function getVoiceBaseline(sessionId: string): ClipProfile | null {
  return voiceBaselineBySession.get(sessionId) ?? null;
}

/**
 * In-call voice comparison fired on a 'different' consensus. Detection only —
 * NEVER hangs up. Throttled to one event write per voiceMismatchThrottleMs();
 * the detail carries VOICE_MISMATCH so it also feeds the existing
 * challenge-noise suspicion path (injectChallengeNoise is BRIDGED-gated).
 */
export async function onVoiceMismatch(sessionId: string, detail: string): Promise<void> {
  const last = lastVoiceMismatchAt.get(sessionId) ?? -Infinity;
  if (Date.now() - last < voiceMismatchThrottleMs()) return;
  lastVoiceMismatchAt.set(sessionId, Date.now());
  console.warn(`[verify] VOICE_MISMATCH session=${sessionId} | ${detail}`);
  await logEvent(sessionId, "VOICE_MISMATCH", detail);
  await injectChallengeNoise(sessionId, `VOICE_MISMATCH ${detail}`);
}

/**
 * Drop all per-session in-process map entries. Call whenever a session reaches
 * a terminal state so these short-lived Maps can't grow unboundedly over the
 * process lifetime. Safe to call for unknown/already-cleaned sessionIds.
 */
function cleanupSessionMaps(sessionId: string): void {
  pendingLegBAnswer.delete(sessionId);
  mergeWatchArmedAt.delete(sessionId);
  noiseInjectionCount.delete(sessionId);
  lastNoiseEventAt.delete(sessionId);
  voiceBaselineBySession.delete(sessionId);
  lastVoiceMismatchAt.delete(sessionId);
}

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

/** Twilio → app: guarded bridge conference recording status callback. */
export function recordingBridgeUrl(sessionId: string): string {
  return `${requirePublicBaseUrl()}/api/verify/recording/bridge?sid=${sessionId}`;
}

/** Leg A callee-IVR gather endpoints (CALL-FLOW.md Phase 2). */
export function gatherLegAAcceptUrl(sessionId: string, attempt: number): string {
  return `${requirePublicBaseUrl()}/api/verify/gather/leg-a-accept?sid=${sessionId}&a=${attempt}`;
}

export function gatherLegAReadyUrl(sessionId: string, attempt: number): string {
  return `${requirePublicBaseUrl()}/api/verify/gather/leg-a-ready?sid=${sessionId}&a=${attempt}`;
}

/** GUARDED MODE ONLY: voiceprint <Record> action — keeps the leg on hold. */
export function voiceprintUrl(sessionId: string): string {
  return `${requirePublicBaseUrl()}/api/verify/voiceprint?sid=${sessionId}`;
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
      "You are receiving a call from an inmate. Do not merge or transfer this call. Please press 1 if you accept.",
    // GUARDED MODE ONLY: spoken after press-1, before the voiceprint <Record>.
    voiceId:
      e.VERIFY_PROMPT_VOICE_ID ??
      "Please identify your voice. After the beep, say: my voice identifies me.",
    // GUARDED MODE ONLY: spoken after the voice-ID recording; the SECOND
    // press-1 is the explicit trigger that originates Leg B.
    secondCall:
      e.VERIFY_PROMPT_SECOND_CALL ??
      "Do not end this call. You will receive a second call. Please press 1.",
    // GUARDED MODE ONLY: the softphone caller hears this after the outbound
    // SDK call connects (parked in the conference while Leg A is verified).
    callerConnect:
      e.VERIFY_PROMPT_CALLER_CONNECT ??
      "Please wait while we connect your call.",
    ready:
      e.VERIFY_PROMPT_READY ??
      "Do not end this call. You will receive a second call. Please press 1.",
    callerHold:
      e.VERIFY_PROMPT_CALLER_HOLD ??
      "Please hold. Your call is being connected. You will hear updates as the line is verified.",
    // GUARDED MODE ONLY: spoken to Leg A immediately after the second press-1,
    // before the verification/bridge hold loop.
    calleeConnectWait:
      e.VERIFY_PROMPT_CALLEE_CONNECT_WAIT ??
      "Please wait while we connect your call.",
    // GUARDED MODE ONLY: played to the remaining caller when the callee's
    // original (first) call is ended before or during the guarded bridge.
    firstCallEnded:
      e.VERIFY_PROMPT_FIRST_CALL_ENDED ??
      "The first call has ended, so this guarded call will now be terminated. Goodbye.",
    reject:
      e.VERIFY_PROMPT_REJECT ??
      "No response received. This verification call will now end. Goodbye.",
    mergeDetected:
      e.VERIFY_PROMPT_MERGE_DETECTED ??
      "We detected a potential speakerphone or merged call on this line. This call will now end. Goodbye.",
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

/**
 * Resolve a Twilio CallSid to a session via its LEG A (callee) leg. Used by
 * the in-process media-stream endpoint to attach relayguard speakerphone
 * detection only to callee-side audio. Returns null when no session's
 * legACallSid matches (e.g. a Leg B stream or an unknown call).
 */
export async function findSessionByLegACallSid(
  callSid: string,
): Promise<VerificationSession | null> {
  if (!callSid) return null;
  const rows = await getDb()
    .select()
    .from(schema.verificationSessions)
    .where(eq(schema.verificationSessions.legACallSid, callSid))
    .limit(1);
  return rows[0] ?? null;
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
  if (TERMINAL_STATES.includes(newState)) cleanupSessionMaps(session.sessionId);
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
      from: twilioCallerIdFor(leg),
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
    // Duplex verdict path: when Leg B's TwiML opens a <Connect><Stream> to the
    // relay, arm the relay with this session's Leg A callSid so the instant
    // the merge tone fires, the relay can speak the verdict into Leg B AND
    // tear down Leg A with zero extra round-trips.
    if (leg === "legB") {
      const { relayArmUrl } = await import("./verification-stream");
      const armUrl = relayArmUrl();
      const secret = process.env.VERIFY_STREAM_SECRET;
      if (armUrl && secret) {
        fetch(armUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-verify-secret": secret },
          body: JSON.stringify({ sid: session.sessionId, legA: session.legACallSid ?? "" }),
        }).catch((err) => console.error("[verify] relay arm failed:", err));
      }
    }
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
/**
 * Resolve the LIVE conference SID for a session. Twilio conferences are
 * addressable ONLY by SID — fetching/updating via the friendly name 404s
 * ("resource not found"). Filter by friendlyName + in-progress (also guards
 * against duplicate-name races).
 */
async function liveConferenceSid(sessionId: string): Promise<string | null> {
  try {
    const confs = await getTwilioClient().conferences.list({
      friendlyName: conferenceName(sessionId),
      status: "in-progress",
      limit: 5,
    });
    return confs.at(0)?.sid ?? null;
  } catch (err) {
    console.warn(
      `[verify] conference lookup failed session=${sessionId}:`,
      (err as Error).message,
    );
    return null;
  }
}

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
  /**
   * Twilio Client identity of a browser softphone (e.g. "user-42"). When set,
   * the caller leg is originated to `client:<callerClient>` (the browser
   * answers inside the softphone) instead of a PSTN caller number — the
   * "Guarded inmate call" mode. Takes precedence over callerNumber.
   */
  callerClient?: string;
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
    // Guarded inmate-call mode (softphone caller leg) — drives the live
    // bridge after verification passes. NULL for legacy sessions.
    guarded: input.callerClient ? true : null,
  };
  await getDb().insert(schema.verificationSessions).values(session);
  await logEvent(
    sessionId,
    "SESSION_CREATED_API",
    `caller=${input.callerNumber ?? "(none)"} callee=${input.calleeNumber}`,
  );

  const created = (await findSession(sessionId))!;

  if (input.callerClient) {
    // Guarded inmate call: NO REST-originated caller leg. The browser
    // softphone places the OUTBOUND Twilio Voice SDK call itself right after
    // this mutation returns, carrying the sessionId as the `guarded` custom
    // param; the TwiML App voice webhook (voiceWebhookHandler) then calls
    // onGuardedCallerConnected() which stores the caller CallSid, moves
    // INITIATED → CALLER_HOLDING and originates Leg A. Until that connect
    // arrives the session stays INITIATED — the stale sweep fails guarded
    // INITIATED sessions whose caller never connects (>2 min).
    await logEvent(
      sessionId,
      "GUARDED_AWAITING_CALLER",
      `Guarded session created for Twilio Client ${input.callerClient} — awaiting outbound SDK connect`,
    );
  } else if (input.callerNumber) {
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

/**
 * GUARDED MODE ONLY: the caller's browser softphone placed the OUTBOUND
 * Twilio Voice SDK call (device.connect with the `guarded` custom param =
 * sessionId) and the TwiML App voice webhook handed it here. Validates the
 * session, stores the caller CallSid, transitions INITIATED → CALLER_HOLDING
 * and originates Leg A (exactly what onCallerAnswered did for the old
 * REST-originated caller leg). Returns false when the session is not a
 * guarded INITIATED session — the webhook then plays the failure prompt.
 */
export async function onGuardedCallerConnected(
  sessionId: string,
  callSid: string,
): Promise<boolean> {
  const session = await findSession(sessionId);
  if (!session || !session.guarded) {
    console.warn(`[verify] GUARDED_CALLER_REJECTED sessionId=${sessionId} — unknown or non-guarded session`);
    return false;
  }
  if (session.state !== VState.INITIATED) {
    console.warn(
      `[verify] GUARDED_CALLER_REJECTED sessionId=${sessionId} state=${session.state} — expected INITIATED (duplicate or stale connect)`,
    );
    return false;
  }
  if (
    await transition(
      session,
      VState.CALLER_HOLDING,
      `Guarded caller connected via outbound SDK call, sid=${callSid}`,
    )
  ) {
    session.callerCallSid = callSid;
    await save(session);
    await originateAndDialLegA(session);
    return true;
  }
  return false;
}

/**
 * Leg A's phone was picked up (Twilio status in-progress). NON-GUARDED flow:
 * pre-originate Leg B RIGHT NOW (PSTN origination takes ~5-15s, so the second
 * call is airborne by the ready press — zero perceived ring latency, exactly
 * like the Asterisk original). GUARDED flow deliberately returns here: Leg B
 * waits for voice-ID plus the callee's second explicit press-1.
 * No FSM transition: CALL_ACCEPTED is still driven by the press-1 IVR.
 */
export async function onLegAAnswered(
  sessionId: string,
  callSid: string,
): Promise<void> {
  const session = await findSession(sessionId);
  if (!session || isTerminal(session)) return;
  if (!session.legACallSid) {
    session.legACallSid = callSid;
    await save(session);
  }
  await logEvent(
    sessionId,
    "ANSWERED_LEGA",
    `sid=${callSid} — pre-originating Leg B (zero ring latency at ready press)`,
  );

  if (session.legBCallSid) return; // already airborne (e.g. retry)
  // GUARDED MODE ONLY: no probe call — single callee call, then voiceprint.
  if (session.guarded) return;
  const legBSid = await originate(session, "legB", session.legBNumber ?? session.calleeNumber, "leg-b", {
    timeoutSec: 15,
    machineDetection: true,
    asyncAmd: true,
  });
  if (legBSid) {
    session.legBCallSid = legBSid;
    session.legBOriginatedAt = new Date();
    await save(session);
    await logEvent(
      sessionId,
      "LEG_B_PRE_ORIGINATED",
      `sid=${legBSid} — ringing while prompt 1 plays; arrives by the first press`,
    );
  } else {
    // Leave legBCallSid empty — the press-1 path (originateLegB) will retry.
    await logEvent(sessionId, "LEG_B_PRE_ORIGINATION_FAILED", "press-1 fallback will originate");
  }
}

/**
 * First press-1 (callee accepted the inmate call) → CALL_ACCEPTED.
 * Returns the session row (callers may ignore it) so webhook handlers can
 * branch on `guarded` without a second DB read.
 */
export async function onCallAccepted(
  sessionId: string,
  callSid: string,
): Promise<VerificationSession | null> {
  const session = await findSession(sessionId);
  if (!session) return null;
  if (
    await transition(session, VState.CALL_ACCEPTED, `Callee accepted, legA=${callSid}`)
  ) {
    session.legACallSid = callSid;
    await save(session);
    // Non-guarded sessions keep the legacy behavior: Leg B is originated as
    // soon as the callee accepts. Guarded sessions intentionally wait through
    // TWO more explicit callee actions: the voice-ID <Record>, then a second
    // press-1. Only that second press invokes onCalleeReady(), so the callee
    // controls exactly when the next call arrives.
    if (!session.guarded) {
      await originateLegB(sessionId);
    } else {
      await logEvent(
        sessionId,
        "GUARDED_VOICEPRINT_STEP",
        "callee accepted — voice-ID phrase recording next; second-call verification starts only after the second press-1",
      );
    }
  }
  return session;
}

/**
 * Second press-1 ("ready"). Guarded sessions originate Leg B HERE — after
 * voice-ID, never automatically from the recording callback. Non-guarded Leg B
 * may already be airborne from the legacy pre-origination path; in that case
 * this confirms and drains the buffered answer without a duplicate call.
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
  if (session.state === VState.LEG_B_DIALING || session.state === VState.LEG_B_ANSWERED) {
    return;
  }

  // Non-guarded Leg B is normally ALREADY AIRBORNE here — pre-originated when
  // Leg A was answered (onLegAAnswered) so the callee never waits for the
  // second call. Guarded Leg B starts here, only after the voice-ID recording
  // AND the callee's second explicit press-1. Originate only as a fallback
  // when not airborne.
  const alreadyAirborne = Boolean(session.legBCallSid);

  if (
    (await transition(
      session,
      VState.CALLEE_READY,
      alreadyAirborne
        ? "Callee ready — Leg B already airborne (pre-originated at answer)"
        : "Callee ready, originating Leg B, caller will listen",
    )) &&
    (await transition(
      session,
      VState.LEG_B_DIALING,
      alreadyAirborne
        ? "Leg B pre-originated — zero ring latency at ready press"
        : "Leg B originated (ring test disabled)",
    ))
  ) {
    if (alreadyAirborne) {
      await logEvent(
        sessionId,
        "LEG_B_PRE_ORIGINATED_ACK",
        `sid=${session.legBCallSid} — no origination needed at press`,
      );
    } else {
      session.legBOriginatedAt = new Date();
      await save(session);

      // Fallback origination (pre-origination at answer failed).
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
    }

    // Drain a Leg B answer that raced ahead of the presses (pre-origination).
    const pending = pendingLegBAnswer.get(sessionId);
    if (pending) {
      pendingLegBAnswer.delete(sessionId);
      await onLegBAnswered(sessionId, pending);
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

  // With answer-time pre-origination Leg B can be answered BEFORE the callee
  // presses 1 (FSM still pre-LEG_B_DIALING). Buffer the answer — originateLegB
  // drains it the moment the FSM reaches LEG_B_DIALING, so the tone on Leg A
  // still only starts after the callee has accepted.
  if (session.state !== VState.LEG_B_DIALING && session.state !== VState.LEG_B_ANSWERED) {
    pendingLegBAnswer.set(sessionId, callSid);
    await logEvent(
      sessionId,
      "LEG_B_EARLY_ANSWER_BUFFERED",
      `state=${session.state} sid=${callSid} — will apply when FSM reaches LEG_B_DIALING`,
    );
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

    // GUARDED MODE ONLY: arm the merge-detection watch. If no merge fires
    // within mergeWatchMs() the session has PASSED and the live bridge runs.
    // Two triggers, both funnelling into the idempotent maybeBridgeGuarded():
    //  1. this setTimeout (primary path on a long-lived server);
    //  2. the leg-a-tone TwiML self-redirect loop, which polls
    //     maybeBridgeGuarded() on every fetch (fallback for runtimes where
    //     background timers are not guaranteed — see sweepStaleSessions).
    if (session.guarded) {
      mergeWatchArmedAt.set(sessionId, Date.now());
      const watchMs = mergeWatchMs();
      await logEvent(
        sessionId,
        "GUARDED_MERGE_WATCH_ARMED",
        `merge-detection watch window=${watchMs}ms — live bridge on pass`,
      );
      setTimeout(() => {
        void maybeBridgeGuarded(sessionId).catch((err) =>
          console.error("[verify] guarded bridge timer error:", err),
        );
      }, watchMs).unref?.();
    }
  }
}

/**
 * Guarded pass point: LEG_B_ANSWERED (callee accepted via press-1 AND the
 * second simultaneous call was answered by a human, i.e. call waiting works
 * and the line is cellular) + the merge-detection watch window elapsed with
 * NO merge detected. Idempotent: any later invocation is a no-op because the
 * session has left LEG_B_ANSWERED. NON-GUARDED sessions return immediately —
 * their engine behavior is bit-for-bit unchanged.
 *
 * Returns true when this call performed the bridge. When `legAInline` is
 * true the caller of this function is the leg-a-tone TwiML fetch itself and
 * serves the guarded-bridge TwiML directly — so Leg A is NOT REST-redirected
 * (a mid-fetch redirect would race the response Twilio is about to execute).
 * `force` skips the merge-watch timing checks — used when Leg B itself hung
 * up (the legacy pass signal: call completed normally, no merge leaked).
 */
export async function maybeBridgeGuarded(
  sessionId: string,
  opts: { legAInline?: boolean; force?: boolean } = {},
): Promise<boolean> {
  const session = await findSession(sessionId);
  if (!session || !session.guarded) return false;
  if (session.state !== VState.LEG_B_ANSWERED) return false; // merge fired or already bridged/terminal
  if (!opts.force) {
    const armedAt = mergeWatchArmedAt.get(sessionId);
    if (armedAt === undefined) {
      // Watch timestamp unknown in this process (e.g. fresh instance serving
      // the leg-a-tone poll fallback) — arm from first sight and defer one
      // poll cycle rather than bridging before the window has elapsed.
      mergeWatchArmedAt.set(sessionId, Date.now());
      return false;
    }
    if (Date.now() - armedAt < mergeWatchMs()) return false;
  }

  if (
    await transition(
      session,
      VState.BRIDGED,
      "verification passed (callee accepted, no merge) — live guarded bridge",
    )
  ) {
    mergeWatchArmedAt.delete(sessionId);
    await logEvent(
      sessionId,
      "GUARDED_BRIDGED",
      `caller=${session.callerCallSid ?? "(none)"} legA=${session.legACallSid ?? "(none)"} — two-way live conference ${conferenceName(sessionId)}; Leg A media stream persists`,
    );
    // Verification is done: hang up the ring-test leg only; Leg B (answered
    // by a human) is left to end naturally. Leg A's <Start><Stream> survives
    // the bridge redirect, so speakerphone detection keeps running in-call.
    await hangupAll(session, { ringTest: true });
    // Bridge the two real parties into the same conference (LIVE, two-way).
    await redirectCall(session.callerCallSid, "guarded-bridge", sessionId);
    if (!opts.legAInline) {
      await redirectCall(session.legACallSid, "guarded-bridge", sessionId);
    }
    return true;
  }
  return false;
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
    // Caller AND callee (Leg A) both hear the merge announcement before the
    // drop (notify-merge = say + hangup) so the party who merged knows why.
    await Promise.allSettled([
      redirectCall(session.callerCallSid, "notify-merge", sessionId),
      redirectCall(session.legACallSid, "notify-merge", sessionId),
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
  // GUARDED MODE ONLY: Leg B is originated with asyncAmd, so the machine
  // verdict ALWAYS arrives a few seconds AFTER the answer callback already
  // took the human path (LEG_B_ANSWERED). Answering a call-waiting call plays
  // a switch beep that Twilio AMD routinely misreads as a voicemail beep —
  // the false positive then killed the second call mid-verification. Once a
  // guarded session is LEG_B_ANSWERED or later, a late machine verdict is
  // log-only: the callee provably answered (they requested this exact call
  // via the second press-1 seconds earlier).
  if (
    session.guarded &&
    (session.state === VState.LEG_B_ANSWERED || session.state === VState.BRIDGED)
  ) {
    console.warn(
      `[verify] AMD_LATE_MACHINE_IGNORED amd=${amdStatus} state=${session.state} — guarded second call stays up`,
    );
    await logEvent(
      sessionId,
      "AMD_LATE_MACHINE_IGNORED",
      `amd=${amdStatus} arrived after Leg B answer (state=${session.state}) — async-AMD false positive guard, call continues`,
    );
    return;
  }
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

  // GUARDED MODE ONLY: the live bridge ends when either party hangs up.
  // endConferenceOnExit=true on both bridge legs makes Twilio drop the other
  // participant too; the hangups below are belt-and-braces. Leg B / ring
  // test completions while BRIDGED are expected (ring test was hung up at
  // bridge time; Leg B is left to end naturally) and fall through untouched.
  if (session.state === VState.BRIDGED && (leg === "caller" || leg === "legA")) {
    if (
      await transition(
        session,
        VState.COMPLETED,
        `${leg} hung up — guarded live call ended`,
      )
    ) {
      session.completedAt = new Date();
      await save(session);
      await logEvent(
        sessionId,
        "GUARDED_CALL_ENDED",
        `leg=${leg} sid=${callSid} ${statusDetail}`,
      );
      if (session.guarded && leg === "legA") {
        // Callee ended the first call mid-bridge: tell the caller why the
        // guarded call is ending before the TwiML hangs them up.
        await redirectCall(session.callerCallSid, "notify-first-call-ended", sessionId);
        await hangupAll(session, { legB: true, ringTest: true });
      } else {
        await hangupAll(session, {
          caller: leg !== "caller",
          legA: leg !== "legA",
          legB: true,
          ringTest: true,
        });
      }
    }
    return;
  }

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
    (session.guarded ||
      (session.state !== VState.LEG_B_ANSWERED && session.state !== VState.LEG_B_DIALING))
  ) {
    // Callee hung up during the Leg A IVR. GUARDED MODE: the first call is the
    // anchor of the whole guarded flow — if the callee ends it at ANY point
    // before or during the bridge (including LEG_B_DIALING / LEG_B_ANSWERED,
    // which legacy non-guarded flow tolerates because the carrier may release
    // the first call when the second connects), the guarded call must be
    // terminated and the caller explicitly told why.
    console.warn(`[verify] LEG_A_HANGUP_IVR — callee hung up during ${session.state}`);
    if (await transition(session, VState.FAILED, `Callee hung up during ${session.state}`)) {
      session.failureReason = session.guarded
        ? "Callee ended the first call"
        : "Callee hung up during IVR";
      session.completedAt = new Date();
      await save(session);
      await redirectCall(
        session.callerCallSid,
        session.guarded ? "notify-first-call-ended" : "notify-failed",
        sessionId,
      );
      await hangupAll(session, { legB: true, ringTest: true });
    }
    return;
  }

  if (leg === "legB" && session.state === VState.LEG_B_ANSWERED) {
    // GUARDED MODE ONLY: Leg B hanging up with no merge leaked is the legacy
    // PASS signal — bridge caller + callee LIVE (guarded-bridge TwiML)
    // instead of the notify-completed announcement + hangupAll. Non-guarded
    // sessions fall through to the unchanged legacy completion below.
    if (session.guarded && (await maybeBridgeGuarded(sessionId, { force: true }))) {
      return;
    }
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
  // Guarded sessions whose caller never connected: the browser places the
  // outbound SDK call immediately after initiateGuarded returns, so a
  // guarded session still INITIATED after ~2 min means the connect never
  // arrived (tab closed, SDK failure) — fail it fast instead of waiting out
  // the 10-minute generic window.
  const guardedCallerCutoff = new Date(Date.now() - GUARDED_CALLER_TIMEOUT_MS);
  const stale = await getDb()
    .select()
    .from(schema.verificationSessions)
    .where(
      and(
        // BRIDGED is excluded: a live guarded call legitimately runs longer
        // than the 10min stale window and ends via hangup status callbacks.
        // (Non-guarded sessions never reach BRIDGED — behavior unchanged.)
        notInArray(schema.verificationSessions.state, [
          ...TERMINAL_STATES,
          VState.BRIDGED,
        ]),
        or(
          lt(schema.verificationSessions.createdAt, cutoff),
          and(
            eq(schema.verificationSessions.guarded, true),
            eq(schema.verificationSessions.state, VState.INITIATED),
            lt(schema.verificationSessions.createdAt, guardedCallerCutoff),
          ),
        ),
      ),
    );
  for (const s of stale) {
    const neverConnected =
      s.guarded && s.state === VState.INITIATED && s.createdAt < guardedCallerCutoff;
    console.warn(
      `[verify] STALE_CLEANUP terminating sessionId=${s.sessionId} state=${s.state} created=${s.createdAt.toISOString()}`,
    );
    await failSession(
      s,
      neverConnected
        ? "Guarded caller never connected (>2min)"
        : "Stale session cleanup (>10min)",
    );
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
  cleanupSessionMaps(session.sessionId);

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

/**
 * OUTER SPEAKERPHONE clear transition — the media-stream detector saw a clean
 * window after a fired suspicion. Challenge noise is finite (the exact 4s
 * probe loop) and is only re-announced while suspicion persists, so the clear
 * path is simply to STOP re-injecting; the live page gets an explicit event on
 * the next poll. Any in-progress announce can finish naturally (≤4s).
 */
export async function onSpeakerphoneCleared(
  sessionId: string,
  reason: string,
): Promise<void> {
  try {
    const session = await findSession(sessionId);
    if (!session || isTerminal(session)) return;
    // A later episode is a NEW suspicion, not a continuation of the previous
    // one — reset the event throttle so it is visible immediately.
    lastNoiseEventAt.delete(sessionId);
    await logEvent(
      sessionId,
      "SPEAKERPHONE_CLEARED",
      `callee audio returned to normal; no further challenge-noise injections | ${reason}`.slice(0, 512),
    );
    try {
      const { logCallEvent } = await import("./simulator");
      const rows = await getDb()
        .select({ id: schema.calls.id })
        .from(schema.calls)
        .where(eq(schema.calls.clientCallId, `guarded-${sessionId}`))
        .limit(1);
      const callId = Number(rows.at(0)?.id ?? 0);
      if (callId) {
        await logCallEvent(callId, "speakerphone_cleared", {
          sessionId,
          reason,
          target: "legA-callee",
          at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn("[verify] logCallEvent speakerphone_cleared mirror failed:", (err as Error).message);
    }
  } catch (err) {
    console.error(`[verify] onSpeakerphoneCleared failed session=${sessionId}:`, err);
  }
}

/**
 * OUTER SPEAKERPHONE case — inject the relayguard challenge noise toward the
 * CALLEE (Leg A, the dialed party) participant ONLY via a Twilio conference
 * announce. With the noise on the callee's downlink they can't hear the
 * inmate/caller clearly while on speakerphone and are prompted to get off
 * speaker to hear better. The caller/inmate leg NEVER gets this noise (the
 * in-call has its own separate tone — untouched here). The call CONTINUES:
 * this never hangs up or redirects any leg.
 *
 * If the session has no legACallSid the announce is skipped (logged) — we do
 * NOT fall back to the caller leg.
 *
 * REPEAT-SAFE: while outer-speakerphone suspicion persists during the live
 * (bridged) call, the detector re-invokes this every refireMs (default 4s —
 * the exact length of the seamless probe loop). Each call simply updates the
 * same conference announce, so repeats are idempotent — Twilio replays the
 * announcement to the callee (sustained masking). When audio returns to
 * normal, re-injection stops on the next clean 1s window and any in-progress
 * 4s loop finishes naturally. Every injection is counted;
 * SPEAKERPHONE_SUSPECTED event WRITES are throttled to one per
 * noiseEventThrottleMs() (default 30s) per episode while the announce
 * re-injection itself is unthrottled.
 *
 * Best-effort throughout: any failure is logged (and recorded as a
 * verification event) but never thrown back into the media path.
 */
export async function injectChallengeNoise(
  sessionId: string,
  reason: string,
): Promise<void> {
  try {
    const session = await findSession(sessionId);
    if (!session) return;
    // Only inject once the call is BRIDGED — before that, Leg A (callee) is
    // not a conference participant yet (still ringing / in the press-1 IVR),
    // so a conference announce would 404. Suspicion detected on pre-bridge
    // audio (ringback, IVR prompts) is ignored by design.
    if (session.state !== VState.BRIDGED) {
      console.log(
        `[verify] SPEAKERPHONE_SUSPECTED session=${sessionId} state=${session.state} — not BRIDGED yet, skipping announce | ${reason}`,
      );
      return;
    }
    const injection = (noiseInjectionCount.get(sessionId) ?? 0) + 1;
    noiseInjectionCount.set(sessionId, injection);
    // Throttle the DB event writes to max 1 per noiseEventThrottleMs() (30s)
    // — the noise itself re-injects every ~4s while suspicion persists, and
    // a sustained suspicion must not flood verification_events.
    const lastEventAt = lastNoiseEventAt.get(sessionId) ?? -Infinity;
    if (Date.now() - lastEventAt >= noiseEventThrottleMs()) {
      lastNoiseEventAt.set(sessionId, Date.now());
      await logEvent(
        sessionId,
        "SPEAKERPHONE_SUSPECTED",
        `challenge-noise injection #${injection} at ${new Date().toISOString()} target=legA-callee | ${reason}`.slice(0, 512),
      );
    } else {
      console.log(
        `[verify] SPEAKERPHONE_SUSPECTED session=${sessionId} injection #${injection} — event write throttled (re-injecting noise only)`,
      );
    }
    if (isTerminal(session)) return;
    if (!session.legACallSid) {
      console.warn(`[verify] SPEAKERPHONE_SUSPECTED session=${sessionId} — no Leg A (callee) leg, skipping announce`);
      return;
    }
    const base = getPublicBaseUrl();
    if (!base) {
      console.warn(`[verify] SPEAKERPHONE_SUSPECTED session=${sessionId} — no public base URL, skipping announce`);
      return;
    }
    const confSid = await liveConferenceSid(sessionId);
    if (!confSid) {
      console.warn(
        `[verify] SPEAKERPHONE_SUSPECTED session=${sessionId} — no in-progress conference yet, skipping announce`,
      );
      return;
    }
    await getTwilioClient()
      .conferences(confSid)
      .participants(session.legACallSid)
      .update({
        announceUrl: `${base}/api/verify/challenge-noise.wav`,
        announceMethod: "GET",
      });
    console.log(
      `[verify] CHALLENGE_NOISE_INJECTED session=${sessionId} legA=${session.legACallSid} target=legA-callee | ${reason}`,
    );
    // Best-effort mirror into the shared call_events stream (guarded calls
    // link their calls row via clientCallId = guarded-<sessionId>).
    try {
      const { logCallEvent } = await import("./simulator");
      const rows = await getDb()
        .select({ id: schema.calls.id })
        .from(schema.calls)
        .where(eq(schema.calls.clientCallId, `guarded-${sessionId}`))
        .limit(1);
      const callId = Number(rows.at(0)?.id ?? 0);
      if (callId) {
        await logCallEvent(callId, "speakerphone_suspected", {
          sessionId,
          reason,
          target: "legA-callee",
          injection,
          at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn("[verify] logCallEvent mirror failed:", (err as Error).message);
    }
  } catch (err) {
    console.error(`[verify] injectChallengeNoise failed session=${sessionId}:`, err);
  }
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

/**
 * GUARDED MODE ONLY: persist the explicit voice-ID recording ("my voice
 * identifies me") so the call-review UI can play it back. Stored even when
 * relayguard profiling failed — playback does not depend on the baseline.
 */
export async function storeVoiceRecording(
  sessionId: string,
  recordingUrl: string,
  durationSec: number,
): Promise<void> {
  const session = await findSession(sessionId);
  if (!session) return;
  session.voiceRecordingUrl = recordingUrl;
  session.voiceRecordingDurationSec = Math.max(0, Math.round(durationSec));
  session.voiceRecordedAt = new Date();
  await save(session);
  await logEvent(
    sessionId,
    "VOICE_RECORDING_STORED",
    `url=${recordingUrl} duration=${Math.round(durationSec)}s`,
  );
}

/** GUARDED MODE ONLY: persist the live bridge conference recording. */
export async function storeBridgeRecording(
  sessionId: string,
  rec: { recordingSid: string; recordingUrl: string; durationSec: number },
): Promise<void> {
  const session = await findSession(sessionId);
  if (!session) return;
  session.bridgeRecordingSid = rec.recordingSid;
  session.bridgeRecordingUrl = rec.recordingUrl;
  session.bridgeRecordingDurationSec = Math.max(0, Math.round(rec.durationSec));
  session.bridgeRecordedAt = new Date();
  await save(session);
  await logEvent(
    sessionId,
    "BRIDGE_RECORDING_STORED",
    `sid=${rec.recordingSid} url=${rec.recordingUrl} duration=${Math.round(rec.durationSec)}s`,
  );
}
