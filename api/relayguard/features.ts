// features.ts — per-clip forensic profile computed from 16 kHz mono audio.
import { stft, frameLevelsDb, type Spectrogram } from './stft';
import { runVad, type VadResult } from './vad';
import {
  expectedProbeBandPower,
  probeBandBins,
  PROBE_BAND,
  type ProbeMeta,
} from './probe';
import { extractVoicePrint, type VoicePrint } from './voice';

export type NoiseLabel = 'quiet' | 'elevated' | 'very_noisy';
export type PitchClass = 'male-typical' | 'female-typical' | 'ambiguous';
export type FidelityState = 'GREEN' | 'AMBER' | 'RED';

export interface BandEnergies {
  sub300: number;
  inband: number; // 300–3400
  above3400: number;
  above4000: number;
}

export interface NoiseBed {
  snrDb: number;
  bedDb: number;
  speechDb: number;
  /** speech − bed, in dB. Field anchors: ≈ 8.5 dB = speakerphone drowning in a
   * noisy room; a bed crushed toward −67 dBFS yields a large margin = direct. */
  speechToBedDb: number;
  label: NoiseLabel;
}

/** Probe analysis attached to a clip recorded under challenge noise. */
export interface ProbeReading {
  on: boolean;
  seed: number;
  level: number;
  band: [number, number];
  /** spectral flatness inside the probe band on non-speech (probe-dominant)
   * frames. Noisy-room anchors: 0.1469 speakerphone vs 0.0034 direct (43×). */
  bandFlatness: number;
  /** Pearson correlation of the received probe-band long-term spectrum against
   * the analytically expected probe spectrum (0–1). NaN when unavailable. */
  fidelity: number;
  fidelityState: FidelityState;
}

export interface F0Stats {
  medianHz: number;
  p25Hz: number;
  p75Hz: number;
  voicedFraction: number;
  pitchClass: PitchClass;
}

/**
 * Spectral-integrity measurements taken on VAD-gated SPEECH frames only.
 * Thin audio (depleted low end, narrowed bandwidth) is a primary
 * speakerphone-relay symptom, so these are measured strictly on speech.
 */
export interface SpeechSpectrum {
  /** number of VAD speech frames contributing (empty clip → 0) */
  frames: number;
  /** fraction of speech-frame energy in 80–300 Hz (fundamental region) */
  lowBand: number;
  /** fraction of speech-frame energy in 300–500 Hz (low-inband; used when the
   * channel strips fundamentals, e.g. the poor baseline) */
  lowInband: number;
  /** power-weighted spectral centroid over speech frames */
  centroidHz: number;
  /** 95% cumulative-energy frequency of the speech-frame mean spectrum */
  p95Hz: number;
  /** mean power spectrum over speech frames (per bin) */
  meanSpectrum: Float32Array;
}

export interface ClipProfile {
  sampleRate: number;
  duration: number;
  spec: Spectrogram;
  vad: VadResult;
  bands: BandEnergies;
  centroidHz: number;
  p95Hz: number;
  p99Hz: number;
  /** thinness score = in-band energy fraction (0..1); higher = more telephone-thin */
  thinness: number;
  /** mean spectral flatness on speech frames (0..1) */
  burstFlatness: number;
  /** mean spectral flatness across all frames */
  flatnessAll: number;
  /** spectral flatness measured inside the probe band (500 Hz–6 kHz) on
   * non-speech frames; NaN when there are no non-speech frames */
  probeBandFlatness: number;
  gapVsBurstDb: number;
  noise: NoiseBed;
  f0: F0Stats;
  /** long-term average power spectrum (per bin) */
  meanSpectrum: Float32Array;
  /** spectral-integrity measurements on VAD-gated speech frames */
  speech: SpeechSpectrum;
  /** voice-biometric print (F0 track, root-based LPC formants, 50-dim
   * MFCC+delta long-term vector, 24-band LTAS) extracted on VAD-gated
   * speech — input to the calibrated 5-matcher voice panel */
  voicePrint: VoicePrint;
  /** present only when the clip was recorded with the challenge-noise probe */
  probe?: ProbeReading;
}

