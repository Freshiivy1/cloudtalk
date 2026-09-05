/**
 * Voice-ID attempt tracker — per-attempt streaming analyzer for the
 * "My voice identifies me" stage on Leg A.
 *
 * One VoiceIdTracker instance supervises ONE phrase attempt: it consumes the
 * callee's uplink as 20 ms μ-law frames (base64, 8 kHz mono, exactly as
 * Twilio Media Streams delivers them) and simultaneously
 *
 * ARMING CONTRACT (2026-09-05 live-bugfix): the integration arms the tracker
 * ONLY from the voice-id-listen TwiML, which Twilio fetches AFTER the prompt
 * <Say> has finished playing — so the tracker can never hear the prompt or
 * its loudspeaker echo (judging that echo was the production false-positive
 * that burned all 3 attempts and ended the call). The initial guardMs
 * window additionally covers the beep + echo tail, and relay confirmation
 * is speech-gated (minVoicedForRelayMs): relay describes how the USER'S
 * VOICE arrives, so it is only judged while the user is actually speaking.
 *
 *   1. VAD / STRUCTURE — a cheap per-frame energy VAD (adaptive noise floor,
 *      hangover) that measures voiced duration, splits speech into sections
 *      (word groups) at natural pauses, and detects end-of-speech from the
 *      trailing silence, and
 *   2. RELAY PATH — a SpeakerphoneDetector in fast single-window mode (1 s
 *      window, 0.5 s hop, arming on the FIRST suspicious window) deciding
 *      whether the voice arrives DIRECTLY from the handset or via a
 *      speakerphone/relay path (forbidden for this stage).
 *
 * TIME SOURCE: all attempt timing is STREAM time — 20 ms per pushed frame —
 * which is sample-accurate and immune to wall-clock jitter/bursty delivery.
 * The injectable now() (default Date.now) stamps the epoch fields
 * (attemptStartedAtMs / speechStartedAtMs) so tests can run on a fake clock.
 *
 * END OF ATTEMPT (each fires onAttemptEnd exactly once, push() afterwards is
 * a no-op):
 *   "relay"        — speakerphone/relay confirmed (onRelayConfirmed fires
 *                    FIRST, exactly once, at the moment of confirmation);
 *   "speech-end"   — trailingSilenceEndMs of unvoiced audio after speech
 *                    started (the phrase is complete, decide now);
 *   "no-speech"    — no voiced frame within noSpeechTimeoutMs of the first
 *                    push (the callee stayed silent);
 *   "max-duration" — maxAttemptMs of audio without any of the above (runaway
 *                    background conversation guard).
 *
 * RELAY CONFIRMATION from the detector's emissions (every emission is one
 * arming-suspicious window: verdict 'SUSPICIOUS RELAY' AND RED relay
 * fingerprint, score >= 0.6, by the detector's construction):
 *   — a single emission with score >= relayHighConfidence (default 0.9), or
 *   — relayConsecutiveEmissions (default 2) CONSECUTIVE suspicious emissions
 *     (an onClean from the detector resets the consecutive counter; with
 *     cleanWindowsToClear=9999 a clean essentially never arrives mid-attempt,
 *     so the counter is effectively monotonic within an attempt).
 *
 * The module is PURE DSP/logic: no DB, no Twilio client, no imports from
 * verification.ts. Also exported: the accent-tolerant phrase matcher
 * (matchVoiceIdPhrase) and the final per-attempt decision function
 * (decideVoiceId) consumed by the integration layer.
 */
import { SpeakerphoneDetector } from "./speakerphone-detector";
import { decodeMulaw } from "../verification-stream";

const SAMPLE_RATE = 8000;
const FRAME_MS = 20;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 160
const FULL_SCALE = 32768;

/* ------------------------------------------------------------- VAD tuning */
/**
 * Voiced threshold = adaptive noise floor + VAD_MARGIN_DB. 11 dB sits in the
 * classic 10–12 dB energy-VAD band: a direct-handset noise bed lives ≈60 dB
 * under speech, so 11 dB cleanly separates words from the bed while riding
 * above plosive/fricative dips inside a word.
 */
