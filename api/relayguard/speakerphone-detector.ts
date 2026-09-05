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
 * CALLEE-ONLY ENFORCEMENT GATE (suppressArming option, wired by
 * verification-stream.ts from the Leg A caller-activity tracker): the detector
 * physically hears ONLY the callee's microphone (Leg B inbound). The caller's
 * voice can appear there in two acoustically-indistinguishable ways — genuine
 * speakerphone echo (actionable against the callee) and same-room/earpiece
 * bleed (never the callee's fault — the live "it's detecting speakerphone for
 * the caller" false positive). BOTH require the caller to be speaking, and
 * the caller's own Leg A uplink tells us exactly when that is. A suspicious
 * window captured while the caller was speaking within the gate window is
 * therefore NEUTRAL: no arming-streak advance, no refire, no arming-streak
 * reset (a CLEAN streak is still reset — the audio IS relay-like, so an
 * episode must not clear across it). Episodes can then arm ONLY from audio
 * captured while the caller is silent — produced on the callee's side.
 *
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
  /**
   * Callee-only enforcement gate (see the file header): consulted on every
   * window that would otherwise advance an arming streak or refire an
   * episode. Returning true marks the window NEUTRAL (the caller was
   * speaking on Leg A, so the suspicious audio may be the caller's own
   * voice via echo/bleed). Callback errors fail OPEN (no suppression) with
   * a throttled warning — a broken gate must never silently disable or
   * silently enable detection.
   */
  suppressArming?: () => boolean;
}

/** Min wall-clock ms between throttled per-window forensic score logs. */
const FORENSIC_LOG_THROTTLE_MS = 5_000;

/**
 * KNOWN-PROBE-TONE MASK — the system's own probe signals are the 852+1336 Hz
 * (DTMF-8) dual tone: the canary's loud challenge loop on Leg A AND the
 * in-call merge-tone beep bursts announced to Leg B. Both leak/echo into Leg
 * B's inbound mic path (the 2026-09-04 retest: the canary tone's held-call
 * leak scored RED 0.68 from the moment the bridge landed and fired a false
 * episode 6 s in; once the merge tone armed, each 0.5 s beep's acoustic echo
 * sustained RED hops for the rest of the call — the user heard constant
 * beeping while "speakerphone" episodes fired with no speakerphone present).
 * A window DOMINATED by the probe pair is system-generated, not speakerphone
 * audio, so it is NEUTRAL: no arming streak, no clean streak, no baseline
 * seed/absorb — the detector waits for a window it can actually judge.
 *
 * Discriminator: normalized Goertzel power p/(E·N²) at BOTH pair frequencies
 * (same scaling as MergeToneDetector — a clean dual tone scores ≈0.25 per
 * frequency, noise ≈1/N). Speech is broadband and never sustains >5% of
 * total energy at both 852 and 1336 Hz across a full 1 s window, while a
 * speakerphone relay bed is noise-like, not a coherent dual tone — so the
 * mask cannot blind the detector to genuine relay audio. A real mid-call
 * 3-way merge still trips merge-relay's loud-tone listener (its own job).
 */
const PROBE_TONE_LOW_HZ = 852;
const PROBE_TONE_HIGH_HZ = 1336;
/** Per-sub-window normalized-power threshold for BOTH pair frequencies. */
const PROBE_TONE_RATIO = 0.04;
/**
 * Single-frequency dominance escape hatch: the leak/echo path (handset audio
 * routing + AGC + μ-law) can heavily attenuate ONE of the pair, so a window
 * where one frequency holds >15% of a sub-window's power is also treated as
 * probe-dominated. Speech harmonics spread energy across many bins and
 * rarely sustain >15% in a single 852/1336 bin across 2+ sub-windows.
 */
const PROBE_TONE_SOLO_RATIO = 0.15;
/** Sub-window length for the mask scan (250 ms — the 0.5 s merge-tone beep
 *  covers exactly 2 of a 1 s window's 4 sub-windows). */
const PROBE_SUB_SAMPLES = 2000;
/** Sub-windows that must be probe-dominated for the whole window to mask. */
const PROBE_SUB_NEED = 2;

function goertzelPowerLocal(samples: ArrayLike<number>, freq: number, off: number, len: number): number {
  const w = (2 * Math.PI * freq) / SAMPLE_RATE;
  const cw = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = off; i < off + len; i++) {
    const s0 = samples[i] + cw * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - cw * s1 * s2;
}

