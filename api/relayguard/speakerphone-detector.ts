/**
 * Speakerphone / relay detector — runs the vendored relayguard DSP on live
 * μ-law media-stream frames.
 *
 * Frames (base64 μ-law, 8 kHz mono, exactly as Twilio Media Streams delivers
 * them) are μ-law-decoded, buffered into ~1 s windows, profiled with
 * analyzeClip() and compared against a rolling baseline with compareClips().
 * A window counts as suspicious when the verdict pipeline says
 * 'SUSPICIOUS RELAY' or the relay fingerprint on the window is RED.
 *
 * onSuspicious(score, detail) fires after `consecutiveWindows` CONSECUTIVE
 * suspicious windows (default 3 — ~3 s of SUSTAINED speakerphone-relay
 * detection before the forensic challenge arms; wired from
 * VERIFY_SPEAKERPHONE_ARM_WINDOWS by verification-stream.ts).
 *
 * ARMING BAR (forensic precision): a window only counts as ARMING-suspicious
 * when the verdict pipeline says 'SUSPICIOUS RELAY' AND the window's relay
 * fingerprint is RED (score >= 0.6). AMBER (or a RED fingerprint with a
 * non-suspicious verdict) NEVER arms — handset speech/ringback/IVR audio
 * routinely scores AMBER, and the live-test false arm came from exactly that.
 *
 * CALIBRATION WARM-UP: the stream layer calls setBridged(true) when the
 * session enters BRIDGED. That moment RESETS the rolling baseline (the
 * pre-bridge baseline was built from ringback/IVR audio — comparing live
 * conversation against it is what false-armed the detector ~3 s into the
 * bridge) and starts a warm-up window (warmupMs, wired from
 * VERIFY_FORENSICS_WARMUP_MS, default 8000): windows are still scored
 * internally (baseline rebuild + forensic logging) but CANNOT arm. The
 * warm-up completion is logged (FORENSICS_WARMUP_COMPLETE).
 *
 * FORENSIC SCORE LOGGING: while BRIDGED, every analysis window's verdict /
 * fingerprint score+state / top contributing fingerprint features are logged,
 * throttled to one line per ~5 s, so production logs prove what the detector
 * saw. Post-fire
 * behavior (SUSTAINED MASKING —
 * replaces the old 30 s cooldown): while suspicion persists, onSuspicious
 * KEEPS firing on subsequent suspicious windows, throttled to one emission
 * per refireMs (default 4 s, matching the seamless challenge-noise loop) so
 * the Twilio conference-announce updates from injectChallengeNoise stay
 * effectively continuous. The detector resets to idle only after
 * `cleanWindowsToClear` CONSECUTIVE fingerprint-clean windows (absolute relay
 * fingerprint below CLEAN_SCORE_CEILING — baseline-independent, so a stale or
 * atypical frozen reference can never block the clear; any hop at or above
 * the ceiling resets the streak, so mid-relay dips never end the episode) —
 * and that transition fires onClean exactly once so the live analysis page
 * can return to normal on the next poll.
 * Re-arming then again requires `consecutiveWindows` consecutive suspicious
 * windows.
 * Detection is advisory — the caller (verification-stream.ts) decides what
 * to do; nothing here ever touches the call legs.
 */
import { analyzeClip, type ClipProfile } from "./features";
import {
  compareClips,
  relayFingerprint,
  type RelayFingerprint,
  type Verdict,
} from "./compare";
import { decodeMulaw } from "../verification-stream";

const SAMPLE_RATE = 8000;
/**
 * Prison-phone channel THRESHOLDS: both legs of a live call are already
 * 8 kHz μ-law telephony, so the "poor" margins apply directly to the live
 * profiles. applyBaseline() itself is deliberately NOT applied to live audio
 * — see channel.ts (double μ-law companding + synthetic noise would destroy
 * forensic evidence, and its 3.4 kHz lowpass would erase the HF-leakage
 * feature the relay fingerprint needs).
 */