const VAD_MARGIN_DB = 11;
/**
 * Absolute floor guard: even with a deep-silence floor estimate (digital
 * zeros → −160 dBFS) a frame must reach −45 dBFS to count as voiced. This
 * keeps line hiss / μ-law idle noise from ever reading as speech, and matches
 * the decision matrix's meanLevelDb < −45 "audio unusable" bar.
 */
const VAD_ABSOLUTE_FLOOR_DB = -45;
/**
 * Hangover: an unvoiced gap shorter than this does NOT close the current
 * voiced run — intra-word dropouts (stop consonants, /t/ /k/ closures) stay
 * inside the run instead of fragmenting the section structure.
 */
const VAD_HANGOVER_MS = 120;
/**
 * Adaptive noise floor: 10th percentile of the levels of the most recent
 * FLOOR_HISTORY_FRAMES UNVOICED frames (≈5 s). Only unvoiced frames feed the
 * estimate, so sustained loud speech can never drag the floor up into the
 * speech band (important for relay audio, whose AGC-lifted bed sits only
 * ≈8.5 dB under speech — those bed frames read as voiced and are excluded).
 */
const FLOOR_HISTORY_FRAMES = 250;
const FLOOR_PERCENTILE = 0.1;
/** Level clamp for digital silence (rms 0 → −160 dBFS). */
const MIN_LEVEL_DB = -160;

/** Clip detector: frame peak at/above this fraction of full scale counts as clipped. */
const CLIP_PEAK = 0.98;

/** Per-attempt audio-quality measurements (all dBFS). */
export interface VoiceIdAudioQuality {
  /** Fraction of frames whose peak reached >= 0.98 of full scale. */
  clippedRatio: number;
  /** Mean RMS level (dBFS) over voiced frames; -Infinity when none. */
  meanLevelDb: number;
  /** Adaptive noise-floor estimate (dBFS). */
  noiseFloorDb: number;
  /** meanLevelDb - noiseFloorDb; 0 when no speech was seen. */
  snrDb: number;
}

/** Point-in-time (or final) state of one phrase attempt. */
export interface VoiceIdSnapshot {
  /** ms since epoch of the first push (0 before any push). */
  attemptStartedAtMs: number;
  /** Epoch ms of the first voiced frame; null while no speech was detected. */
  speechStartedAtMs: number | null;
  /** Total voiced audio (sum of voiced 20 ms frames). */
  voicedDurationMs: number;
  /** Voiced runs split at unvoiced gaps >= sectionGapMs. */
  sectionCount: number;
  /** Section boundaries, ms offsets from attempt start (last may be open). */
  sections: Array<{ startMs: number; endMs: number }>;
  /** Current/final unvoiced run after speech start (0 while voiced). */
  trailingSilenceMs: number;
  /** trailingSilenceMs >= trailingSilenceEndMs was reached. */
  speechEnded: boolean;
  /** Max suspicious score (relay fingerprint, 0..1) emitted so far. */
  relayConfidence: number;
  /** Max CONSECUTIVE suspicious emissions seen so far. */
  relayWindows: number;
  /** Relay/speakerphone path confirmed (see file header). */
  relayConfirmed: boolean;
  /** Detail of the confirming emission(s). */
  relayEvidence: string;
  /** ms from speech start to relay confirmation; null if not confirmed or no speech yet. */
  relayDecisionMs: number | null;
  audioQuality: VoiceIdAudioQuality;
  ended: boolean;
  endReason: "speech-end" | "no-speech" | "max-duration" | "relay" | null;
}

