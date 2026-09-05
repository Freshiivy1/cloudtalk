/**
 * SpeechActivityVad — lightweight adaptive RMS voice-activity tracker for the
 * CALLER's Leg A uplink (20 ms frames, 8 kHz μ-law decoded PCM).
 *
 * WHY THIS EXISTS (callee-only speakerphone enforcement): the live-call
 * SpeakerphoneDetector listens on Leg B's INBOUND stream — physically the
 * callee's microphone ONLY. The caller's voice can appear there in exactly
 * two ways, which are acoustically indistinguishable on that uplink alone:
 *
 *   1. the callee is genuinely on speakerphone and the caller's voice echoes
 *      back through the loudspeaker + room + mic (actionable against the
 *      callee), or
 *   2. the caller's voice bleeds into the callee's mic through the air
 *      (same-room testing) or a loud earpiece (NOT the callee's fault — the
 *      exact "it's detecting speakerphone for the caller" false positive).
 *
 * Both require THE CALLER TO BE SPEAKING. The server already receives the
 * caller's own uplink on the Leg A (hold-canary) stream, so "was the caller
 * speaking when this Leg B window was captured?" is directly observable.
 * This tracker answers that question: verification-stream.ts feeds every
 * Leg A frame here, and the Leg B detector's arming gate suppresses any
 * suspicious window whose audio may contain the caller's voice — episodes
 * can then ONLY arm from audio produced on the callee's side while the
 * caller is silent (the callee's own far-field speech on a speakerphone).
 *
 * The VAD is deliberately simple and conservative: an adaptive RMS noise
 * floor (EMA of non-speech frames) plus a fixed margin. Over-triggering
 * (marking non-speech as speech) only makes the arming gate MORE
 * conservative; under-triggering is bounded by the activity window.
 */
export interface SpeechActivityVadOptions {
  /**
   * dB a frame's RMS must exceed the adaptive noise floor by to count as
   * speech (default 12 — normal speech sits 20–40 dB above a phone-line bed).
   */
  marginDb?: number;
  /** Absolute RMS guard (dBFS): frames quieter than this are never speech
   *  (default -45 — μ-law comfort noise / line hiss). */
  guardDb?: number;
  /** EMA weight for the noise-floor update on non-speech frames (default
   *  0.05 — the floor tracks room/line changes in ~1 s). */
  floorAlpha?: number;
  /**
   * EMA weight for the SLOW upward floor drift on speech-classified frames
   * (default 0.005). Without it, a constant loud caller-side noise source
   * (TV, crowd) sits above the floor+margin forever and suppresses the
   * arming gate permanently; the slow drift re-classifies it as noise after
   * a few seconds while normal speech (pauses let the floor settle back)
   * keeps registering. Worst-case gate suppression from a constant loud
   * source: ~6 s.
   */
  floorSpeechAlpha?: number;
  /** Injectable clock (tests drive stream time). */
  now?: () => number;
}

export class SpeechActivityVad {
  private readonly marginDb: number;
  private readonly guardDb: number;
  private readonly floorAlpha: number;
  private readonly floorSpeechAlpha: number;
  private readonly nowFn: () => number;
  /** Adaptive noise floor in dBFS (starts low: early speech is never masked). */
  private floorDb = -65;
  /** Wall-clock ms of the most recent speech frame (-Infinity = never). */
  private lastSpeechAt = Number.NEGATIVE_INFINITY;
  /** Test/diagnostic counters. */
  private framesSeen = 0;
  private speechFramesSeen = 0;

  constructor(opts: SpeechActivityVadOptions = {}) {
    this.marginDb = opts.marginDb ?? 12;
    this.guardDb = opts.guardDb ?? -45;
    this.floorAlpha = opts.floorAlpha ?? 0.05;
    this.floorSpeechAlpha = opts.floorSpeechAlpha ?? 0.005;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  /**
   * Feed one decoded 20 ms frame (int16-range samples, 8 kHz mono). Returns
   * true when the frame is speech-like.
   */
  noteFrame(samples: ArrayLike<number>): boolean {
    this.framesSeen++;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = samples.length > 0 ? Math.sqrt(sum / samples.length) / 32768 : 0;
    const rmsDb = 20 * Math.log10(Math.max(rms, 1e-7));
    const speech = rmsDb >= this.guardDb && rmsDb >= this.floorDb + this.marginDb;
    if (speech) {
      this.speechFramesSeen++;
      this.lastSpeechAt = this.nowFn();
      // SLOW upward drift even on speech frames: a constant loud source (TV,
      // crowd) must eventually re-classify as noise (see floorSpeechAlpha).
      // Capped at (floor + margin) like the non-speech path, and 10× slower,
      // so ordinary speech with natural pauses is unaffected.
      const capped = Math.min(rmsDb, this.floorDb + this.marginDb);
      this.floorDb =
        (1 - this.floorSpeechAlpha) * this.floorDb + this.floorSpeechAlpha * capped;
    } else {
      // Adapt the floor from NON-speech frames only. Cap the sample at
      // (floor + margin) so a single loud non-speech burst (a click, a beep)
      // cannot drag the floor up and mask real speech afterwards.
      const capped = Math.min(rmsDb, this.floorDb + this.marginDb);
      this.floorDb = (1 - this.floorAlpha) * this.floorDb + this.floorAlpha * capped;
    }
    return speech;
  }

  /**
   * True when speech was noted within `windowMs` before `at` (default: now).
   * The window covers the Leg B detector's trailing 1 s analysis window plus
   * cross-call echo/bleed latency: any caller speech inside it could be the
   * source of the Leg B window's audio.
   */
  active(windowMs: number, at?: number): boolean {
    const t = at ?? this.nowFn();
    return t - this.lastSpeechAt <= windowMs;
  }

  get frames(): number {
    return this.framesSeen;
  }

  get speechFrames(): number {
    return this.speechFramesSeen;
  }

  /** Test hook: current adaptive floor (dBFS). */
  get noiseFloorDb(): number {
    return this.floorDb;
  }
}
