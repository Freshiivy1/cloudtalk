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
 *   POST {PUBLIC_BASE_URL}/api/verify/voiceprint?sid=...        (guarded only —
 *     save-only voice-ID <Record> action: stamps the capture and hands the
 *     callee straight to the second press-1 gather)
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt, lt, ne, notInArray, or } from "drizzle-orm";
import * as schema from "@db/schema";
import type { VerificationSession } from "@db/schema";
import { PROMPT_LIGHT_DURATION_MS } from "./generated/prompt-light-asset";
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
  /**
   * The merge-detection pipeline itself failed (stream error/timeout, missing
   * readiness, arm/challenge-start callback failure after retry, relay
   * detector failure). NEVER a pass — an unmonitored call is not a verified
   * call.
   */
  DETECTION_FAILED: "DETECTION_FAILED",
  /**
   * The call ran or ended without a verified live outcome (stream never
   * became ready, canary lost, Leg B ended before monitoring was confirmed).
   * NEVER a pass.
   */
  DETECTION_INCONCLUSIVE: "DETECTION_INCONCLUSIVE",
  /**
   * SUPREME FLAG: speakerphone/relay audio was detected again after the
   * final warning (strike 3: warning prompt + caller muted) — the call is
   * ended, the call record is flagged, and admin is alerted. NEVER a pass.
   */
  SPEAKERPHONE_TERMINATED: "SPEAKERPHONE_TERMINATED",
  FAILED: "FAILED",
} as const;
export type VerificationState = (typeof VState)[keyof typeof VState];

export const TERMINAL_STATES: readonly VerificationState[] = [
  VState.COMPLETED,
  VState.MERGE_DETECTED,
  VState.VOIP_DETECTED,
  VState.CALL_WAITING_OFF,
  VState.DETECTION_FAILED,
  VState.DETECTION_INCONCLUSIVE,
  VState.SPEAKERPHONE_TERMINATED,
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
  LEG_A_DIALING: [
    VState.CALL_ACCEPTED,
    VState.CALL_WAITING_OFF,
    VState.DETECTION_FAILED,
    VState.FAILED,
  ],
  CALL_ACCEPTED: [
    VState.CALLEE_READY,
    VState.CALL_WAITING_OFF,
    VState.DETECTION_FAILED,
    VState.FAILED,
  ],
  CALLEE_READY: [
    VState.LEG_B_DIALING,
    VState.CALL_WAITING_OFF,
    VState.DETECTION_FAILED,
    VState.FAILED,
  ],
  LEG_B_DIALING: [
    VState.LEG_B_ANSWERED,
    VState.VOIP_DETECTED,
    VState.CALL_WAITING_OFF,
    VState.COMPLETED,
    VState.DETECTION_FAILED,
    VState.DETECTION_INCONCLUSIVE,
    VState.FAILED,
  ],
  LEG_B_ANSWERED: [
    VState.BRIDGED,
    VState.COMPLETED,
    VState.MERGE_DETECTED,
    VState.VOIP_DETECTED,
    VState.CALL_WAITING_OFF,
    VState.DETECTION_FAILED,
    VState.DETECTION_INCONCLUSIVE,
    VState.FAILED,
  ],
  // Post-bridge merge/voip detection via the media-stream path keeps the
  // existing hang-up-everything behavior (those flows are unchanged).
  BRIDGED: [
    VState.COMPLETED,
    VState.MERGE_DETECTED,
    VState.VOIP_DETECTED,
    VState.DETECTION_FAILED,
    VState.DETECTION_INCONCLUSIVE,
    VState.SPEAKERPHONE_TERMINATED,
    VState.FAILED,
  ],
  COMPLETED: [],
  MERGE_DETECTED: [],
  VOIP_DETECTED: [],
  CALL_WAITING_OFF: [],
  DETECTION_FAILED: [],
  DETECTION_INCONCLUSIVE: [],
  SPEAKERPHONE_TERMINATED: [],
  FAILED: [],
};

export type VerifyLeg = "caller" | "legA" | "legB" | "ringTest";

const SMS_WINDOW_SECONDS = 15;
/**
 * The merge-test tone is the existing merge-tone pair 852 Hz + 1336 Hz — that
 * is DTMF digit '8' (852 Hz row, 1336 Hz column), NOT '9' (which would be
 * 852+1477). Frequencies are unchanged; only the naming is corrected. Leg B's
 * silent <Gather numDigits=1> (legacy path) fires the instant it leaks across
 * a merge — single digit, no inter-digit delay.
 */
export const MERGE_TONE_DIGIT = "8";
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
 * Early stream-ready buffer. Leg B's TwiML opens the non-blocking relay
 * stream the instant the call connects, so the relay's stream-ready callback
 * can beat the Twilio answered status callback that drives the FSM to
 * LEG_B_ANSWERED. Rejecting that callback (500) would burn the relay's
 * bounded retries and risks losing readiness entirely — instead the readiness
 * is buffered here and drained by onLegBAnswered(), which starts the Leg A
 * challenge the moment the FSM catches up. Short-lived, in-process (mirrors
 * pendingLegBAnswer); cleared by cleanupSessionMaps() on terminal states.
 */
const pendingStreamReady = new Map<string, { streamSid: string; readyAt?: string }>();

/* -------------------------------------------------------------------------- */
/* Two-phase Call Waiting challenge (corrected architecture)                    */
/* -------------------------------------------------------------------------- */

/**
 * Detection phases, persisted on verification_sessions.detectionPhase so a
 * restart can reconstruct where the challenge stood without process memory.
 *  - AWAITING_STREAM_READY: Leg B answered; the relay has not yet confirmed
 *    the inbound stream. Missing readiness by streamReadyBy is
 *    DETECTION_FAILED — never a silent pass.
 *  - PROMPT_LIGHT: Phase 1 — Leg A plays the prompt-light asset (speech +
 *    attenuated 852+1336 Hz watermark). A merge is detected by prompt
 *    fingerprint AND overlapping light DTMF.
 *  - LOUD_DTMF: Phase 2 — Leg A loops the existing loud verify-tone.wav; the
 *    relay's existing loud Goertzel detector alone is decisive.
 */
export const DetectionPhase = {
  AWAITING_STREAM_READY: "AWAITING_STREAM_READY",
  PROMPT_LIGHT: "PROMPT_LIGHT",
  LOUD_DTMF: "LOUD_DTMF",
} as const;
export type DetectionPhaseValue = (typeof DetectionPhase)[keyof typeof DetectionPhase];

/**
 * Readiness deadline (ms) after Leg B answers. If the relay's stream-ready
 * callback has not arrived by then, the session is DETECTION_FAILED (missing
 * readiness) — a live call without monitoring is never allowed to continue.
 * Default 45s: the merge relay runs on Render's free tier and a cold start
 * takes ~22s, so the old 15s default could expire before a sleeping relay
 * even woke (wakeRelay() at session initiation mitigates this; the deadline
 * is the backstop). Env-overridable via VERIFY_STREAM_READY_TIMEOUT_MS
 * (mainly for tests). The in-process watchdog timer is scheduled at arming
 * (scheduleReadinessWatchdog in onLegBAnswered / the recall re-arm).
 */
export function streamReadyTimeoutMs(): number {
  const v = Number(process.env.VERIFY_STREAM_READY_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 45_000;
}

/**
 * Tolerance (ms) added to promptEndsAt before the LOUD_DTMF phase is
 * considered active. Env-overridable via VERIFY_TRANSITION_TOLERANCE_MS.
 */
export function transitionToleranceMs(): number {
  const v = Number(process.env.VERIFY_TRANSITION_TOLERANCE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 1_000;
}

/**
 * The phase the challenge is in RIGHT NOW, derived from the persisted
 * timestamps (restart-safe — no process memory involved). Returns null when
 * no challenge has started.
 */
export function currentDetectionPhase(
  session: Pick<
    VerificationSession,
    "challengeStartedAt" | "promptEndsAt" | "detectionPhase"
  >,
): DetectionPhaseValue | null {
  if (!session.challengeStartedAt) {
    return session.detectionPhase === DetectionPhase.AWAITING_STREAM_READY
      ? DetectionPhase.AWAITING_STREAM_READY
      : null;
  }
  if (session.promptEndsAt) {
    const endsAt = new Date(session.promptEndsAt).getTime() + transitionToleranceMs();
    return Date.now() < endsAt
      ? DetectionPhase.PROMPT_LIGHT
      : DetectionPhase.LOUD_DTMF;
  }
  return (session.detectionPhase as DetectionPhaseValue | null) ?? null;
}

/** True when the session's merge detection was confirmed live (stream ready). */
export function detectionIsLive(
  session: Pick<VerificationSession, "streamReadyAt" | "challengeStartedAt">,
): boolean {
  return Boolean(session.streamReadyAt && session.challengeStartedAt);
}

/**
 * D2: event-driven BRIDGED notification registry. bridgeGuardedLive() sets
 * the flag SYNCHRONOUSLY on the successful LEG_B_ANSWERED → BRIDGED
 * transition, so the media-stream analyzer path (verification-stream.ts)
 * sees the bridge on the very next audio window instead of waiting for the
 * ~0.5s DB refresh poll — closing the race where false-RED windows were
 * scored with bridged=false (no warm-up suppression) before the poll
 * noticed the bridge. Cleared by cleanupSessionMaps() on terminal states.
 */
const bridgedSessions = new Set<string>();

/** True once this process has bridged the session (event-driven, no DB). */
export function isBridgedSession(sessionId: string): boolean {
  return bridgedSessions.has(sessionId);
}

/* ------- Speakerphone-relay STRIKE LADDER (per-session, in-process) -------
 * A STRIKE is a CONFIRMED, DISTINCT speakerphone-like episode, recorded at
 * episode onset (the stream layer marks onset = first detector emission
 * after the previous episode fully cleared). One continuous suspicious
 * period = exactly one strike, no matter how many detector frames refire.
 * A new strike requires: previous episode ended → audio normal for the
 * recovery period (the detector's fingerprint-clean streak, ≈3s) →
 * detector rearmed → a new episode independently confirmed. Ladder:
 *   strike 1  → recorded (timestamp + detector evidence); call continues.
 *   strike 2  → recorded; call continues UNCHANGED (a milestone only).
 *   strike 3  → WARNING FLAG: mute the inmate FIRST, play the warning to
 *               the conference (recipient hears it; the inmate hears it
 *               receive-only), unmute when playback completes, resume.
 *   strike 4  → SUPREME FLAG: admin notified exactly once, call ended.
 * Strikes 1–2 inject NO audio into either leg. All entries are cleared by
 * cleanupSessionMaps() on terminal states. */
const speakerphoneStrikes = new Map<string, number>();
/** Sessions whose strike-3 warning was successfully delivered (plays once ever). */
const speakerphoneWarnedSessions = new Set<string>();
/** Wall-clock the strike-3 warning PLAYBACK started; present only while the
 * warning flow (muted → playing → unmute) is in progress. Detector callbacks
 * are coalesced away in this window so the warning audio itself can never
 * create strike 4. */
const speakerphoneWarningActiveAt = new Map<string, number>();
/** Sessions already supreme-flagged (idempotency key: one flag per session). */
const speakerphoneSupremeSessions = new Set<string>();
/** Pending unmute timers for the strike-3 warning flow (completion-driven:
 * measured warning-audio duration + buffer, never a blind guess). */
const speakerphoneUnmuteTimers = new Map<string, NodeJS.Timeout>();
/**
 * Sessions whose canary (Leg A) loud-tone loop has been PERMANENTLY silenced
 * after a speakerphone episode onset. The loud 852+1336 Hz loop is the
 * pre-bridge/early-bridge merge canary — but while a relay episode is active
 * its acoustic leak into the speakerphone mic path can cross the relay's
 * loud-tone floor and false-fire MERGE_DETECTED (the 2026-09-04 live test:
 * call killed mid-relay-episode with the wrong reason). Once silenced the
 * tone never resumes for the session; in-call merge supervision continues
 * via the AUTHORIZED merge-relay detector (Leg A audio crossing into Leg B's
 * inbound stream). Cleared by cleanupSessionMaps() on terminal states.
 */
const canarySilencedSessions = new Set<string>();

/**
 * Consecutive suspicious analysis hops the SpeakerphoneDetector requires
 * before the outer-call forensic system fires (challenge noise to the CALLER
 * only — never the merge tone). Default 2: with the 0.5 s sliding hop the
 * detector then fires 1.0–2.0 s after relay audio starts (the 2 s pickup
 * budget) instead of 3–4 s with the old non-overlapping 3-window rule. Every
 * arming hop must still clear the full bar — verdict 'SUSPICIOUS RELAY' AND a
 * RED (≥0.6) relay fingerprint — so a brief blip or borderline audio never
 * fires. Env-overridable via VERIFY_SPEAKERPHONE_ARM_WINDOWS, floored at 1;
 * an unset, empty, or non-numeric value yields the default 2.
 */
export function speakerphoneArmWindows(): number {
  const raw = process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS;
  if (!raw) return 2; // unset OR set-but-empty → default
  const v = Number(raw);
  if (!Number.isFinite(v)) return 2;
  return Math.max(1, Math.floor(v));
}

/**
 * Consecutive FINGERPRINT-CLEAN hops (absolute relay fingerprint below the
 * detector's clean ceiling, 0.5) required to CLEAR a fired speakerphone
 * suspicion and stop the challenge noise. Default 6 ≈ 3 s of confirmed-normal
 * audio at the 0.5 s hop. Any hop at/above the ceiling RESETS the streak, so
 * the mid-relay fingerprint dips (≈0.55–0.6) a sustained relay produces can
 * never chain into a clear — the exact "noise played 3 s then went back to
 * normal" failure. Clearing is deliberately verdict-independent: the verdict
 * compares against a frozen single-window baseline whose per-window thinness
 * varies with phoneme content far past the channel-vote margin, so normal
 * audio can read SUSPICIOUS against a stale reference — the absolute
 * fingerprint is the robust "is this relay-like right now" signal.
 * Env-overridable via VERIFY_SPEAKERPHONE_CLEAR_WINDOWS, floored at 1.
 */
export function speakerphoneClearWindows(): number {
  const raw = process.env.VERIFY_SPEAKERPHONE_CLEAR_WINDOWS;
  if (!raw) return 6;
  const v = Number(raw);
  if (!Number.isFinite(v)) return 6;
  return Math.max(1, Math.floor(v));
}

/**
 * Sliding analysis hop (seconds) for the SpeakerphoneDetector: every hop the
 * trailing 1 s of Leg B audio is analyzed. Default 0.5 — relay onset is seen
 * by a full analysis within ~1.5 s (2 s pickup budget with 2-hop arming).
 * Env-overridable via VERIFY_FORENSICS_HOP_SEC.
 */
export function forensicsHopSec(): number {
  const raw = process.env.VERIFY_FORENSICS_HOP_SEC;
  if (!raw) return 0.5;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0 || v > 1) return 0.5;
  return v;
}

/**
 * Forensic calibration warm-up (ms) after a session enters BRIDGED: the
 * SpeakerphoneDetector scores windows internally (rebuilding its rolling
 * baseline from LIVE in-call audio — the pre-bridge baseline was ringback/IVR
 * audio, and comparing bridged speech against it is what false-armed the
 * detector ~3s into the live-test bridge) but cannot arm. Default 2000 (4
 * hops at the 0.5 s hop — enough for the baseline to seed from in-call
 * speech; the baseline is fully reset at bridge, so the old 8 s suppression
 * was dead time that delayed real detections). Env-overridable via
 * VERIFY_FORENSICS_WARMUP_MS.
 */
export function forensicsWarmupMs(): number {
  const raw = process.env.VERIFY_FORENSICS_WARMUP_MS;
  if (!raw) return 2_000;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) return 2_000;
  return Math.floor(v);
}