export interface VoiceIdTrackerOptions {
  /** Unvoiced run after speech start that ends the attempt (default 650). */
  trailingSilenceEndMs?: number;
  /** Unvoiced gap that splits sections (default 250 — short natural word
   *  pauses stay in-section). */
  sectionGapMs?: number;
  /** No voiced frame within this window ends the attempt (default 6000). */
  noSpeechTimeoutMs?: number;
  /** Hard cap on attempt audio (default 15000). */
  maxAttemptMs?: number;
  /** Single-emission relay confirmation score (default 0.9). */
  relayHighConfidence?: number;
  /** Consecutive suspicious emissions that confirm relay (default 2). */
  relayConsecutiveEmissions?: number;
  /** Initial stream window that is NOT analysed (default 500 — covers the
   *  250 ms beep + its acoustic echo tail after the prompt; the integration
   *  arms the tracker only AFTER the prompt has finished playing, so the
   *  only loud outbound audio left to echo is the beep). Pass 0 in tests
   *  that feed pre-trimmed audio. */
  guardMs?: number;
  /** Relay confirmation is SUPPRESSED until this much VAD-voiced user speech
   *  has accumulated (default 300). Relay describes how the USER'S VOICE
   *  arrives — it is only decidable while the user is actually speaking, so
   *  prompt/beep echo, room tone and background can never confirm (the
   *  2026-09-05 live false-positive: the prompt's own loudspeaker echo was
   *  judged "speakerphone" while the callee had not said a word). */
  minVoicedForRelayMs?: number;
  /** Fires ONCE, immediately at relay confirmation (before onAttemptEnd). */
  onRelayConfirmed?: (snap: VoiceIdSnapshot) => void;
  /** Fires ONCE when the attempt ends for any reason. */
  onAttemptEnd?: (snap: VoiceIdSnapshot) => void;
  /** Epoch clock for the timestamp fields (default Date.now). Stream timing
   *  (VAD, sections, timeouts) is sample-based: 20 ms per pushed frame. */
  now?: () => number;
}

export class VoiceIdTracker {
  private readonly trailingSilenceEndMs: number;
  private readonly sectionGapMs: number;
  private readonly noSpeechTimeoutMs: number;
  private readonly maxAttemptMs: number;
  private readonly relayHighConfidence: number;
  private readonly relayConsecutiveEmissions: number;
  private readonly guardMs: number;
  private readonly minVoicedForRelayMs: number;
  private readonly onRelayConfirmedCb?: (snap: VoiceIdSnapshot) => void;
  private readonly onAttemptEndCb?: (snap: VoiceIdSnapshot) => void;
  private readonly nowFn: () => number;

  private readonly detector: SpeakerphoneDetector;

  private disposed = false;
  private started = false;
  private attemptStartedAtMs = 0;
  /** Stream time fed so far (20 ms per frame) — the attempt timeline. */
  private elapsedMs = 0;

  /* ---- VAD state ---- */
  /** Recent UNVOICED frame levels (dBFS) feeding the floor percentile. */
  private unvoicedLevels: number[] = [];
  private floorDb = MIN_LEVEL_DB;
  private voicedFrames = 0;
  private voicedDbSum = 0;
  private clippedFrames = 0;
  private totalFrames = 0;
  private speechStartOffsetMs: number | null = null;
  /** End (stream ms) of the most recent voiced frame. */
  private lastVoicedEndMs = 0;
  /** A voiced run closes only after VAD_HANGOVER_MS of unvoiced audio. */
  private runOpen = false;
  private sections: Array<{ startMs: number; endMs: number }> = [];
  private speechEnded = false;

  /* ---- relay state ---- */
  private relayConfidence = 0;
  private relayWindows = 0;
  private consecutiveSuspicious = 0;
  private relayConfirmed = false;
  private relayEvidence = "";
  private relayDecisionMs: number | null = null;

  /* ---- end state ---- */
  private ended = false;
  private endReason: VoiceIdSnapshot["endReason"] = null;
  private relayFired = false;
  private endFired = false;

