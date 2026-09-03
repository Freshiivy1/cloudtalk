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
import { and, desc, eq, gt, lt, ne, notInArray, or } from "drizzle-orm";
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

/**
 * D2: event-driven BRIDGED notification registry. maybeBridgeGuarded() sets
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
 * Consecutive suspicious 1s analysis windows the SpeakerphoneDetector
 * requires before the outer-call forensic system fires (challenge noise to
 * the CALLER only — never the merge tone). Default 3 (sustained ~3s
 * speakerphone-relay detection — a brief 2-window blip must NOT fire the
 * challenge). Env-overridable via VERIFY_SPEAKERPHONE_ARM_WINDOWS, floored
 * at 1; an unset, empty, or non-numeric value yields the default 3.
 */
export function speakerphoneArmWindows(): number {
  const raw = process.env.VERIFY_SPEAKERPHONE_ARM_WINDOWS;
  if (!raw) return 3; // unset OR set-but-empty → default
  const v = Number(raw);
  if (!Number.isFinite(v)) return 3;
  return Math.max(1, Math.floor(v));
}

/**
 * Forensic calibration warm-up (ms) after a session enters BRIDGED: the
 * SpeakerphoneDetector scores windows internally (rebuilding its rolling
 * baseline from LIVE in-call audio — the pre-bridge baseline was ringback/IVR
 * audio, and comparing bridged speech against it is what false-armed the
 * detector ~3s into the live-test bridge) but cannot arm. Default 8000.
 * Env-overridable via VERIFY_FORENSICS_WARMUP_MS.
 */
export function forensicsWarmupMs(): number {
  const raw = process.env.VERIFY_FORENSICS_WARMUP_MS;
  if (!raw) return 8_000;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) return 8_000;
  return Math.floor(v);
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

/* -------------------------------------------------------------------------- */
/* GUARDED MODE ONLY: voice-ID enforcement (phrase + voiceprint gate)           */
/* -------------------------------------------------------------------------- */

/**
 * The guarded bridge is gated on a PASSING voice-ID: before Leg B is ever
 * originated, the callee's "my voice identifies me" recording must pass BOTH
 *  (a) a usable voiceprint — analyzeClip() succeeds with >=
 *      VOICE_ID_MIN_SPEECH_SEC of VAD speech, and
 *  (b) phrase verification — the Twilio <Record transcribe> transcript
 *      fuzzy-matches the expected phrase (>=3 of the 4 content tokens).
 * While the transcript is awaited the callee is held in the voice-id-wait
 * loop; after voiceIdTranscriptTimeoutMs() with no transcript the fallback
 * ACCEPTS when the voiceprint is strong (VOICE_ID_TRANSCRIPT_MISSING logged).
 * ANY failure re-prompts and re-records; after VOICE_ID_MAX_ATTEMPTS the
 * session FAILS (polite prompt + hangup). NO BRIDGE without a pass.
 */

/** Max voice-ID record attempts before the call is failed. */
export const VOICE_ID_MAX_ATTEMPTS = 3;

/**
 * Max voice-id-wait loop polls (2s pause each, ~20s) tolerated with NO
 * attempt begun — i.e. the voice-ID <Record> action never fired (Twilio
 * action-fetch failure, or the redirect-after-Record fallback landed in the
 * wait loop). Past this cap the wait loop counts a FAILED attempt (D1) and
 * routes into the normal re-record path instead of holding the callee in
 * silence forever.
 */
export const VOICE_ID_WAIT_MAX_POLLS = 10;

/** Min VAD speech (seconds) for a voiceprint to count as usable/strong. */
export const VOICE_ID_MIN_SPEECH_SEC = 1.5;

