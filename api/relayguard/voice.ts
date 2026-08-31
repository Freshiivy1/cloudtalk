// voice.ts — the corpus-calibrated 5-matcher voice-biometric panel.
//
// Five independent voice-identity matchers run on the VAD-gated speech of the
// channel-normalized audio (A vs B). Each matcher produces a RAW score, then a
// CALIBRATED probability via a shipped logistic map p = 1/(1+exp(-(a·raw+b)))
// with (a, b) trained offline against the VoxForge corpus (32 male speakers +
// the user's field sample — see voiceCalibration.ts):
//
//   1. mfcc_v2  — 13 MFCC + first deltas (drop static c0 → 25 rows), long-term
//                 vector [mean(25), 0.5·std(25)] (50 dims); raw = cosine of
//                 mean-centered vectors.
//   2. fisher   — same 50-dim vector, corpus-trained Fisher weights;
//                 raw = −√( Σⱼ Wⱼ(aⱼ−bⱼ)² / Σⱼ Wⱼ ).
//   3. formant  — LPC order 12 (0.97 pre-emphasis) on voiced frames, formants
//                 from the POLYNOMIAL ROOTS of the LPC polynomial; per-formant
//                 relative delta of medians; raw = mean of clip(1−Δ/0.18, 0, 1).
//   4. f0       — autocorrelation F0 per voiced frame;
//                 raw = exp(−|12·log2(medB/medA)| / 3.5).
//   5. ltas     — 24 log-spaced bands 200–3600 Hz, long-term average spectrum
//                 (dB) over speech frames, mean-normalized; raw = cosine.
//
// VOTE: p ≥ VOTE_SAME_AT (0.60) → 'same', p ≤ VOTE_DIFFERENT_AT (0.40) →
// 'different', else abstain (abstain also under 10 voiced/speech frames).
//
// CONSENSUS RULE (exact, from the calibration run):
//   consensus = 'same'      iff same      ≥ 3 AND different === 0
//   consensus = 'different' iff different ≥ 3 AND same      === 0
//   otherwise → 'no_consensus'.
//   A 'same' consensus OVERRIDES the spectral-integrity flag veto (flags stay
//   informational). A 'different' consensus VETOES any MATCH — the voices are
//   not the same person regardless of channel similarity (compare.ts).
import { mfccFrame, cosine01, MFCC_CONFIG, HOP, meanMfcc, type Spectrogram } from './stft';
import {
  MFCC_V2_LOGISTIC,
  FISHER_LOGISTIC,
  FISHER_WEIGHTS,
  FORMANT_LOGISTIC,
  F0_LOGISTIC,
  LTAS_LOGISTIC,
  VOTE_SAME_AT,
  VOTE_DIFFERENT_AT,
  type LogisticParams,
} from './voiceCalibration';
import type { VadResult } from './vad';
import type { BaselineMode } from './channel';
import type { ClipProfile } from './features';

export type VoiceVerdict = 'same' | 'different' | 'abstain';
export type VoiceConsensus = 'same' | 'different' | 'no_consensus';

export type VoiceMatcherId = 'mfcc_v2' | 'fisher' | 'formant' | 'f0' | 'ltas';

export interface VoiceMatcherResult {
  id: VoiceMatcherId;
  name: string;
  /** raw matcher score before calibration (NaN when abstaining) */
  raw: number;
  /** calibrated same-voice probability from the shipped logistic map (NaN when abstaining) */
  p: number;
  /** logistic params used for the calibration map (shipped constants) */
  logistic: LogisticParams;
  verdict: VoiceVerdict;
  detail: string;
}

export interface VoicePanel {
  matchers: VoiceMatcherResult[];
  sameCount: number;
  differentCount: number;
  abstainCount: number;
  /** non-abstaining matchers */
  voters: number;
  /** size of the winning camp (same/different); for no_consensus, the larger camp */
  agreeCount: number;
  consensus: VoiceConsensus;
  /** consensus === 'same' — the same-voice override of the flag veto */
  overrideEngaged: boolean;
  /** consensus === 'different' — different-voice veto of any MATCH */
  vetoEngaged: boolean;
  /** human-readable statement of the consensus rule, reused in UI and export */
  rule: string;
}

