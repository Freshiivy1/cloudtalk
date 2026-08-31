// probe.ts — deterministic "challenge noise" probe. (Vendored from
// relayguard-forensics; browser playback (WebAudio startProbe/stopProbe)
// stripped so this module imports cleanly under Node.)
// A seeded PRNG drives white noise through a fixed biquad chain (high-pass
// ~500 Hz, low-pass ~6 kHz, gentle 1–4 kHz presence lift) so the probe is
// bass-free: the telephone channel strips sub-300 Hz content anyway, and bass
// would only mask speech. The generator is a pure function of
// (seed, duration, sample rate), so the analyzer can reconstruct the exact
// expected probe spectrum analytically and correlate it against what arrived.
import { stft } from './stft';

export interface ProbeMeta {
  on: boolean;
  seed: number;
  /** slider level 0–100 */
  level: number;
  /** probe passband, Hz */
  band: [number, number];
}

export const PROBE_SEED = 0x5eed;
export const PROBE_BAND: [number, number] = [500, 6000];
export const PROBE_DEFAULT_LEVEL = 35;

/** mulberry32 — tiny deterministic PRNG, stable across browsers. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- biquads --

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function makeBiquad(
  type: 'lowpass' | 'highpass' | 'peaking',
  sr: number,
  f0: number,
  q: number,
  gainDb = 0,
): Biquad {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / sr;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * q);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (type === 'lowpass') {
    b0 = (1 - cosw) / 2;
    b1 = 1 - cosw;
    b2 = (1 - cosw) / 2;
  } else if (type === 'highpass') {
    b0 = (1 + cosw) / 2;
    b1 = -(1 + cosw);
    b2 = (1 + cosw) / 2;
  } else {
    b0 = 1 + alpha * A;
    b1 = -2 * cosw;
    b2 = 1 - alpha * A;
  }
  if (type === 'peaking') {
    a0 = 1 + alpha / A;
    a1 = -2 * cosw;
    a2 = 1 - alpha / A;
  } else {
    a0 = 1 + alpha;
    a1 = -2 * cosw;
    a2 = 1 - alpha;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function runBiquad(samples: Float32Array, f: Biquad): void {
  const { b0, b1, b2, a1, a2 } = f;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    samples[i] = y0;
  }
}

/** The fixed shaping chain — must stay identical between generator + analyzer. */
function shapeChain(sr: number): Biquad[] {
  return [
    makeBiquad('highpass', sr, 500, 0.707),
    makeBiquad('highpass', sr, 500, 0.707), // 4th-order HP: no bass survives
    makeBiquad('lowpass', sr, 6000, 0.707),
    makeBiquad('peaking', sr, 2000, 0.9, 4), // gentle 1–4 kHz presence lift
  ];
}

/**
 * Generate the shaped probe noise. Pure function of (seed, durationSec,
 * sampleRate): the same arguments always produce the same buffer.
 */
export function generateProbe(durationSec: number, sampleRate: number, seed = PROBE_SEED): Float32Array {
  const n = Math.max(1, Math.round(durationSec * sampleRate));
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  for (let i = 0; i < n; i++) out[i] = rand() * 2 - 1;
  for (const f of shapeChain(sampleRate)) runBiquad(out, f);
  // Normalize to a fixed RMS so `level` is the only loudness control.
  let sum = 0;
  for (let i = 0; i < n; i++) sum += out[i] * out[i];
  const rms = Math.sqrt(sum / n);
  if (rms > 1e-9) {
    const g = 0.25 / rms;
    for (let i = 0; i < n; i++) out[i] *= g;
  }
  return out;
}

/**
 * Generate a seamlessly looping probe buffer: a 50 ms equal-power crossfade
 * is baked into the loop seam so `source.loop = true` never clicks.
 */
export function generateProbeLoop(loopSec: number, sampleRate: number, seed = PROBE_SEED): Float32Array {
  const xfade = Math.min(Math.round(0.05 * sampleRate), Math.round((loopSec * sampleRate) / 4));
  const n = Math.round(loopSec * sampleRate);
  // Generate extra material, then fold the tail back onto the head.
  const ext = generateProbe(loopSec + xfade / sampleRate, sampleRate, seed);
  const out = ext.slice(0, n);
  for (let i = 0; i < xfade; i++) {
    const t = (i + 1) / (xfade + 1);
    const head = Math.sin((t * Math.PI) / 2);
    const tail = Math.cos((t * Math.PI) / 2);
    out[i] = out[i] * head + ext[n + i] * tail;
  }
  return out;
}

/** Playback gain for a 0–100 slider level (35% ≈ −15 dB rel full scale). */
export function probeGain(level: number): number {
  return 0.5 * Math.max(0, Math.min(100, level)) / 100;
}

/** dB relative to full-scale shaped noise, for the live indicator. */
export function probeLevelDb(level: number): number {
  const g = probeGain(level);
  return g > 1e-6 ? 20 * Math.log10(g) : -Infinity;
}

// ------------------------------------------------------ expected spectrum --

const EXPECTED_DURATION_SEC = 3;

/**
 * Analytically expected probe-band spectrum: mean per-bin power of the
 * generated probe, sliced to the probe band and aligned to the analyzer's
 * spectrogram grid (`bins` × `sampleRate`). Pure function of
 * (seed, bins, sampleRate).
 */
export function expectedProbeBandPower(
  bins: number,
  sampleRate: number,
  seed = PROBE_SEED,
): Float32Array {
  const { lo, hi, n } = probeBandBins(bins, sampleRate);
  const out = new Float32Array(n);
  if (n <= 0) return out;
  const samples = generateProbe(EXPECTED_DURATION_SEC, sampleRate, seed);
  // Average power per bin over the analyzer's own STFT grid (stft.ts does not
  // depend on probe.ts, so there is no import cycle).
  const spec = stft(samples, sampleRate);
  if (spec.frames === 0) return out;
  for (let f = 0; f < spec.frames; f++) {
    const row = spec.power[f];
    for (let b = lo; b <= hi; b++) out[b - lo] += row[b];
  }
  for (let i = 0; i < n; i++) out[i] /= spec.frames;
  return out;
}

/** Probe-band bin range on the analyzer's spectrogram grid. */
export function probeBandBins(
  bins: number,
  sampleRate: number,
  band: [number, number] = PROBE_BAND,
): { lo: number; hi: number; n: number } {
  const binHz = sampleRate / 2 / (bins - 1);
  const hiHz = Math.min(band[1], sampleRate / 2);
  const lo = Math.max(1, Math.round(band[0] / binHz));
  const hi = Math.min(bins - 1, Math.round(hiHz / binHz));
  return { lo, hi, n: Math.max(0, hi - lo + 1) };
}

// (Browser playback section removed in the Node vendored copy — the server
// renders the probe to a WAV buffer in noise.ts instead of WebAudio.)