function percentileOf(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

/** Frequency below which `frac` of the total spectral energy lies. */
export function cumulativeEnergyHz(meanSpec: Float32Array, binHz: number, frac: number): number {
  let total = 0;
  for (let i = 0; i < meanSpec.length; i++) total += meanSpec[i];
  if (total <= 0) return 0;
  const target = total * frac;
  let acc = 0;
  for (let i = 0; i < meanSpec.length; i++) {
    acc += meanSpec[i];
    if (acc >= target) return i * binHz;
  }
  return (meanSpec.length - 1) * binHz;
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n < 4) return NaN;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da < 1e-20 || db < 1e-20) return NaN;
  return num / Math.sqrt(da * db);
}

function spectralFlatness(row: Float32Array): number {
  // geometric mean / arithmetic mean, epsilon-floored
  let logSum = 0;
  let sum = 0;
  const n = row.length;
  for (let i = 0; i < n; i++) {
    const v = row[i] + 1e-14;
    logSum += Math.log(v);
    sum += v;
  }
  const gm = Math.exp(logSum / n);
  const am = sum / n;
  return am > 0 ? gm / am : 0;
}

/** Autocorrelation F0 estimate over speech frames. */
function estimateF0(
  samples: Float32Array,
  sr: number,
  speechFrames: number[],
): F0Stats {
  const none: F0Stats = {
    medianHz: NaN,
    p25Hz: NaN,
    p75Hz: NaN,
    voicedFraction: 0,
    pitchClass: 'ambiguous',
  };
  if (speechFrames.length < 5) return none;

  const winLen = Math.round(0.04 * sr); // 40 ms
  const minLag = Math.floor(sr / 400); // 400 Hz max f0
  const maxLag = Math.ceil(sr / 50); // 50 Hz min f0
  const buf = new Float32Array(winLen);
  const f0s: number[] = [];
  let voiced = 0;

  // Subsample speech frames to keep this fast (every 2nd frame)
  for (let fi = 0; fi < speechFrames.length; fi += 2) {
    const start = speechFrames[fi] * 512;
    if (start + winLen > samples.length) continue;
    let energy = 0;
    for (let i = 0; i < winLen; i++) {
      buf[i] = samples[start + i];
      energy += buf[i] * buf[i];
    }
    if (energy / winLen < 1e-7) continue;
    // normalized autocorrelation over lag range
    let bestLag = -1;
    let bestVal = 0;
    let r0 = 0;
    for (let i = 0; i < winLen; i++) r0 += buf[i] * buf[i];
    if (r0 <= 0) continue;
    for (let lag = minLag; lag <= maxLag && lag < winLen; lag++) {
      let s = 0;
      for (let i = 0; i + lag < winLen; i++) s += buf[i] * buf[i + lag];
      const v = s / r0;
      if (v > bestVal) {
        bestVal = v;
        bestLag = lag;
      }
    }
    if (bestLag > 0 && bestVal > 0.3) {
      voiced++;
      f0s.push(sr / bestLag);
    }
  }
  const total = Math.ceil(speechFrames.length / 2);
  const voicedFraction = total > 0 ? voiced / total : 0;
  if (f0s.length < 3) return { ...none, voicedFraction };

  f0s.sort((a, b) => a - b);
  const medianHz = percentileOf(f0s, 50);
  const p25Hz = percentileOf(f0s, 25);
  const p75Hz = percentileOf(f0s, 75);
  const pitchClass: PitchClass =
    medianHz < 165 ? 'male-typical' : medianHz > 210 ? 'female-typical' : 'ambiguous';
  return { medianHz, p25Hz, p75Hz, voicedFraction, pitchClass };
}