/** Per-clip voice-biometric print, extracted on VAD-gated speech frames. */
export interface VoicePrint {
  speechFrames: number;
  voicedFrames: number;
  /** F0 per voiced frame (Hz), autocorrelation peak > 0.3 */
  f0Hz: Float32Array;
  /** LPC root-based formant estimates per voiced frame (Hz); NaN when not found */
  f1Hz: Float32Array;
  f2Hz: Float32Array;
  f3Hz: Float32Array;
  /** number of voiced frames with at least one valid root-based formant */
  formantFrames: number;
  /** 50-dim long-term MFCC+delta vector: [mean(25), 0.5·std(25)] over speech frames */
  mfccVec: Float64Array;
  /** 24-band (log-spaced 200–3600 Hz) long-term average spectrum, dB, mean-normalized */
  ltasDb: Float32Array;
}

// ------------------------------------------------------------- thresholds --

/** Minimum voiced (or speech, for the spectral matchers) frames per clip.
 * Below this a matcher abstains gracefully rather than guessing. */
export const VOICE_MIN_FRAMES = 10;
/** Formant matcher floor: voiced frames with all three root-based formants. */
export const FORMANT_MIN_FRAMES = 5;
/** Formant relative-delta full-mismatch point (clip(1 − Δ/0.18, 0, 1)). */
export const FORMANT_REL_FULL = 0.18;
/** F0 matcher: semitone distance at which the raw score falls to 1/e. */
export const F0_SEMITONE_SCALE = 3.5;

export { VOTE_SAME_AT, VOTE_DIFFERENT_AT };

export const VOICE_RULE_TEXT =
  'Calibrated panel: each matcher maps its raw score through a corpus-trained logistic to a same-voice probability p ' +
  `(p ≥ ${VOTE_SAME_AT} → SAME, p ≤ ${VOTE_DIFFERENT_AT} → DIFFERENT, else abstain; abstain also under ${VOICE_MIN_FRAMES} voiced frames). ` +
  'Consensus over non-abstaining matchers: ≥3 SAME with 0 DIFFERENT → SAME VOICE (overrides the spectral-integrity flag veto); ' +
  '≥3 DIFFERENT with 0 SAME → DIFFERENT VOICE (vetoes any MATCH); otherwise NO CONSENSUS.';

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function medianOf(arr: Float32Array | number[]): number {
  const v = Array.from(arr).filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (v.length === 0) return NaN;
  return v[Math.floor(v.length / 2)];
}

/** Calibrated same-voice probability: p = 1/(1+exp(−(a·raw+b))). */
export function calibrate(raw: number, lg: LogisticParams): number {
  if (!Number.isFinite(raw)) return NaN;
  return 1 / (1 + Math.exp(-(lg.a * raw + lg.b)));
}

// --------------------------------------------------------- shared helpers --

/** MFCC shape cosine (legacy voice vote): drop c0, mean-center, cosine over
 * VAD-gated speech frames. Identical math to the legacy pipeline. */
export function mfccVoiceCosine(a: ClipProfile, b: ClipProfile): number {
  const shape = (v: Float32Array): Float32Array => {
    const s = v.slice(1);
    let m = 0;
    for (let i = 0; i < s.length; i++) m += s[i];
    m /= s.length;
    for (let i = 0; i < s.length; i++) s[i] -= m;
    return s;
  };
  const mfccA = shape(meanMfcc(a.spec, a.vad.speechFrames));
  const mfccB = shape(meanMfcc(b.spec, b.vad.speechFrames));
  return cosine01(mfccA, mfccB);
}

/** Median F0 distance in semitones (NaN when either clip lacks voiced frames). */
export function f0SemitoneDistanceOf(a: ClipProfile, b: ClipProfile): number {
  return Number.isFinite(a.f0.medianHz) && Number.isFinite(b.f0.medianHz)
    ? Math.abs(12 * Math.log2(b.f0.medianHz / a.f0.medianHz))
    : NaN;
}

/** Plain cosine similarity in −1..1 (panel raw scores use the signed range). */
function cosineSigned(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na < 1e-20 || nb < 1e-20) return NaN;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Subtract the across-dims mean in place (mean-centering for the cosine). */
function meanCenter(v: Float64Array): Float64Array {
  let m = 0;
  for (let i = 0; i < v.length; i++) m += v[i];
  m /= v.length;
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] - m;
  return out;
}

// ---------------------------------------------------------- DSP primitives --