  constructor(opts: VoiceIdTrackerOptions = {}) {
    this.trailingSilenceEndMs = opts.trailingSilenceEndMs ?? 650;
    this.sectionGapMs = opts.sectionGapMs ?? 250;
    this.noSpeechTimeoutMs = opts.noSpeechTimeoutMs ?? 6000;
    this.maxAttemptMs = opts.maxAttemptMs ?? 15000;
    this.relayHighConfidence = opts.relayHighConfidence ?? 0.9;
    this.relayConsecutiveEmissions = opts.relayConsecutiveEmissions ?? 2;
    this.guardMs = Math.max(0, opts.guardMs ?? 500);
    this.minVoicedForRelayMs = Math.max(0, opts.minVoicedForRelayMs ?? 300);
    this.onRelayConfirmedCb = opts.onRelayConfirmed;
    this.onAttemptEndCb = opts.onAttemptEnd;
    this.nowFn = opts.now ?? (() => Date.now());

    // Fast per-attempt relay supervision: every 0.5 s hop the trailing 1 s of
    // audio is analyzed and the FIRST arming-suspicious window emits (the
    // detector's arming bar still applies: 'SUSPICIOUS RELAY' verdict AND RED
    // fingerprint >= 0.6, or the no-baseline absolute RED arming when the
    // relay was present from the first frame and no clean baseline exists).
    // Bridged from construction (the attempt only exists mid-bridge), no
    // warm-up (a voice-id attempt is ~seconds — there is no time to calibrate
    // away the decision), refire 0 (every suspicious hop emits so the
    // consecutive-emission rule sees them all), effectively no clean-clear
    // mid-attempt.
    this.detector = new SpeakerphoneDetector({
      windowSec: 1,
      hopSec: 0.5,
      consecutiveWindows: 1,
      warmupMs: 0,
      bridged: true,
      armOnlyWhenBridged: false,
      cleanWindowsToClear: 9999,
      refireMs: 0,
      onSuspicious: (score, detail) => this.handleSuspicious(score, detail),
      onClean: () => {
        this.consecutiveSuspicious = 0;
      },
    });
  }

  /** Feed one Twilio media payload (base64 μ-law, 8 kHz mono, 20 ms frames). */
  push(payloadB64: string): void {
    if (this.ended || this.disposed) return;
    const bytes = Buffer.from(payloadB64, "base64");
    if (bytes.length === 0) return;
    if (!this.started) {
      this.started = true;
      this.attemptStartedAtMs = this.nowFn();
    }
    // Cheap per-frame VAD over the whole payload (normally exactly 1 frame).
    // Frames inside the initial guard window (beep + acoustic echo tail) are
    // NOT analysed — the attempt timeline still advances so all offsets stay
    // stream-accurate.
    const payloadStartMs = this.elapsedMs;
    for (let off = 0; off < bytes.length && !this.ended; off += FRAME_SAMPLES) {
      const n = Math.min(FRAME_SAMPLES, bytes.length - off);
      const frameDurationMs = (n / SAMPLE_RATE) * 1000;
      if (this.elapsedMs < this.guardMs) {
        this.elapsedMs += frameDurationMs;
        continue;
      }
      const pcm = new Array<number>(n);
      for (let i = 0; i < n; i++) pcm[i] = decodeMulaw(bytes[off + i]);
      this.processFrame(pcm, frameDurationMs);
      this.checkEndConditions();
    }
    // Heavy DSP runs inside the detector on its own 0.5 s hop schedule —
    // only post-guard audio is ever judged (a payload straddling the guard
    // boundary is dropped whole; 20 ms granularity is immaterial).
    if (!this.ended && payloadStartMs >= this.guardMs) this.detector.push(payloadB64);
  }

  /** Current (or final) attempt state. */
  snapshot(): VoiceIdSnapshot {
    return {
      attemptStartedAtMs: this.attemptStartedAtMs,
      speechStartedAtMs:
        this.speechStartOffsetMs === null
          ? null
          : this.attemptStartedAtMs + this.speechStartOffsetMs,
      voicedDurationMs: this.voicedFrames * FRAME_MS,
      sectionCount: this.sections.length,
      sections: this.sections.map((s) => ({ ...s })),
      trailingSilenceMs: this.currentTrailingSilenceMs(),
      speechEnded: this.speechEnded,
      relayConfidence: this.relayConfidence,
      relayWindows: this.relayWindows,
      relayConfirmed: this.relayConfirmed,
      relayEvidence: this.relayEvidence,
      relayDecisionMs: this.relayDecisionMs,
      audioQuality: this.quality(),
      ended: this.ended,
      endReason: this.endReason,
    };
  }

  /**
   * Teardown: stops processing (push becomes a no-op). Deliberately does NOT
   * fire onAttemptEnd — dispose is the integration layer abandoning the
   * attempt (call ended, stage superseded), not an attempt verdict.
   */
  dispose(): void {
    this.disposed = true;
  }