const BASELINE_MODE = "poor" as const;

/**
 * Clean-episode fingerprint ceiling: while a suspicion episode is active, a
 * hop counts toward clearing ONLY when its absolute relay fingerprint is
 * below this score. The ceiling sits between the two populations the
 * end-to-end simulation measures on 1 s hops: sustained speakerphone-relay
 * audio never dips below ≈0.55 (AGC-lifted bed → gapContrast/noiseBed stay
 * high even between bursts), while genuine direct audio — now that vad.ts
 * measures real gap depth on single-burst windows instead of falling back to
 * a relay-like default — lands ≤0.45. Clearing on the ABSOLUTE fingerprint
 * (not the relative verdict) makes the clear immune to the frozen-baseline
 * content noise that made verdict-based clearing unreliable: same-voice 1 s
 * windows differ in thinness by up to ~0.4 from phoneme content alone, far
 * past the 0.08 channel-vote margin, so a verdict against a stale reference
 * can read SUSPICIOUS on perfectly normal audio.
 */
const CLEAN_SCORE_CEILING = 0.5;

/** Top-3 contributing relay-fingerprint features, highest score first. */
function topFingerprintFeatures(fp: RelayFingerprint): string {
  return Object.entries(fp.components)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
    .join(",");
}

export interface SpeakerphoneDetectorOptions {
  /** Analysis window in seconds (default 1). */
  windowSec?: number;
  /**
   * Hop between consecutive analyses in seconds (default = windowSec, i.e.
   * non-overlapping windows — the legacy behavior the unit tests rely on).
   * Production wiring (verification-stream.ts) uses 0.5: every hop the
   * TRAILING `windowSec` of audio is analyzed, so a relay starting mid-call
   * produces its first full-relay analysis within ~1.5 s instead of up to 2 s,
   * and 2 consecutive suspicious hops land within the 2 s pickup budget.
   */
  hopSec?: number;
  /** Consecutive suspicious windows required before (re-)firing (default 3). */
  consecutiveWindows?: number;
  /**
   * Minimum wall-clock ms between emissions while suspicion persists
   * (default 4_000, matching the 4-second challenge-noise loop). After the
   * initial trigger the detector keeps emitting on each suspicious window once
   * this interval has passed (sustained challenge-noise masking); a clean
   * window resets to idle.
   */
  refireMs?: number;
  /**
   * Calibration warm-up (ms) after entering BRIDGED during which arming is
   * suppressed while the rolling baseline rebuilds (default 0 = no warm-up;
   * verification-stream.ts wires VERIFY_FORENSICS_WARMUP_MS, default 8000).
   */
  warmupMs?: number;
  /**
   * Initial BRIDGED flag (default false). The stream layer flips it via
   * setBridged() when the verification session enters BRIDGED.
   */
  bridged?: boolean;
  /**
   * When true, suspicious windows accumulate a streak ONLY while BRIDGED
   * (default false — the detector stays a pure streak/refire state machine).
   * Wired by verification-stream.ts (D2): pre-bridge audio is ringback/IVR
   * — and between the actual bridge and the bridged flag arriving (registry
   * / DB poll) windows would otherwise be scored with bridged=false, no
   * warm-up suppression and a live IVR-era baseline, letting ≥3 false-RED
   * windows fire the challenge BEFORE the warm-up starts. Freezing the
   * streak while !bridged closes that race.
   */
  armOnlyWhenBridged?: boolean;
  /**
   * Consecutive MATCH-verdict windows required to clear a fired suspicion
   * (default 2; production wiring uses 6 ≈ 3 s at the 0.5 s hop). Sustained
   * relay audio routinely produces borderline UNCERTAIN / AMBER-fingerprint
   * windows mid-episode, and counting those as "clean" is exactly what
   * silenced the challenge noise after ~3 s while the relay was still
   * playing. Borderline windows leave the clean streak untouched (they
   * neither advance nor reset it); only a suspicious window resets it.
   */
  cleanWindowsToClear?: number;
  /** Called when speakerphone use is suspected. score ∈ 0..1 (relay fp). */
  onSuspicious?: (score: number, detail: string) => void;
  /** Called once when a fired suspicion clears on a clean analysis window. */
  onClean?: (detail: string) => void;
  /** Called once when the post-BRIDGED calibration warm-up completes. */
  onWarmupComplete?: (detail: string) => void;
}

