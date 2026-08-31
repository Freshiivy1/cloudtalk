// stft.ts — windowed STFT (1024/512 Hann) → power spectrogram, plus MFCC.

export const FFT_SIZE = 1024;
export const HOP = 512;

export interface Spectrogram {
  /** power[frame][bin], bin count = FFT_SIZE/2 + 1 */
  power: Float32Array[];
  frames: number;
  bins: number;
  sampleRate: number;
  fftSize: number;
  hop: number;
}

let hannCache: Float32Array | null = null;

function hann(n: number): Float32Array {
  if (hannCache && hannCache.length === n) return hannCache;
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  hannCache = w;
  return w;
}

// In-place iterative radix-2 FFT. re/im length must be power of two.
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  // bit-reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j];
        const ui = im[i + j];
        const vr = re[i + j + len / 2] * cwr - im[i + j + len / 2] * cwi;
        const vi = re[i + j + len / 2] * cwi + im[i + j + len / 2] * cwr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr;
        im[i + j + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

/** Compute power spectrogram of mono samples. */
export function stft(samples: Float32Array, sampleRate: number): Spectrogram {
  const win = hann(FFT_SIZE);
  const bins = FFT_SIZE / 2 + 1;
  const frames = Math.max(0, Math.floor((samples.length - FFT_SIZE) / HOP) + 1);
  const power: Float32Array[] = new Array(frames);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = samples[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const row = new Float32Array(bins);
    for (let b = 0; b < bins; b++) row[b] = re[b] * re[b] + im[b] * im[b];
    power[f] = row;
  }
  return { power, frames, bins, sampleRate, fftSize: FFT_SIZE, hop: HOP };
}

/** Frame RMS levels (dBFS) straight from samples at HOP spacing. */
export function frameLevelsDb(samples: Float32Array): Float32Array {
  const frames = Math.max(0, Math.floor((samples.length - FFT_SIZE) / HOP) + 1);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    let sum = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const v = samples[off + i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / FFT_SIZE);
    out[f] = 20 * Math.log10(rms + 1e-10);
  }
  return out;
}

// ------------------------------------------------------------------ MFCC ---

export interface MfccConfig {
  numCoeffs: number;
  numFilters: number;
  lowHz: number;
  highHz: number;
}

export const MFCC_CONFIG: MfccConfig = {
  numCoeffs: 13,
  numFilters: 26,
  lowHz: 300,
  highHz: 3400,
};

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}
function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

let filterbankCache: { key: string; fb: Float32Array[] } | null = null;

function melFilterbank(cfg: MfccConfig, sampleRate: number, bins: number): Float32Array[] {
  const key = `${cfg.numFilters}:${cfg.lowHz}:${cfg.highHz}:${sampleRate}:${bins}`;
  if (filterbankCache && filterbankCache.key === key) return filterbankCache.fb;
  const binHz = sampleRate / 2 / (bins - 1);
  const lowMel = hzToMel(cfg.lowHz);
  const highMel = hzToMel(Math.min(cfg.highHz, sampleRate / 2));
  const fb: Float32Array[] = [];
  const points: number[] = [];
  for (let i = 0; i < cfg.numFilters + 2; i++) {
    points.push(melToHz(lowMel + ((highMel - lowMel) * i) / (cfg.numFilters + 1)));
  }
  for (let m = 0; m < cfg.numFilters; m++) {
    const f = new Float32Array(bins);
    const fL = points[m];
    const fC = points[m + 1];
    const fR = points[m + 2];
    for (let b = 0; b < bins; b++) {
      const hz = b * binHz;
      if (hz >= fL && hz <= fC && fC > fL) f[b] = (hz - fL) / (fC - fL);
      else if (hz > fC && hz <= fR && fR > fC) f[b] = (fR - hz) / (fR - fC);
    }
    fb.push(f);
  }
  filterbankCache = { key, fb };
  return fb;
}

/** MFCC for one power-spectrum frame (row of `bins` values). */
export function mfccFrame(
  powerRow: Float32Array,
  cfg: MfccConfig,
  sampleRate: number,
): Float32Array {
  const fb = melFilterbank(cfg, sampleRate, powerRow.length);
  const energies = new Float32Array(cfg.numFilters);
  for (let m = 0; m < cfg.numFilters; m++) {
    let e = 0;
    const filt = fb[m];
    for (let b = 0; b < powerRow.length; b++) e += powerRow[b] * filt[b];
    energies[m] = Math.log(e + 1e-12);
  }
  // DCT-II
  const out = new Float32Array(cfg.numCoeffs);
  for (let k = 0; k < cfg.numCoeffs; k++) {
    let s = 0;
    for (let m = 0; m < cfg.numFilters; m++) {
      s += energies[m] * Math.cos((Math.PI * k * (m + 0.5)) / cfg.numFilters);
    }
    out[k] = s;
  }
  return out;
}

/** Mean MFCC vector over a set of frame indices. */
export function meanMfcc(
  spec: Spectrogram,
  frameIdx: number[],
  cfg: MfccConfig = MFCC_CONFIG,
): Float32Array {
  const acc = new Float32Array(cfg.numCoeffs);
  if (frameIdx.length === 0) return acc;
  for (const f of frameIdx) {
    if (f < 0 || f >= spec.frames) continue;
    const v = mfccFrame(spec.power[f], cfg, spec.sampleRate);
    for (let k = 0; k < cfg.numCoeffs; k++) acc[k] += v[k];
  }
  for (let k = 0; k < cfg.numCoeffs; k++) acc[k] /= frameIdx.length;
  return acc;
}

/** Cosine similarity of two vectors, mapped 0..1 (from -1..1). */
export function cosine01(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na < 1e-12 || nb < 1e-12) return 0;
  const cos = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return (cos + 1) / 2;
}