  /* ------------------------------------------------------------ internals */

  /** One 20 ms frame of decoded PCM through the energy VAD. */
  private processFrame(pcm: number[], frameDurationMs: number): void {
    const frameStartMs = this.elapsedMs;
    const frameEndMs = frameStartMs + frameDurationMs;
    this.elapsedMs = frameEndMs;
    this.totalFrames++;

    let sumSq = 0;
    let peak = 0;
    for (const s of pcm) {
      sumSq += s * s;
      const a = Math.abs(s);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sumSq / pcm.length) / FULL_SCALE;
    const levelDb = 20 * Math.log10(Math.max(rms, 1e-8));
    if (peak / FULL_SCALE >= CLIP_PEAK) this.clippedFrames++;

    const thresholdDb = Math.max(this.floorDb + VAD_MARGIN_DB, VAD_ABSOLUTE_FLOOR_DB);
    const voiced = levelDb >= thresholdDb;

    if (voiced) {
      this.voicedFrames++;
      this.voicedDbSum += levelDb;
      if (this.speechStartOffsetMs === null) this.speechStartOffsetMs = frameStartMs;
      if (!this.runOpen) {
        // New voiced run: a raw unvoiced gap >= sectionGapMs splits sections;
        // shorter pauses (natural word gaps) extend the current section.
        const gapMs = frameStartMs - this.lastVoicedEndMs;
        if (this.sections.length === 0 || gapMs >= this.sectionGapMs) {
          this.sections.push({ startMs: frameStartMs, endMs: frameEndMs });
        }
        this.runOpen = true;
      }
      this.sections[this.sections.length - 1].endMs = frameEndMs;
      this.lastVoicedEndMs = frameEndMs;
    } else {
      // Unvoiced frames feed the adaptive floor (never voiced ones — sustained
      // loud audio must not drag the floor into the speech band).
      this.unvoicedLevels.push(levelDb);
      if (this.unvoicedLevels.length > FLOOR_HISTORY_FRAMES) this.unvoicedLevels.shift();
      this.floorDb = percentile(this.unvoicedLevels, FLOOR_PERCENTILE);
      // Hangover: the run survives brief intra-word dropouts.
      if (this.runOpen && frameEndMs - this.lastVoicedEndMs >= VAD_HANGOVER_MS) {
        this.runOpen = false;
      }
    }
  }

  private currentTrailingSilenceMs(): number {
    if (this.speechStartOffsetMs === null) return 0;
    return Math.max(0, this.elapsedMs - this.lastVoicedEndMs);
  }

  /** End-condition evaluation after each frame (first match wins). */
  private checkEndConditions(): void {
    if (this.ended) return;
    if (this.speechStartOffsetMs === null && this.elapsedMs >= this.noSpeechTimeoutMs) {
      this.end("no-speech");
      return;
    }
    if (
      this.speechStartOffsetMs !== null &&
      this.currentTrailingSilenceMs() >= this.trailingSilenceEndMs
    ) {
      this.speechEnded = true;
      this.end("speech-end");
      return;
    }
    if (this.elapsedMs >= this.maxAttemptMs) {
      this.end("max-duration");
    }
  }

  /** One arming-suspicious window from the detector (score >= 0.6 RED). */
  private handleSuspicious(score: number, detail: string): void {
    if (this.ended) return;
    // SPEECH GATE: relay describes how the USER'S VOICE arrives — a window
    // is only judgeable once the user is actually speaking. Suspicious
    // windows before that (prompt/beep echo, room tone, background) are
    // ignored entirely: they never confirm, never accumulate confidence,
    // never count toward the consecutive-emission rule.
    if (this.voicedFrames * FRAME_MS < this.minVoicedForRelayMs) return;
    this.relayConfidence = Math.max(this.relayConfidence, score);
    this.consecutiveSuspicious++;
    this.relayWindows = Math.max(this.relayWindows, this.consecutiveSuspicious);
    this.relayEvidence = detail;
    const confirmed =
      score >= this.relayHighConfidence ||
      this.consecutiveSuspicious >= this.relayConsecutiveEmissions;
    if (!confirmed || this.relayConfirmed) return;
    this.relayConfirmed = true;
    this.relayDecisionMs =
      this.speechStartOffsetMs === null ? null : this.elapsedMs - this.speechStartOffsetMs;
    // ended/endReason are set BEFORE onRelayConfirmed fires (spec order), so
    // the confirmation snapshot already reads as a finished relay attempt.
    this.ended = true;
    this.endReason = "relay";
    if (!this.relayFired) {
      this.relayFired = true;
      this.onRelayConfirmedCb?.(this.snapshot());
    }
    if (!this.endFired) {
      this.endFired = true;
      this.onAttemptEndCb?.(this.snapshot());
    }
  }