/** Levinson-Durbin recursion: autocorrelation r[0..order] → LPC coeffs a[1..order]. */
function levinsonDurbin(r: Float64Array, order: number): Float64Array | null {
  const a = new Float64Array(order + 1);
  a[0] = 1;
  let e = r[0];
  if (!(e > 0)) return null;
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / e;
    if (!Number.isFinite(k) || Math.abs(k) >= 1) return null;
    const prev = Float64Array.from(a);
    for (let j = 1; j < i; j++) a[j] = prev[j] + k * prev[i - j];
    a[i] = k;
    e *= 1 - k * k;
    if (!(e > 1e-12)) return null;
  }
  return a;
}

const LPC_ORDER = 12;
const LPC_PREEMPH = 0.97;

/**
 * Roots of a real-coefficient polynomial via the Durand-Kerner method.
 * coeffs[0..n] are the descending-power coefficients (coeffs[0] leading).
 * Returns n complex roots, or null when iteration fails to converge.
 */
function polyRoots(coeffs: Float64Array): { re: number; im: number }[] | null {
  const n = coeffs.length - 1;
  if (n < 1) return null;
  const lead = coeffs[0];
  if (lead === 0) return null;
  const c = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) c[i] = coeffs[i] / lead;

  // Seed on the classic (0.4 + 0.9i)^k spiral — breaks symmetry for real coeffs.
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  {
    let sr = 0.4;
    let si = 0.9;
    for (let k = 0; k < n; k++) {
      re[k] = sr;
      im[k] = si;
      const tr = sr * 0.4 - si * 0.9;
      si = sr * 0.9 + si * 0.4;
      sr = tr;
    }
  }

  const evalPoly = (zr: number, zi: number): [number, number] => {
    // Horner on descending-power coefficients
    let pr = c[0];
    let pi = 0;
    for (let i = 1; i <= n; i++) {
      const tr = pr * zr - pi * zi + c[i];
      pi = pr * zi + pi * zr;
      pr = tr;
    }
    return [pr, pi];
  };

  for (let iter = 0; iter < 300; iter++) {
    let maxStep = 0;
    for (let k = 0; k < n; k++) {
      const [pr, pi] = evalPoly(re[k], im[k]);
      // denominator: product over j≠k of (x_k − x_j)
      let dr = 1;
      let di = 0;
      for (let j = 0; j < n; j++) {
        if (j === k) continue;
        const tr0 = re[k] - re[j];
        const ti0 = im[k] - im[j];
        const ndr = dr * tr0 - di * ti0;
        di = dr * ti0 + di * tr0;
        dr = ndr;
      }
      const denom = dr * dr + di * di;
      if (denom < 1e-24) return null;
      const stepRe = (pr * dr + pi * di) / denom;
      const stepIm = (pi * dr - pr * di) / denom;
      re[k] -= stepRe;
      im[k] -= stepIm;
      const step = Math.abs(stepRe) + Math.abs(stepIm);
      if (step > maxStep) maxStep = step;
    }
    if (maxStep < 1e-12) break;
  }

  const out: { re: number; im: number }[] = [];
  for (let k = 0; k < n; k++) out.push({ re: re[k], im: im[k] });
  return out;
}

/**
 * Root-based F1/F2/F3 from the LPC polynomial of one pre-emphasized voiced
 * frame: keep roots with imag > 0.005, frequency 90–3900 Hz, bandwidth < 400
 * Hz, sort ascending, take the first three. NaN for any missing formant.
 */
function lpcFormantsFromRoots(a: Float64Array, sr: number): [number, number, number] {
  const roots = polyRoots(a);
  if (!roots) return [NaN, NaN, NaN];
  const cands: number[] = [];
  for (const r of roots) {
    if (r.im <= 0.005) continue;
    const mag = Math.hypot(r.re, r.im);
    if (!(mag > 0 && mag < 1)) continue;
    const freq = (Math.atan2(r.im, r.re) * sr) / (2 * Math.PI);
    const bw = (-Math.log(mag) * sr) / Math.PI;
    if (freq < 90 || freq > 3900 || bw >= 400) continue;
    cands.push(freq);
  }
  cands.sort((x, y) => x - y);
  return [cands[0] ?? NaN, cands[1] ?? NaN, cands[2] ?? NaN];
}

