/**
 * Speakerphone / relay detector — runs the vendored relayguard DSP on live
 * μ-law media-stream frames.
 *
 * Frames (base64 μ-law, 8 kHz mono, exactly as Twilio Media Streams delivers
 * them) are μ-law-decoded, buffered into ~2 s windows, profiled with
 * analyzeClip() and compared against a rolling baseline with compareClips().
 * A window counts as suspicious when the verdict pipeline says
 * 'SUSPICIOUS RELAY' or the relay fingerprint on the window is RED.
 *
 * onSuspicious(score, detail) fires after 2 CONSECUTIVE suspicious windows.
 * Post-fire behavior (SUSTAINED MASKING — replaces the old 30 s cooldown):
 * while suspicion persists, onSuspicious KEEPS firing on subsequent
 * suspicious windows, throttled to one emission per refireMs (default 8 s)
 * so the Twilio conference-announce updates from injectChallengeNoise don't
 * overlap badly. The detector resets to idle only after a CLEAN
 * (non-suspicious) window — re-arming then again requires `consecutiveWindows`
 * consecutive suspicious windows. Detection is advisory — the caller
 * (verification-stream.ts) decides what to do; nothing here ever touches
 * the call legs.
 */
import { analyzeClip, type ClipProfile } from "./features";
import { compareClips, relayFingerprint, type Verdict } from "./compare";
import { decodeMulaw } from "../verification-stream";

const SAMPLE_RATE = 8000;
/** Prison-phone channel model: the live legs are 8 kHz μ-law telephony. */
const BASELINE_MODE = "poor" as const;

export interface SpeakerphoneDetectorOptions {
  /** Analysis window in seconds (default 2). */
  windowSec?: number;
  /** Consecutive suspicious windows required before (re-)firing (default 2). */
  consecutiveWindows?: number;
  /**
   * Minimum wall-clock ms between emissions while suspicion persists
   * (default 8_000). After the initial trigger the detector keeps emitting
   * on each suspicious window once this interval has passed (sustained
   * challenge-noise masking); a clean window resets to idle.
   */
  refireMs?: number;
  /** Called when speakerphone use is suspected. score ∈ 0..1 (relay fp). */
  onSuspicious?: (score: number, detail: string) => void;
}

export class SpeakerphoneDetector {
  private readonly win: number;
  private readonly need: number;
  private readonly refire: number;
  private readonly onSuspicious?: (score: number, detail: string) => void;
  private buf: number[] = [];
  private baseline: ClipProfile | null = null;
  private streak = 0;
  private windows = 0;
  private lastFiredAt = 0;

  constructor(opts: SpeakerphoneDetectorOptions = {}) {
    this.win = Math.round((opts.windowSec ?? 2) * SAMPLE_RATE);
    this.need = opts.consecutiveWindows ?? 2;
    this.refire = opts.refireMs ?? 8_000;
    this.onSuspicious = opts.onSuspicious;
  }

  /** Feed one Twilio media payload (base64 μ-law, 8 kHz mono). */
  push(payloadB64: string): void {
    const bytes = Buffer.from(payloadB64, "base64");
    const pcm = new Array<number>(bytes.length);
    for (let i = 0; i < bytes.length; i++) pcm[i] = decodeMulaw(bytes[i]);
    this.pushSamples(pcm);
  }

  /** Feed decoded 16-bit PCM samples (8 kHz mono). */
  pushSamples(samples: ArrayLike<number>): void {
    for (let i = 0; i < samples.length; i++) this.buf.push(samples[i]);
    while (this.buf.length >= this.win) {
      const window = this.buf.slice(0, this.win);
      this.buf = this.buf.slice(this.win);
      try {
        this.analyzeWindow(window);
      } catch (err) {
        // DSP must never break the media path.
        console.warn("[speakerphone-detector] analysis failed:", (err as Error).message);
      }
    }
  }

  get windowsAnalyzed(): number {
    return this.windows;
  }

  private analyzeWindow(window: number[]): void {
    this.windows++;
    // int16 → float, peak-normalized (μ-law levels vary per trunk).
    let peak = 0;
    for (const s of window) {
      const a = Math.abs(s);
      if (a > peak) peak = a;
    }
    const scale = peak > 0 ? 0.9 / peak : 1;
    const samples = new Float32Array(window.length);
    for (let i = 0; i < window.length; i++) samples[i] = window[i] * scale;

    const profile = analyzeClip(samples, SAMPLE_RATE);

    // No baseline yet: seed the rolling baseline from the first window that
    // actually contains speech; silent ring-in windows tell us nothing.
    if (!this.baseline) {
      if (profile.vad.speechFrames.length > 0) this.baseline = profile;
      return;
    }

    const result = compareClips(this.baseline, profile, BASELINE_MODE);
    const fp = relayFingerprint(profile);
    const verdict: Verdict = result.verdict;
    const suspicious = verdict === "SUSPICIOUS RELAY" || fp.state === "RED";

    if (suspicious) {
      this.streak++;
      const detail =
        `verdict=${verdict} relayState=${fp.state} relayScore=${fp.score.toFixed(2)} ` +
        `weighted=${result.weightedScore.toFixed(2)} confidence=${Math.round(result.confidence)} ` +
        `flags=${result.flags.join(",") || "none"} streak=${this.streak}`;
      // Initial trigger after `need` consecutive suspicious windows; while
      // suspicion persists, RE-FIRE on each suspicious window once refireMs
      // has elapsed (sustained masking — no 30s cooldown lockout).
      if (this.streak >= this.need && Date.now() - this.lastFiredAt >= this.refire) {
        this.lastFiredAt = Date.now();
        this.onSuspicious?.(fp.score, detail);
      }
    } else {
      // Clean window → back to idle: re-firing needs `need` fresh
      // consecutive suspicious windows again.
      this.streak = 0;
      // Rolling baseline: clean windows keep the reference fresh, so a slow
      // drift (handset → speakerphone mid-call) still shows up as a change.
      if (verdict === "MATCH") this.baseline = profile;
    }
  }
}