  private end(reason: NonNullable<VoiceIdSnapshot["endReason"]>): void {
    if (this.ended) return;
    this.ended = true;
    this.endReason = reason;
    if (!this.endFired) {
      this.endFired = true;
      this.onAttemptEndCb?.(this.snapshot());
    }
  }

  private quality(): VoiceIdAudioQuality {
    const clippedRatio = this.totalFrames > 0 ? this.clippedFrames / this.totalFrames : 0;
    const meanLevelDb = this.voicedFrames > 0 ? this.voicedDbSum / this.voicedFrames : -Infinity;
    const noiseFloorDb = this.floorDb;
    const snrDb = this.voicedFrames > 0 ? meanLevelDb - noiseFloorDb : 0;
    return { clippedRatio, meanLevelDb, noiseFloorDb, snrDb };
  }
}

/** Lower-percentile of a small numeric sample (sorts a copy). */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return MIN_LEVEL_DB;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

/* ================================================================ matcher */

/** Small classic Levenshtein (anchors/tokens are short — O(n·m) DP is fine). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

interface Anchor {
  name: string;
  canonical: string;
  /** Telephone/accent variants accepted verbatim. */
  variants: string[];
  /** Optional prefix acceptance (identif* covers identify/identifies/…). */
  prefix?: string;
  /** Max Levenshtein distance to the canonical form. */
  maxEdits: number;
}

/**
 * Ordered anchors for "my voice identifies me". Variant sets cover the
 * common telephone-STT / accented mishearings; the "identifies" prefix rule
 * means a thick accent softening or omitting the final "s" (identify,
 * identifie, identified, identifi) still passes.
 */
const ANCHORS: Anchor[] = [
  { name: "my", canonical: "my", variants: ["my", "mai", "ma", "meh"], maxEdits: 1 },
  {
    name: "voice",
    canonical: "voice",
    variants: ["voice", "vois", "vice", "boice", "woice", "voyce"],
    maxEdits: 1,
  },
  { name: "identifies", canonical: "identifies", variants: [], prefix: "identif", maxEdits: 2 },
  { name: "me", canonical: "me", variants: ["me", "mi", "mee"], maxEdits: 1 },
];

/** Verbatim variant (or prefix) membership — the "strong" anchor match. */
function isVariant(anchorIdx: number, token: string): boolean {
  const a = ANCHORS[anchorIdx];
  if (a.variants.includes(token)) return true;
  if (a.prefix && token.startsWith(a.prefix)) return true;
  return false;
}

/**
 * Anchor match: a verbatim variant always matches; an edit-distance match is
 * accepted ONLY when the token is not a verbatim variant of a DIFFERENT
 * anchor — otherwise the 1-edit fuzziness of the short anchors ("my"/"me")
 * would let the correct words match in the WRONG ORDER
 * ("me voice identifies my" would otherwise align me→my … my→me).
 */
function anchorMatches(anchorIdx: number, token: string): boolean {
  if (isVariant(anchorIdx, token)) return true;
  for (let j = 0; j < ANCHORS.length; j++) {
    if (j !== anchorIdx && isVariant(j, token)) return false;
  }
  return levenshtein(token, ANCHORS[anchorIdx].canonical) <= ANCHORS[anchorIdx].maxEdits;
}

export interface VoiceIdPhraseMatch {
  /** Anchors matched IN ORDER (0..4). */
  anchorsMatched: number;
  /** anchorsMatched / 4. */
  coverage: number;
  /** All 4 anchors matched in order. */
  orderedOk: boolean;
  /** Canonical names of the matched anchors, in order. */
  matchedAnchors: string[];
  /** Normalized transcript tokens. */
  tokens: string[];
}