/** 24 log-spaced band edges, 200–3600 Hz. */
const LTAS_BANDS = 24;
const LTAS_LO = 200;
const LTAS_HI = 3600;
const LTAS_EDGES: number[] = (() => {
  const e: number[] = [];
  for (let i = 0; i <= LTAS_BANDS; i++) {
    e.push(LTAS_LO * Math.pow(LTAS_HI / LTAS_LO, i / LTAS_BANDS));
  }
  return e;
})();

/**
 * Long-term average spectrum: mean of the per-frame log-power (dB) per
 * log-spaced band over speech frames, mean-normalized across bands.
 * Averaging in the dB domain keeps loud frames from dominating the shape.
 */
function ltasVector(spec: Spectrogram, speechFrames: number[]): Float32Array {
  const binHz = spec.sampleRate / 2 / (spec.bins - 1);
  const acc = new Float64Array(LTAS_BANDS);
  let used = 0;
  for (const f of speechFrames) {
    const row = spec.power[f];
    if (!row) continue;
    used++;
    for (let band = 0; band < LTAS_BANDS; band++) {
      const bLo = Math.max(1, Math.floor(LTAS_EDGES[band] / binHz));
      const bHi = Math.min(spec.bins - 1, Math.ceil(LTAS_EDGES[band + 1] / binHz));
      let s = 0;
      for (let b = bLo; b <= bHi; b++) s += row[b];
      acc[band] += 10 * Math.log10(s + 1e-14);
    }
  }
  const out = new Float32Array(LTAS_BANDS);
  if (used === 0) return out;
  let mean = 0;
  for (let i = 0; i < LTAS_BANDS; i++) {
    out[i] = acc[i] / used;
    mean += out[i];
  }
  mean /= LTAS_BANDS;
  for (let i = 0; i < LTAS_BANDS; i++) out[i] -= mean;
  return out;
}

/**
 * Long-term MFCC+delta vector over speech frames: 13 MFCC + first deltas =
 * 26 rows, drop static c0 → 25 rows (c1..c12, Δc0..Δc12); the per-clip vector
 * is [mean(25), 0.5·std(25)] — 50 dims.
 */
function mfccDeltaVector(spec: Spectrogram, speechFrames: number[]): Float64Array {
  const nC = MFCC_CONFIG.numCoeffs; // 13
  const rows = 2 * nC - 1; // 25
  const frames: Float32Array[] = [];
  for (const f of speechFrames) {
    if (f < 0 || f >= spec.frames) continue;
    frames.push(mfccFrame(spec.power[f], MFCC_CONFIG, spec.sampleRate));
  }
  const out = new Float64Array(2 * rows);
  if (frames.length === 0) return out;
  // 26 feature rows per frame: static c0..c12 + first deltas Δc0..Δc12.
  // First delta = symmetric frame-to-frame difference, (c[t+1] − c[t−1]) / 2,
  // with the frame sequence clamped at the edges.
  const feat: Float64Array[] = frames.map((c, t) => {
    const prev = frames[Math.max(0, t - 1)];
    const next = frames[Math.min(frames.length - 1, t + 1)];
    const row = new Float64Array(2 * nC);
    for (let k = 0; k < nC; k++) {
      row[k] = c[k];
      row[nC + k] = (next[k] - prev[k]) / 2;
    }
    return row;
  });
  // drop static c0 → row index j in 0..24 maps to feature index j+1
  const mean = new Float64Array(rows);
  for (const row of feat) {
    for (let j = 0; j < rows; j++) mean[j] += row[j + 1];
  }
  for (let j = 0; j < rows; j++) mean[j] /= feat.length;
  const std = new Float64Array(rows);
  for (const row of feat) {
    for (let j = 0; j < rows; j++) {
      const d = row[j + 1] - mean[j];
      std[j] += d * d;
    }
  }
  for (let j = 0; j < rows; j++) std[j] = Math.sqrt(std[j] / feat.length);
  for (let j = 0; j < rows; j++) {
    out[j] = mean[j];
    out[rows + j] = 0.5 * std[j];
  }
  return out;
}

/**
 * Extract the per-clip voice print from channel-normalized 16 kHz mono audio.
 * Runs on VAD-gated speech frames (every 2nd frame, like the F0 estimator).
 */
