/**
 * HoldDetector — second-call (call-waiting / add-call) engagement detection on
 * the Leg A (callee) uplink, BRIDGED sessions only.
 *
 * Why this exists (v3 design): when the callee taps "add call" / answers
 * call-waiting, our bridged call is placed ON HOLD by their phone. The uplink
 * then carries either silence/comfort noise (typical mobile hold) or a steady
 * narrowband hold tone/music-on-hold, where moments earlier there was live
 * two-way speech. That signature — real speech first, THEN sustained
 * non-speech or a steady tone — is the trigger that arms the continuous merge
 * tone (api/verification.ts armMergeTone), replacing v2's fixed-interval probe
 * scheduler. Detection is therefore event-driven: the merge verdict can fire
 * within 1-3 s of the callee pressing merge, independent of any probe tick.
 *
 * DSP notes:
 * - Consumes the exact same 8 kHz μ-law frames as MergeToneDetector /
 *   SpeakerphoneDetector (base64 Twilio media payloads, 20 ms each).
 * - Short-term energy = mean square of the μ-law-decoded frame.
 * - A frame is SPEECH-like when its energy exceeds the speech floor AND the
 *   recent signal is NOT steady. A frame is TONE-like (a candidate hold
 *   tone) when energy is above the silence band but the last ~0.5 s is steady
 *   (low coefficient of variation of both energy and zero-crossing rate) —
 *   steady-state sinusoids/beeps are not speech. Everything else (silence,
 *   comfort noise) is hold-like non-speech.
 * - ENGAGE rule: ≥ VERIFY_SECOND_CALL_PRIOR_SPEECH_MS (default 3000 ms) of
 *   accumulated speech since arm/last disengage, THEN sustained hold-like
 *   audio for ≥ VERIFY_SECOND_CALL_HOLD_MS (default 2500 ms) — fires
 *   onSecondCallEngaged exactly once per engagement.
 * - DISENGAGE rule: speech resumes for ≥ VERIFY_SECOND_CALL_RESUME_MS
 *   (default 1000 ms) after an engagement — fires onSecondCallDisengaged and
 *   re-arms the engage rule (fresh prior-speech accumulation).
 * - The detector is INERT while disarmed; the stream layer arms it only
 *   while the verification session is BRIDGED (verification store check).
 */
import { decodeMulaw } from "../verification-stream";

const SAMPLE_RATE = 8000;
/** Twilio Media Streams frames are 20 ms (160 samples @ 8 kHz). */
const FRAME_MS = 20;

/** Hold-signature sustain time before an engagement fires (default 2.5 s). */
export function secondCallHoldMs(): number {
  const v = Number(process.env.VERIFY_SECOND_CALL_HOLD_MS);
  return Number.isFinite(v) && v > 0 ? v : 2_500;
}

/** Prior live speech required before a hold can count (default 3 s). */
export function secondCallPriorSpeechMs(): number {
  const v = Number(process.env.VERIFY_SECOND_CALL_PRIOR_SPEECH_MS);
  return Number.isFinite(v) && v >= 0 ? v : 3_000;
}

/** Resumed speech needed to disengage after an engagement (default 1 s). */
export function secondCallResumeMs(): number {
  const v = Number(process.env.VERIFY_SECOND_CALL_RESUME_MS);
  return Number.isFinite(v) && v > 0 ? v : 1_000;
}

/**
 * Speech energy floor (mean-square of int16 samples @ 8 kHz). Normal speech
 * sits at 1e6-1e8; comfort noise and line hiss stay well under 1e5.
 */
export function secondCallSpeechFloor(): number {
  const v = Number(process.env.VERIFY_SECOND_CALL_SPEECH_FLOOR);
  return Number.isFinite(v) && v > 0 ? v : 5e5;
}

export interface HoldDetectorOptions {
  /** Session id passed through to the callbacks. */
  sessionId?: string;
  /** Overrides (default: the VERIFY_SECOND_CALL_* env getters above). */
  holdMs?: number;
  priorSpeechMs?: number;
  resumeMs?: number;
  speechFloor?: number;
  /** Initial armed state (default false — inert until the session bridges). */
  armed?: boolean;
  onSecondCallEngaged?: (sessionId: string) => void;
  onSecondCallDisengaged?: (sessionId: string) => void;
}

export class HoldDetector {
  private readonly sid: string;
  private readonly holdMs: number;
  private readonly priorSpeechMs: number;
  private readonly resumeMs: number;
  private readonly speechFloor: number;
  private readonly onEngaged?: (sessionId: string) => void;
  private readonly onDisengaged?: (sessionId: string) => void;

  private armed: boolean;
  /** Accumulated speech (ms) since arm / last disengage. */
  private speechMs = 0;
  /** Consecutive hold-like audio (ms) while not engaged. */
  private holdLikeMs = 0;
  /** Consecutive speech (ms) observed while engaged. */
  private resumeSpeechMs = 0;
  private engaged = false;

  /** Rolling per-frame history for the steadiness test (~0.5 s). */
  private static readonly STEADY_FRAMES = 25;
  private energies: number[] = [];
  private zcrs: number[] = [];