/**
 * Accent-tolerant matcher for the exact phrase "my voice identifies me".
 *
 * Normalization: lowercase, punctuation stripped, whitespace collapsed.
 * Alignment: greedy in-order — each anchor is searched at/after the token
 * following the previous anchor's match.
 *
 * FILLER: extra tokens are skipped by the alignment, so leading/incidental
 * filler ("um my voice identifies me") passes AS LONG AS all four anchors
 * still align in order; filler that displaces an anchor does not.
 */
export function matchVoiceIdPhrase(transcript: string): VoiceIdPhraseMatch {
  const tokens = transcript
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 0);

  const matchedAnchors: string[] = [];
  let pos = 0;
  for (let a = 0; a < ANCHORS.length; a++) {
    let found = -1;
    for (let i = pos; i < tokens.length; i++) {
      if (anchorMatches(a, tokens[i])) {
        found = i;
        break;
      }
    }
    if (found < 0) break;
    matchedAnchors.push(ANCHORS[a].name);
    pos = found + 1;
  }
  const anchorsMatched = matchedAnchors.length;
  return {
    anchorsMatched,
    coverage: anchorsMatched / ANCHORS.length,
    orderedOk: anchorsMatched === ANCHORS.length,
    matchedAnchors,
    tokens,
  };
}

/* =============================================================== decision */

export type VoiceIdVerdict =
  | "pass"
  | "retry-relay"
  | "retry-phrase"
  | "retry-audio"
  | "retry-nospeech"
  | "inconclusive";

export interface VoiceIdDecisionInput {
  /** STT transcript; null/"" when STT produced nothing. */
  transcript: string | null;
  transcriptConfidence: number | null;
  /** Final tracker snapshot; null = detector/stream unavailable. */
  tracker: VoiceIdSnapshot | null;
  /** Minimum voiced audio for a pass (default 400 — fast-speaker floor). */
  minVoicedMs?: number;
  /** Maximum voiced audio (default 8000 — background-conversation guard). */
  maxVoicedMs?: number;
}

export interface VoiceIdDecision {
  verdict: VoiceIdVerdict;
  reasons: string[];
  scores: {
    relayConfidence: number;
    phraseCoverage: number;
    voicedDurationMs: number;
    sectionCount: number;
  };
}

/**
 * Final per-attempt verdict. Order matters — first match wins:
 *   1. relay confirmed            → retry-relay (beats everything — a
 *                                   speakerphone/relay sample can NEVER be
 *                                   enrolled as the voiceprint);
 *   2. tracker unavailable        → inconclusive (NEVER pass);
 *   3. no/too little speech       → retry-nospeech;
 *   4. audio unusable             → retry-audio;
 *   5. runaway speech (> maxVoicedMs) → retry-audio (background conversation
 *                                   contaminates the voiceprint);
 *   6. usable direct-handset speech (≥ minVoicedMs voiced) → PASS;
 *   7. speech present but too short to trust → inconclusive.
 * PHRASE IS NOT A GATE (2026-09-05, user directive): the spoken phrase only
 * elicits a clean sample — the transcript anchors are recorded as EVIDENCE
 * (scores.phraseCoverage, reasons) but never decide the verdict. What is
 * enforced: the audio arrived on the direct handset path (not speakerphone/
 * relay), speech is actually present, and the quality is good enough to
 * build a trustworthy voiceprint.
 */