export function extractVoicePrint(
  samples: Float32Array,
  sampleRate: number,
  vad: VadResult,
  spec: Spectrogram,
): VoicePrint {
  const winLen = Math.round(0.04 * sampleRate); // 40 ms (F0 track)
  const lpcLen = Math.round(0.03 * sampleRate); // 30 ms (formant track)
  const minLag = Math.floor(sampleRate / 400);
  const maxLag = Math.ceil(sampleRate / 50);
  const r = new Float64Array(maxLag + 1);
  const rPre = new Float64Array(LPC_ORDER + 1);
  const buf = new Float32Array(winLen);
  const pre = new Float32Array(lpcLen);
  // Hann window applied after pre-emphasis, before the LPC autocorrelation —
  // windowing stabilizes the order-12 fit so the root-based formants hold up.
  const lpcWin = new Float32Array(lpcLen);
  for (let i = 0; i < lpcLen; i++) lpcWin[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (lpcLen - 1)));

  const f0s: number[] = [];
  const f1s: number[] = [];
  const f2s: number[] = [];
  const f3s: number[] = [];
  let formantFrames = 0;

  const frames = vad.speechFrames;
  for (let fi = 0; fi < frames.length; fi += 1) {
    const frame = frames[fi];
    const start = frame * HOP;
    if (start + winLen > samples.length) continue;
    for (let i = 0; i < winLen; i++) buf[i] = samples[start + i];
    for (let lag = 0; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i + lag < winLen; i++) s += buf[i] * buf[i + lag];
      r[lag] = s;
    }
    const r0 = r[0];
    if (r0 / winLen < 1e-7) continue;
    // F0: strongest normalized autocorrelation peak in 50–400 Hz lag range
    let bestLag = -1;
    let bestVal = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const v = r[lag] / r0;
      if (v > bestVal) {
        bestVal = v;
        bestLag = lag;
      }
    }
    if (bestLag <= 0 || bestVal <= 0.3) continue;
    f0s.push(sampleRate / bestLag);

    // LPC formants on the same frame (30 ms window): 0.97 pre-emphasis, then Hann
    pre[0] = buf[0] * lpcWin[0];
    for (let i = 1; i < lpcLen; i++) pre[i] = (buf[i] - LPC_PREEMPH * buf[i - 1]) * lpcWin[i];
    for (let lag = 0; lag <= LPC_ORDER; lag++) {
      let s = 0;
      for (let i = lag; i < lpcLen; i++) s += pre[i] * pre[i - lag];
      rPre[lag] = s;
    }
    const coeffs = levinsonDurbin(rPre, LPC_ORDER);
    if (coeffs) {
      const [f1, f2, f3] = lpcFormantsFromRoots(coeffs, sampleRate);
      f1s.push(f1);
      f2s.push(f2);
      f3s.push(f3);
      // a valid formant frame yields at least one root-based formant
      if (Number.isFinite(f1)) formantFrames++;
    } else {
      f1s.push(NaN);
      f2s.push(NaN);
      f3s.push(NaN);
    }
  }

  return {
    speechFrames: frames.length,
    voicedFrames: f0s.length,
    f0Hz: Float32Array.from(f0s),
    f1Hz: Float32Array.from(f1s),
    f2Hz: Float32Array.from(f2s),
    f3Hz: Float32Array.from(f3s),
    formantFrames,
    mfccVec: mfccDeltaVector(spec, frames),
    ltasDb: ltasVector(spec, frames),
  };
}

// ---------------------------------------------------------------- matchers --

function mkResult(
  id: VoiceMatcherId,
  name: string,
  raw: number,
  logistic: LogisticParams,
  detail: string,
): VoiceMatcherResult {
  const p = calibrate(raw, logistic);
  const verdict: VoiceVerdict = !Number.isFinite(p)
    ? 'abstain'
    : p >= VOTE_SAME_AT
      ? 'same'
      : p <= VOTE_DIFFERENT_AT
        ? 'different'
        : 'abstain';
  return { id, name, raw, p, logistic, verdict, detail };
}

function abstain(
  id: VoiceMatcherId,
  name: string,
  logistic: LogisticParams,
  why: string,
): VoiceMatcherResult {
  return { id, name, raw: NaN, p: NaN, logistic, verdict: 'abstain', detail: `ABSTAIN — ${why}` };
}

/**
 * Run the calibrated 5-matcher voice panel on two channel-normalized clip
 * profiles. The baseline parameter is retained for call-site compatibility;
 * the calibrated matchers no longer widen tolerances per baseline — the
 * logistic maps absorb channel variation (trained on mixed clean/relay pairs).
 */