  constructor(opts: HoldDetectorOptions = {}) {
    this.sid = opts.sessionId ?? "";
    this.holdMs = opts.holdMs ?? secondCallHoldMs();
    this.priorSpeechMs = opts.priorSpeechMs ?? secondCallPriorSpeechMs();
    this.resumeMs = opts.resumeMs ?? secondCallResumeMs();
    this.speechFloor = opts.speechFloor ?? secondCallSpeechFloor();
    this.armed = opts.armed ?? false;
    this.onEngaged = opts.onSecondCallEngaged;
    this.onDisengaged = opts.onSecondCallDisengaged;
  }

  /** Arm/disarm from the stream layer (armed only while BRIDGED). */
  setArmed(armed: boolean): void {
    if (this.armed === armed) return;
    this.armed = armed;
    if (!armed) this.reset();
  }

  get isArmed(): boolean {
    return this.armed;
  }

  get isEngaged(): boolean {
    return this.engaged;
  }

  private reset(): void {
    this.speechMs = 0;
    this.holdLikeMs = 0;
    this.resumeSpeechMs = 0;
    this.engaged = false;
    this.energies = [];
    this.zcrs = [];
  }

  /** Feed one Twilio media payload (base64 μ-law, 8 kHz mono). */
  push(payloadB64: string): void {
    const bytes = Buffer.from(payloadB64, "base64");
    const pcm = new Array<number>(bytes.length);
    for (let i = 0; i < bytes.length; i++) pcm[i] = decodeMulaw(bytes[i]);
    this.pushSamples(pcm);
  }

  /** Feed decoded 16-bit PCM samples (8 kHz mono), chunked into 20 ms frames. */
  pushSamples(samples: ArrayLike<number>): void {
    const frameLen = (SAMPLE_RATE * FRAME_MS) / 1000;
    for (let off = 0; off + frameLen <= samples.length; off += frameLen) {
      this.pushFrame(samples, off, frameLen);
    }
  }

  private pushFrame(samples: ArrayLike<number>, off: number, len: number): void {
    // Per-frame short-term energy + zero-crossing rate.
    let e = 0;
    let zc = 0;
    let prev = samples[off];
    for (let i = 0; i < len; i++) {
      const s = samples[off + i];
      e += s * s;
      if ((s >= 0) !== (prev >= 0) && (s !== 0 || prev !== 0)) zc++;
      prev = s;
    }
    const energy = e / len;
    const zcr = zc / len;
    this.energies.push(energy);
    this.zcrs.push(zcr);
    if (this.energies.length > HoldDetector.STEADY_FRAMES) this.energies.shift();
    if (this.zcrs.length > HoldDetector.STEADY_FRAMES) this.zcrs.shift();

    if (!this.armed) return;

    const speech = energy > this.speechFloor && !this.isSteady();
    // hold-like = silence/comfort noise (below the speech floor) OR a steady
    // narrowband hold tone (above the floor but not speech-like).
    if (!this.engaged) {
      if (speech) {
        this.speechMs += FRAME_MS;
        this.holdLikeMs = 0;
        return;
      }
      this.holdLikeMs += FRAME_MS;
      if (this.speechMs >= this.priorSpeechMs && this.holdLikeMs >= this.holdMs) {
        // Second call engaged: real conversation went quiet/held and stayed
        // that way. Fire once; disengage requires resumed speech below.
        this.engaged = true;
        this.resumeSpeechMs = 0;
        try {
          this.onEngaged?.(this.sid);
        } catch (err) {
          console.warn("[hold-detector] onSecondCallEngaged failed:", (err as Error).message);
        }
      }
      return;
    }

    // Engaged: wait for speech to resume (callee came back / dropped the
    // second call without merging).
    if (speech) {
      this.resumeSpeechMs += FRAME_MS;
      if (this.resumeSpeechMs >= this.resumeMs) {
        this.engaged = false;
        this.speechMs = this.resumeSpeechMs; // resumed speech counts toward re-arm
        this.holdLikeMs = 0;
        this.resumeSpeechMs = 0;
        try {
          this.onDisengaged?.(this.sid);
        } catch (err) {
          console.warn("[hold-detector] onSecondCallDisengaged failed:", (err as Error).message);
        }
      }
    } else {
      this.resumeSpeechMs = 0;
    }
  }

  /**
   * Steadiness over the rolling ~0.5 s history: a steady narrowband hold tone
   * has near-constant energy AND near-constant zero-crossing rate. Speech
   * (even a sustained vowel) modulates both. Silence is handled by the energy
   * floor, not this test.
   */
  private isSteady(): boolean {
    const n = this.energies.length;
    if (n < HoldDetector.STEADY_FRAMES) return false;
    const eMean = this.energies.reduce((a, b) => a + b, 0) / n;
    if (eMean <= 0) return false;
    const eVar = this.energies.reduce((a, b) => a + (b - eMean) * (b - eMean), 0) / n;
    const eCV = Math.sqrt(eVar) / eMean;
    if (eCV >= 0.15) return false;
    const zMean = this.zcrs.reduce((a, b) => a + b, 0) / n;
    if (zMean <= 0) return false;
    const zVar = this.zcrs.reduce((a, b) => a + (b - zMean) * (b - zMean), 0) / n;
    return Math.sqrt(zVar) / zMean < 0.15;
  }
}
