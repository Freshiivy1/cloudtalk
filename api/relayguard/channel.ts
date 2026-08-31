// channel.ts — channel baseline models applied to BOTH clips before comparison.
// Implemented with cascaded RBJ biquads + mu-law companding + optional light line noise.

export type BaselineMode = 'good' | 'okay' | 'poor';

export interface BaselineInfo {
  mode: BaselineMode;
  label: string;
  /** thinness delta margin: B must be thinner than A by more than this to vote relay */
  margin: number;
  /** passband for the band diagram strip, Hz */
  band: [number, number];
  description: string;
}

export const BASELINES: Record<BaselineMode, BaselineInfo> = {
  good: {
    mode: 'good',
    label: 'Good — clean recording',
    margin: 0.03,
    band: [0, 8000],
    description:
      'Wideband 16 kHz passthrough. Expect energy well above 3.4 kHz; thinness margins are tight (0.03), so even mild high-frequency loss counts against B.',
  },
  okay: {
    mode: 'okay',
    label: 'Okay — normal phone',
    margin: 0.05,
    band: [300, 3600],
    description:
      'Standard 8 kHz telephony with a mild ~3.6 kHz lowpass. Most cellular and landline calls land here; this is the baseline for typical A/B comparisons. Thinness margin is halved to 0.05 — mild bass or bandwidth loss already counts.',
  },
  poor: {
    mode: 'poor',
    label: 'Poor — prison phone',
    margin: 0.08,
    band: [300, 3400],
    description:
      '300–3400 Hz bandpass, heavy mu-law compression and audible line noise. Both clips are expected to be thin — relay evidence then rests on the other signals. Thinness margin 0.08; bass is judged from the 300–500 Hz low-inband instead of the stripped sub-300 region.',
  },
};

export function thinnessMargin(mode: BaselineMode): number {
  return BASELINES[mode].margin;
}

// ---------------------------------------------------------------- biquads --

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

function makeBiquad(
  type: 'lowpass' | 'highpass' | 'bandpass' | 'peaking',
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
  switch (type) {
    case 'lowpass':
      b0 = (1 - cosw) / 2;
      b1 = 1 - cosw;
      b2 = (1 - cosw) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cosw) / 2;
      b1 = -(1 + cosw);
      b2 = (1 + cosw) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
      break;
    case 'bandpass': // constant skirt gain, peak gain = Q
      b0 = sinw / 2;
      b1 = 0;
      b2 = -sinw / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
      break;
    case 'peaking':
      b0 = 1 + alpha * A;
      b1 = -2 * cosw;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosw;
      a2 = 1 - alpha / A;
      break;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

function runBiquad(samples: Float32Array, f: Biquad): Float32Array {
  const out = new Float32Array(samples.length);
  const { b0, b1, b2, a1, a2 } = f;
  let { x1, x2, y1, y2 } = f;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    out[i] = y0;
  }
  return out;
}

function cascade(samples: Float32Array, filters: Biquad[]): Float32Array {
  let out = samples;
  for (const f of filters) out = runBiquad(out, f);
  return out;
}

// ---------------------------------------------------------------- mu-law ---

const MU = 255;

export function mulawEncode(x: number): number {
  const s = Math.max(-1, Math.min(1, x));
  const sign = s < 0 ? -1 : 1;
  return sign * (Math.log(1 + MU * Math.abs(s)) / Math.log(1 + MU));
}

export function mulawDecode(y: number): number {
  const sign = y < 0 ? -1 : 1;
  return sign * ((Math.pow(1 + MU, Math.abs(y)) - 1) / MU);
}

/** Mu-law compand with 8-bit quantization (like telephony PCM). */
export function mulawCompand(samples: Float32Array, quantize = true): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let y = mulawEncode(samples[i]);
    if (quantize) y = Math.round(y * 127) / 127;
    out[i] = mulawDecode(y);
  }
  return out;
}

/** Simple feed-forward level compressor. */
function compress(samples: Float32Array, thresholdDb: number, ratio: number, sr: number): Float32Array {
  const out = new Float32Array(samples.length);
  const thresh = Math.pow(10, thresholdDb / 20);
  const attack = Math.exp(-1 / (0.005 * sr));
  const release = Math.exp(-1 / (0.08 * sr));
  let env = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    env = a > env ? attack * env + (1 - attack) * a : release * env + (1 - release) * a;
    let g = 1;
    if (env > thresh) {
      const overDb = 20 * Math.log10(env / thresh);
      g = Math.pow(10, (-(overDb - overDb / ratio)) / 20);
    }
    out[i] = samples[i] * g;
  }
  return out;
}

// ------------------------------------------------------------- processing --

/** Deterministic light line-noise (hum + hiss), seeded by a simple LCG. */
function addLineNoise(samples: Float32Array, sr: number, humHz: number, level: number): Float32Array {
  const out = new Float32Array(samples.length);
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let i = 0; i < samples.length; i++) {
    const hum = Math.sin((2 * Math.PI * humHz * i) / sr) * level * 0.6;
    const hiss = rand() * level;
    out[i] = Math.max(-1, Math.min(1, samples[i] + hum + hiss));
  }
  return out;
}

/**
 * Apply a channel baseline model to normalized 16 kHz mono audio.
 * The input is expected to be peak-normalized; output is peak-normalized again
 * to the same peak so comparisons stay level-matched.
 */
export function applyBaseline(samples: Float32Array, sr: number, mode: BaselineMode): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  if (peak < 1e-8) peak = 1;

  let out: Float32Array;
  if (mode === 'good') {
    // Wideband passthrough, mild 8k lowpass (2-pole x2 ≈ 4th order at ~7.6k)
    out = cascade(samples, [
      makeBiquad('lowpass', sr, 7600, 0.707),
      makeBiquad('lowpass', sr, 7600, 0.707),
    ]);
  } else if (mode === 'okay') {
    // Telephony: mild ~300 Hz highpass + mild ~3.6 kHz lowpass (2nd order each)
    // + gentle compression. Kept mild so relative thinness between clips survives.
    out = cascade(samples, [
      makeBiquad('highpass', sr, 300, 0.707),
      makeBiquad('lowpass', sr, 3600, 0.707),
    ]);
    out = compress(out, -18, 2.5, sr);
  } else {
    // Poor: 300–3400 Hz bandpass (steep), mu-law compand + quantization, light line noise
    out = cascade(samples, [
      makeBiquad('highpass', sr, 300, 0.707),
      makeBiquad('highpass', sr, 300, 0.9),
      makeBiquad('lowpass', sr, 3400, 0.707),
      makeBiquad('lowpass', sr, 3400, 0.9),
    ]);
    out = mulawCompand(out, true);
    out = compress(out, -20, 3, sr);
    out = addLineNoise(out, sr, 120, 0.0035);
  }

  // Re-normalize to input peak
  let p2 = 0;
  for (let i = 0; i < out.length; i++) {
    const v = Math.abs(out[i]);
    if (v > p2) p2 = v;
  }
  if (p2 > 1e-8) {
    const g = peak / p2;
    for (let i = 0; i < out.length; i++) out[i] *= g;
  }
  return out;
}