export function compareVoicePanel(
  a: ClipProfile,
  b: ClipProfile,
  _baseline?: BaselineMode,
): VoicePanel {
  void _baseline; // retained for call-site compatibility (see doc comment)
  const pa = a.voicePrint;
  const pb = b.voicePrint;
  const matchers: VoiceMatcherResult[] = [];
  const fewSpeech =
    pa.speechFrames < VOICE_MIN_FRAMES || pb.speechFrames < VOICE_MIN_FRAMES;
  const fewVoiced =
    pa.voicedFrames < VOICE_MIN_FRAMES || pb.voicedFrames < VOICE_MIN_FRAMES;
  const fewNote = (kind: string) =>
    `too few ${kind} frames (A ${kind === 'voiced' ? pa.voicedFrames : pa.speechFrames}, ` +
    `B ${kind === 'voiced' ? pb.voicedFrames : pb.speechFrames}; need ≥ ${VOICE_MIN_FRAMES} each)`;

  // 1 — MFCC + deltas: cosine of mean-centered 50-dim long-term vectors
  {
    const name = 'MFCC + deltas';
    if (fewSpeech) {
      matchers.push(abstain('mfcc_v2', name, MFCC_V2_LOGISTIC, fewNote('speech')));
    } else {
      const ca = meanCenter(pa.mfccVec);
      const cb = meanCenter(pb.mfccVec);
      const raw = cosineSigned(ca, cb);
      const p = calibrate(raw, MFCC_V2_LOGISTIC);
      matchers.push(
        mkResult(
          'mfcc_v2',
          name,
          raw,
          MFCC_V2_LOGISTIC,
          `mean-centered cosine ${Number.isFinite(raw) ? raw.toFixed(3) : 'n/a'} of the 50-dim ` +
            `MFCC+delta long-term vector over gated speech (A ${pa.speechFrames} / B ${pb.speechFrames} frames) ` +
            `→ calibrated p ${Number.isFinite(p) ? p.toFixed(2) : 'n/a'}`,
        ),
      );
    }
  }

  // 2 — Fisher discriminant: corpus-weighted distance on the same 50-dim vector
  {
    const name = 'Fisher discriminant (corpus-trained)';
    if (fewSpeech) {
      matchers.push(abstain('fisher', name, FISHER_LOGISTIC, fewNote('speech')));
    } else {
      let num = 0;
      let den = 0;
      for (let j = 0; j < FISHER_WEIGHTS.length; j++) {
        const d = pa.mfccVec[j] - pb.mfccVec[j];
        num += FISHER_WEIGHTS[j] * d * d;
        den += FISHER_WEIGHTS[j];
      }
      const dist = den > 0 ? Math.sqrt(num / den) : NaN;
      const raw = Number.isFinite(dist) ? -dist : NaN;
      const p = calibrate(raw, FISHER_LOGISTIC);
      matchers.push(
        mkResult(
          'fisher',
          name,
          raw,
          FISHER_LOGISTIC,
          `Fisher-weighted distance ${Number.isFinite(dist) ? dist.toFixed(3) : 'n/a'} ` +
            `(50 corpus-trained between/within-speaker weights) → calibrated p ${Number.isFinite(p) ? p.toFixed(2) : 'n/a'}`,
        ),
      );
    }
  }

  // 3 — Formant signature: LPC order 12 root-based F1/F2/F3 medians
  {
    const name = 'Formant signature';
    if (fewVoiced) {
      matchers.push(abstain('formant', name, FORMANT_LOGISTIC, fewNote('voiced')));
    } else if (pa.formantFrames < FORMANT_MIN_FRAMES || pb.formantFrames < FORMANT_MIN_FRAMES) {
      matchers.push(
        abstain(
          'formant',
          name,
          FORMANT_LOGISTIC,
          `fewer than ${FORMANT_MIN_FRAMES} frames with valid root-based formants ` +
            `(A ${pa.formantFrames}, B ${pb.formantFrames})`,
        ),
      );
    } else {
      const medA = [medianOf(pa.f1Hz), medianOf(pa.f2Hz), medianOf(pa.f3Hz)];
      const medB = [medianOf(pb.f1Hz), medianOf(pb.f2Hz), medianOf(pb.f3Hz)];
      const sims: number[] = [];
      const parts: string[] = [];
      for (let i = 0; i < 3; i++) {
        if (!Number.isFinite(medA[i]) || !Number.isFinite(medB[i]) || medA[i] <= 0 || medB[i] <= 0)
          continue;
        const d = Math.abs(medA[i] - medB[i]) / ((medA[i] + medB[i]) / 2);
        sims.push(clamp01(1 - d / FORMANT_REL_FULL));
        parts.push(
          `F${i + 1} ${Math.round(medA[i])}→${Math.round(medB[i])} Hz (${Math.round(d * 100)}%)`,
        );
      }
      if (sims.length === 0) {
        matchers.push(
          abstain('formant', name, FORMANT_LOGISTIC, 'no stable root-based formants on at least one clip'),
        );
      } else {
        const raw = sims.reduce((s, v) => s + v, 0) / sims.length;
        const p = calibrate(raw, FORMANT_LOGISTIC);
        matchers.push(
          mkResult(
            'formant',
            name,
            raw,
            FORMANT_LOGISTIC,
            `LPC order ${LPC_ORDER} root-based medians A→B: ${parts.join(', ')} — ` +
              `raw ${raw.toFixed(2)} (mean of clip(1 − Δ/${FORMANT_REL_FULL})) → calibrated p ${p.toFixed(2)}`,
          ),
        );
      }
    }
  }

  // 4 — Pitch / F0: autocorrelation F0 median distance in semitones
  {
    const name = 'Pitch / F0';
    if (fewVoiced) {
      matchers.push(abstain('f0', name, F0_LOGISTIC, fewNote('voiced')));
    } else {
      const medA = medianOf(pa.f0Hz);
      const medB = medianOf(pb.f0Hz);
      if (!Number.isFinite(medA) || !Number.isFinite(medB) || medA <= 0 || medB <= 0) {
        matchers.push(abstain('f0', name, F0_LOGISTIC, 'no stable median F0 on at least one clip'));
      } else {
        const semi = Math.abs(12 * Math.log2(medB / medA));
        const raw = Math.exp(-semi / F0_SEMITONE_SCALE);
        const p = calibrate(raw, F0_LOGISTIC);
        matchers.push(
          mkResult(
            'f0',
            name,
            raw,
            F0_LOGISTIC,
            `median F0 ${Math.round(medA)}→${Math.round(medB)} Hz, ${semi.toFixed(1)} semitones apart — ` +
              `raw exp(−Δ/${F0_SEMITONE_SCALE}) ${raw.toFixed(2)} → calibrated p ${p.toFixed(2)}`,
          ),
        );
      }
    }
  }

  // 5 — Long-term spectrum: 24-band LTAS (dB, mean-normalized) cosine
  {
    const name = 'Long-term spectrum';
    if (fewSpeech) {
      matchers.push(abstain('ltas', name, LTAS_LOGISTIC, fewNote('speech')));
    } else {
      const raw = cosineSigned(pa.ltasDb, pb.ltasDb);
      const p = calibrate(raw, LTAS_LOGISTIC);
      matchers.push(
        mkResult(
          'ltas',
          name,
          raw,
          LTAS_LOGISTIC,
          `cosine ${Number.isFinite(raw) ? raw.toFixed(3) : 'n/a'} of 24 log-spaced bands ` +
            `(200–3600 Hz) mean-normalized LTAS over speech frames → calibrated p ${Number.isFinite(p) ? p.toFixed(2) : 'n/a'}`,
        ),
      );
    }
  }

  // --- consensus (exact calibrated rule, documented in VOICE_RULE_TEXT) ---
  const sameCount = matchers.filter((m) => m.verdict === 'same').length;
  const differentCount = matchers.filter((m) => m.verdict === 'different').length;
  const abstainCount = matchers.length - sameCount - differentCount;
  const voters = sameCount + differentCount;
  let consensus: VoiceConsensus = 'no_consensus';
  if (sameCount >= 3 && differentCount === 0) consensus = 'same';
  else if (differentCount >= 3 && sameCount === 0) consensus = 'different';
  const agreeCount =
    consensus === 'same'
      ? sameCount
      : consensus === 'different'
        ? differentCount
        : Math.max(sameCount, differentCount);
  return {
    matchers,
    sameCount,
    differentCount,
    abstainCount,
    voters,
    agreeCount,
    consensus,
    overrideEngaged: consensus === 'same',
    vetoEngaged: consensus === 'different',
    rule: VOICE_RULE_TEXT,
  };
}