/**
 * Compute the full forensic profile of one clip (16 kHz mono, peak-normalized).
 * `probe` is the challenge-noise metadata captured at record time; when
 * present and `on`, probe-aware metrics (band flatness, response fidelity)
 * are attached to the profile. Without it the profile is identical to before.
 */
export function analyzeClip(
  samples: Float32Array,
  sampleRate: number,
  probe?: ProbeMeta,
): ClipProfile {
  const spec = stft(samples, sampleRate);
  const levels = frameLevelsDb(samples);
  const vad = runVad(levels, sampleRate);
  const binHz = sampleRate / 2 / (spec.bins - 1);

  // mean spectrum + band energies (averaged over frames)
  const meanSpectrum = new Float32Array(spec.bins);
  const bands = { sub300: 0, inband: 0, above3400: 0, above4000: 0 };
  let centroidAcc = 0;
  let totalPow = 0;
  const b300 = Math.round(300 / binHz);
  const b3400 = Math.round(3400 / binHz);
  const b4000 = Math.round(4000 / binHz);

  for (let f = 0; f < spec.frames; f++) {
    const row = spec.power[f];
    let framePow = 0;
    for (let b = 0; b < spec.bins; b++) {
      meanSpectrum[b] += row[b];
      framePow += row[b];
    }
    for (let b = 0; b < spec.bins; b++) {
      if (b < b300) bands.sub300 += row[b];
      if (b >= b300 && b <= b3400) bands.inband += row[b];
      if (b > b3400) bands.above3400 += row[b];
      if (b > b4000) bands.above4000 += row[b];
      centroidAcc += row[b] * b * binHz;
    }
    totalPow += framePow;
  }
  if (spec.frames > 0) for (let b = 0; b < spec.bins; b++) meanSpectrum[b] /= spec.frames;
  const tp = totalPow > 0 ? totalPow : 1;
  bands.sub300 /= tp;
  bands.inband /= tp;
  bands.above3400 /= tp;
  bands.above4000 /= tp;

  const centroidHz = totalPow > 0 ? centroidAcc / totalPow : 0;
  const p95Hz = cumulativeEnergyHz(meanSpectrum, binHz, 0.95);
  const p99Hz = cumulativeEnergyHz(meanSpectrum, binHz, 0.99);

  // spectral flatness on speech frames / all frames
  let flatSum = 0;
  let flatN = 0;
  let flatAllSum = 0;
  for (let f = 0; f < spec.frames; f++) {
    const fl = spectralFlatness(spec.power[f]);
    flatAllSum += fl;
    if (vad.speechMask[f]) {
      flatSum += fl;
      flatN++;
    }
  }
  const burstFlatness = flatN > 0 ? flatSum / flatN : NaN;
  const flatnessAll = spec.frames > 0 ? flatAllSum / spec.frames : NaN;

  // --- probe-band flatness (500 Hz–6 kHz) on non-speech, probe-dominant frames ---
  const band = probe?.band ?? PROBE_BAND;
  const { lo: pbLo, hi: pbHi, n: pbN } = probeBandBins(spec.bins, sampleRate, band);
  let pbFlatSum = 0;
  let pbFlatN = 0;
  // mean power per probe-band bin over non-speech frames (for fidelity)
  const pbMeanPower = new Float32Array(pbN);
  for (let f = 0; f < spec.frames; f++) {
    if (vad.speechMask[f]) continue;
    const row = spec.power[f];
    pbFlatSum += spectralFlatness(row.subarray(pbLo, pbHi + 1));
    pbFlatN++;
    for (let b = pbLo; b <= pbHi; b++) pbMeanPower[b - pbLo] += row[b];
  }
  const probeBandFlatness = pbFlatN > 0 ? pbFlatSum / pbFlatN : NaN;

  // noise bed
  const bedDb = vad.noiseFloorDb;
  let speechSum = 0;
  for (const f of vad.speechFrames) speechSum += levels[f];
  const speechDb = vad.speechFrames.length > 0 ? speechSum / vad.speechFrames.length : NaN;
  const snrDb = Number.isFinite(speechDb) && Number.isFinite(bedDb) ? speechDb - bedDb : NaN;
  const label: NoiseLabel = bedDb > -42 ? 'very_noisy' : bedDb > -60 ? 'elevated' : 'quiet';

  const f0 = estimateF0(samples, sampleRate, vad.speechFrames);
  const voicePrint = extractVoicePrint(samples, sampleRate, vad, spec);

  // --- speech-frame spectral integrity (low band, centroid, p95) ---
  // Accumulated over VAD-gated speech frames only so silence/noise can't
  // dilute the thinness signature of the actual voice.
  const b80 = Math.max(1, Math.round(80 / binHz));
  const b500 = Math.round(500 / binHz);
  const speechMean = new Float32Array(spec.bins);
  let spLowBand = 0;
  let spLowInband = 0;
  let spCentroidAcc = 0;
  let spTotal = 0;
  for (const f of vad.speechFrames) {
    const row = spec.power[f];
    if (!row) continue;
    for (let b = 0; b < spec.bins; b++) {
      const v = row[b];
      speechMean[b] += v;
      spTotal += v;
      spCentroidAcc += v * b * binHz;
      if (b >= b80 && b < b300) spLowBand += v;
      if (b >= b300 && b < b500) spLowInband += v;
    }
  }
  const nSpeech = vad.speechFrames.length;
  if (nSpeech > 0) for (let b = 0; b < spec.bins; b++) speechMean[b] /= nSpeech;
  const speech: SpeechSpectrum = {
    frames: nSpeech,
    lowBand: spTotal > 0 ? spLowBand / spTotal : NaN,
    lowInband: spTotal > 0 ? spLowInband / spTotal : NaN,
    centroidHz: spTotal > 0 ? spCentroidAcc / spTotal : NaN,
    p95Hz: nSpeech > 0 ? cumulativeEnergyHz(speechMean, binHz, 0.95) : NaN,
    meanSpectrum: speechMean,
  };

  // --- probe response fidelity (only when the probe was used) ---
  let probeReading: ProbeReading | undefined;
  if (probe?.on) {
    let fidelity = NaN;
    if (pbFlatN > 0 && pbN >= 4) {
      for (let i = 0; i < pbN; i++) pbMeanPower[i] /= pbFlatN;
      const expected = expectedProbeBandPower(spec.bins, sampleRate, probe.seed);
      // Pearson on band magnitudes (sqrt of power)
      const recvMag = new Float32Array(pbN);
      const expMag = new Float32Array(pbN);
      for (let i = 0; i < pbN; i++) {
        recvMag[i] = Math.sqrt(pbMeanPower[i]);
        expMag[i] = Math.sqrt(expected[i]);
      }
      fidelity = pearson(recvMag, expMag);
    }
    const fidelityState: FidelityState = !Number.isFinite(fidelity)
      ? 'AMBER'
      : fidelity >= 0.75
        ? 'GREEN'
        : fidelity >= 0.5
          ? 'AMBER'
          : 'RED';
    probeReading = {
      on: true,
      seed: probe.seed,
      level: probe.level,
      band: [band[0], band[1]],
      bandFlatness: probeBandFlatness,
      fidelity,
      fidelityState,
    };
  }

  return {
    sampleRate,
    duration: samples.length / sampleRate,
    spec,
    vad,
    bands,
    centroidHz,
    p95Hz,
    p99Hz,
    thinness: bands.inband,
    burstFlatness,
    flatnessAll,
    probeBandFlatness,
    gapVsBurstDb: vad.gapDepthDb,
    noise: { snrDb, bedDb, speechDb, speechToBedDb: snrDb, label },
    f0,
    meanSpectrum,
    speech,
    voicePrint,
    probe: probeReading,
  };
}