/**
 * MEASURED duration (ms) of `public/speakerphone-warning.wav` — the strike-3
 * warning audio (266496 frames @ 16 kHz = 16656 ms; re-measure if the asset
 * is re-rendered). The strike-3 unmute is completion-driven from THIS
 * measurement plus a delivery buffer — not a guessed fixed timer: the asset
 * is served by us, so its playback length is known exactly. Env-overridable
 * via VERIFY_SPEAKERPHONE_WARNING_AUDIO_MS (tests shorten it).
 */
export function speakerphoneWarningAudioMs(): number {
  const raw = process.env.VERIFY_SPEAKERPHONE_WARNING_AUDIO_MS;
  if (!raw) return 16_656;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return 16_656;
  return Math.max(200, Math.min(60_000, Math.floor(v)));
}

/**
 * Buffer (ms) added to the measured warning-audio duration before the
 * inmate unmute fires — covers Twilio fetch + conference-mix latency.
 */
export function speakerphoneWarningUnmuteBufferMs(): number {
  const raw = process.env.VERIFY_SPEAKERPHONE_WARNING_UNMUTE_BUFFER_MS;
  if (!raw) return 1_500;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) return 1_500;
  return Math.min(10_000, Math.floor(v));
}

/**
 * Admin phone number (E.164) for the supreme-flag SMS alert. Empty (default)
 * skips the SMS — the call still terminates, is flagged on the calls row,
 * and the event is logged. Env: ADMIN_ALERT_NUMBER.
 */
export function adminAlertNumber(): string {
  return (process.env.ADMIN_ALERT_NUMBER ?? "").trim();
}

/* -------------------------------------------------------------------------- */
/* GUARDED MODE ONLY: save-only voice ID ("my voice identifies me")            */
/* -------------------------------------------------------------------------- */

/**
 * Save-only voice ID: after the first press-1 the callee is asked to say
 * "my voice identifies me"; the phrase is recorded and the voiceprint
 * profile is built (VOICEPRINT_CAPTURED evidence), but NO voice matching and
 * NO phrase verification is EVER performed — the capture is call-review
 * evidence, not a gate. The voiceprint <Record> action stamps the capture on
 * the session (voiceIdCapturedAt + voiceIdRecordingSid — see
 * markVoiceIdCaptured) and thereby against the Leg B call it originates, and
 * hands the callee STRAIGHT to the second press-1 gather: no wait loop, no
 * verdict, no re-record. A capture is valid for the SAME UTC calendar day as
 * the call only (voiceIdFreshForToday) — a fresh capture is required each
 * day; a prior-day capture is never reused.
 */

/**
 * True while a voice-ID capture stamped at `capturedAt` is still fresh for
 * `now` — both fall on the SAME UTC calendar day. A missing capture is never
 * fresh; a prior-day capture is never reused.
 */