/** Min wall-clock ms between throttled per-window forensic score logs. */
const FORENSIC_LOG_THROTTLE_MS = 5_000;

export class SpeakerphoneDetector {
  private readonly win: number;
  private readonly hop: number;
  private readonly need: number;
  private readonly refire: number;
  private readonly warmup: number;
  private readonly onSuspicious?: (score: number, detail: string) => void;
  private readonly onClean?: (detail: string) => void;
  private readonly onWarmupComplete?: (detail: string) => void;
  private readonly cleanNeed: number;
  private buf: number[] = [];
  private baseline: ClipProfile | null = null;
  private streak = 0;
  private cleanStreak = 0;
  private windows = 0;
  private lastFiredAt = 0;
  private suspecting = false;
  /** Test hook: how many times the rolling baseline was (re)built/absorbed. */
  private baselineAbsorbs = 0;
  /** BRIDGED state + warm-up bookkeeping. */
  private readonly armOnlyWhenBridged: boolean;
  private bridged: boolean;
  private bridgedAt = 0;
  private warmupDone: boolean;
  private warmupWindows = 0;
  private lastForensicLogAt = 0;

  constructor(opts: SpeakerphoneDetectorOptions = {}) {
    this.win = Math.round((opts.windowSec ?? 1) * SAMPLE_RATE);
    this.hop = Math.max(1, Math.round((opts.hopSec ?? opts.windowSec ?? 1) * SAMPLE_RATE));
    this.need = opts.consecutiveWindows ?? 3;
    this.refire = opts.refireMs ?? 4_000;
    this.warmup = Math.max(0, opts.warmupMs ?? 0);
    this.onSuspicious = opts.onSuspicious;
    this.onClean = opts.onClean;
    this.onWarmupComplete = opts.onWarmupComplete;
    this.armOnlyWhenBridged = opts.armOnlyWhenBridged ?? false;
    this.cleanNeed = Math.max(1, opts.cleanWindowsToClear ?? 2);
    this.bridged = opts.bridged ?? false;
    this.warmupDone = this.warmup <= 0;
    if (this.bridged) this.bridgedAt = Date.now();
  }

