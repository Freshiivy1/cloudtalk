/**
 * sim-channel.ts — deterministic simulation channel models + WAV fixture
 * loading shared by the real-DSP relayguard tests (speakerphone simulation
 * and the caller-activity arming-gate scenarios). MOVED VERBATIM from
 * speakerphone-simulation.test.ts so every simulation test runs the SAME
 * channel code (a hand-copied highpass coefficient once silently changed the
 * simulated audio and invalidated a probe — single source of truth now).
 *
 * Fixtures (8 kHz mono PCM16 WAV, real TTS speech):
 *   fixtures/sim-callee-8k.wav — female voice, the CALLEE
 *   fixtures/sim-caller-8k.wav — male voice, the CALLER
 *
 * Channel models (deterministic, seeded):
 *   direct() — normal path: 300–3400 Hz telephone bandpass + a bed crushed
 *              ≈60 dB under speech (field anchor: direct bed → −67 dBFS).
 *   relay()  — speakerphone relay double path: dense FIR room reverb
 *              (20 taps to 411 ms), speaker/mic band shaping, soft-clip
 *              nonlinearity, a room bed, then a speakerphone-style AGC that
 *              lifts quiet parts up to +26 dB toward speech level, then the
 *              relaying phone's own telephone channel.
 */
import fs from "fs";

export const SIM_SAMPLE_RATE = 8000;
const SR = SIM_SAMPLE_RATE;

export function loadWavPcm16(name: string): Float32Array {
  const buf = fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  // minimal RIFF parse: find the data chunk
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      const out = new Float32Array(size / 2);
      for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + size + (size & 1);
  }
  throw new Error(`fixture ${name}: no data chunk`);
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function biquad(type: "lowpass" | "highpass" | "peaking", f0: number, q: number, gainDb = 0) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / SR;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * q);
  let b0: number, b1: number, b2: number;
  const a0 = 1 + alpha, a1 = -2 * cosw, a2 = 1 - alpha;
  if (type === "lowpass") { b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2; }
  else if (type === "highpass") { b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2; }
  else { b0 = 1 + alpha * A; b1 = -2 * cosw; b2 = 1 - alpha * A; }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function runBiquad(x: Float32Array, f: ReturnType<typeof biquad>): Float32Array {
  const out = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y0 = f.b0 * x[i] + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y0;
    out[i] = y0;
  }
  return out;
}

function telephone(x: Float32Array): Float32Array {
  let y = runBiquad(x, biquad("highpass", 300, 0.707));
  y = runBiquad(y, biquad("highpass", 300, 0.9));
  y = runBiquad(y, biquad("lowpass", 3400, 0.707));
  y = runBiquad(y, biquad("lowpass", 3400, 0.9));
  return y;
}

function rmsActive(x: Float32Array): number {
  let s = 0, n = 0;
  for (let i = 0; i < x.length; i++) {
    const a = x[i] * x[i];
    if (a > 1e-8) { s += a; n++; }
  }
  return n ? Math.sqrt(s / n) : 1e-6;
}

/** Direct handset: telephone channel + bed ≈60 dB under speech RMS. */
export function direct(x: Float32Array, seed: number, bedRelDb = -60): Float32Array {
  const y = telephone(x);
  const rng = lcg(seed);
  const bed = Math.pow(10, bedRelDb / 20) * rmsActive(y);
  const out = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) out[i] = y[i] + (rng() * 2 - 1) * bed;
  return out;
}

/** Speakerphone relay double path (see file header). */
export function relay(x: Float32Array, seed: number, bedRelDb = -14): Float32Array {
  // Dense FIR room response (stable by construction): early taps + tail.
  const taps: [number, number][] = [
    [0.017, 0.5], [0.031, 0.48], [0.047, 0.44], [0.063, 0.4], [0.081, 0.36],
    [0.101, 0.33], [0.123, 0.3], [0.147, 0.27], [0.173, 0.24], [0.201, 0.21],
    [0.231, 0.19], [0.263, 0.17], [0.297, 0.15], [0.333, 0.13], [0.371, 0.11],
    [0.411, 0.09],
  ];
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let v = x[i];
    for (const [t, g] of taps) {
      const d = Math.floor(t * SR);
      if (i >= d) v += g * x[i - d];
    }
    y[i] = v;
  }
  // speaker + mic band shaping
  let z = runBiquad(y, biquad("highpass", 350, 0.8));
  z = runBiquad(z, biquad("lowpass", 3200, 0.8));
  z = runBiquad(z, biquad("peaking", 1000, 2.5, -5));
  // soft-clip nonlinearity (speaker driven hard)
  for (let i = 0; i < z.length; i++) z[i] = Math.tanh(1.4 * z[i]);
  // diffuse room bed
  const rng = lcg(seed);
  const bed = Math.pow(10, bedRelDb / 20) * rmsActive(z);
  for (let i = 0; i < z.length; i++) z[i] += (rng() * 2 - 1) * bed;
  // speakerphone AGC: lifts quiet parts (bed + reverb tail) toward speech
  // level — the physical origin of the ≈8.5 dB speech-to-bed drowning anchor.
  const atk = Math.exp(-1 / (0.005 * SR));
  const rel = Math.exp(-1 / (0.15 * SR));
  let env = 1e-6;
  const envs = new Float32Array(z.length);
  for (let i = 0; i < z.length; i++) {
    const a = Math.abs(z[i]);
    env = a > env ? atk * env + (1 - atk) * a : rel * env + (1 - rel) * a;
    envs[i] = env;
  }
  const sorted = Float32Array.from(envs).sort();
  const ref = sorted[Math.floor(sorted.length * 0.9)] || 1e-6;
  const maxBoost = Math.pow(10, 26 / 20);
  let g = 1;
  for (let i = 0; i < z.length; i++) {
    const want = Math.min(maxBoost, ref / Math.max(envs[i], 1e-6));
    g = rel * g + (1 - rel) * want;
    z[i] *= g;
  }
  return telephone(z);
}

/** Peak-normalize like the detector does internally (for direct DSP probes). */
export function peakNorm(x: Float32Array): Float32Array {
  let p = 0;
  for (const v of x) if (Math.abs(v) > p) p = Math.abs(v);
  const g = p > 0 ? 0.9 / p : 1;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
  return out;
}