export interface ProbeToneMeasurement {
  masked: boolean;
  /** Max normalized Goertzel power at 852 / 1336 Hz across sub-windows. */
  low: number;
  high: number;
}

/**
 * Scan the (peak-normalized) window in 250 ms sub-windows for the system's
 * own 852+1336 Hz probe signature. A window is masked when ≥PROBE_SUB_NEED
 * sub-windows are probe-dominated (both ratios > PROBE_TONE_RATIO, or a
 * single-frequency > PROBE_TONE_SOLO_RATIO). The measured max ratios are
 * returned for forensic logging — the 2026-09-04 retest showed the raw leak
 * does NOT always present as a clean dual tone, so production logs must
 * carry the real numbers for threshold tuning.
 */
function measureProbeTone(samples: ArrayLike<number>): ProbeToneMeasurement {
  let dominated = 0;
  let low = 0;
  let high = 0;
  for (let off = 0; off + PROBE_SUB_SAMPLES <= samples.length; off += PROBE_SUB_SAMPLES) {
    let e = 0;
    for (let i = off; i < off + PROBE_SUB_SAMPLES; i++) e += samples[i] * samples[i];
    e /= PROBE_SUB_SAMPLES;
    if (e < 1e-4) continue; // silent sub-window: not a probe (VAD handles silence)
    const norm = e * PROBE_SUB_SAMPLES * PROBE_SUB_SAMPLES;
    const rl = goertzelPowerLocal(samples, PROBE_TONE_LOW_HZ, off, PROBE_SUB_SAMPLES) / norm;
    const rh = goertzelPowerLocal(samples, PROBE_TONE_HIGH_HZ, off, PROBE_SUB_SAMPLES) / norm;
    if (rl > low) low = rl;
    if (rh > high) high = rh;
    if (
      (rl > PROBE_TONE_RATIO && rh > PROBE_TONE_RATIO) ||
      rl > PROBE_TONE_SOLO_RATIO ||
      rh > PROBE_TONE_SOLO_RATIO
    ) {
      dominated++;
    }
  }
  return { masked: dominated >= PROBE_SUB_NEED, low, high };
}

export class SpeakerphoneDetector {
  private readonly win: number;
  private readonly hop: number;
  private readonly need: number;
  private readonly refire: number;
  private readonly warmup: number;
  private readonly onSuspicious?: (score: number, detail: string) => void;
  private readonly onClean?: (detail: string) => void;
  private readonly onWarmupComplete?: (detail: string) => void;
  private readonly suppressArming?: () => boolean;
  private lastGateLogAt = 0;
  private readonly cleanNeed: number;
  private buf: number[] = [];
  private baseline: ClipProfile | null = null;
  private streak = 0;
  private cleanStreak = 0;
  /**
   * No-baseline absolute-arming streak: consecutive hops with a RED absolute
   * relay fingerprint while NO baseline exists (the relay-from-bridge case —
   * every window so far was too relay-like to seed a reference). Direct-call
   * speech measures 0.27–0.45 (never RED ≥0.6), so a RED-only streak is a
   * safe absolute arming signal when no relative verdict is available.
   */
  private noBaselineRedStreak = 0;
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
    this.suppressArming = opts.suppressArming;
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
    this.noBaselineRedStreak = 0;
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

  /** Test hook: the callee-only caller-activity gate is wired. */
  get callerGateArmed(): boolean {
    return !!this.suppressArming;
  }