export function decideVoiceId(input: VoiceIdDecisionInput): VoiceIdDecision {
  const minVoicedMs = input.minVoicedMs ?? 400;
  const maxVoicedMs = input.maxVoicedMs ?? 8000;
  const t = input.tracker;
  const reasons: string[] = [];
  const transcript = input.transcript ?? "";
  const match = matchVoiceIdPhrase(transcript);
  const scores = {
    relayConfidence: t?.relayConfidence ?? 0,
    phraseCoverage: match.coverage,
    voicedDurationMs: t?.voicedDurationMs ?? 0,
    sectionCount: t?.sectionCount ?? 0,
  };
  const sttNote =
    input.transcriptConfidence !== null
      ? ` sttConfidence=${input.transcriptConfidence.toFixed(2)}`
      : " sttConfidence=n/a";

  // 1. Relay beats everything — the voice did not come directly from the handset.
  if (t?.relayConfirmed) {
    reasons.push(
      `relay confirmed (confidence=${t.relayConfidence.toFixed(2)}, ` +
        `consecutiveWindows=${t.relayWindows}, decisionMs=${t.relayDecisionMs ?? "n/a"}): ` +
        `${t.relayEvidence || "no detail"}`,
    );
    return { verdict: "retry-relay", reasons, scores };
  }

  // 2. Detector unavailable must NEVER pass.
  if (t === null) {
    reasons.push("tracker unavailable (null) — cannot verify direct-handset audio path");
    return { verdict: "inconclusive", reasons, scores };
  }

  // 3. No (usable) speech.
  if (!t.speechStartedAtMs || t.voicedDurationMs < 300) {
    reasons.push(
      `no usable speech (speechStarted=${t.speechStartedAtMs !== null}, ` +
        `voicedDurationMs=${t.voicedDurationMs} < 300, endReason=${t.endReason ?? "none"})`,
    );
    return { verdict: "retry-nospeech", reasons, scores };
  }

  // 4. Audio unusable for a trustworthy decision.
  const q = t.audioQuality;
  if (q.clippedRatio > 0.3 || q.meanLevelDb < -45 || (q.snrDb < 3 && t.voicedDurationMs >= 300)) {
    if (q.clippedRatio > 0.3) {
      reasons.push(`clipping: clippedRatio=${q.clippedRatio.toFixed(2)} > 0.3`);
    }
    if (q.meanLevelDb < -45) {
      reasons.push(`too quiet: meanLevelDb=${q.meanLevelDb.toFixed(1)} dBFS < -45`);
    }
    if (q.snrDb < 3 && t.voicedDurationMs >= 300) {
      reasons.push(
        `no speech over noise: snrDb=${q.snrDb.toFixed(1)} < 3 with voicedDurationMs=${t.voicedDurationMs}`,
      );
    }
    return { verdict: "retry-audio", reasons, scores };
  }

  // 5. Runaway speech / background conversation can never be a CLEAN
  //    enrollment sample (the voiceprint would be contaminated).
  if (t.voicedDurationMs > maxVoicedMs) {
    reasons.push(
      `voicedDurationMs=${t.voicedDurationMs} > maxVoicedMs=${maxVoicedMs} — ` +
        `background conversation, not a short enrollment utterance`,
    );
    return { verdict: "retry-audio", reasons, scores };
  }

  // 6. Transcript anchors are EVIDENCE ONLY (phrase is not a gate) — logged
  //    for review, never decides the verdict.
  reasons.push(
    `phrase evidence: coverage=${match.coverage.toFixed(2)} anchors=[${match.matchedAnchors.join(",")}]` +
      `${sttNote} transcript=${transcript ? JSON.stringify(transcript) : "<empty>"}`,
  );
  if (t.sectionCount === 0) {
    reasons.push(`structure sanity failed: sectionCount=0 with voicedDurationMs=${t.voicedDurationMs}`);
    return { verdict: "retry-audio", reasons, scores };
  }
  if (t.voicedDurationMs >= minVoicedMs) {
    // 7. PASS: usable speech on the direct handset path with trustworthy
    //    quality — exactly what a voiceprint enrollment needs.
    reasons.push(
      `pass: usable direct-handset speech, voicedDurationMs=${t.voicedDurationMs} >= minVoicedMs=${minVoicedMs}, ` +
        `sections=${t.sectionCount}, snrDb=${q.snrDb.toFixed(1)}, relay=not confirmed`,
    );
    return { verdict: "pass", reasons, scores };
  }

  // 8. Speech is present (>= 300ms) but shorter than the enrollment floor —
  //    too little to trust; nothing in the matrix fits: inconclusive.
  reasons.push(
    `speech present but voicedDurationMs=${t.voicedDurationMs} < minVoicedMs=${minVoicedMs} — too short to trust`,
  );
  return { verdict: "inconclusive", reasons, scores };
}