export function voiceIdFreshForToday(capturedAt: Date | null, now: Date = new Date()): boolean {
  if (!capturedAt) return false;
  return capturedAt.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

/**
 * The voice-ID <Record> action fired — stamp the save-only capture on the
 * session (voiceIdCapturedAt + voiceIdRecordingSid). No attempts, no
 * verdict, no gate: the callee proceeds to the second press-1 immediately
 * and Leg B is originated from that press regardless of profiling outcome.
 */
export async function markVoiceIdCaptured(
  sessionId: string,
  recordingSid: string,
): Promise<void> {
  const session = await findSession(sessionId);
  if (!session || isTerminal(session)) return;
  session.voiceIdCapturedAt = new Date();
  session.voiceIdRecordingSid = recordingSid || null;
  await save(session);
  await logEvent(
    sessionId,
    "VOICE_ID_CAPTURED",
    `recordingSid=${recordingSid || "(none)"} — save-only voice ID (no matching); valid same UTC day only`,
  );
}


/**
 * Drop all per-session in-process map entries. Call whenever a session reaches
 * a terminal state so these short-lived Maps can't grow unboundedly over the
 * process lifetime. Safe to call for unknown/already-cleaned sessionIds.
 */
function cleanupSessionMaps(sessionId: string): void {
  pendingLegBAnswer.delete(sessionId);
  pendingStreamReady.delete(sessionId);
  clearReadinessTimer(sessionId);
  bridgedSessions.delete(sessionId);
  secondCallEngagedSessions.delete(sessionId);
  speakerphoneStrikes.delete(sessionId);
  speakerphoneWarnedSessions.delete(sessionId);
  speakerphoneWarningActiveAt.delete(sessionId);
  speakerphoneSupremeSessions.delete(sessionId);
  const ut = speakerphoneUnmuteTimers.get(sessionId);
  if (ut) clearTimeout(ut);
  speakerphoneUnmuteTimers.delete(sessionId);
  canarySilencedSessions.delete(sessionId);
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

/**
 * Live-bridge TwiML URL. The `leg` param tells the webhook which conference
 * ROLE to serve (corrected architecture): Leg B (the callee's live leg) is
 * the ANCHOR (startConferenceOnEnter: true — the conference exists the moment
 * the callee enters), the browser caller is the JOINER (false — it can never
 * spawn a duplicate same-name conference, the classic Twilio race that
 * strands both parties alone in silence; if the caller arrives first it
 * simply waits in the lobby for the anchor). Leg A is the Call Waiting
 * canary and NEVER joins the conference.
 */
export function bridgeUrl(sessionId: string, leg: "caller" | "legA" | "legB"): string {
  return `${twimlUrl("guarded-bridge", sessionId)}&leg=${leg}`;
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

/** Twilio → app: bridge conference lifecycle/participant status callback. */
export function conferenceStatusUrl(sessionId: string): string {
  return `${requirePublicBaseUrl()}/api/verify/conference?sid=${sessionId}`;
}

/** Leg A callee-IVR gather endpoints (CALL-FLOW.md Phase 2). */
export function gatherLegAAcceptUrl(sessionId: string, attempt: number): string {
  return `${requirePublicBaseUrl()}/api/verify/gather/leg-a-accept?sid=${sessionId}&a=${attempt}`;
}

export function gatherLegAReadyUrl(sessionId: string, attempt: number): string {
  return `${requirePublicBaseUrl()}/api/verify/gather/leg-a-ready?sid=${sessionId}&a=${attempt}`;
}

/** GUARDED MODE ONLY: voiceprint <Record> action — save-only voice-ID capture. */
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
    // GUARDED MODE ONLY: spoken after press-1, before the voiceprint <Record>
    // (save-only — the phrase is captured as call-review evidence, never
    // verified, so there are no retry/failure prompts).
    voiceId:
      e.VERIFY_PROMPT_VOICE_ID ??
      "Please identify your voice. After the beep, say: my voice identifies me.",
    // GUARDED MODE ONLY: spoken after the voice-ID recording; the SECOND
    // press-1 is the explicit trigger that originates Leg B. The callee is
    // pre-taught the call-waiting choreography: answering the second call
    // puts THIS call on hold on their handset, so they must know the second
    // call ends by itself (the engine hangs Leg B up at bridge time) and
    // returns them here.
    secondCall:
      e.VERIFY_PROMPT_SECOND_CALL ??
      "You will receive a second call. Please do not hang up this call. If you have any call on hold, please end that call. When you are ready, press 1.",
    // GUARDED MODE ONLY: the softphone caller hears this after the outbound
    // SDK call connects (parked in the conference while Leg A is verified).
    callerConnect:
      e.VERIFY_PROMPT_CALLER_CONNECT ??
      "Please wait while we connect your call.",
    ready:
      e.VERIFY_PROMPT_READY ??
      "You will receive a second call. Please do not hang up this call. If you have any call on hold, please end that call. When you are ready, press 1.",
    callerHold:
      e.VERIFY_PROMPT_CALLER_HOLD ??
      "Speakerphone is permitted, but please tell the person receiving your call to use a quiet room, keep the phone close, and remove all background voices and noise. Repeated speakerphone-like audio or excessive background noise may cause a warning or end the call.",
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
    // GUARDED MODE ONLY: played to the SURVIVING bridge party when the other
    // party hung up mid-call. Served via the post-<Dial> <Redirect> inside
    // the bridge TwiML itself — a REST redirect cannot reach a call inside an
    // active <Dial><Conference>.
    partnerEnded:
      e.VERIFY_PROMPT_PARTNER_ENDED ??
      "The other party has ended the call. Goodbye.",
    reject:
      e.VERIFY_PROMPT_REJECT ??
      "No response received. This verification call will now end. Goodbye.",
    mergeDetected:
      e.VERIFY_PROMPT_MERGE_DETECTED ??
      "We detected a potential speakerphone or merged call on this line. This call will now end. Goodbye.",
    // GUARDED MODE ONLY: played to every leg when a merge is detected MID-CALL
    // (BRIDGED) — the whole conference is torn down right after.
    conferenceEnding:
      e.VERIFY_PROMPT_CONFERENCE_ENDING ??
      "We've identified a conference call. This call is ending now.",
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

/**
 * SMS provider config. Two transports are supported:
 *   - "twilio"   — sends via the Twilio Messages API using the SAME account
 *                  already configured for voice (no extra vendor, inbound
 *                  replies arrive on the Twilio number's SMS webhook);
 *   - "crazytel" — the original Asterisk SmsService HTTP port (Bearer auth).
 * SMS_PROVIDER picks explicitly; otherwise it auto-selects "twilio" whenever
 * Twilio REST credentials are present, falling back to "crazytel".
 */
function smsCfg() {
  const e = process.env;
  const maxAttempts = Number.parseInt(e.SMS_MAX_ATTEMPTS ?? "3", 10);
  const timeoutMs = Number.parseInt(e.SMS_HTTP_TIMEOUT_MS ?? "6000", 10);
  const explicit = (e.SMS_PROVIDER ?? "").trim().toLowerCase();
  const provider: "twilio" | "crazytel" =
    explicit === "twilio" || explicit === "crazytel"
      ? explicit
      : e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN
        ? "twilio"
        : "crazytel";
  return {
    enabled: (e.SMS_ENABLED ?? "false") === "true",
    provider,
    token: e.SMS_API_TOKEN ?? "",
    // Twilio needs a real SMS-capable Twilio number (E.164). When SMS_FROM is
    // unset and the provider is twilio, fall back to the verified voice caller
    // ID — it is the one Twilio number we know the account owns.
    from: e.SMS_FROM ?? (provider === "twilio" ? (e.TWILIO_CALLER_ID ?? "") : "CallVerify"),
    baseUrl: e.SMS_BASE_URL ?? "https://sms.crazytel.net.au/api/v1/sms/send",
    /** Delivery attempts incl. the first (transient 5xx/timeouts are retried). */
    maxAttempts: Number.isFinite(maxAttempts) && maxAttempts >= 1 ? Math.min(maxAttempts, 5) : 3,
    /** Per-attempt HTTP timeout. */
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1000 ? timeoutMs : 6000,
    messageConfirmed:
      e.SMS_MESSAGE_CONFIRMED ??
      "Your call waiting is off. Please turn it on to receive calls. If you need assistance I am AI SMS — just tell me your phone model and I can walk you through the settings to turn it on.",
    messageHangup:
      e.SMS_MESSAGE_HANGUP ??
      "How was your call? If your call didn't go through and you heard a weird sound it means your call waiting is off. Please turn call waiting on. If you need assistance I am AI SMS — I can help.",
    /**
     * SMART UPGRADE (beyond the Asterisk version): repeat-offender template.
     * When this callee has already failed call-waiting verification before,
     * the follow-up SMS is more direct and includes the universal GSM code.
     */
    messageRepeat:
      e.SMS_MESSAGE_REPEAT ??
      "Calls to your phone are still failing because call waiting is OFF — this has happened more than once. Fastest fix: open your Phone app, dial *43# and press call to switch call waiting ON. Reply with your phone model (e.g. iPhone 13, Samsung S23) and AI SMS will walk you through it step by step.",
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
      // Call-review recordings (guarded voice-ID clip + bridge conference
      // recording) — written by storeVoiceRecording/storeBridgeRecording and
      // previously dropped here, so call review never had playable audio.
      voiceRecordingUrl: session.voiceRecordingUrl,
      voiceRecordingDurationSec: session.voiceRecordingDurationSec,
      voiceRecordedAt: session.voiceRecordedAt,
      // Save-only voice-ID capture stamp (markVoiceIdCaptured) — same-UTC-day
      // validity is derived at read time via voiceIdFreshForToday.
      voiceIdCapturedAt: session.voiceIdCapturedAt,
      voiceIdRecordingSid: session.voiceIdRecordingSid,
      bridgeRecordingSid: session.bridgeRecordingSid,
      bridgeRecordingUrl: session.bridgeRecordingUrl,
      bridgeRecordingDurationSec: session.bridgeRecordingDurationSec,
      bridgeRecordedAt: session.bridgeRecordedAt,
      // Two-phase challenge readiness/phase (restart-safe persistence).
      streamSid: session.streamSid,
      streamReadyAt: session.streamReadyAt,
      streamReadyBy: session.streamReadyBy,
      challengeStartedAt: session.challengeStartedAt,
      promptLightDurationMs: session.promptLightDurationMs,
      promptEndsAt: session.promptEndsAt,
      detectionPhase: session.detectionPhase,
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
    // Arm the merge relay for Leg B's inbound-only detection stream. The arm
    // call is authenticated (x-verify-secret), retried once, and a failure is
    // OBSERVABLE (RELAY_ARM_FAILED event) — it prevents silent success because
    // the readiness deadline (streamReadyBy, set at Leg B answer) turns a
    // missing stream-ready into DETECTION_FAILED.
    if (leg === "legB") {
      await armRelay(session, call.sid);
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

/* -------------------------------------------------------------------------- */
/* Relay control channel (cloudtalk → relay): /arm + /challenge-start           */
/* -------------------------------------------------------------------------- */

/**
 * POST the relay /arm contract:
 *   { sid, legA, legB, mode: "merge-detection",
 *     tone: { low: 852, high: 1336 }, promptLightDurationMs, promptEndsAt }
 * promptEndsAt is null at arm time — the challenge only starts after the
 * relay's stream-ready callback, at which point /challenge-start carries the
 * exact timestamps. One retry on transient failure; a non-2xx/timeout final
 * result logs RELAY_ARM_FAILED (observable) and the readiness deadline still
 * guarantees no silent success.
 */
async function armRelay(
  session: VerificationSession,
  legBCallSid: string,
): Promise<boolean> {
  const { relayArmUrl, postRelayJson } = await import("./verification-stream");
  const url = relayArmUrl();
  if (!url) return false; // relay not configured — Leg B TwiML path fails closed
  const body = {
    sid: session.sessionId,
    legA: session.legACallSid ?? "",
    legB: legBCallSid,
    mode: "merge-detection",
    // Existing merge-tone pair = DTMF-8 (852 Hz row + 1336 Hz column).
    tone: { low: 852, high: 1336 },
    promptLightDurationMs: PROMPT_LIGHT_DURATION_MS,
    promptEndsAt: null,
  };
  const r = await postRelayJson(url, body, { attempts: 2 });
  if (!r.ok) {
    console.error(
      `[verify] RELAY_ARM_FAILED session=${session.sessionId} status=${r.status ?? "n/a"} err=${r.error ?? ""}`,
    );
    await logEvent(
      session.sessionId,
      "RELAY_ARM_FAILED",
      `status=${r.status ?? "n/a"} ${r.error ?? ""} — readiness deadline will fail the detection if the stream never becomes ready`.slice(0, 512),
    ).catch(() => {});
  }
  return r.ok;
}

/**
 * POST the relay /challenge-start contract after stream-ready:
 *   { sid, challengeStartedAt, promptLightDurationMs, promptEndsAt,
 *     transitionToleranceMs }
 * Timestamp fields are EPOCH MILLISECONDS (numbers), matching the relay's
 * persisted-state schema — NOT ISO strings. The relay persists this and
 * reconstructs the phase after restart. Bounded retries with backoff; a final
 * failure is a callback failure after retry → the caller turns it into
 * DETECTION_FAILED (never a pass).
 */
async function sendChallengeStart(
  session: VerificationSession,
): Promise<boolean> {
  const { relayChallengeStartUrl, postRelayJson } = await import(
    "./verification-stream"
  );
  const url = relayChallengeStartUrl();
  if (!url) return false;
  const body = {
    sid: session.sessionId,
    challengeStartedAt: session.challengeStartedAt
      ? new Date(session.challengeStartedAt).getTime()
      : null,
    promptLightDurationMs: session.promptLightDurationMs,
    promptEndsAt: session.promptEndsAt
      ? new Date(session.promptEndsAt).getTime()
      : null,
    transitionToleranceMs: transitionToleranceMs(),
  };
  const r = await postRelayJson(url, body, { attempts: 3 });
  if (!r.ok) {
    console.error(
      `[verify] CHALLENGE_START_FAILED session=${session.sessionId} status=${r.status ?? "n/a"} err=${r.error ?? ""}`,
    );
    await logEvent(
      session.sessionId,
      "CHALLENGE_START_FAILED",
      `relay /challenge-start failed after retries: status=${r.status ?? "n/a"} ${r.error ?? ""}`.slice(0, 512),
    ).catch(() => {});
  }
  return r.ok;
}

/* -------------------------------------------------------------------------- */
/* Stream readiness watchdog (restart-safe: deadline persisted on the session)  */
/* -------------------------------------------------------------------------- */

/** In-process readiness timers (the DB deadline is the restart-safe truth). */
const readinessTimers = new Map<string, NodeJS.Timeout>();

function clearReadinessTimer(sessionId: string): void {
  const t = readinessTimers.get(sessionId);
  if (t) clearTimeout(t);
  readinessTimers.delete(sessionId);
}

function scheduleReadinessWatchdog(sessionId: string): void {
  clearReadinessTimer(sessionId);
  const t = setTimeout(() => {
    void checkStreamReadiness(sessionId).catch((err) =>
      console.error("[verify] readiness watchdog error:", err),
    );
  }, streamReadyTimeoutMs() + 500);
  t.unref?.();
  readinessTimers.set(sessionId, t);
}

/**
 * Readiness gate: if the relay's stream-ready has NOT arrived by the persisted
 * streamReadyBy deadline the session is DETECTION_FAILED (missing readiness) —
 * never a silent pass. Called by the in-process timer AND by the Leg A hold
 * poll (fallback for runtimes without guaranteed background timers / after a
 * restart). No-op once streamReadyAt is set or the session is terminal.
 */
export async function checkStreamReadiness(sessionId: string): Promise<void> {
  const session = await findSession(sessionId);
  if (!session || isTerminal(session)) return;
  if (session.streamReadyAt) return; // ready — nothing to enforce
  if (!session.streamReadyBy) return; // detection not armed (pre-Leg B answer)
  if (Date.now() < new Date(session.streamReadyBy).getTime()) return;
  await onStreamFailed(
    sessionId,
    "DETECTION_FAILED",
    `stream-ready not received within ${streamReadyTimeoutMs()}ms of Leg B answer (missing readiness)`,
  );
}

/* -------------------------------------------------------------------------- */
/* Call Waiting engagement state (Leg A hold observation — drives NO audio)    */
/* -------------------------------------------------------------------------- */

/**
 * The HoldDetector on Leg A's uplink observes the callee putting Leg A on
 * hold to answer Leg B — the ordinary Call Waiting choreography. This is
 * PURE STATE: it drives no audio, no announcement, no timer, no redirect.
 *
 * The legacy reverse-detection path that used to live here — an ARMED
 * merge-tone beep announced into the Leg B conference participant every 2s
 * (announceMergeTone/armMergeTone/disarmMergeTone, the 404-disarm counter,
 * the engagement-deferral timers and the isMergeToneEffective() suppression
 * of the speakerphone strike ladder) — was REMOVED on 2026-09-05. It
 * duplicated the authorised Leg A→Leg B detector (the merge relay listening
 * on Leg B's inbound stream for Leg A's own prompt/watermark/loud tone
 * crossing over after a physical merge), interrupted the live conversation
 * with beeps, could be triggered by ordinary Call Waiting behaviour, and
 * masked speakerphone strikes. Leg B must remain clean: no code path may
 * deliberately play a detection tone into Leg B.
 */

/**
 * Sessions with an ACTIVE HoldDetector second-call engagement — "Leg A
 * legitimately held through Call Waiting", one of the explicitly separated
 * call states. Set by onSecondCallEngaged(), cleared by
 * onSecondCallDisengaged() and by cleanupSessionMaps() on terminal states.
 */
const secondCallEngagedSessions = new Set<string>();

/** True while a HoldDetector second-call engagement is active. */
export function isSecondCallEngaged(sessionId: string): boolean {
  return secondCallEngagedSessions.has(sessionId);
}

/**
 * HoldDetector callback: the callee put Leg A on hold and engaged a second
 * call (normal Call Waiting). State + telemetry ONLY — no tone is armed, no
 * announcement is made, nothing is played into any leg. A genuine mid-call
 * merge is caught by the authorised merge-relay detector (Leg A audio
 * crossing into Leg B), never by injecting audio into Leg B.
 */
export async function onSecondCallEngaged(sessionId: string): Promise<void> {
  try {
    const session = await findSession(sessionId);
    if (!session || session.state !== VState.BRIDGED) return;
    if (secondCallEngagedSessions.has(sessionId)) return; // idempotent
    secondCallEngagedSessions.add(sessionId);
    console.log(`[verify] SECOND_CALL_ENGAGED session=${sessionId} — Leg A held via Call Waiting (state only, no audio)`);
    await logEvent(
      sessionId,
      "SECOND_CALL_ENGAGED",
      "hold signature on Leg A uplink (sustained non-speech/hold tone after live speech) — Leg A legitimately held through Call Waiting; merge supervision continues via the authorised Leg A→Leg B relay detector",
    );
  } catch (err) {
    console.error(`[verify] onSecondCallEngaged failed session=${sessionId}:`, err);
  }
}

/**
 * HoldDetector callback: speech resumed on Leg A's uplink (the callee came
 * back, or dropped the other call WITHOUT merging). Clears the engagement
 * state. Never drives audio.
 */
export async function onSecondCallDisengaged(sessionId: string): Promise<void> {
  try {
    const session = await findSession(sessionId);
    if (!session || isTerminal(session)) return;
    if (!secondCallEngagedSessions.delete(sessionId)) return; // not engaged
    console.log(`[verify] SECOND_CALL_DISENGAGED session=${sessionId}`);
    await logEvent(
      sessionId,
      "SECOND_CALL_DISENGAGED",
      "speech resumed on Leg A uplink ≥1s — Call Waiting hold released (no merge detected)",
    );
  } catch (err) {
    console.error(`[verify] onSecondCallDisengaged failed session=${sessionId}:`, err);
  }
}

/**
 * AMI RedirectAction equivalent — point a live call at new TwiML.
 * Returns true on success; on failure the error is logged AND recorded as a
 * REDIRECT_FAILED verification event so a failed redirect is always
 * observable on the session timeline (no silent success). State transitions
 * that depend on the redirect MUST check the return value.
 */
async function redirectCall(
  callSid: string | null,
  twimlKind: string,
  sessionId: string,
  bridgeLeg?: "caller" | "legA" | "legB",
): Promise<boolean> {
  if (!callSid) return false;
  try {
    // Bridge redirects carry the leg role so the webhook serves the right
    // conference attributes (anchor vs joiner — see bridgeUrl).
    const url =
      twimlKind === "guarded-bridge" && bridgeLeg
        ? bridgeUrl(sessionId, bridgeLeg)
        : twimlUrl(twimlKind, sessionId);
    await getTwilioClient()
      .calls(callSid)
      .update({ url, method: "POST" });
    console.log(`[verify] REDIRECT sid=${callSid} kind=${twimlKind}${bridgeLeg ? ` leg=${bridgeLeg}` : ""}`);
    return true;
  } catch (err) {
    console.error(`[verify] REDIRECT_FAILED sid=${callSid} kind=${twimlKind}`, err);
    await logEvent(
      sessionId,
      "REDIRECT_FAILED",
      `sid=${callSid} kind=${twimlKind}${bridgeLeg ? ` leg=${bridgeLeg}` : ""} err=${err instanceof Error ? err.message : String(err)}`.slice(0, 512),
    ).catch(() => {});
    return false;
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

  // Render free-tier cold start: the merge relay sleeps after 15 min idle and
  // its first request takes ~22s. Ping /health NOW (best-effort, never
  // blocks or fails the call) so the relay is warm by the time Leg B is
  // originated and the stream-readiness deadline starts.
  void import("./verification-stream")
    .then((m) => m.wakeRelay())
    .catch(() => {});

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
    // Re-wake the merge relay (CALLER_HOLDING, right before Leg A): a guarded
    // session may sit through voice-ID long enough for Render to sleep again.
    // Best-effort — never blocks or fails the call.
    void import("./verification-stream")
      .then((m) => m.wakeRelay())
      .catch(() => {});
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
 * Second press-1 ("ready"). Guarded sessions originate Leg B HERE — after the
 * save-only voice-ID recording, never automatically from the recording
 * callback. Non-guarded Leg B may already be airborne from the legacy
 * pre-origination path; in that case this confirms and drains the buffered
 * answer without a duplicate call.
 *
 * SAVE-ONLY VOICE ID: there is NO voice-ID verdict gate. The voice-ID phrase
 * is captured as call-review evidence only (stamped via markVoiceIdCaptured);
 * the second press-1 always proceeds to Leg B origination.
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

/**
 * Leg B answered → LEG_B_ANSWERED. Corrected architecture:
 *  - Leg B is the LIVE call: its TwiML opened the non-blocking inbound-only
 *    <Start><Stream> (mode=merge-detection) and continues straight into
 *    <Dial><Conference> with the browser caller.
 *  - The readiness deadline (streamReadyBy, persisted) is armed HERE: if the
 *    relay's stream-ready callback does not arrive in time the session is
 *    DETECTION_FAILED — an unmonitored live call is never a pass.
 *  - Leg A (the canary) does NOT get the challenge tone yet: Phase 1 starts
 *    only after stream-ready (see onStreamReady).
 */
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
  // drains it the moment the FSM reaches LEG_B_DIALING, so the challenge on
  // Leg A still only starts after the callee has accepted.
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
    // Arm the stream-readiness deadline (persisted — restart-safe). Without a
    // configured relay there is no detection path at all (the record-chunk
    // fallback was removed): guarded sessions fail closed immediately, and
    // non-guarded sessions arm the deadline anyway so a missing stream-ready
    // becomes DETECTION_FAILED rather than a silent pass.
    const { relayConfigured } = await import("./verification-stream");
    if (session.guarded && !relayConfigured()) {
      await save(session);
      await onStreamFailed(
        sessionId,
        "DETECTION_FAILED",
        "merge relay not configured (VERIFY_STREAM_URL) — cannot monitor the live call",
      );
      return;
    }
    session.streamReadyBy = new Date(Date.now() + streamReadyTimeoutMs());
    session.detectionPhase = DetectionPhase.AWAITING_STREAM_READY;
    await save(session);
    scheduleReadinessWatchdog(sessionId);
    await logEvent(
      sessionId,
      "STREAM_READINESS_ARMED",
      `deadline=${session.streamReadyBy.toISOString()} — missing stream-ready is DETECTION_FAILED, never a pass`,
    );

    // GUARDED MODE ONLY: bridge the browser caller into the live conference
    // with Leg B immediately (Leg B's TwiML dials the conference itself as
    // the anchor). There is no watch-window pass anymore: the call is live
    // from this point and the two-phase canary challenge + relay detection
    // supervise it; any detection-pipeline failure tears it down as
    // DETECTION_FAILED / DETECTION_INCONCLUSIVE.
    if (session.guarded) {
      await bridgeGuardedLive(session);
    }

    // Drain a stream-ready that raced ahead of the answered status callback
    // (the relay's stream opens the instant Leg B connects): the Leg A
    // challenge starts NOW against the buffered readiness — no readiness
    // signal is lost to ordering.
    const early = pendingStreamReady.get(sessionId);
    if (early) {
      pendingStreamReady.delete(sessionId);
      await logEvent(
        sessionId,
        "STREAM_READY_EARLY_DRAINED",
        `streamSid=${early.streamSid} — Leg B answer caught up, starting the challenge`,
      );
      await onStreamReady(sessionId, early.streamSid, early.readyAt);
    }
  }
}

/**
 * GUARDED MODE ONLY: move LEG_B_ANSWERED → BRIDGED and redirect the parked
 * browser caller into the live conference (JOINER; Leg B is the anchor and
 * enters from its own TwiML). Registry clearing happens BEFORE the redirect
 * so a fast participant-join callback can never be erased by a later delete.
 * The join watchdog then PROVES both parties joined (conference status
 * callbacks); a failed redirect is observable (REDIRECT_FAILED event) and
 * re-issued by the watchdog — no silent success.
 */
async function bridgeGuardedLive(session: VerificationSession): Promise<void> {
  const sessionId = session.sessionId;
  if (
    await transition(
      session,
      VState.BRIDGED,
      "Leg B answered — browser caller + callee bridged live (two-phase canary challenge supervises)",
    )
  ) {
    // D2: flip the event-driven registry flag SYNCHRONOUSLY with the bridge
    // so the media-stream analyzer path (Leg A uplink forensics) starts the
    // warm-up on the next audio window — not on the next DB refresh poll.
    bridgedSessions.add(sessionId);
    await logEvent(
      sessionId,
      "GUARDED_BRIDGED",
      `caller=${session.callerCallSid ?? "(none)"} legB=${session.legBCallSid ?? "(none)"} — two-way live conference ${conferenceName(sessionId)}; Leg A canary stream persists`,
    );
    await hangupAll(session, { ringTest: true });
    // ORDER MATTERS: clear the join registry BEFORE issuing the redirect so
    // participant-join callbacks that land immediately after the redirect are
    // never erased (the old ordering cleared the registry AFTER the redirects
    // and could silently drop a recorded join).
    bridgeJoinRegistry.delete(sessionId);
    const redirected = await redirectCall(
      session.callerCallSid,
      "guarded-bridge",
      sessionId,
      "caller",
    );
    if (!redirected && session.callerCallSid) {
      // Observable: the caller is still parked in caller-wait; its self-heal
      // poll joins the conference on the next fetch, and the join watchdog
      // re-issues this redirect.
      await logEvent(
        sessionId,
        "BRIDGE_CALLER_REDIRECT_FAILED",
        `caller=${session.callerCallSid} — caller-wait self-heal + join watchdog will recover`,
      );
    }
    scheduleBridgeWatchdog(sessionId);
  }
}

/* -------------------------------------------------------------------------- */
/* Bridge supervisor — join watchdog + callee drop auto-recall                  */
/* -------------------------------------------------------------------------- */

/**
 * Live record of which CallSids have JOINED the bridge conference, fed by the
 * /api/verify/conference status callback (participant-join events). Used by
 * the join watchdog to prove both parties actually made it into the room —
 * a REST redirect that silently failed leaves that leg parked in silence,
 * which presents exactly as "I can't hear the other person".
 */
const bridgeJoinRegistry = new Map<string, Set<string>>();

/** Sessions that already used their one automatic callee recall. */
const bridgeRecallUsed = new Set<string>();

/** Called by the conference status webhook on participant-join. */
export function noteConferenceJoin(sessionId: string, callSid: string): void {
  let set = bridgeJoinRegistry.get(sessionId);
  if (!set) {
    set = new Set();
    bridgeJoinRegistry.set(sessionId, set);
  }
  set.add(callSid);
}

/** Called by the conference status webhook on participant-leave. */
export function noteConferenceLeave(sessionId: string, callSid: string): void {
  bridgeJoinRegistry.get(sessionId)?.delete(callSid);
}

/** Watchdog delay after bridging before checking both legs joined (env-overridable for tests). */
export function bridgeWatchdogMs(): number {
  const v = Number.parseInt(process.env.VERIFY_BRIDGE_WATCHDOG_MS ?? "20000", 10);
  return Number.isFinite(v) && v >= 0 ? v : 20_000;
}

/** Auto-recall of a dropped callee mid-bridge (env VERIFY_BRIDGE_RECALL, default on). */
export function bridgeRecallEnabled(): boolean {
  return (process.env.VERIFY_BRIDGE_RECALL ?? "true") === "true";
}

/**
 * 20s (default) after the bridge, both parties must have JOINED the
 * conference. A leg that never joined was never heard by the other party —
 * the systematic "I can't hear the inmate" failure. Recovery: re-issue the
 * REST redirect into the bridge (harmless if the leg is already inside), and
 * log loudly so the dashboard timeline shows it.
 */
async function bridgeJoinWatchdog(sessionId: string): Promise<void> {
  try {
    const session = await findSession(sessionId);
    if (!session || session.state !== VState.BRIDGED) {
      bridgeJoinRegistry.delete(sessionId);
      return;
    }
    const joined = bridgeJoinRegistry.get(sessionId) ?? new Set<string>();
    // The live bridge parties are the browser caller and the callee's LIVE
    // leg (Leg B). Leg A is the canary — it NEVER joins the conference.
    const expected: Array<["caller" | "legB", string | null]> = [
      ["caller", session.callerCallSid],
      ["legB", session.legBCallSid],
    ];
    for (const [leg, callSid] of expected) {
      if (callSid && !joined.has(callSid)) {
        console.warn(`[verify] BRIDGE_JOIN_MISSING session=${sessionId} leg=${leg} — re-issuing bridge redirect`);
        await logEvent(
          sessionId,
          "BRIDGE_JOIN_MISSING",
          `leg=${leg} sid=${callSid} never joined the conference — re-issuing guarded-bridge redirect`,
        );
        await redirectCall(callSid, "guarded-bridge", sessionId, leg);
      }
    }
  } catch (err) {
    console.error(`[verify] bridgeJoinWatchdog failed session=${sessionId}:`, err);
  }
}

function scheduleBridgeWatchdog(sessionId: string): void {
  const t = setTimeout(() => {
    void bridgeJoinWatchdog(sessionId);
  }, bridgeWatchdogMs());
  t.unref?.();
}

/**
 * Callee drop auto-recovery (the "the first call ended without me ending"
 * fix): the callee's bridged leg ended mid-conversation while the caller is
 * still live. Verification already PASSED, so we don't re-verify — we dial
 * the callee back once, straight into the live conference (bridge-recall
 * TwiML), tell the caller we're reconnecting (conference announce), and keep
 * the session BRIDGED. A second drop ends the call normally (no recall loop).
 */
async function recallCalleeIntoBridge(
  session: VerificationSession,
  droppedCallSid: string,
  statusDetail: string,
): Promise<boolean> {
  if (!bridgeRecallEnabled()) return false;
  if (!session.guarded || !session.callerCallSid) return false;
  if (bridgeRecallUsed.has(session.sessionId)) return false;
  bridgeRecallUsed.add(session.sessionId);

  await logEvent(
    session.sessionId,
    "BRIDGE_RECALL",
    `callee leg ended mid-call (sid=${droppedCallSid} ${statusDetail}) — re-dialling callee directly into the live conference`.slice(0, 512),
  );

  // Tell the caller (still in the conference) that we're reconnecting —
  // announce plays to the CALLER participant only.
  try {
    const confSid = await liveConferenceSid(session.sessionId);
    if (confSid) {
      await getTwilioClient()
        .conferences(confSid)
        .participants(session.callerCallSid)
        .update({
          announceUrl: twimlUrl("notify-reconnecting", session.sessionId),
          announceMethod: "POST",
        });
    }
  } catch (err) {
    console.warn(`[verify] BRIDGE_RECALL announce failed session=${session.sessionId}:`, err);
  }

  try {
    const call = await getTwilioClient().calls.create({
      to: session.calleeNumber,
      from: twilioCallerId(),
      url: twimlUrl("bridge-recall", session.sessionId),
      method: "POST",
      statusCallback: statusUrl("legB", session.sessionId),
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["completed"],
      timeout: 30,
    });
    // The recall call is the callee's NEW live leg (Leg B role): its TwiML
    // re-opens the inbound detection stream and re-joins the conference as
    // anchor. The readiness deadline is re-armed — a recall that never
    // re-establishes monitoring is DETECTION_FAILED, not a silent pass.
    // streamReadyAt is reset so readiness is RE-GATED on the new stream; the
    // OLD streamSid is deliberately KEPT on the session so onStreamReady can
    // reject a late stream-ready from the dead stream (stale-sid guard) and
    // only a ready with a NEW stream sid restarts the challenge.
    session.legBCallSid = call.sid;
    session.streamReadyAt = null;
    session.streamReadyBy = new Date(Date.now() + streamReadyTimeoutMs());
    session.detectionPhase = DetectionPhase.AWAITING_STREAM_READY;
    await save(session);
    scheduleReadinessWatchdog(session.sessionId);
    await armRelay(session, call.sid);
    await logEvent(
      session.sessionId,
      "BRIDGE_RECALL_DIALED",
      `newLegB=${call.sid} to=${session.calleeNumber} — session stays BRIDGED, readiness re-armed`,
    );
    scheduleBridgeWatchdog(session.sessionId);
    return true;
  } catch (err) {
    console.error(`[verify] BRIDGE_RECALL originate failed session=${session.sessionId}:`, err);
    await logEvent(
      session.sessionId,
      "BRIDGE_RECALL_FAILED",
      err instanceof Error ? err.message : String(err),
    );
    return false; // fall through to the normal call-ended path
  }
}

/**
 * Merge detected. PRE-BRIDGE: Leg A's DTMF tones leaked into Leg B's Gather
 * (or the relay/record-chunk path fired) — caller + Leg A hear `notify-merge`.
 * IN-CALL (opts.inCall or the session is already BRIDGED): every leg hears
 * `notify-conference-merge` and the live conference is completed outright —
 * a REST redirect cannot pull a call out of an active <Dial><Conference>,
 * so ending the conference by SID is the belt-and-braces guarantee that BOTH
 * bridge legs drop. Idempotent via the terminal-state guard + transition.
 */
export async function onMergeDetected(
  sessionId: string,
  opts: { inCall?: boolean } = {},
): Promise<void> {
  const session = await findSession(sessionId);
  if (!session || isTerminal(session)) return;
  const inCall = opts.inCall === true || session.state === VState.BRIDGED;

  if (
    await transition(
      session,
      VState.MERGE_DETECTED,
      inCall
        ? "In-call merge detected (BRIDGED) — conference torn down"
        : "DTMF tone leak — callee merged calls",
    )
  ) {
    session.toneDetected = true;
    session.toneDetectedAt = new Date();
    session.completedAt = new Date();
    await save(session);

    if (inCall) {
      // All terminations in parallel — speed matters (merge must die
      // instantly). Caller, Leg A AND Leg B (if present) all hear the
      // conference-ending announcement whose TwiML then hangs them up.
      await Promise.allSettled([
        redirectCall(session.callerCallSid, "notify-conference-merge", sessionId),
        redirectCall(session.legACallSid, "notify-conference-merge", sessionId),
        session.legBCallSid
          ? redirectCall(session.legBCallSid, "notify-conference-merge", sessionId)
          : Promise.resolve(),
        hangupCall(session.ringTestCallSid),
      ]);
      // Belt-and-braces: completing the conference by SID drops BOTH bridge
      // participants even if a redirect raced a leg that was still inside
      // <Dial><Conference>. 404/already-completed errors are ignored.
      const confSid = await liveConferenceSid(sessionId);
      if (confSid) {
        try {
          await getTwilioClient()
            .conferences(confSid)
            .update({ status: "completed" });
          console.log(
            `[verify] CONFERENCE_COMPLETED session=${sessionId} conf=${confSid}`,
          );
        } catch (err) {
          console.warn(
            `[verify] conference complete failed session=${sessionId} conf=${confSid}:`,
            (err as Error).message,
          );
        }
      }
      return;
    }

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

/* -------------------------------------------------------------------------- */
/* Relay callbacks — stream-ready / stream-detected / stream-failed             */
/* -------------------------------------------------------------------------- */

/**
 * Relay → cloudtalk `stream-ready`: the Leg B inbound stream is live and the
 * detector is armed. ONLY NOW does the Leg A two-phase challenge start:
 *  1. redirect the Leg A canary to the challenge TwiML (Phase 1 prompt-light,
 *     then the loud tone loop) — if the redirect fails the callback reports
 *    failure so the relay retries (no silent success);
 *  2. persist challengeStartedAt / promptLightDurationMs / promptEndsAt and
 *     detectionPhase=PROMPT_LIGHT (restart-safe);
 *  3. post /challenge-start to the relay (bounded retries); a callback
 *     failure after retry is DETECTION_FAILED, never a pass.
 * Idempotency / ordering rules:
 *  - a duplicate stream-ready for the stream ALREADY marked ready is a 200
 *    no-op (relay restart / callback retry);
 *  - EARLY stream-ready (FSM has not reached LEG_B_ANSWERED yet — the relay
 *    can beat Twilio's answered status callback) is buffered, never rejected,
 *    and drained by onLegBAnswered();
 *  - after a bridge-recall re-arm (streamReadyAt reset, old streamSid kept), a
 *    stream-ready naming the PREVIOUS stream's sid is stale and rejected, and
 *    only a ready for the NEW stream sid re-gates readiness and restarts the
 *    challenge — Leg A can never start against a stale/dead stream.
 */
export async function onStreamReady(
  sessionId: string,
  streamSid: string,
  readyAt?: string,
): Promise<{ ok: boolean; reason: string }> {
  const session = await findSession(sessionId);
  if (!session) return { ok: false, reason: "unknown session" };
  if (isTerminal(session)) return { ok: true, reason: "session already terminal (idempotent)" };

  if (session.streamReadyAt) {
    // Idempotent retry (relay restart / callback retry) for the stream we
    // already acknowledged — never restart the challenge for it.
    if (!streamSid || !session.streamSid || session.streamSid === streamSid) {
      return { ok: true, reason: "stream already ready (idempotent)" };
    }
    // A ready naming a DIFFERENT stream while ours is live is the previous
    // attempt's late callback — ignore it (200 so the relay does not burn its
    // bounded retries on a deliberately dropped signal).
    console.warn(
      `[verify] STREAM_READY_STALE session=${sessionId} streamSid=${streamSid} current=${session.streamSid} — already ready, ignoring`,
    );
    return { ok: true, reason: "stale stream-ready ignored (current stream already ready)" };
  }

  // streamReadyAt is null: either the first arm, or a bridge-recall re-arm
  // awaiting the NEW leg's stream (the recall keeps the old streamSid on the
  // session precisely so this guard can fire). A ready naming the PREVIOUS
  // attempt's stream sid is stale — reject it so Leg A can never (re)start
  // its challenge against a dead stream.
  if (
    session.challengeStartedAt &&
    session.streamSid &&
    streamSid &&
    session.streamSid === streamSid
  ) {
    console.warn(
      `[verify] STREAM_READY_SUPERSEDED session=${sessionId} streamSid=${streamSid} — readiness re-armed for a new leg; stale ready rejected`,
    );
    await logEvent(
      sessionId,
      "STREAM_READY_SUPERSEDED",
      `streamSid=${streamSid} arrived after readiness was re-armed — ignored; awaiting the new stream`,
    );
    return { ok: false, reason: "stale stream-ready for a superseded stream" };
  }

  if (session.state !== VState.LEG_B_ANSWERED && session.state !== VState.BRIDGED) {
    // EARLY READY: the stream opened before the answered status callback drove
    // the FSM to LEG_B_ANSWERED. Buffer the readiness — never reject — and
    // drain it from onLegBAnswered so no readiness signal is lost.
    pendingStreamReady.set(sessionId, { streamSid, readyAt });
    console.log(
      `[verify] STREAM_READY_EARLY session=${sessionId} state=${session.state} streamSid=${streamSid} — buffered until Leg B answer`,
    );
    await logEvent(
      sessionId,
      "STREAM_READY_EARLY",
      `state=${session.state} streamSid=${streamSid} — readiness buffered; challenge starts at Leg B answer`,
    );
    return { ok: true, reason: "readiness buffered — awaiting Leg B answer" };
  }

  // readyAt may be ISO-8601 OR epoch-ms (number / numeric string) — the relay
  // persists epoch-ms internally.
  const readyIsoMs = readyAt ? Date.parse(readyAt) : Number.NaN;
  const readyEpochMs =
    readyAt && /^\d{10,}$/.test(readyAt.trim()) ? Number(readyAt.trim()) : Number.NaN;
  const startedAt = Number.isFinite(readyIsoMs)
    ? new Date(readyIsoMs)
    : Number.isFinite(readyEpochMs)
      ? new Date(readyEpochMs)
      : new Date();
  const promptEndsAt = new Date(startedAt.getTime() + PROMPT_LIGHT_DURATION_MS);

  // 1) Start the canary challenge on Leg A. The redirect MUST succeed before
  //    we record the challenge as started — otherwise the relay would count
  //    Phase 1 against a prompt that was never played. A SILENCED canary (a
  //    speakerphone episode already owned this session) is never restarted —
  //    the relay restart just re-gates readiness without the tone.
  if (session.legACallSid && !canarySilencedSessions.has(sessionId)) {
    const ok = await redirectCall(session.legACallSid, "leg-a-challenge", sessionId);
    if (!ok) {
      await logEvent(
        sessionId,
        "CHALLENGE_REDIRECT_FAILED",
        `legA=${session.legACallSid} — challenge NOT started; relay will retry stream-ready`,
      );
      return { ok: false, reason: "leg A challenge redirect failed" };
    }
  }

  // 2) Persist the challenge timeline (restart-safe) + phase.
  session.streamSid = streamSid || session.streamSid;
  session.streamReadyAt = new Date();
  session.challengeStartedAt = startedAt;
  session.promptLightDurationMs = PROMPT_LIGHT_DURATION_MS;
  session.promptEndsAt = promptEndsAt;
  session.detectionPhase = DetectionPhase.PROMPT_LIGHT;
  await save(session);
  clearReadinessTimer(sessionId);
  await logEvent(
    sessionId,
    "CHALLENGE_STARTED",
    `streamSid=${streamSid} challengeStartedAt=${startedAt.toISOString()} promptLightDurationMs=${PROMPT_LIGHT_DURATION_MS} promptEndsAt=${promptEndsAt.toISOString()} phase=${DetectionPhase.PROMPT_LIGHT}`,
  );

  // 3) Tell the relay the exact challenge window (persisted relay-side; the
  //    relay reconstructs the phase after restart). Callback failure after
  //    retry → DETECTION_FAILED (never a pass).
  const delivered = await sendChallengeStart(session);
  if (!delivered) {
    await onStreamFailed(
      sessionId,
      "DETECTION_FAILED",
      "relay /challenge-start callback failed after retries",
    );
    return { ok: false, reason: "challenge-start delivery failed" };
  }
  return { ok: true, reason: "challenge started" };
}

/**
 * Relay → cloudtalk `stream-failed` (or an internal readiness/canary-loss
 * detection): the merge-detection pipeline cannot vouch for this call.
 * Transitions to DETECTION_FAILED / DETECTION_INCONCLUSIVE — NEVER a pass —
 * and tears the call down exactly once (end Leg A canary, complete the
 * conference so both live parties drop, terminal state persisted).
 */
export async function onStreamFailed(
  sessionId: string,
  verdict: "DETECTION_FAILED" | "DETECTION_INCONCLUSIVE",
  reason: string,
): Promise<void> {
  const session = await findSession(sessionId);
  if (!session || isTerminal(session)) return;
  const target =
    verdict === "DETECTION_INCONCLUSIVE"
      ? VState.DETECTION_INCONCLUSIVE
      : VState.DETECTION_FAILED;

  if (await transition(session, target, `merge detection cannot verify this call — ${reason}`.slice(0, 400))) {
    session.completedAt = new Date();
    session.failureReason = `Detection ${verdict === "DETECTION_INCONCLUSIVE" ? "inconclusive" : "failed"}: ${reason}`.slice(0, 512);
    await save(session);
    await logEvent(sessionId, verdict, reason.slice(0, 512));

    // Full teardown: canary (Leg A), both live parties, conference room.
    // REST status=completed pulls a leg out of <Dial><Conference>; completing
    // the conference by SID is the belt-and-braces guarantee (same convention
    // as the in-call merge verdict).
    await hangupAll(session, { caller: true, legA: true, legB: true, ringTest: true });
    const confSid = await liveConferenceSid(sessionId);
    if (confSid) {
      try {
        await getTwilioClient().conferences(confSid).update({ status: "completed" });
        console.log(`[verify] CONFERENCE_COMPLETED session=${sessionId} conf=${confSid} (${verdict})`);
      } catch (err) {
        console.warn(
          `[verify] conference complete failed session=${sessionId} conf=${confSid}:`,
          (err as Error).message,
        );
      }
    }
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
  // Structured call-waiting analysis (upgrade over the Asterisk version, which
  // only logged free-text lines): a single machine-readable evidence trail for
  // the dashboard — detection reason, FSM state at detection, guarded mode,
  // Leg B age (how long the second call survived before failing), the callee's
  // repeat-offender count and the SMS window that now applies.
  const stateAtDetection = session.state;
  const legBAgeMs = session.legBOriginatedAt
    ? Date.now() - new Date(session.legBOriginatedAt).getTime()
    : null;
  let priorFailures = 0;
  try {
    priorFailures = await countPriorCallWaitingOff(session.calleeNumber, session.sessionId);
  } catch {
    // history lookup is best-effort — never block the verdict on it
  }
  await logEvent(
    sessionId,
    "CALL_WAITING_ANALYSIS",
    JSON.stringify({
      reason,
      stateAtDetection,
      guarded: !!session.guarded,
      legBAgeMs,
      priorCallWaitingOff: priorFailures,
      smsWindowSec: session.callerCallSid ? SMS_WINDOW_SECONDS : 0,
      smsPlan: session.callerCallSid
        ? "unconfirmed template if caller hangs up within window"
        : "confirmed template now (no caller leg)",
    }).slice(0, 512),
  );
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

/**
 * Leg B AMD returned MACHINE — voicemail answered the second call. AMD is
 * asynchronous and a machine answer NEVER human-confirms anything: the old
 * guarded "late machine = ignore" exception is removed (a voicemail beep and
 * a human answering call waiting are no longer conflated). Pre-answer machine
 * verdicts keep the legacy semantics (call waiting OFF); once the session is
 * LEG_B_ANSWERED/BRIDGED the call cannot be a verified human answer, so the
 * outcome is DETECTION_INCONCLUSIVE with a full teardown.
 */
export async function onVoicemailDetected(
  sessionId: string,
  amdStatus: string,
): Promise<void> {
  const session = await findSession(sessionId);
  if (!session || isTerminal(session)) return;
  if (
    session.state === VState.LEG_B_ANSWERED ||
    session.state === VState.BRIDGED
  ) {
    console.warn(
      `[verify] AMD_MACHINE_AFTER_ANSWER amd=${amdStatus} state=${session.state} — voicemail/machine NEVER human-confirms`,
    );
    await logEvent(
      sessionId,
      "AMD_MACHINE_AFTER_ANSWER",
      `amd=${amdStatus} arrived after Leg B answer (state=${session.state}) — machine answer cannot confirm a human; detection inconclusive`,
    );
    await onStreamFailed(
      sessionId,
      "DETECTION_INCONCLUSIVE",
      `Leg B answered by a machine/voicemail (amd=${amdStatus}) — not a human confirmation`,
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

  if (
    leg === "legA" ||
    (leg === "legB" &&
      session.guarded &&
      session.state === VState.BRIDGED &&
      bridgeRecallUsed.has(sessionId))
  ) {
    // RECALL-FAILURE path: this failure is the BRIDGE RECALL call (the
    // callee's re-dialled live leg — legB role in the corrected architecture;
    // legA role kept for legacy sessions). The callee didn't take the re-dial
    // — end the conference so the caller is released to the partner-ended
    // notice, and close the session COMPLETED (the original conversation did
    // happen and was monitored before the drop).
    if (session.guarded && session.state === VState.BRIDGED && bridgeRecallUsed.has(sessionId)) {
      console.warn(`[verify] BRIDGE_RECALL_NO_ANSWER reason=${reason} — ending bridge`);
      if (await transition(session, VState.COMPLETED, `Bridge recall failed (${reason}) — callee unreachable`)) {
        session.completedAt = new Date();
        await save(session);
        await logEvent(sessionId, "BRIDGE_RECALL_UNANSWERED", `reason=${reason}`);
        const confSid = await liveConferenceSid(sessionId);
        if (confSid) {
          try {
            await getTwilioClient().conferences(confSid).update({ status: "completed" });
          } catch (err) {
            console.warn(`[verify] conference end failed session=${sessionId}:`, err);
          }
        }
        await hangupAll(session, { caller: true, legB: true, ringTest: true });
      }
      return;
    }
    if (leg !== "legA") return; // legB failures outside recall: handled via onCallCompleted
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

  // GUARDED MODE ONLY (corrected architecture): the live bridge parties are
  // the browser caller and the callee's Leg B. Leg A is the Call Waiting
  // canary — its loss while BRIDGED means the challenge can no longer run:
  // DETECTION_INCONCLUSIVE (lost canary), never a pass.
  if (session.state === VState.BRIDGED && leg === "legA" && session.legACallSid === callSid) {
    console.warn(`[verify] CANARY_LOST session=${sessionId} — Leg A ended mid-call`);
    await logEvent(sessionId, "CANARY_LOST", `Leg A (canary) ended mid-call sid=${callSid} ${statusDetail}`);
    await onStreamFailed(sessionId, "DETECTION_INCONCLUSIVE", "canary (Leg A) lost mid-call");
    return;
  }

  if (session.state === VState.BRIDGED && (leg === "caller" || leg === "legB")) {
    // CALLEE DROP AUTO-RECALL: the callee's live leg (Leg B) ended while the
    // caller is still live (handset glitch, accidental hold-end, carrier
    // blip). Dial them back once, straight into the live conference with a
    // fresh detection stream. Once per session.
    if (
      leg === "legB" &&
      session.legBCallSid === callSid &&
      (await recallCalleeIntoBridge(session, callSid, statusDetail))
    ) {
      return; // session stays BRIDGED; the recall call continues the bridge
    }
    // Leg B (callee) ending the live call is only a clean COMPLETED when the
    // detection pipeline was live for the call (stream-ready had arrived and
    // the challenge started). Without a verified live outcome a Leg B
    // completion is DETECTION_INCONCLUSIVE — never a forced pass.
    const monitored = detectionIsLive(session);
    const target = monitored ? VState.COMPLETED : VState.DETECTION_INCONCLUSIVE;
    const why = monitored
      ? `${leg} hung up — guarded live call ended (detection was live)`
      : `${leg} hung up before stream readiness was confirmed — no verified live outcome`;
    if (await transition(session, target, why)) {
      session.completedAt = new Date();
      if (!monitored) {
        session.failureReason = "Leg B ended without a verified live outcome (detection inconclusive)";
      }
      await save(session);
      await logEvent(
        sessionId,
        monitored ? "GUARDED_CALL_ENDED" : "DETECTION_INCONCLUSIVE",
        `leg=${leg} sid=${callSid} ${statusDetail}`,
      );
      // The REMAINING party is inside an active <Dial><Conference>, which a
      // REST redirect CANNOT pull them out of — so the "partner ended" notice
      // is delivered by the bridge TwiML itself: endConferenceOnExit on the
      // caller leg ends the conference when the caller leaves, and the
      // surviving leg's Dial verb returns into its post-Dial <Redirect>. The
      // ONE case that needs a REST hangup is a remaining leg that never
      // reached the started conference (pre-start lobby) — detect it via the
      // absence of a live conference and hang the leg up directly.
      const remaining =
        leg === "legB" ? session.callerCallSid : session.legBCallSid;
      const confSid = await liveConferenceSid(sessionId);
      if (!confSid) {
        await hangupCall(remaining);
      } else if (leg === "caller") {
        // Caller gone: endConferenceOnExit ends the room, but release the
        // callee leg explicitly in case the exit raced.
        await hangupCall(session.legBCallSid);
      } else {
        // CALLEE (Leg B) gone: endConferenceOnExit lives ONLY on the caller
        // leg, so the room SURVIVES the callee's exit and the caller would be
        // stranded alone in an active <Dial><Conference> until they hang up
        // manually. Complete the conference by SID: the caller's Dial verb
        // returns, its post-Dial <Redirect> plays notify-partner-ended and the
        // leg hangs up (same convention as the in-call merge verdict).
        try {
          await getTwilioClient()
            .conferences(confSid)
            .update({ status: "completed" });
          console.log(
            `[verify] CONFERENCE_COMPLETED session=${sessionId} conf=${confSid} (callee ended the live call)`,
          );
        } catch (err) {
          console.warn(
            `[verify] conference complete failed session=${sessionId} conf=${confSid}:`,
            (err as Error).message,
          );
          // Fallback: never leave the caller stranded — REST-hangup the leg.
          await hangupCall(remaining);
        }
      }
      // The canary (Leg A) and the ring test always end with the live call.
      await hangupAll(session, { legA: true, ringTest: true });
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
    // CORRECTED ARCHITECTURE: a Leg B completion is NEVER a forced pass. The
    // old force-bridge and time-only watch are gone — Leg B ending while
    // LEG_B_ANSWERED completes COMPLETED only when the detection pipeline was
    // confirmed live (stream-ready + challenge started); otherwise the call
    // ran unmonitored and the outcome is DETECTION_INCONCLUSIVE.
    const monitored = detectionIsLive(session);
    if (session.guarded && !monitored) {
      await onStreamFailed(
        sessionId,
        "DETECTION_INCONCLUSIVE",
        "Leg B ended before stream readiness was confirmed — no verified live outcome",
      );
      return;
    }
    if (!session.guarded && !monitored && session.streamReadyBy) {
      // Detection was armed (Leg B answered) but never confirmed ready — the
      // record-chunk fallback no longer exists, so this call was unmonitored.
      await onStreamFailed(
        sessionId,
        "DETECTION_INCONCLUSIVE",
        "Leg B ended with no confirmed detection stream — outcome inconclusive",
      );
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

/* -------------------------------------------------------------------------- */
/* Smart SMS notification (Crazytel) — Asterisk SmsService parity + upgrades  */
/* -------------------------------------------------------------------------- */

/**
 * Counts this callee's PRIOR call-waiting-off failures (terminal sessions in
 * CALL_WAITING_OFF state, excluding the current session). Drives the smart
 * repeat-offender escalation: the first failure gets the coaching template,
 * repeats get the direct `*43#` fix-it template.
 */
export async function countPriorCallWaitingOff(
  calleeNumber: string,
  excludeSessionId?: string,
): Promise<number> {
  const conditions = [
    eq(schema.verificationSessions.calleeNumber, calleeNumber),
    eq(schema.verificationSessions.state, VState.CALL_WAITING_OFF),
  ];
  if (excludeSessionId) {
    conditions.push(ne(schema.verificationSessions.sessionId, excludeSessionId));
  }
  const rows = await getDb()
    .select({ sessionId: schema.verificationSessions.sessionId })
    .from(schema.verificationSessions)
    .where(and(...conditions))
    .orderBy(desc(schema.verificationSessions.completedAt))
    .limit(20);
  return rows.length;
}

/**
 * Picks the SMS template. Parity with the Asterisk version (confirmed vs
 * hangup) plus the smart upgrade: repeat offenders get the escalation text.
 */
export function buildSmsMessage(
  cfg: { messageConfirmed: string; messageHangup: string; messageRepeat: string },
  confirmed: boolean,
  priorFailures: number,
): string {
  if (priorFailures > 0) return cfg.messageRepeat;
  return confirmed ? cfg.messageConfirmed : cfg.messageHangup;
}

export interface SmsDeliveryResult {
  ok: boolean;
  /** Last HTTP status (when the provider answered) */
  status?: number;
  /** Provider message id / reference parsed from the JSON response, if any */
  providerId?: string;
  /** Last error text (network error / provider error body) */
  error?: string;
}

/**
 * Crazytel SMS HTTP delivery — exact port of SmsService.send's wire contract
 * (Authorization: Bearer <api-token>, JSON body {to, from, message} — the
 * token is NEVER sent in the body), upgraded with:
 *   - per-attempt timeout (AbortController) so a hung provider can't wedge the
 *     session engine;
 *   - retry with exponential backoff on network errors and 5xx (transient
 *     provider faults); 4xx is a permanent config problem → no retry;
 *   - delivery audit: the provider's message id/reference is captured into the
 *     SMS_SENT event so every outbound text is traceable end-to-end.
 */
export interface SmsTransportCfg {
  provider: "twilio" | "crazytel";
  baseUrl: string;
  token: string;
  from: string;
  maxAttempts: number;
  timeoutMs: number;
}

interface SmsAttempt extends SmsDeliveryResult {
  /** true = retrying cannot help (bad credentials/number/payload) */
  permanent?: boolean;
}

/** One Crazytel send attempt — exact SmsService.java wire contract. */
async function sendViaCrazytel(cfg: SmsTransportCfg, to: string, message: string): Promise<SmsAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(cfg.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // SmsService.java: .header("Authorization", "Bearer " + props.getToken())
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({ to, from: cfg.from, message }),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    if (res.ok) {
      let providerId: string | undefined;
      try {
        const j = JSON.parse(text) as Record<string, unknown>;
        const id = j.id ?? j.messageId ?? j.message_id ?? j.reference;
        if (id != null) providerId = String(id);
      } catch {
        // non-JSON success body — fine, delivery still confirmed by 2xx
      }
      return { ok: true, status: res.status, providerId };
    }
    // 4xx = permanent (bad token/number/payload) — retrying cannot help.
    return { ok: false, status: res.status, error: text.slice(0, 200), permanent: res.status >= 400 && res.status < 500 };
  } catch (err) {
    return {
      ok: false,
      error:
        controller.signal.aborted
          ? `timeout after ${cfg.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** One Twilio Messages API attempt — same account as voice, no extra vendor. */
async function sendViaTwilio(cfg: SmsTransportCfg, to: string, message: string): Promise<SmsAttempt> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = getTwilioClient();
    const timeout = new Promise<never>((_r, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${cfg.timeoutMs}ms`)), cfg.timeoutMs);
    });
    const msg = (await Promise.race([
      client.messages.create({ to, from: cfg.from, body: message }),
      timeout,
    ])) as { sid?: string };
    return { ok: true, providerId: msg.sid };
  } catch (err) {
    // Twilio REST errors carry an HTTP status: 4xx permanent, 5xx retryable.
    // Network/SDK errors carry no status → retryable.
    const status =
      typeof (err as { status?: unknown })?.status === "number"
        ? (err as { status: number }).status
        : undefined;
    return {
      ok: false,
      status,
      error: err instanceof Error ? err.message : String(err),
      permanent: status != null && status >= 400 && status < 500,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * SMS delivery with provider transports ("twilio" default when Twilio creds
 * exist; "crazytel" = the Asterisk SmsService HTTP port), upgraded with:
 *   - per-attempt timeout so a hung provider can't wedge the session engine;
 *   - retry with exponential backoff on network errors and 5xx (transient
 *     provider faults); 4xx is a permanent config problem → no retry;
 *   - delivery audit: the provider's message id/SID is captured into the
 *     SMS_SENT event so every outbound text is traceable end-to-end.
 */
export async function deliverSms(
  cfg: SmsTransportCfg,
  to: string,
  message: string,
): Promise<SmsDeliveryResult> {
  const transport = cfg.provider === "twilio" ? sendViaTwilio : sendViaCrazytel;
  let last: SmsDeliveryResult = { ok: false, error: "no attempt made" };
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    const r = await transport(cfg, to, message);
    if (r.ok) return r;
    last = r;
    if (r.permanent) return last;
    if (attempt < cfg.maxAttempts) {
      // Backoff: 800ms, 1600ms, 3200ms, … (capped at 4s)
      await new Promise((res) => setTimeout(res, Math.min(800 * 2 ** (attempt - 1), 4000)));
    }
  }
  return last;
}

/**
 * Sends the SMS appropriate to the trigger and marks smsSent.
 * Port of SessionService.sendSmsOnce + the SmsEvent listener (Crazytel HTTP).
 *
 * Parity with the Asterisk version:
 *   - mark-before-send so concurrent triggers can never double-text the callee
 *     (Java: session.markSmsSent() then publish SmsEvent AFTER_COMMIT);
 *   - same two triggers (explicit confirmation vs caller hangup in the window);
 *   - same Bearer-auth Crazytel wire contract.
 *
 * Upgrades beyond Asterisk:
 *   - smart repeat-offender escalation template (per-callee failure history);
 *   - retry with backoff + per-attempt timeout;
 *   - provider message-id capture for a full delivery audit trail.
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
  const providerReady =
    cfg.provider === "twilio" ? twilioRestConfigured() : Boolean(cfg.token);
  if (!cfg.enabled || !providerReady) {
    await logEvent(
      session.sessionId,
      "SMS_SKIPPED",
      cfg.enabled
        ? `SMS provider credentials missing (provider=${cfg.provider})`
        : "SMS disabled",
    );
    return;
  }

  // Smart escalation: has this callee failed call-waiting verification before?
  let priorFailures = 0;
  try {
    priorFailures = await countPriorCallWaitingOff(session.calleeNumber, session.sessionId);
  } catch (err) {
    console.warn("[verify] SMS_HISTORY_LOOKUP_FAILED — defaulting to base template", err);
  }
  if (priorFailures > 0) {
    await logEvent(
      session.sessionId,
      "SMS_REPEAT_OFFENDER",
      `callee=${session.calleeNumber} priorCallWaitingOff=${priorFailures} — escalation template`,
    );
  }
  const message = buildSmsMessage(cfg, confirmed, priorFailures);

  // Bounded delivery (maxAttempts × timeout) — every caller of sendSmsOnce is
  // an async status-callback/admin path, never a TwiML webhook with a
  // response deadline, so awaiting retries here is safe.
  const result = await deliverSms(cfg, session.calleeNumber, message);
  if (result.ok) {
    await logEvent(
      session.sessionId,
      "SMS_SENT",
      `to=${session.calleeNumber} via=${cfg.provider} template=${priorFailures > 0 ? "repeat" : confirmed ? "confirmed" : "hangup"}${result.providerId ? ` providerId=${result.providerId}` : ""}`,
    ).catch(() => {});
  } else {
    console.error(`[verify] SMS_FAILED to=${session.calleeNumber}`, result.error);
    await logEvent(
      session.sessionId,
      "SMS_FAILED",
      `attempts=${cfg.maxAttempts}${result.status ? ` http=${result.status}` : ""} ${result.error ?? ""}`.slice(0, 512),
    ).catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* Inbound AI SMS — two-way upgrade beyond the Asterisk version               */
/* -------------------------------------------------------------------------- */

/**
 * The Asterisk templates invite the callee to "reply with your phone model"
 * but nothing ever reads those replies. Crazytel Virtual Mobile Numbers post
 * inbound texts to a JSON webhook ({from, to, text}), so this port closes the
 * loop: the reply webhook (POST /api/verify/sms/inbound) routes the sender's
 * text here and this returns a concrete, model-specific call-waiting
 * walkthrough. Deterministic knowledge base — no LLM dependency, no extra API
 * keys, instant even on a cold free-tier dyno.
 */
export function buildAiSmsReply(text: string): string {
  const t = text.toLowerCase();
  const universal =
    "Universal fix: open the Phone app, dial *43# and press call — this switches call waiting ON on most carriers.";
  if (/iphone|apple|ios/.test(t)) {
    return `iPhone: Settings → Apps → Phone → Call Waiting → ON (older iOS: Settings → Phone → Call Waiting). Then ask them to call you again. ${universal}`;
  }
  if (/samsung|galaxy|\bs2\d|note\s?\d/.test(t)) {
    return `Samsung: Phone app → ⋮ menu → Settings → Supplementary services → Call waiting → ON. Then ask them to call you again. ${universal}`;
  }
  if (/pixel|google/.test(t)) {
    return `Google Pixel: Phone app → ⋮ menu → Settings → Calls → Call waiting → ON. Then ask them to call you again. ${universal}`;
  }
  if (/oppo|realme|xiaomi|redmi|huawei|motorola|\bmoto\b|nokia|tcl|zte|vivo|oneplus|android/.test(t)) {
    return `Android: Phone app → ⋮ menu → Settings → Calling accounts (or Carrier call settings) → your SIM → Call waiting → ON. Then ask them to call you again. ${universal}`;
  }
  // Model not recognised — ask again AND give the universal fix so this reply
  // is still useful on its own.
  return `AI SMS: I didn't catch your phone model — reply with e.g. "iPhone 13" or "Samsung S23" and I'll send the exact steps. ${universal}`;
}

/** Cooldown between AI replies to the same session (reply-loop protection). */
const SMS_AI_REPLY_COOLDOWN_MS = 60_000;
/** Max AI replies per session per rolling 24h (abuse / cost protection). */
const SMS_AI_REPLY_MAX_PER_DAY = 10;

/**
 * Handles one inbound SMS from a callee: attaches the text to their most
 * recent verification session's event trail, rate-limits, and replies with
 * the model-specific walkthrough via Crazytel. Returns a short status string
 * for the webhook response/logs.
 */
export async function handleInboundSms(fromRaw: string, text: string): Promise<string> {
  const from = normalizeE164(fromRaw);
  if (!from || !text.trim()) return "invalid-request";
  const db = getDb();

  // Most recent session for this callee (any state — a reply may arrive days
  // after the failure). The event trail attaches there; with no session we
  // still answer — the knowledge base needs no session context.
  const recent = await db
    .select()
    .from(schema.verificationSessions)
    .where(eq(schema.verificationSessions.calleeNumber, from))
    .orderBy(desc(schema.verificationSessions.createdAt))
    .limit(1);
  const session = recent[0] ?? null;

  if (session) {
    await logEvent(session.sessionId, "SMS_INBOUND", `from=${from} text="${text.slice(0, 120)}"`);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const replyRows = await db
      .select({ timestamp: schema.verificationEvents.timestamp })
      .from(schema.verificationEvents)
      .where(
        and(
          eq(schema.verificationEvents.sessionId, session.sessionId),
          eq(schema.verificationEvents.eventType, "SMS_AI_REPLY"),
          gt(schema.verificationEvents.timestamp, dayAgo),
        ),
      )
      .orderBy(desc(schema.verificationEvents.timestamp));
    if (replyRows.length >= SMS_AI_REPLY_MAX_PER_DAY) {
      await logEvent(
        session.sessionId,
        "SMS_AI_REPLY_LIMIT",
        `${replyRows.length} AI replies in 24h — suppressed inbound from ${from}`,
      );
      return "reply-limit";
    }
    const lastAt = replyRows[0]?.timestamp ? new Date(replyRows[0].timestamp).getTime() : 0;
    if (Date.now() - lastAt < SMS_AI_REPLY_COOLDOWN_MS) {
      return "cooldown";
    }
  }

  const cfg = smsCfg();
  const providerReady =
    cfg.provider === "twilio" ? twilioRestConfigured() : Boolean(cfg.token);
  if (!cfg.enabled || !providerReady) {
    if (session) {
      await logEvent(session.sessionId, "SMS_SKIPPED", `inbound reply — SMS disabled or provider credentials missing (provider=${cfg.provider})`);
    }
    return "sms-disabled";
  }

  const reply = buildAiSmsReply(text);
  const result = await deliverSms(cfg, from, reply);
  if (session) {
    await logEvent(
      session.sessionId,
      result.ok ? "SMS_AI_REPLY" : "SMS_FAILED",
      result.ok
        ? `to=${from} aiReply${result.providerId ? ` providerId=${result.providerId}` : ""}`
        : `to=${from} ${result.error ?? ""}`.slice(0, 512),
    ).catch(() => {});
  }
  return result.ok ? "replied" : "send-failed";
}

/**
 * OUTER SPEAKERPHONE clear transition — the media-stream detector saw the
 * required streak of fingerprint-clean windows after a fired suspicion. This
 * is the RECOVERY COMPLETE + REARM point of the strike policy: the episode
 * has ended, audio returned to normal for the required recovery period, and
 * the next episode onset will be a NEW independently confirmed episode (and
 * the next strike). Late emissions after a terminal transition are no-ops
 * (the terminal guard below). The live page gets an explicit event on the
 * next poll.
 */
export async function onSpeakerphoneCleared(
  sessionId: string,
  reason: string,
): Promise<void> {
  try {
    const session = await findSession(sessionId);
    if (!session || isTerminal(session)) return;
    // EPISODE END + RECOVERY COMPLETE: the detector saw the required streak
    // of fingerprint-clean windows (≈3s of confirmed-normal audio) after a
    // fired episode — the recovery period the strike policy requires between
    // strikes. The detector is now REARMED: the next suspicious episode onset
    // is a NEW, independently confirmed episode and records the next strike.
    // Strikes themselves are recorded at episode CONFIRMATION (onset) in
    // injectSpeakerphoneChallenge — never here, so repeated detector frames
    // inside one continuous suspicious period can never multiply strikes.
    const strikes = speakerphoneStrikes.get(sessionId) ?? 0;
    console.log(
      `[verify] SPEAKERPHONE_CLEARED session=${sessionId} — episode ended, recovery complete, detector rearmed (strikes=${strikes}) | ${reason}`,
    );
    await logEvent(
      sessionId,
      "SPEAKERPHONE_CLEARED",
      `suspicious episode ended; audio normal for the required recovery period; detector rearmed for the next distinct episode | strikes so far=${strikes} | ${reason}`.slice(0, 512),
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
          strikes,
          target: "caller-inmate",
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
 * Permanently silence the canary (Leg A) loud-tone loop for this session by
 * redirecting the held canary leg to the silent self-refreshing `leg-a-hold`
 * TwiML. Triggered on the FIRST speakerphone episode onset: while relay audio
 * is present, the loud 852+1336 Hz loop's acoustic leak through the
 * speakerphone mic path can cross the relay's loud-tone energy floor and
 * false-fire MERGE_DETECTED (the 2026-09-04 live test — call killed
 * mid-episode with the wrong reason). The leg stays alive (HoldDetector keeps
 * watching its uplink); only the tone stops. Once silenced, a later
 * onStreamReady challenge restart is suppressed (see the gate there), so the
 * tone can never resume mid-session. Idempotent; best-effort.
 */
export async function silenceCanaryLoudTone(sessionId: string): Promise<void> {
  if (canarySilencedSessions.has(sessionId)) return;
  canarySilencedSessions.add(sessionId);
  try {
    const session = await findSession(sessionId);
    if (!session || isTerminal(session) || session.state !== VState.BRIDGED) {
      canarySilencedSessions.delete(sessionId);
      return;
    }
    if (!session.legACallSid) {
      canarySilencedSessions.delete(sessionId);
      return;
    }
    const ok = await redirectCall(session.legACallSid, "leg-a-hold", sessionId);
    if (!ok) {
      canarySilencedSessions.delete(sessionId); // allow retry on the next onset
      return;
    }
    console.log(
      `[verify] CANARY_TONE_SILENCED session=${sessionId} legA=${session.legACallSid} — loud tone loop stopped (speakerphone episode owns the session)`,
    );
    await logEvent(
      sessionId,
      "CANARY_TONE_SILENCED",
      "speakerphone episode onset — canary loud 852+1336Hz loop permanently silenced so its acoustic leak cannot false-fire the relay loud-tone listener; in-call merge supervision continues via the authorised Leg A→Leg B relay detector (prompt fingerprint + loud-tone listener on Leg B inbound)",
    );
  } catch (err) {
    canarySilencedSessions.delete(sessionId);
    console.error(`[verify] silenceCanaryLoudTone failed session=${sessionId}:`, err);
  }
}

/**
 * SPEAKERPHONE STRIKE-LADDER DISPATCHER — the single entry point the
 * media-stream suspicion handler calls on EVERY detector emission.
 *
 * STRIKE SEMANTICS (2026-09-05 spec): a strike is recorded AT EPISODE
 * CONFIRMATION (episodeStart = the first emission of a new episode; the
 * stream layer computes it from speakerphoneSuspicion membership BEFORE
 * adding, so concurrent callbacks cannot double-count). One continuous
 * suspicious period = ONE strike regardless of how many frames refire
 * (non-onset refires are no-ops). A new strike additionally requires the
 * previous episode to have ended and audio to have returned to normal for
 * the recovery period — that is exactly the detector's fingerprint-clean
 * clear streak, so an onset can only arrive after a valid recovery.
 *
 * Ladder:
 *   strike 1 → recorded (timestamp + detector evidence); call continues.
 *   strike 2 → recorded; call continues UNCHANGED (a milestone only).
 *   strike 3 → WARNING FLAG (issueSpeakerphoneWarning): mute the inmate,
 *              play the warning to the conference, unmute on completion,
 *              resume. NOT supreme.
 *   strike 4 → SUPREME FLAG (onSpeakerphoneSupreme): only if the strike-3
 *              warning was actually DELIVERED; otherwise the warning is
 *              retried (a supreme without a delivered warning would punish
 *              a delivery failure, not the caller).
 *
 * While the strike-3 warning flow is in progress (muted → playing →
 * unmute) detector callbacks are coalesced away: the warning audio itself
 * must never create strike 4, and duplicate callbacks from the same
 * episode are ignored.
 *
 * Strikes 1–2 inject NO audio into either leg — the challenge-noise path
 * was removed with the legacy merge-tone path on 2026-09-05.
 */
export async function injectSpeakerphoneChallenge(
  sessionId: string,
  reason: string,
  episodeStart: boolean,
): Promise<void> {
  // The strike-3 warning owns the moment: coalesce every detector callback
  // while it plays so warning audio can never generate another strike.
  if (speakerphoneWarningActiveAt.has(sessionId)) {
    console.log(
      `[verify] SPEAKERPHONE_LADDER session=${sessionId} — warning in progress, detector callback coalesced (no strike) | ${reason}`,
    );
    return;
  }
  if (!episodeStart) return; // refire inside an already-counted episode
  // CONFIRMED DISTINCT EPISODE → persist the next strike exactly once, with
  // timestamp + detector evidence + session/conference/participant context.
  const strikes = (speakerphoneStrikes.get(sessionId) ?? 0) + 1;
  speakerphoneStrikes.set(sessionId, strikes);
  try {
    const session = await findSession(sessionId);
    const confSid = session ? await liveConferenceSid(sessionId) : null;
    await logEvent(
      sessionId,
      "SPEAKERPHONE_STRIKE",
      (`strike ${strikes} confirmed at ${new Date().toISOString()} — distinct speakerphone-like episode ` +
        `| state=${session?.state ?? "unknown"} conference=${confSid ?? "none"} ` +
        `caller=${session?.callerCallSid ?? "none"} legA=${session?.legACallSid ?? "none"} legB=${session?.legBCallSid ?? "none"} ` +
        `| evidence: ${reason}`).slice(0, 512),
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
        await logCallEvent(callId, "speakerphone_strike", {
          sessionId,
          strike: strikes,
          reason,
          conferenceSid: confSid,
          at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn("[verify] logCallEvent speakerphone_strike mirror failed:", (err as Error).message);
    }
  } catch (err) {
    console.error(`[verify] strike persistence failed session=${sessionId}:`, err);
  }
  if (strikes <= 2) {
    console.log(
      `[verify] SPEAKERPHONE_LADDER session=${sessionId} strike=${strikes} — recorded only; call continues unchanged`,
    );
    return;
  }
  const warned = speakerphoneWarnedSessions.has(sessionId);
  if (strikes === 3 || !warned) {
    // Strike 3 (or a retry after a failed delivery): WARNING FLAG only.
    console.log(
      `[verify] SPEAKERPHONE_LADDER session=${sessionId} strike=${strikes} → WARNING FLAG`,
    );
    await issueSpeakerphoneWarning(sessionId, reason, strikes);
    return;
  }
  console.log(
    `[verify] SPEAKERPHONE_LADDER session=${sessionId} strike=${strikes} + delivered warning → SUPREME`,
  );
  await onSpeakerphoneSupreme(
    sessionId,
    `strike ${strikes}: repeated speakerphone-like audio or excessive background noise after a delivered warning | ${reason}`,
  );
}

/**
 * STRIKE-3 WARNING FLAG (plays exactly once per session when delivery
 * succeeds). Ordered contract:
 *  1. MUTE the inmate's outbound conference audio FIRST and confirm the
 *     mute succeeded — they must not talk over the warning, but they are
 *     NOT disconnected and still RECEIVE audio (hears the warning
 *     receive-only). If the mute fails the warning is NOT played, nothing
 *     is marked delivered, and the next episode retries.
 *  2. PLAY the warning to the whole conference (conference-level announce)
 *     so the RECIPIENT hears it directly and the muted inmate hears it
 *     receive-only. If the announce fails, record the delivery failure and
 *     SAFELY UNMUTE immediately — the inmate is never left muted.
 *  3. UNMUTE on playback completion: the served asset's duration is
 *     MEASURED (speakerphoneWarningAudioMs) — completion = measured
 *     duration + delivery buffer, then the unmute is confirmed (with
 *     retries, so a transient Twilio error can never leave the inmate
 *     permanently muted). Delivery is recorded (SPEAKERPHONE_WARNING +
 *     SPEAKERPHONE_CALLER_UNMUTED), the count stays at strike 3, and the
 *     call resumes.
 * No fixed-timer guessing: the unmute delay is derived from the exact
 * rendered asset we serve.
 */
async function issueSpeakerphoneWarning(
  sessionId: string,
  reason: string,
  strikes: number,
): Promise<void> {
  try {
    const session = await findSession(sessionId);
    if (!session || isTerminal(session)) return;
    if (session.state !== VState.BRIDGED) {
      console.log(
        `[verify] SPEAKERPHONE_WARNING session=${sessionId} state=${session.state} — not BRIDGED, deferring warning (retry on next episode)`,
      );
      return;
    }
    if (!session.callerCallSid) {
      console.warn(`[verify] SPEAKERPHONE_WARNING session=${sessionId} — no caller leg, skipping (retry on next episode)`);
      return;
    }
    const base = getPublicBaseUrl();
    if (!base) {
      console.warn(`[verify] SPEAKERPHONE_WARNING session=${sessionId} — no public base URL, skipping`);
      return;
    }
    const confSid = await liveConferenceSid(sessionId);
    if (!confSid) {
      console.warn(`[verify] SPEAKERPHONE_WARNING session=${sessionId} — no live conference, skipping`);
      return;
    }
    // 1. MUTE the inmate FIRST — before any playback starts.
    try {
      await getTwilioClient()
        .conferences(confSid)
        .participants(session.callerCallSid)
        .update({ muted: true });
    } catch (err) {
      console.error(`[verify] SPEAKERPHONE_WARNING session=${sessionId} — inmate mute FAILED, warning not played:`, err);
      await logEvent(
        sessionId,
        "SPEAKERPHONE_WARNING_FAILED",
        `strike 3: inmate mute failed — warning NOT played, caller left unmuted; the next distinct episode retries | ${(err as Error).message}`.slice(0, 512),
      ).catch(() => {});
      return; // NOT marked warned — delivery retried on the next episode
    }
    try {
      await getDb()
        .update(schema.calls)
        .set({ muted: true })
        .where(eq(schema.calls.clientCallId, `guarded-${sessionId}`));
    } catch (err) {
      console.warn("[verify] muted mirror failed:", (err as Error).message);
    }
    console.log(
      `[verify] SPEAKERPHONE_CALLER_MUTED session=${sessionId} caller=${session.callerCallSid} — muted BEFORE warning playback (receive-only)`,
    );
    await logEvent(
      sessionId,
      "SPEAKERPHONE_CALLER_MUTED",
      "strike 3: inmate outbound audio muted before warning playback (confirmed); still receives conference audio; NOT disconnected",
    );
    // 2. PLAY the warning to the CONFERENCE — the recipient hears it
    //    directly; the muted inmate hears it in receive-only mode.
    try {
      await getTwilioClient()
        .conferences(confSid)
        .update({
          announceUrl: `${base}/api/verify/speakerphone-warning.wav`,
          announceMethod: "GET",
        });
    } catch (err) {
      console.error(`[verify] SPEAKERPHONE_WARNING session=${sessionId} — announce failed after mute, unmuting:`, err);
      await logEvent(
        sessionId,
        "SPEAKERPHONE_WARNING_FAILED",
        `strike 3: warning announce failed — delivery NOT claimed; inmate safely unmuted | ${(err as Error).message}`.slice(0, 512),
      ).catch(() => {});
      await unmuteSpeakerphoneCaller(sessionId, "warning announce failed — safe unmute");
      return; // NOT marked warned — retried on the next episode
    }
    // Mark issued ONLY after the announce succeeded (see docstring).
    speakerphoneWarnedSessions.add(sessionId);
    speakerphoneWarningActiveAt.set(sessionId, Date.now());
    const unmuteInMs = speakerphoneWarningAudioMs() + speakerphoneWarningUnmuteBufferMs();
    console.log(
      `[verify] SPEAKERPHONE_WARNING session=${sessionId} conf=${confSid} — warning playing to conference (recipient + inmate receive-only); unmute in ${unmuteInMs}ms (measured audio ${speakerphoneWarningAudioMs()}ms + buffer) | ${reason}`,
    );
    await logEvent(
      sessionId,
      "SPEAKERPHONE_WARNING",
      `strike ${strikes} (warning flag): warning playing to the conference — recipient hears it, inmate receive-only with mic muted; unmute in ${unmuteInMs}ms; next distinct confirmed episode after recovery = supreme flag (call ended + admin alerted) | ${reason}`.slice(0, 512),
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
        await logCallEvent(callId, "speakerphone_warning", {
          sessionId,
          reason,
          strike: strikes,
          target: "conference",
          at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn("[verify] logCallEvent speakerphone_warning mirror failed:", (err as Error).message);
    }
    // 3. UNMUTE on playback completion (measured asset duration + buffer).
    const unmuteTimer = setTimeout(() => {
      void completeSpeakerphoneWarning(sessionId);
    }, unmuteInMs);
    unmuteTimer.unref?.();
    speakerphoneUnmuteTimers.set(sessionId, unmuteTimer);
  } catch (err) {
    console.error(`[verify] issueSpeakerphoneWarning failed session=${sessionId}:`, err);
  }
}

/**
 * Raw unmute of the inmate's outbound conference audio with confirmation
 * (the REST update resolving IS the confirmation). Throws are caught by the
 * caller. Best-effort DB mirror + call_events mirror.
 */
async function unmuteSpeakerphoneCaller(sessionId: string, why: string): Promise<boolean> {
  try {
    const session = await findSession(sessionId);
    if (!session) return false;
    const confSid = await liveConferenceSid(sessionId);
    if (!confSid || !session.callerCallSid) {
      console.warn(
        `[verify] SPEAKERPHONE_CALLER_UNMUTED session=${sessionId} — conference/participant gone (${why}); DB mirror still written`,
      );
    } else {
      await getTwilioClient()
        .conferences(confSid)
        .participants(session.callerCallSid)
        .update({ muted: false });
    }
    await getDb()
      .update(schema.calls)
      .set({ muted: false })
      .where(eq(schema.calls.clientCallId, `guarded-${sessionId}`));
    console.log(`[verify] SPEAKERPHONE_CALLER_UNMUTED session=${sessionId} — ${why}`);
    await logEvent(
      sessionId,
      "SPEAKERPHONE_CALLER_UNMUTED",
      `inmate outbound audio restored (confirmed) — ${why}`.slice(0, 512),
    );
    return true;
  } catch (err) {
    console.error(`[verify] unmuteSpeakerphoneCaller failed session=${sessionId} (${why}):`, err);
    return false;
  }
}

/**
 * Strike-3 playback completion: the measured warning duration + buffer has
 * elapsed — unmute the inmate, confirm, record successful delivery, and
 * resume the two-way conversation with the count retained at strike 3.
 * The unmute is retried (3 attempts, 2s apart) so a transient Twilio error
 * can NEVER leave the inmate permanently muted; a final failure raises a
 * loud SPEAKERPHONE_UNMUTE_FAILED event for ops.
 */
async function completeSpeakerphoneWarning(sessionId: string): Promise<void> {
  speakerphoneUnmuteTimers.delete(sessionId);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const session = await findSession(sessionId).catch(() => null);
    if (!session || isTerminal(session)) return; // call already ending — moot
    const ok = await unmuteSpeakerphoneCaller(
      sessionId,
      `warning playback complete (measured ${speakerphoneWarningAudioMs()}ms asset + buffer), attempt ${attempt}`,
    );
    if (ok) {
      speakerphoneWarningActiveAt.delete(sessionId);
      await logEvent(
        sessionId,
        "SPEAKERPHONE_WARNING_DELIVERED",
        "strike-3 warning successfully delivered: played to the conference with the inmate muted receive-only, inmate unmuted after completion, call resumed — count retained at strike 3; detection rearms once audio is normal",
      ).catch(() => {});
      try {
        const { logCallEvent } = await import("./simulator");
        const rows = await getDb()
          .select({ id: schema.calls.id })
          .from(schema.calls)
          .where(eq(schema.calls.clientCallId, `guarded-${sessionId}`))
          .limit(1);
        const callId = Number(rows.at(0)?.id ?? 0);
        if (callId) {
          await logCallEvent(callId, "speakerphone_warning_delivered", {
            sessionId,
            strike: 3,
            target: "conference",
            at: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.warn("[verify] logCallEvent warning_delivered mirror failed:", (err as Error).message);
      }
      return;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2_000));
  }
  console.error(
    `[verify] SPEAKERPHONE_UNMUTE_FAILED session=${sessionId} — 3 unmute attempts failed; OPS: inmate may still be muted`,
  );
  await logEvent(
    sessionId,
    "SPEAKERPHONE_UNMUTE_FAILED",
    "strike-3 unmute failed after 3 confirmed attempts — inmate may still be muted; manual ops intervention required",
  ).catch(() => {});
}

/**
 * SUPREME FLAG — the top of the speakerphone strike ladder (episode 4 onset,
 * or a strike-3 warning episode that never cleared). The call:
 *  1. transitions BRIDGED → SPEAKERPHONE_TERMINATED (terminal; NEVER a pass);
 *  2. is FLAGGED on the calls row (flagged=true + flagReason) for review;
 *  3. alerts the admin by SMS (ADMIN_ALERT_NUMBER; skipped when unset);
 *  4. plays the termination prompt to BOTH live parties (caller + Leg B
 *     participant whisper channels — the muted caller still HEARS downlink);
 *  5. after the prompt lands, hangs up every leg and completes the
 *     conference by SID (belt-and-braces — a REST redirect cannot reach a
 *     leg inside an active <Dial><Conference>, so the announce + delayed
 *     teardown is the reliable in-conference path).
 * Idempotent per session (speakerphoneSupremeSessions). Best-effort: every
 * step is individually fault-isolated; the terminal transition has already
 * happened before any telephony step runs, so a Twilio failure can never
 * resurrect the call.
 */
export async function onSpeakerphoneSupreme(
  sessionId: string,
  reason: string,
): Promise<void> {
  if (speakerphoneSupremeSessions.has(sessionId)) return;
  speakerphoneSupremeSessions.add(sessionId);
  try {
    const session = await findSession(sessionId);
    if (!session || isTerminal(session)) return;
    if (session.state !== VState.BRIDGED) {
      console.log(
        `[verify] SPEAKERPHONE_SUPREME session=${sessionId} state=${session.state} — not BRIDGED, ignoring | ${reason}`,
      );
      return;
    }
    // Cancel any pending strike-3 warning machinery — the ladder is resolved
    // now. A supreme fires only AFTER a delivered warning, but a concurrent
    // unmute timer is cancelled defensively.
    const unmuteTimer = speakerphoneUnmuteTimers.get(sessionId);
    if (unmuteTimer) clearTimeout(unmuteTimer);
    speakerphoneUnmuteTimers.delete(sessionId);
    speakerphoneWarningActiveAt.delete(sessionId);

    const strikes = speakerphoneStrikes.get(sessionId) ?? 0;
    const transitioned = await transition(
      session,
      VState.SPEAKERPHONE_TERMINATED,
      `supreme flag at strike ${strikes} — repeated speakerphone-like audio or excessive background noise after a delivered warning | ${reason}`.slice(0, 256),
    );
    if (!transitioned) return;
    session.completedAt = new Date();
    session.failureReason =
      `Supreme flag: repeated speakerphone-like audio or excessive background noise after a delivered warning (${strikes} strikes) — call ended and flagged for review`.slice(0, 512);
    await save(session);
    console.log(
      `[verify] SPEAKERPHONE_SUPREME session=${sessionId} strikes=${strikes} — call flagged, terminating | ${reason}`,
    );
    await logEvent(
      sessionId,
      "SPEAKERPHONE_SUPREME",
      `supreme flag (strike ${strikes}): repeated speakerphone-like audio or excessive background noise after a delivered warning — call flagged for review, admin alerted (exactly once), call ended | ${reason}`.slice(0, 512),
    );

    // Flag the calls row for review + mirror the event stream.
    try {
      await getDb()
        .update(schema.calls)
        .set({
          flagged: true,
          flagReason: `speakerphone supreme: ${strikes} strikes — repeated speakerphone-like audio after delivered warning`.slice(0, 255),
        })
        .where(eq(schema.calls.clientCallId, `guarded-${sessionId}`));
      const { logCallEvent } = await import("./simulator");
      const rows = await getDb()
        .select({ id: schema.calls.id })
        .from(schema.calls)
        .where(eq(schema.calls.clientCallId, `guarded-${sessionId}`))
        .limit(1);
      const callId = Number(rows.at(0)?.id ?? 0);
      if (callId) {
        await logCallEvent(callId, "speakerphone_supreme", {
          sessionId,
          strikes,
          reason,
          flagged: true,
          at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn("[verify] supreme flag/mirror failed:", (err as Error).message);
    }

    // Admin SMS alert (best-effort; skipped when ADMIN_ALERT_NUMBER unset or
    // SMS disabled — the flag + events above are the durable record).
    const adminTo = adminAlertNumber();
    if (adminTo) {
      try {
        const cfg = smsCfg();
        const providerReady =
          cfg.provider === "twilio" ? twilioRestConfigured() : Boolean(cfg.token);
        if (cfg.enabled && providerReady) {
          const result = await deliverSms(
            cfg,
            adminTo,
            `SUPREME FLAG: guarded call ${sessionId} ended — repeated speakerphone-like audio or excessive background noise after a delivered warning (${strikes} strikes). Flagged for review.`,
          );
          await logEvent(
            sessionId,
            result.ok ? "ADMIN_ALERT_SENT" : "ADMIN_ALERT_FAILED",
            result.ok
              ? `supreme-flag SMS delivered to admin (${adminTo}) via ${cfg.provider} id=${result.providerId ?? "n/a"}`
              : `supreme-flag SMS to admin (${adminTo}) failed: ${result.error ?? "unknown"}`.slice(0, 512),
          );
        } else {
          await logEvent(
            sessionId,
            "ADMIN_ALERT_SKIPPED",
            `ADMIN_ALERT_NUMBER set but SMS disabled/credentials missing (provider=${cfg.provider})`,
          );
        }
      } catch (err) {
        console.warn("[verify] admin alert SMS failed:", (err as Error).message);
      }
    }

    // Termination prompt to BOTH live parties, then delayed teardown.
    const base = getPublicBaseUrl();
    const confSid = await liveConferenceSid(sessionId);
    if (base && confSid) {
      const url = `${base}/api/verify/speakerphone-terminated.wav`;
      await Promise.allSettled([
        session.callerCallSid
          ? getTwilioClient()
              .conferences(confSid)
              .participants(session.callerCallSid)
              .update({ announceUrl: url, announceMethod: "GET" })
          : Promise.resolve(),
        session.legBCallSid
          ? getTwilioClient()
              .conferences(confSid)
              .participants(session.legBCallSid)
              .update({ announceUrl: url, announceMethod: "GET" })
          : Promise.resolve(),
      ]);
    }
    // 8.5s ≈ terminated-prompt duration (measured 7.08s) + buffer. Fault-
    // isolated: the session is already terminal, so nothing here can
    // resurrect it. Unref'd — a pending teardown must never hold the
    // process (or a test runner) open.
    const teardownTimer = setTimeout(() => {
      void (async () => {
        try {
          await hangupAll(session, { caller: true, legA: true, legB: true, ringTest: true });
          if (confSid) {
            await getTwilioClient()
              .conferences(confSid)
              .update({ status: "completed" });
            console.log(`[verify] CONFERENCE_COMPLETED session=${sessionId} conf=${confSid} (supreme)`);
          }
        } catch (err) {
          console.warn(`[verify] supreme teardown incomplete session=${sessionId}:`, (err as Error).message);
        }
      })();
    }, 8_500);
    teardownTimer.unref?.();
  } catch (err) {
    console.error(`[verify] onSpeakerphoneSupreme failed session=${sessionId}:`, err);
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
 * GUARDED MODE ONLY: persist the save-only voice-ID recording ("my voice
 * identifies me") so the call-review UI can play it back. Stored even when
 * relayguard profiling failed — playback does not depend on the profile.
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