  /**
   * CALLEE-ONLY GATE: true when the caller was speaking on Leg A within the
   * gate window, so this window's suspicious audio may be the CALLER's voice
   * (speakerphone echo — indistinguishable from same-room/earpiece bleed on
   * the callee uplink alone — or pure bleed). Gated windows are NEUTRAL for
   * arming/refire (see the call sites). Callback errors fail OPEN with a
   * throttled warning; suppressions are forensic-logged (BRIDGED, throttled).
   */
  private armingSuppressed(path: string, fpState: string, fpScore: number): boolean {
    if (!this.suppressArming) return false;
    let suppressed: boolean;
    try {
      suppressed = this.suppressArming();
    } catch (err) {
      if (Date.now() - this.lastGateLogAt >= FORENSIC_LOG_THROTTLE_MS) {
        this.lastGateLogAt = Date.now();
        console.warn(
          `[speakerphone-detector] CALLER_GATE_ERROR path=${path} — gate callback threw (fail-open, no suppression):`,
          (err as Error).message,
        );
      }
      return false;
    }
    if (suppressed && this.bridged && Date.now() - this.lastGateLogAt >= FORENSIC_LOG_THROTTLE_MS) {
      this.lastGateLogAt = Date.now();
      console.log(
        `[speakerphone-detector] CALLER_GATE_NEUTRAL window=${this.windows} path=${path} ` +
          `relayState=${fpState} relayScore=${fpScore.toFixed(2)} — caller active on Leg A within the gate ` +
          `window; suspicious audio may be the caller's own voice (echo/bleed) — no arming, no refire`,
      );
    }
    return suppressed;
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

    // KNOWN-PROBE-TONE MASK (see the constants above): our own 852+1336 Hz
    // probe signals (canary loud-tone loop leak / merge-tone beep echo) are
    // NEUTRAL windows — no arming, no clearing, no seeding. The measured
    // pair ratios ride along in every forensic line for threshold tuning.
    const probe = measureProbeTone(samples);
    if (probe.masked) {
      if (this.bridged && Date.now() - this.lastForensicLogAt >= FORENSIC_LOG_THROTTLE_MS) {
        this.lastForensicLogAt = Date.now();
        console.log(
          `[speakerphone-detector] FORENSIC_WINDOW window=${this.windows} verdict=PROBE_TONE ` +
            `probe852=${probe.low.toFixed(3)} probe1336=${probe.high.toFixed(3)} ` +
            `masked (own 852+1336Hz probe leak/echo — neutral)`,
        );
      }
      return;
    }

    const profile = analyzeClip(samples, SAMPLE_RATE);

    // NO-BASELINE PATH — the reference has not been seeded (fresh detector, or
    // reset at bridge and not yet re-seeded). Three fingerprint-gated rules:
    //
    //  1. SEEDING: only a fingerprint-GREEN window with a real turn-exchange
    //     (≥2 VAD bursts) may become the reference. A single-burst window (one
    //     fluent sentence, a beep, ringback) is not representative enough to
    //     anchor every subsequent comparison (the end-to-end simulation showed
    //     a 1-burst seed flips relay verdicts to UNCERTAIN), and a
    //     relay-contaminated window must NEVER seed — otherwise every later
    //     relay window compares MATCH against it and the detector goes
    //     fail-safe silent forever (the 2026-09-04 live incident: relay audio
    //     playing FROM BRIDGE seeded the baseline; zero detections, and the
    //     false HoldDetector engagement + canary-tone leak killed the call
    //     with the wrong reason instead).
    //
    //  2. ABSOLUTE ARMING FALLBACK (relay-from-bridge): while no GREEN window
    //     has seeded a baseline, a RED absolute fingerprint on `need` hops
    //     (BRIDGED, post-warm-up) arms WITHOUT a relative verdict. Borderline
    //     AMBER dips between RED hops neither advance nor reset the streak
    //     (sustained relay oscillates RED↔AMBER); only GREEN hops reset it.
    //     Direct-call speech measures 0.27–0.45 — never RED (≥0.6) — so a
    //     RED-only streak cannot false-arm on normal audio.
    //
    //  3. NO-BASELINE CLEARING: an episode armed via rule 2 clears on the
    //     same fingerprint-clean streak as the baseline path. No seeding
    //     mid-episode (same freeze rule as the baseline path).
    if (!this.baseline) {
      const fp = relayFingerprint(profile);
      if (this.bridged && Date.now() - this.lastForensicLogAt >= FORENSIC_LOG_THROTTLE_MS) {
        this.lastForensicLogAt = Date.now();
        console.log(
          `[speakerphone-detector] FORENSIC_WINDOW window=${this.windows} verdict=NO_BASELINE ` +
            `relayState=${fp.state} relayScore=${fp.score.toFixed(2)} top=${topFingerprintFeatures(fp)} ` +
            `probe852=${probe.low.toFixed(3)} probe1336=${probe.high.toFixed(3)} ` +
            `noBaseRedStreak=${this.noBaselineRedStreak} warmup=${this.warmupDone ? "done" : "active"}`,
        );
      }
      // Calibration warm-up: same contract as the baseline path — score
      // internally, never arm, complete (and log) exactly once.
      if (this.bridged && !this.warmupDone) {
        this.warmupWindows++;
        if (Date.now() - this.bridgedAt < this.warmup) return;
        this.warmupDone = true;
        console.log(
          `[speakerphone-detector] FORENSICS_WARMUP_COMPLETE elapsed=${Date.now() - this.bridgedAt}ms ` +
            `windows=${this.warmupWindows} — no GREEN baseline yet; absolute arming live`,
        );
        this.onWarmupComplete?.(
          `elapsed=${Date.now() - this.bridgedAt}ms windows=${this.warmupWindows} — no baseline (fingerprint-gated), absolute arming live`,
        );
      }
      // Active no-baseline episode: refire on sustained RED hops (same
      // sustained-masking contract as the baseline path — the challenge
      // noise must keep looping for the whole episode), clear only on the
      // fingerprint-clean streak.
      if (this.suspecting) {
        if (fp.score < CLEAN_SCORE_CEILING) {
          this.cleanStreak++;
          if (this.cleanStreak >= this.cleanNeed) {
            this.suspecting = false;
            this.streak = 0;
            this.cleanStreak = 0;
            this.noBaselineRedStreak = 0;
            this.onClean?.(
              `NO_BASELINE episode — relayState=${fp.state} relayScore=${fp.score.toFixed(2)} — ` +
                `${this.cleanNeed} consecutive fingerprint-clean windows (relayScore < ${CLEAN_SCORE_CEILING})`,
            );
          }
        } else {
          this.cleanStreak = 0;
          if (
            fp.state === "RED" &&
            Date.now() - this.lastFiredAt >= this.refire &&
            // Callee-only gate: no refire on audio that may be the caller's.
            !this.armingSuppressed("no-baseline-refire", fp.state, fp.score)
          ) {
            this.lastFiredAt = Date.now();
            this.onSuspicious?.(
              fp.score,
              `NO_BASELINE sustained — relayScore=${fp.score.toFixed(2)} still RED mid-episode ` +
                `top=${topFingerprintFeatures(fp)}`,
            );
          }
        }
        return;
      }
      // Seeding (allowed pre-bridge too — the bridge transition resets the
      // baseline anyway; the GREEN gate is the contamination protection).
      if (
        fp.state === "GREEN" &&
        profile.vad.speechFrames.length > 0 &&
        profile.vad.burstCount >= 2
      ) {
        this.baseline = profile;
        this.baselineAbsorbs++;
        this.noBaselineRedStreak = 0;
        return;
      }
      // D2: arming may only accumulate while BRIDGED.
      if (this.armOnlyWhenBridged && !this.bridged) {
        this.noBaselineRedStreak = 0;
        return;
      }
      if (fp.state === "RED") {
        // Callee-only gate: a RED window captured while the caller speaks is
        // NEUTRAL — it neither advances nor resets the absolute-arming streak
        // (mirrors the AMBER-dip rule: sustained relay rides out caller-speech
        // overlaps and arms on the next caller-silent RED hops).
        if (!this.armingSuppressed("no-baseline", fp.state, fp.score)) {
          this.noBaselineRedStreak++;
          if (
            this.noBaselineRedStreak >= this.need &&
            Date.now() - this.lastFiredAt >= this.refire
          ) {
            this.lastFiredAt = Date.now();
            this.suspecting = true;
            this.onSuspicious?.(
              fp.score,
              `NO_BASELINE absolute arming — relayScore=${fp.score.toFixed(2)} RED for ` +
                `${this.noBaselineRedStreak} hops (baseline never seeded: relay present ` +
                `from bridge) top=${topFingerprintFeatures(fp)}`,
            );
          }
        }
      } else if (fp.state === "GREEN") {
        this.noBaselineRedStreak = 0;
      }
      // AMBER hops are BORDERLINE (mirrors the clean-streak rule): they
      // neither advance nor reset the RED streak — sustained relay audio
      // oscillates between RED and AMBER (≈0.55–0.6) on 1s hops, and a hard
      // reset would let the relay ride just under RED forever. Direct-call
      // speech measures 0.27–0.45 and NEVER reaches RED, so tolerance of
      // AMBER dips cannot false-arm on normal audio.
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
          `probe852=${probe.low.toFixed(3)} probe1336=${probe.high.toFixed(3)} ` +
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
      // Callee-only gate: the window still resets the clean streak (it IS
      // relay-like — an episode must never clear across it) but is otherwise
      // NEUTRAL: no arming-streak advance, no refire, no streak reset. The
      // caller's own voice (echo/bleed) can therefore never start or sustain
      // an episode — only audio captured while the caller is silent can.
      if (this.armingSuppressed("baseline", fp.state, fp.score)) {
        this.cleanStreak = 0;
        return;
      }
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