/** Max wait for the Twilio transcript before the strong-voiceprint fallback. */
export function voiceIdTranscriptTimeoutMs(): number {
  const v = Number(process.env.VERIFY_VOICE_ID_TRANSCRIPT_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 15_000;
}

/**
 * Fuzzy phrase match for the voice-ID transcript. Expected: "my voice
 * identifies me" (or "my name identifies me"), case-insensitive. Small STT
 * substitutions are tolerated: >=3 of the 4 content token groups must be
 * present — [my], [voice|name], [identif…] (covers identify/identified),
 * [me].
 */
export function voiceIdPhraseMatches(transcript: string): boolean {
  const words = transcript
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return false;
  const groups = [
    (ws: string[]) => ws.includes("my"),
    (ws: string[]) => ws.includes("voice") || ws.includes("name"),
    (ws: string[]) => ws.some((w) => w.startsWith("identif")),
    (ws: string[]) => ws.includes("me"),
  ];
  return groups.filter((g) => g(words)).length >= 3;
}

interface VoiceIdAttempt {
  pendingSince: number;
  /** Twilio RecordingSid of this attempt's <Record> (late-transcript guard). */
  recordingSid: string;
  recordingNoted: boolean;
  /** Recording exists with usable audio (url + >=1s). */
  recordingUsable: boolean;
  /** analyzeClip succeeded AND >= VOICE_ID_MIN_SPEECH_SEC of VAD speech. */
  voiceprintStrong: boolean;
  transcriptReceived: boolean;
  transcriptMatched: boolean;
  decided: "pending" | "passed" | "failed";
  decisionReason: string;
  missingLogged: boolean;
}

interface VoiceIdState {
  attempts: number;
  current: VoiceIdAttempt | null;
  /** Transcript that raced in before the record action (rare Twilio ordering). */
  earlyTranscript: { status: string; text: string; recordingSid: string } | null;
}

const voiceIdBySession = new Map<string, VoiceIdState>();

function voiceIdState(sessionId: string): VoiceIdState {
  let st = voiceIdBySession.get(sessionId);
  if (!st) {
    st = { attempts: 0, current: null, earlyTranscript: null };
    voiceIdBySession.set(sessionId, st);
  }
  return st;
}

function newVoiceIdAttempt(recordingSid: string): VoiceIdAttempt {
  return {
    pendingSince: Date.now(),
    recordingSid,
    recordingNoted: false,
    recordingUsable: false,
    voiceprintStrong: false,
    transcriptReceived: false,
    transcriptMatched: false,
    decided: "pending",
    decisionReason: "",
    missingLogged: false,
  };
}

function applyTranscript(a: VoiceIdAttempt, status: string, text: string): void {
  a.transcriptReceived = true;
  // A completed transcription fuzzy-matches the phrase; a failed/empty one
  // can never match (counts as a mismatch → re-record, NOT the timeout
  // fallback — that is reserved for a transcript that never arrives).
  a.transcriptMatched = status === "completed" && voiceIdPhraseMatches(text.trim());
}

/**
 * The voice-ID <Record> action fired — a new attempt begins. Called once per
 * recording (initial + each re-record). Returns the 1-based attempt number.
 */
export function voiceIdBeginAttempt(sessionId: string, recordingSid = ""): number {
  const st = voiceIdState(sessionId);
  st.attempts++;
  const a = newVoiceIdAttempt(recordingSid);
  if (
    st.earlyTranscript &&
    (!recordingSid || !st.earlyTranscript.recordingSid || st.earlyTranscript.recordingSid === recordingSid)
  ) {
    applyTranscript(a, st.earlyTranscript.status, st.earlyTranscript.text);
    st.earlyTranscript = null;
  }
  st.current = a;
  return st.attempts;
}

/**
 * D3: true while `recordingSid` belongs to the CURRENT voice-ID attempt —
 * used to keep a slow processVoiceprint fetch (still retrying when a
 * re-record already began attempt N+1) from stamping its baseline/note onto
 * the new attempt. Un-correlatable (empty) SIDs are accepted, matching the
 * late-transcript guard convention; no current attempt → stale.
 */
export function voiceIdIsCurrentRecording(sessionId: string, recordingSid: string): boolean {
  const cur = voiceIdBySession.get(sessionId)?.current;
  if (!cur) return false;
  if (!recordingSid || !cur.recordingSid) return true;
  return cur.recordingSid === recordingSid;
}

/** Recording profiling outcome for the current attempt (from the action). */
export function voiceIdNoteRecording(
  sessionId: string,
  note: { usable: boolean; strong: boolean; detail: string; recordingSid?: string },
): void {
  const st = voiceIdState(sessionId);
  if (!st.current || st.current.decided !== "pending") return;
  // D3: a note from a PREVIOUS attempt's recording (its processVoiceprint
  // fetch was still retrying when the re-record began) must never land on
  // the new attempt — same guard as the stale-transcript path.
  if (
    note.recordingSid &&
    st.current.recordingSid &&
    note.recordingSid !== st.current.recordingSid
  ) {
    console.log(
      `[verify] VOICE_ID_RECORDING_STALE session=${sessionId} — profiling note for an older recording, ignoring`,
    );
    return;
  }
  st.current.recordingNoted = true;
  st.current.recordingUsable = note.usable;
  st.current.voiceprintStrong = note.strong;
  console.log(
    `[verify] VOICE_ID_RECORDING_NOTED session=${sessionId} usable=${note.usable} strong=${note.strong} | ${note.detail}`,
  );
}

/** Twilio transcribeCallback for the voice-ID recording. */
export async function voiceIdNoteTranscript(
  sessionId: string,
  note: { status: string; text: string; recordingSid?: string },
): Promise<void> {
  const st = voiceIdState(sessionId);
  if (!st.current) {
    // Transcript raced ahead of the record action — buffer it for the attempt.
    st.earlyTranscript = { status: note.status, text: note.text, recordingSid: note.recordingSid ?? "" };
    return;
  }
  if (st.current.decided !== "pending" || st.current.transcriptReceived) {
    console.log(
      `[verify] VOICE_ID_TRANSCRIPT_LATE session=${sessionId} — attempt already decided/heard, ignoring`,
    );
    return;
  }
  // A transcript from a PREVIOUS recording (late Twilio delivery after a
  // re-record) must never decide the current attempt.
  if (
    st.current.recordingSid &&
    note.recordingSid &&
    note.recordingSid !== st.current.recordingSid
  ) {
    console.log(
      `[verify] VOICE_ID_TRANSCRIPT_STALE session=${sessionId} — transcript for an older recording, ignoring`,
    );
    return;
  }
  applyTranscript(st.current, note.status, note.text);
  await logEvent(
    sessionId,
    "VOICE_ID_TRANSCRIPT",
    `status=${note.status} matched=${st.current.transcriptMatched} text="${note.text.slice(0, 200)}"`,
  );
}

export interface VoiceIdVerdict {
  status: "pending" | "passed" | "failed";
  attempts: number;
  reason: string;
}

/**
 * Current voice-ID verdict for the wait loop. Computes (and latches) the
 * per-attempt decision:
 *  - recording missing/unusable → FAILED (re-record).
 *  - transcript received: a phrase MISMATCH (including empty/failed
 *    transcriptions) → FAILED (re-record); a MATCH passes only when the
 *    voiceprint is also strong (BOTH halves required).
 *  - no transcript after voiceIdTranscriptTimeoutMs → strong-voiceprint
 *    fallback: PASS when strong (VOICE_ID_TRANSCRIPT_MISSING logged), FAIL
 *    otherwise.
 */
export async function voiceIdVerdict(sessionId: string): Promise<VoiceIdVerdict> {
  const st = voiceIdState(sessionId);
  const a = st.current;
  if (!a) return { status: "pending", attempts: st.attempts, reason: "no recording yet" };
  if (a.decided !== "pending") {
    return { status: a.decided, attempts: st.attempts, reason: a.decisionReason };
  }

  const decide = async (
    status: "passed" | "failed",
    reason: string,
    eventType: string,
  ): Promise<VoiceIdVerdict> => {
    a.decided = status;
    a.decisionReason = reason;
    console.log(`[verify] ${eventType} session=${sessionId} attempt=${st.attempts} | ${reason}`);
    await logEvent(sessionId, eventType, `attempt=${st.attempts} | ${reason}`.slice(0, 512));
    return { status, attempts: st.attempts, reason };
  };

  // Missing/unusable recording → fail the attempt immediately (re-record).
  if (a.recordingNoted && !a.recordingUsable) {
    return decide("failed", "voice-ID recording missing or unusable", "VOICE_ID_FAILED");
  }

  if (a.transcriptReceived) {
    // A phrase mismatch (wrong/empty/failed transcription) fails the attempt
    // as soon as it arrives — the callee re-records.
    if (!a.transcriptMatched) {
      return decide(
        "failed",
        `phrase mismatch — transcript did not match "my voice identifies me"`,
        "VOICE_ID_FAILED",
      );
    }
    if (a.recordingNoted) {
      // BOTH halves must pass: phrase verified AND usable voiceprint.
      if (a.voiceprintStrong) {
        return decide(
          "passed",
          "phrase matched and voiceprint usable — voice-ID verified",
          "VOICE_ID_PASSED",
        );
      }
      return decide(
        "failed",
        "phrase matched but voiceprint unusable/insufficient speech",
        "VOICE_ID_FAILED",
      );
    }
    // Profiling still running — fall through to the timeout check below.
  }

  // Profiling never completed inside the wait window — fail the attempt
  // rather than holding the callee forever.
  const elapsed = Date.now() - a.pendingSince;
  if (!a.recordingNoted && elapsed >= voiceIdTranscriptTimeoutMs()) {
    return decide(
      "failed",
      `recording profiling timed out after ${Math.round(elapsed / 1000)}s`,
      "VOICE_ID_FAILED",
    );
  }

  // Transcript-timeout fallback: the callee waited the full window with no
  // transcript — ACCEPT when the voiceprint is provably strong (logged),
  // otherwise fail the attempt and re-record.
  if (!a.transcriptReceived && a.recordingNoted && elapsed >= voiceIdTranscriptTimeoutMs()) {
    if (a.voiceprintStrong) {
      if (!a.missingLogged) {
        a.missingLogged = true;
        await logEvent(
          sessionId,
          "VOICE_ID_TRANSCRIPT_MISSING",
          `no transcript after ${Math.round(elapsed / 1000)}s — accepting on strong voiceprint`,
        );
      }
      return decide(
        "passed",
        "transcript unavailable but voiceprint strong — fallback accept",
        "VOICE_ID_PASSED",
      );
    }
    return decide(
      "failed",
      `no transcript after ${Math.round(elapsed / 1000)}s and voiceprint unusable`,
      "VOICE_ID_FAILED",
    );
  }

  return { status: "pending", attempts: st.attempts, reason: "awaiting transcript/voiceprint" };
}

/**
 * D1: the voice-id-wait loop hit its poll cap (VOICE_ID_WAIT_MAX_POLLS × 2s)
 * with NO attempt begun — the <Record> action never fired (Twilio
 * action-fetch failure, or the redirect-after-Record fallback landed in the
 * wait loop). Counts as a FAILED voice-ID attempt so the wait loop routes
 * into the normal re-record path (and the polite goodbye after
 * VOICE_ID_MAX_ATTEMPTS) instead of holding the callee in silence forever.
 * Passthrough to the normal verdict when an attempt IS in flight (the poll
 * cap only applies to the no-attempt case).
 */
export async function voiceIdNoteMissedAttempt(sessionId: string): Promise<VoiceIdVerdict> {
  const st = voiceIdState(sessionId);
  // An attempt IS in flight — the poll cap only applies to the no-attempt
  // case (the pending attempt's transcript/profiling timeouts decide it).
  if (st.current && st.current.decided === "pending") return voiceIdVerdict(sessionId);
  st.attempts++;
  const a = newVoiceIdAttempt("");
  a.decided = "failed";
  a.decisionReason = "voice-ID recording never started (<Record> action not received)";
  st.current = a;
  console.log(
    `[verify] VOICE_ID_NO_ATTEMPT session=${sessionId} attempt=${st.attempts} — counted as failed (wait poll cap)`,
  );
  await logEvent(
    sessionId,
    "VOICE_ID_NO_ATTEMPT",
    `attempt=${st.attempts} | <Record> action never fired within ${VOICE_ID_WAIT_MAX_POLLS} wait polls — counted as failed`,
  );
  return { status: "failed", attempts: st.attempts, reason: a.decisionReason };
}

/** True once the session's voice-ID has PASSED (bridge gate). */
export async function isVoiceIdPassed(sessionId: string): Promise<boolean> {
  return (await voiceIdVerdict(sessionId)).status === "passed";
}

/**
 * True while NO voice-ID attempt has begun (the <Record> action hasn't
 * fired). D1: the wait loop's poll cap only applies in this state.
 */
export function voiceIdAwaitingAttempt(sessionId: string): boolean {
  return voiceIdBySession.get(sessionId)?.current == null;
}

/**
 * The wait loop served the re-record TwiML for a FAILED attempt — clear the
 * latched attempt so subsequent wait-loop polls see "no attempt begun"
 * until the new <Record> action fires. D1: if it never fires, the poll cap
 * counts the miss as the NEXT failed attempt (3 strikes → polite goodbye)
 * instead of instantly re-serving the same re-record TwiML forever.
 */
export function voiceIdAcknowledgeFailure(sessionId: string): void {
  const st = voiceIdBySession.get(sessionId);
  if (st?.current && st.current.decided === "failed") st.current = null;
}

/**
 * Voice-ID exhausted VOICE_ID_MAX_ATTEMPTS failures → the call ends: FAILED
 * (reason logged), the caller hears notify-failed, verification legs are
 * torn down. The CALLEE leg is deliberately NOT REST-hung-up — the
 * voice-id-wait TwiML plays the polite failure prompt and hangs up itself.
 */
export async function onVoiceIdFailed(sessionId: string): Promise<void> {
  const session = await findSession(sessionId);
  if (!session || isTerminal(session)) return;
  if (
    await transition(
      session,
      VState.FAILED,
      `voice-ID verification failed after ${VOICE_ID_MAX_ATTEMPTS} attempts`,
    )
  ) {
    session.failureReason = "Voice-ID verification failed";
    session.completedAt = new Date();
    await save(session);
    await logEvent(
      sessionId,
      "VOICE_ID_EXHAUSTED",
      `voice-ID failed ${VOICE_ID_MAX_ATTEMPTS} times — call ended`,
    );
    await redirectCall(session.callerCallSid, "notify-failed", sessionId);
    await hangupAll(session, { legB: true, ringTest: true });
  }
}

/**
 * In-call voice comparison fired on a 'different' consensus. Detection only —
 * NEVER hangs up and NEVER fires challenge noise: a voice mismatch is a
 * forensic signal (event log + dashboard), while challenge noise is reserved
 * for the SpeakerphoneDetector.onSuspicious path exclusively. Throttled to
 * one event write per voiceMismatchThrottleMs().
 */
export async function onVoiceMismatch(sessionId: string, detail: string): Promise<void> {
  const last = lastVoiceMismatchAt.get(sessionId) ?? -Infinity;
  if (Date.now() - last < voiceMismatchThrottleMs()) return;
  lastVoiceMismatchAt.set(sessionId, Date.now());
  console.warn(`[verify] VOICE_MISMATCH session=${sessionId} | ${detail}`);
  await logEvent(sessionId, "VOICE_MISMATCH", detail);
}

/**
 * Drop all per-session in-process map entries. Call whenever a session reaches
 * a terminal state so these short-lived Maps can't grow unboundedly over the
 * process lifetime. Safe to call for unknown/already-cleaned sessionIds.
 */
function cleanupSessionMaps(sessionId: string): void {
  pendingLegBAnswer.delete(sessionId);
  mergeWatchArmedAt.delete(sessionId);
  bridgedSessions.delete(sessionId);
  noiseInjectionCount.delete(sessionId);
  lastNoiseEventAt.delete(sessionId);
  voiceBaselineBySession.delete(sessionId);
  lastVoiceMismatchAt.delete(sessionId);
  voiceIdBySession.delete(sessionId);
  secondCallEngagedSessions.delete(sessionId);
  disarmMergeTone(sessionId);
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
 * Guarded live-bridge TwiML URL. The `leg` param tells the webhook which
 * conference ROLE to serve: Leg A is the ANCHOR (startConferenceOnEnter:
 * true — the conference exists the moment the callee enters), the caller is
 * the JOINER (false — it can never spawn a duplicate same-name conference,
 * the classic Twilio race that strands both parties alone in silence; if the
 * caller arrives first it simply waits in the lobby for the anchor).
 */
export function bridgeUrl(sessionId: string, leg: "caller" | "legA"): string {
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

/** GUARDED MODE ONLY: Twilio transcription callback for the voice-ID <Record>. */
export function voiceprintTranscriptionUrl(sessionId: string): string {
  return `${requirePublicBaseUrl()}/api/verify/voiceprint-transcription?sid=${sessionId}`;
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
    // GUARDED MODE ONLY: voice-ID attempt failed (phrase mismatch / unusable
    // recording) — re-prompt before re-recording.
    voiceIdRetry:
      e.VERIFY_PROMPT_VOICE_ID_RETRY ??
      "That didn't match. Please try again. After the beep, say: my voice identifies me.",
    // GUARDED MODE ONLY: all voice-ID attempts exhausted — polite goodbye.
    voiceIdFailed:
      e.VERIFY_PROMPT_VOICE_ID_FAILED ??
      "We could not verify your voice. This call will now end. Goodbye.",
    // GUARDED MODE ONLY: spoken after the voice-ID recording; the SECOND
    // press-1 is the explicit trigger that originates Leg B. The callee is
    // pre-taught the call-waiting choreography: answering the second call
    // puts THIS call on hold on their handset, so they must know the second
    // call ends by itself (the engine hangs Leg B up at bridge time) and
    // returns them here.
    secondCall:
      e.VERIFY_PROMPT_SECOND_CALL ??
      "Do not end this call. You will receive a second call — please answer it. It will end by itself and return you to this call. Press 1 to continue.",
    // GUARDED MODE ONLY: the softphone caller hears this after the outbound
    // SDK call connects (parked in the conference while Leg A is verified).
    callerConnect:
      e.VERIFY_PROMPT_CALLER_CONNECT ??
      "Please wait while we connect your call.",
    ready:
      e.VERIFY_PROMPT_READY ??
      "Do not end this call. You will receive a second call — please answer it. It will end by itself and return you to this call. Press 1 to continue.",
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
      bridgeRecordingSid: session.bridgeRecordingSid,
      bridgeRecordingUrl: session.bridgeRecordingUrl,
      bridgeRecordingDurationSec: session.bridgeRecordingDurationSec,
      bridgeRecordedAt: session.bridgeRecordedAt,
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

/* -------------------------------------------------------------------------- */
/* BRIDGED in-call merge detection — continuous ARMED merge tone (v3)           */
/* -------------------------------------------------------------------------- */

/**
 * v3 design (replaces v2's periodic probe scheduler, which could take a full
 * probe interval to notice a merge): mid-call merges are detected by TRIGGER,
 * not by interval. When the HoldDetector on Leg A's uplink sees the callee
 * engage a SECOND call (call-waiting / add-call: sustained hold silence or a
 * steady hold tone after real speech), onSecondCallEngaged() ARMS the merge
 * tone — a 0.5s DTMF-'9' BEEP announced to the LEG A conference participant
 * ONLY every mergeToneRearmMs() (default 2s). Beeps, not a continuous tone:
 * a participant announce REPLACES that participant's conference audio while
 * it plays, so a continuous tone silenced the callee for the whole armed
 * episode (live-test bug). The instant the callee presses "merge", a beep
 * crosses into Leg A's own uplink and the stream-side MergeToneDetector
 * fires (300ms streak — fits inside one beep): verdict within 1-3 s of the
 * actual merge (worst case ~2s to the next beep + 300ms + REST).
 * The speakerphone onSuspicious path NEVER arms the tone — suspicion is
 * handled by the caller-targeted challenge noise alone, so relay detection
 * has no hangup path and the family never hears the DTMF tone during a pure
 * speakerphone relay.
 * Unarmed tone fires are ignored (MERGE_TONE_UNARMED) so self-echo of the
 * armed tone into a NON-merged handset and ambient tone-like audio can no
 * longer false-positive a verdict.
 */

/**
 * Re-announce cadence (ms) while the merge tone is armed (default 2s). The
 * armed tone is a 0.5s BEEP every 2s — NOT a continuous tone: a Twilio
 * participant announce REPLACES that participant's conference audio while it
 * plays, so the old 5s-tone/4.5s-rearm pattern stomped the callee's audio
 * >100% of the armed time (the "silence from the moment we connected" live
 * symptom). Beeps occupy 25% of the armed time and still close the detection
 * budget in 1-3s (worst case ~2s to the next beep + 300ms streak + verdict).
 */
export function mergeToneRearmMs(): number {
  const v = Number(process.env.VERIFY_MERGE_TONE_REARM_MS);
  return Number.isFinite(v) && v > 0 ? v : 2_000;
}

/**
 * Merge-tone render length (s) — also the served merge-tone.wav duration.
 * Default 0.5 (a BEEP; see mergeToneRearmMs). The Goertzel streak needs
 * 300ms of continuous tone, which fits inside one 0.5s beep.
 */
export function mergeToneSec(): number {
  const v = Number(process.env.VERIFY_MERGE_TONE_SEC);
  return Number.isFinite(v) && v > 0 ? v : 0.5;
}

/**
 * Elevated energy floor for the ARMED mid-call recognizer (mean-square of a
 * 50 ms analysis window; the legacy pre-bridge floor is 1e6). While armed the
 * merge tone plays on Leg A's downlink at known loud amplitude, so a genuine
 * merged echo returns LOUD — the raised floor (default 2e6) rejects the much
 * quieter acoustic leakage of the tone into a NON-merged callee handset.
 */
export function mergeToneEnergyFloor(): number {
  const v = Number(process.env.VERIFY_MERGE_TONE_ENERGY_FLOOR);
  return Number.isFinite(v) && v > 0 ? v : 2e6;
}

/** Per-session re-announce timers + armed flags for the continuous tone. */
const mergeToneTimers = new Map<string, NodeJS.Timeout>();
const mergeToneArmedSessions = new Set<string>();
/**
 * Sessions with an ACTIVE HoldDetector second-call engagement. Set by
 * onSecondCallEngaged(), cleared by onSecondCallDisengaged() and by
 * cleanupSessionMaps() — while set, the disengage path (not the
 * speakerphone-cleared path) owns merge-tone disarm.
 */
const secondCallEngagedSessions = new Set<string>();

/** True while the continuous merge tone is armed for this session. */
export function isMergeToneArmed(sessionId: string): boolean {
  return mergeToneArmedSessions.has(sessionId);
}

/** True while a HoldDetector second-call engagement is active. */
export function isSecondCallEngaged(sessionId: string): boolean {
  return secondCallEngagedSessions.has(sessionId);
}

/** Stop the re-announce timer and drop the armed flag. Always safe to call. */
export function disarmMergeTone(sessionId: string): void {
  const t = mergeToneTimers.get(sessionId);
  if (t) clearInterval(t);
  mergeToneTimers.delete(sessionId);
  mergeToneArmedSessions.delete(sessionId);
}

/** Announce the merge tone to the LEG A participant only. Never throws. */
async function announceMergeTone(sessionId: string): Promise<void> {
  try {
    const session = await findSession(sessionId);
    // Left BRIDGED (terminal transition / teardown raced a rearm) → disarm.
    if (!session || session.state !== VState.BRIDGED) {
      disarmMergeTone(sessionId);
      return;
    }
    if (!session.legACallSid) {
      console.warn(`[verify] MERGE_TONE_SKIPPED session=${sessionId} — no Leg A leg`);
      return;
    }
    const base = getPublicBaseUrl();
    if (!base) {
      console.warn(`[verify] MERGE_TONE_SKIPPED session=${sessionId} — no public base URL`);
      return;
    }
    // Twilio conferences are addressable by SID only — resolve the live one.
    const confSid = await liveConferenceSid(sessionId);
    if (!confSid) {
      console.warn(
        `[verify] MERGE_TONE_SKIPPED session=${sessionId} — no in-progress conference`,
      );
      return;
    }
    await getTwilioClient()
      .conferences(confSid)
      .participants(session.legACallSid)
      .update({
        announceUrl: `${base}/api/verify/merge-tone.wav`,
        announceMethod: "GET",
      });
    console.log(
      `[verify] MERGE_TONE_ANNOUNCED session=${sessionId} legA=${session.legACallSid} duration=${mergeToneSec()}s`,
    );
  } catch (err) {
    // Best-effort: a failed announce must never crash the media path.
    console.error(`[verify] MERGE_TONE_ANNOUNCE_FAILED session=${sessionId}:`, err);
  }
}

/**
 * Arm the merge tone for a BRIDGED session: announce immediately to the Leg
 * A participant, then re-announce every mergeToneRearmMs() with a
 * mergeToneSec()-second beep render (0.5s beep every 2s by default — the
 * detection budget still closes in 1-3s while the callee keeps 75% of their
 * conference audio). Idempotent while armed. The timer is unref'd and
 * cleared by disarmMergeTone() and by cleanupSessionMaps() on every terminal
 * transition. Errors are caught/logged — never thrown back into the media
 * path.
 */
export async function armMergeTone(sessionId: string): Promise<void> {
  try {
    const session = await findSession(sessionId);
    if (!session || session.state !== VState.BRIDGED) return;
    if (mergeToneArmedSessions.has(sessionId)) return; // idempotent
    mergeToneArmedSessions.add(sessionId);
    const timer = setInterval(() => {
      void announceMergeTone(sessionId);
    }, mergeToneRearmMs());
    timer.unref?.();
    mergeToneTimers.set(sessionId, timer);
    console.log(
      `[verify] MERGE_TONE_ARMED session=${sessionId} rearm=${mergeToneRearmMs()}ms tone=${mergeToneSec()}s`,
    );
    await announceMergeTone(sessionId);
  } catch (err) {
    console.error(`[verify] armMergeTone failed session=${sessionId}:`, err);
  }
}

/**
 * HoldDetector callback: the callee (Leg A) engaged a SECOND call — the
 * bridged call went on hold (sustained non-speech / hold tone after ≥3s of
 * live speech). BRIDGED-gated; arms the continuous merge tone so a subsequent
 * "merge" tap is caught within 1-3 s.
 */
export async function onSecondCallEngaged(sessionId: string): Promise<void> {
  try {
    const session = await findSession(sessionId);
    if (!session || session.state !== VState.BRIDGED) return;
    secondCallEngagedSessions.add(sessionId);
    await logEvent(
      sessionId,
      "SECOND_CALL_ENGAGED",
      "hold signature on Leg A uplink (sustained non-speech/hold tone after live speech) — continuous merge tone armed",
    );
    await armMergeTone(sessionId);
  } catch (err) {
    console.error(`[verify] onSecondCallEngaged failed session=${sessionId}:`, err);
  }
}

/**
 * HoldDetector callback: speech resumed ≥1s after a second-call engagement
 * (callee came back / dropped the other call WITHOUT merging). Disarms the
 * merge tone — the caller path (verification-stream.ts) already checked that
 * no speakerphone suspicion is active; if suspicion IS active the tone stays
 * armed and this handler is never invoked.
 */
export async function onSecondCallDisengaged(sessionId: string): Promise<void> {
  try {
    const session = await findSession(sessionId);
    if (!session || isTerminal(session)) return;
    secondCallEngagedSessions.delete(sessionId);
    disarmMergeTone(sessionId);
    await logEvent(
      sessionId,
      "SECOND_CALL_DISENGAGED",
      "speech resumed on Leg A uplink ≥1s — merge tone disarmed",
    );
  } catch (err) {
    console.error(`[verify] onSecondCallDisengaged failed session=${sessionId}:`, err);
  }
}

async function redirectCall(
  callSid: string | null,
  twimlKind: string,
  sessionId: string,
  bridgeLeg?: "caller" | "legA",
): Promise<void> {
  if (!callSid) return;
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
 *
 * VOICE-ID GATE (guarded only): Leg B is NEVER originated — and therefore the
 * bridge can never happen — until the voice-ID has PASSED (phrase transcript
 * match + usable voiceprint, or the logged strong-voiceprint fallback). A
 * guarded press that arrives without a pass is bounced back to the
 * voice-id-wait loop (returns false).
 *
 * Returns false when the press was rejected by the voice-ID gate (the webhook
 * re-serves the wait loop); true otherwise.
 */
export async function onCalleeReady(sessionId: string): Promise<boolean> {
  const session = await findSession(sessionId);
  if (!session) return true;
  if (session.guarded && session.state === VState.CALL_ACCEPTED) {
    if (!(await isVoiceIdPassed(sessionId))) {
      console.warn(
        `[verify] VOICE_ID_GATE_BLOCKED session=${sessionId} — second press-1 without a passing voice-ID; Leg B NOT originated`,
      );
      await logEvent(
        sessionId,
        "VOICE_ID_GATE_BLOCKED",
        "callee pressed ready before voice-ID passed — bounced to the voice-ID wait loop",
      );
      return false;
    }
  }
  if (session.state === VState.CALL_ACCEPTED) {
    await originateLegB(sessionId);
    return true;
  }
  await logEvent(
    sessionId,
    "CALLEE_READY_CONFIRMED",
    `state=${session.state} — Leg B already ringing (pre-originated at accept)`,
  );
  return true;
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
    // D2: flip the event-driven registry flag SYNCHRONOUSLY with the bridge
    // so the media-stream analyzer path starts the forensic warm-up on the
    // next audio window — not on the next DB refresh poll.
    bridgedSessions.add(sessionId);
    await logEvent(
      sessionId,
      "GUARDED_BRIDGED",
      `caller=${session.callerCallSid ?? "(none)"} legA=${session.legACallSid ?? "(none)"} — two-way live conference ${conferenceName(sessionId)}; Leg A media stream persists`,
    );
    // Verification is done: hang up the ring-test leg. Leg A's
    // <Start><Stream> survives the bridge redirect, so speakerphone
    // detection keeps running in-call.
    await hangupAll(session, { ringTest: true });
    // Bridge the two real parties into the same conference (LIVE, two-way).
    // LEG A ENTERS FIRST and is the conference anchor: in the inline path
    // (legAInline) the leg-a-tone fetch serves the anchor TwiML directly;
    // otherwise Leg A is REST-redirected here BEFORE the caller. The caller
    // always joins with startConferenceOnEnter: false (bridgeUrl role), so a
    // near-simultaneous arrival can never spawn a duplicate same-name
    // conference stranding both parties alone in silence.
    if (!opts.legAInline) {
      await redirectCall(session.legACallSid, "guarded-bridge", sessionId, "legA");
    }
    await redirectCall(session.callerCallSid, "guarded-bridge", sessionId, "caller");
    // LEG B TEARDOWN — the two-way-audio fix. Reaching LEG_B_ANSWERED means
    // the callee ANSWERED the verification second call via call waiting,
    // which puts Leg A ON HOLD on their handset. Bridging a held line
    // conferences silence both ways (the caller talks to a muted held call;
    // the callee is listening to Leg B's silent detector loop). Ending Leg B
    // server-side makes the handset return to Leg A — now the live
    // conference — restoring two-way audio. Leg B's completion status then
    // lands while BRIDGED and is ignored by onCallCompleted (verified path).
    if (session.legBCallSid) {
      await logEvent(
        sessionId,
        "LEG_B_PASS_TEARDOWN",
        `sid=${session.legBCallSid} — verification second call ended at bridge time so the callee's handset returns to Leg A (call waiting had it on hold)`,
      );
      await hangupCall(session.legBCallSid);
    }
    // The pre-bridge merge tone stops here. Mid-call merge detection is
    // TRIGGER-driven (v3): the HoldDetector on Leg A's uplink arms the
    // continuous merge tone when the callee engages a second call, and the
    // stream-side MergeToneDetector fires the instant the tone crosses a
    // merge. Nothing to start at bridge time.
    return true;
  }
  return false;
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
  // participant too; the surviving leg then hears the partner-ended notice
  // via its post-Dial <Redirect> (see below). Leg B / ring test completions
  // while BRIDGED are expected (the ring test was hung up and Leg B was torn
  // down at bridge time) and fall through untouched.
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
      if (session.guarded && (leg === "legA" || leg === "caller")) {
        // Either party ended the live bridge. The REMAINING party is inside
        // an active <Dial><Conference>, which a REST redirect CANNOT pull
        // them out of — so the "partner ended" notice is delivered by the
        // bridge TwiML itself: endConferenceOnExit on the departed leg ends
        // the conference, the surviving leg's Dial verb returns, and its
        // post-Dial <Redirect> plays notify-partner-ended and hangs up.
        // The ONE case that needs a REST hangup is a remaining leg that
        // never reached the started conference (e.g. the caller still in the
        // pre-start lobby because the anchor died before entering) — that
        // lobby has no end trigger, so detect it via the absence of a live
        // conference and hang the leg up directly.
        const remaining =
          leg === "legA" ? session.callerCallSid : session.legACallSid;
        const confSid = await liveConferenceSid(sessionId);
        if (!confSid) {
          await hangupCall(remaining);
        }
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
 * OUTER SPEAKERPHONE clear transition — the media-stream detector saw a clean
 * window after a fired suspicion. Challenge noise is finite (the exact 4s
 * probe loop) and is only re-announced while suspicion persists: re-injection
 * is driven EXCLUSIVELY by SpeakerphoneDetector.onSuspicious emissions, which
 * stop on the very clean window that fires this callback — so the pending
 * re-injection is cancelled promptly by construction (there is no engine-side
 * re-injection timer to cancel), and any in-progress announce finishes
 * naturally (≤4s). injectChallengeNoise is additionally BRIDGED-gated, so a
 * late emission after any terminal transition (e.g. MERGE_DETECTED) is a
 * no-op. The live page gets an explicit event on the next poll.
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
    // Defensive disarm: if the tone is armed but there is NO ACTIVE
    // HoldDetector second-call engagement (e.g. the disengage fired while
    // suspicion was active and deferred the disarm to this path), the clear
    // transition disarms it — otherwise the callee would keep hearing the
    // tone for the rest of the call. While an engagement IS active the tone
    // stays armed: the disengage path owns that disarm. (The speakerphone
    // suspicion path itself NEVER arms the tone.)
    if (
      session.state === VState.BRIDGED &&
      isMergeToneArmed(sessionId) &&
      !secondCallEngagedSessions.has(sessionId)
    ) {
      disarmMergeTone(sessionId);
      console.log(
        `[verify] MERGE_TONE_DISARMED session=${sessionId} — speakerphone suspicion cleared, no active second-call engagement`,
      );
      await logEvent(
        sessionId,
        "MERGE_TONE_DISARMED",
        "speakerphone suspicion cleared with no active second-call engagement — merge tone disarmed",
      );
    }
    await logEvent(
      sessionId,
      "SPEAKERPHONE_CLEARED",
      `callee audio returned to normal; no further challenge-noise injections (caller-targeted) | ${reason}`.slice(0, 512),
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
 * OUTER SPEAKERPHONE case — inject the relayguard challenge noise toward the
 * CALLER (inmate, browser softphone leg) participant ONLY via a Twilio
 * conference announce. The noise is a forensic challenge aimed at the party
 * the suspicion is ABOUT: with the noise on the inmate's downlink they can't
 * hear the callee clearly while the call is being relayed over speakerphone
 * and are prompted to take it off speaker to hear better. The callee/Leg A
 * participant NEVER gets this noise — Leg A's participant announce channel is
 * reserved EXCLUSIVELY for the in-call merge tone (armMergeTone): a new
 * participant announce replaces the in-progress one, so announcing noise to
 * Leg A would kill the DTMF merge tone and mask its return path (the exact
 * live-test bug this retarget fixes). The call CONTINUES: this never hangs
 * up or redirects any leg.
 *
 * If the session has no callerCallSid the announce is skipped (logged) — we
 * do NOT fall back to the Leg A (callee) leg.
 *
 * SUSTAINED MASKING: while outer-speakerphone suspicion persists during the
 * live (bridged) call, the SpeakerphoneDetector re-invokes the suspicion
 * handler every refireMs (default 4s — the exact length of the seamless
 * probe loop), and each emission re-announces the noise to the caller via
 * this function — so the masking is CONTINUOUS for the whole suspicious
 * episode, never a one-shot. Re-announces are NOT suppressed by anything on
 * the forensic path: the only suppression is the mutual exclusion in
 * handleSpeakerphoneSuspicious — while the in-call merge system owns the
 * moment (merge tone ARMED by a HoldDetector second-call engagement, or the
 * session MERGE_DETECTED/terminal) the noise is skipped entirely
 * (NOISE_SUPPRESSED_MERGE_ACTIVE) so it can never interrupt the DTMF merge
 * tone. When audio returns to normal, re-injection stops on the first clean
 * 1s window (SPEAKERPHONE_CLEARED) and any in-progress 4s loop finishes
 * naturally. Every injection is counted; SPEAKERPHONE_SUSPECTED event
 * WRITES are throttled to one per noiseEventThrottleMs() (default 30s) per
 * episode while the announce re-injection itself is unthrottled.
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
    // Only inject once the call is BRIDGED — before that there is no live
    // inmate↔callee conversation to challenge (the caller may not even be in
    // the conference yet), so a conference announce could 404. Suspicion
    // detected on pre-bridge audio (ringback, IVR prompts) is ignored by
    // design.
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
        `challenge-noise injection #${injection} at ${new Date().toISOString()} target=caller-inmate | ${reason}`.slice(0, 512),
      );
    } else {
      console.log(
        `[verify] SPEAKERPHONE_SUSPECTED session=${sessionId} injection #${injection} — event write throttled (re-injecting noise only)`,
      );
    }
    if (isTerminal(session)) return;
    if (!session.callerCallSid) {
      console.warn(`[verify] SPEAKERPHONE_SUSPECTED session=${sessionId} — no caller (inmate) leg, skipping announce`);
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
    // CALLER participant ONLY — NEVER the Leg A (callee) participant: Leg A's
    // announce channel belongs to the DTMF merge tone, and a competing
    // announce there would replace/kill it (see the docstring above).
    await getTwilioClient()
      .conferences(confSid)
      .participants(session.callerCallSid)
      .update({
        announceUrl: `${base}/api/verify/challenge-noise.wav`,
        announceMethod: "GET",
      });
    console.log(
      `[verify] CHALLENGE_NOISE_INJECTED session=${sessionId} caller=${session.callerCallSid} target=caller-inmate | ${reason}`,
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
          target: "caller-inmate",
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