  /**
   * Stream-layer hook: the verification session entered/left BRIDGED. On the
   * false → true transition the rolling baseline is RESET (it was built from
   * pre-bridge ringback/IVR audio — comparing live conversation against it is
   * what false-armed the detector seconds into the live-test bridge) and the
   * calibration warm-up starts: windows keep being scored internally but
   * cannot arm for warmupMs. Idempotent while already bridged.
   */
  setBridged(bridged: boolean): void {
    if (bridged === this.bridged) return;
    this.bridged = bridged;
    if (!bridged) return;
    this.bridgedAt = Date.now();
    this.warmupDone = this.warmup <= 0;
    this.warmupWindows = 0;
    this.baseline = null;
    this.streak = 0;
    this.cleanStreak = 0;
    this.suspecting = false;
    if (!this.warmupDone) {
      console.log(
        `[speakerphone-detector] FORENSICS_WARMUP_START warmup=${this.warmup}ms — baseline rebuilding, arming suppressed`,
      );
    }
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
      // Sliding analysis: every `hop` samples the TRAILING `win` samples are
      // analyzed (hop == win = legacy non-overlapping behavior).
      const window = this.buf.slice(0, this.win);
      this.buf = this.buf.slice(this.hop);
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

  /**
   * True while a fired suspicion has not yet been cleared by a clean window.
   * Used by the second-call disengage path (verification-stream.ts): when
   * suspicion is active the merge tone stays armed even if the hold detector
   * sees speech resume.
   */
  get isSuspecting(): boolean {
    return this.suspecting;
  }

  /** Test hook: number of times the rolling baseline was seeded/absorbed. */
  get baselineAbsorptions(): number {
    return this.baselineAbsorbs;
  }

  /**
   * Refresh the rolling baseline with new reference audio. HARD RULES:
   * never while a suspicion episode is active (the reference must stay
   * "normal direct-call audio" for the whole episode — absorbing relayed
   * audio mid-episode makes the same audio compare MATCH forever, which is
   * exactly how the live detector went silent after 3–4 pickups), and only
   * for clearly-clean windows (MATCH verdict AND GREEN relay fingerprint —
   * AMBER/RED audio is never allowed to become the reference).
   */
  private absorbBaseline(profile: ClipProfile, verdict: Verdict, fpState: string): void {
    if (this.suspecting) return;
    if (verdict !== "MATCH" || fpState !== "GREEN") return;
    this.baseline = profile;
    this.baselineAbsorbs++;
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

    // No baseline yet: seed the rolling baseline from the first window with a
    // real turn-exchange (≥2 VAD bursts). A single-burst window (one fluent
    // sentence, a beep, ringback) is not representative enough to anchor every
    // subsequent comparison — the end-to-end simulation showed a 1-burst seed
    // window flips relay verdicts to UNCERTAIN. Windows without ≥2 bursts are
    // scored-and-skipped (fail-safe: no baseline, no arming).
    if (!this.baseline) {
      if (profile.vad.speechFrames.length > 0 && profile.vad.burstCount >= 2) {
        this.baseline = profile;
        this.baselineAbsorbs++;
      }
      return;
    }

    const result = compareClips(this.baseline, profile, BASELINE_MODE);
    const fp = relayFingerprint(profile);
    const verdict: Verdict = result.verdict;

    // FORENSIC SCORE LOGGING (BRIDGED only, throttled): every window's
    // verdict / fingerprint score+state / top contributing features — the
    // production log proves exactly what the detector saw.
    if (this.bridged && Date.now() - this.lastForensicLogAt >= FORENSIC_LOG_THROTTLE_MS) {
      this.lastForensicLogAt = Date.now();
      console.log(
        `[speakerphone-detector] FORENSIC_WINDOW window=${this.windows} verdict=${verdict} ` +
          `relayState=${fp.state} relayScore=${fp.score.toFixed(2)} ` +
          `weighted=${result.weightedScore.toFixed(2)} top=${topFingerprintFeatures(fp)} ` +
          `streak=${this.streak} warmup=${this.warmupDone ? "done" : "active"}`,
      );
    }

    // CALIBRATION WARM-UP: after entering BRIDGED the detector scores windows
    // internally (baseline rebuild above + logging) but CANNOT arm for
    // warmupMs. The completion transition is logged exactly once.
    if (this.bridged && !this.warmupDone) {
      this.warmupWindows++;
      if (Date.now() - this.bridgedAt < this.warmup) {
        // Rolling baseline keeps absorbing fresh, clearly-clean in-call audio.
        this.absorbBaseline(profile, verdict, fp.state);
        return;
      }
      this.warmupDone = true;
      const detail =
        `elapsed=${Date.now() - this.bridgedAt}ms windows=${this.warmupWindows} — ` +
        `baseline rebuilt, forensic arming live`;
      console.log(`[speakerphone-detector] FORENSICS_WARMUP_COMPLETE ${detail}`);
      this.onWarmupComplete?.(detail);
    }

    // STREAK FREEZE (D2): when armed-only-when-bridged, suspicion can only
    // accumulate once the bridged flag says BRIDGED — pre-bridge windows
    // (including the race between the actual bridge and the flag arriving
    // via the event-driven registry / DB poll) never build a streak, so a
    // delayed bridged-flag refresh can no longer fire the challenge BEFORE
    // the warm-up starts. The rolling baseline still absorbs clean audio.
    if (this.armOnlyWhenBridged && !this.bridged) {
      this.streak = 0;
      this.cleanStreak = 0;
      this.absorbBaseline(profile, verdict, fp.state);
      return;
    }

    // ARMING BAR: a window counts as suspicious ONLY when the verdict is
    // 'SUSPICIOUS RELAY' AND the relay fingerprint is RED (>= 0.6). AMBER —
    // or a bare RED with a non-suspicious verdict — never arms (handset
    // speech / ringback / IVR routinely score AMBER).
    const suspicious = verdict === "SUSPICIOUS RELAY" && fp.state === "RED";

    if (suspicious) {
      this.streak++;
      this.cleanStreak = 0;
      const detail =
        `verdict=${verdict} relayState=${fp.state} relayScore=${fp.score.toFixed(2)} ` +
        `weighted=${result.weightedScore.toFixed(2)} confidence=${Math.round(result.confidence)} ` +
        `flags=${result.flags.join(",") || "none"} streak=${this.streak}`;
      // Initial trigger after `need` consecutive suspicious windows; while
      // suspicion persists, RE-FIRE on each suspicious window once refireMs
      // has elapsed (sustained masking — no 30s cooldown lockout).
      if (this.streak >= this.need && Date.now() - this.lastFiredAt >= this.refire) {
        this.lastFiredAt = Date.now();
        this.suspecting = true;
        this.onSuspicious?.(fp.score, detail);
      }
    } else {
      // CLEAN-EPISODE HYSTERESIS + BASELINE FREEZE: while a suspicion episode
      // is active, relay-compatible audio must NOT end it — sustained relay
      // audio routinely produces UNCERTAIN / AMBER-fingerprint windows, and
      // counting those as "clean" (a) silenced the challenge noise after ~3 s
      // while the relay was still playing (the exact live-test failure) and
      // (b) let the old code absorb relayed audio into the rolling baseline,
      // after which the same audio compared MATCH forever. Suspicion now
      // clears only after `cleanNeed` CONSECUTIVE hops whose ABSOLUTE relay
      // fingerprint is below CLEAN_SCORE_CEILING (see the constant's comment
      // for why the fingerprint — not the verdict — is the clearing signal).
      // Any hop at/above the ceiling RESETS the clean streak, so the mid-relay
      // AMBER dips (≈0.55–0.6) the simulation measures can never chain into a
      // clear. The baseline stays frozen for the entire episode
      // (absorbBaseline enforces this — absorption still requires MATCH AND
      // GREEN).
      if (this.suspecting) {
        if (fp.score < CLEAN_SCORE_CEILING) {
          this.cleanStreak++;
          if (this.cleanStreak >= this.cleanNeed) {
            this.suspecting = false;
            this.streak = 0;
            this.cleanStreak = 0;
            this.onClean?.(
              `verdict=${verdict} relayState=${fp.state} relayScore=${fp.score.toFixed(2)} ` +
                `weighted=${result.weightedScore.toFixed(2)} confidence=${Math.round(result.confidence)} — ` +
                `${this.cleanNeed} consecutive fingerprint-clean windows ` +
                `(relayScore < ${CLEAN_SCORE_CEILING})`,
            );
          }
        } else {
          this.cleanStreak = 0;
        }
        return;
      }
      // Not suspecting: a non-suspicious window resets the arming streak.
      this.streak = 0;
      this.cleanStreak = 0;
      // Rolling baseline: clearly-clean windows (MATCH + GREEN fingerprint)
      // keep the reference fresh, so a slow drift (handset → speakerphone
      // mid-call) still shows up as a change.
      this.absorbBaseline(profile, verdict, fp.state);
    }
  }
}
