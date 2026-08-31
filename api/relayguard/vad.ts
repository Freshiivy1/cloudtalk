// vad.ts — energy-based VAD: frame dB vs 20th-percentile noise floor + adaptive threshold.
import { HOP } from './stft';

export interface SpeechTurn {
  start_s: number;
  end_s: number;
}

export interface VadResult {
  /** per-frame dB levels */
  levelsDb: Float32Array;
  /** boolean speech mask per frame */
  speechMask: boolean[];
  /** frame indices considered speech */
  speechFrames: number[];
  /** contiguous speech segments (seconds) */
  turns: SpeechTurn[];
  /** speech duty cycle 0..1 */
  dutyCycle: number;
  /** number of speech bursts (segments) */
  burstCount: number;
  /** coefficient of variation of burst durations; NaN when <2 bursts */
  burstCV: number;
  /** mean gap depth dB (bed level minus burst level); NaN when <2 bursts */
  gapDepthDb: number;
  /** dynamic range dB (95th - 10th percentile of frame dB) */
  dynamicRangeDb: number;
  /** 20th-percentile noise floor dB */
  noiseFloorDb: number;
  /** adaptive threshold dB */
  thresholdDb: number;
  sampleRate: number;
}

function percentile(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

/** Run VAD over frame dB levels. Frames come from frameLevelsDb (32ms hop). */
export function runVad(levelsDb: Float32Array, sampleRate: number): VadResult {
  const n = levelsDb.length;
  const frameDur = HOP / sampleRate;

  if (n === 0) {
    return {
      levelsDb,
      speechMask: [],
      speechFrames: [],
      turns: [],
      dutyCycle: 0,
      burstCount: 0,
      burstCV: NaN,
      gapDepthDb: NaN,
      dynamicRangeDb: NaN,
      noiseFloorDb: NaN,
      thresholdDb: NaN,
      sampleRate,
    };
  }

  const sorted = Float32Array.from(levelsDb).sort();
  const p20 = percentile(sorted, 20);
  const p10 = percentile(sorted, 10);
  const p95 = percentile(sorted, 95);
  const dynamicRangeDb = p95 - p10;

  // Adaptive threshold: noise floor + offset scaled by how peaky the signal is.
  const offset = Math.min(12, Math.max(5, dynamicRangeDb * 0.35));
  const thresholdDb = p20 + offset;

  const speechMask: boolean[] = new Array(n);
  const speechFrames: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = levelsDb[i] > thresholdDb;
    speechMask[i] = s;
    if (s) speechFrames.push(i);
  }

  // Merge nearby speech frames into segments (bridge gaps < 0.2 s), drop segments < 0.12 s.
  const bridgeFrames = Math.round(0.2 / frameDur);
  const minSegFrames = Math.max(1, Math.round(0.12 / frameDur));
  const raw: [number, number][] = [];
  let segStart = -1;
  let lastSpeech = -1;
  for (let i = 0; i < n; i++) {
    if (speechMask[i]) {
      if (segStart === -1) segStart = i;
      lastSpeech = i;
    } else if (segStart !== -1 && i - lastSpeech > bridgeFrames) {
      raw.push([segStart, lastSpeech]);
      segStart = -1;
    }
  }
  if (segStart !== -1) raw.push([segStart, lastSpeech]);

  const turns: SpeechTurn[] = raw
    .filter(([a, b]) => b - a + 1 >= minSegFrames)
    .map(([a, b]) => ({
      start_s: (a * HOP) / sampleRate,
      end_s: Math.min(n * frameDur, ((b + 1) * HOP) / sampleRate),
    }));

  const dutyCycle = speechFrames.length / n;
  const burstCount = turns.length;

  const durations = turns.map((t) => t.end_s - t.start_s);
  let burstCV = NaN;
  if (durations.length >= 2) {
    const mean = durations.reduce((s, v) => s + v, 0) / durations.length;
    const varr =
      durations.reduce((s, v) => s + (v - mean) * (v - mean), 0) / durations.length;
    burstCV = mean > 1e-9 ? Math.sqrt(varr) / mean : NaN;
  }

  // Gap depth: mean level during inter-burst gaps vs mean level during bursts.
  let gapDepthDb = NaN;
  if (burstCount >= 2) {
    const inBurst = new Array<boolean>(n).fill(false);
    for (const [a, b] of raw) for (let i = a; i <= b && i < n; i++) inBurst[i] = true;
    let burstSum = 0;
    let burstN = 0;
    let gapSum = 0;
    let gapN = 0;
    for (let i = 0; i < n; i++) {
      if (inBurst[i]) {
        burstSum += levelsDb[i];
        burstN++;
      } else {
        gapSum += levelsDb[i];
        gapN++;
      }
    }
    if (burstN > 0 && gapN > 0) gapDepthDb = gapSum / gapN - burstSum / burstN;
  }

  return {
    levelsDb,
    speechMask,
    speechFrames,
    turns,
    dutyCycle,
    burstCount,
    burstCV,
    gapDepthDb,
    dynamicRangeDb,
    noiseFloorDb: p20,
    thresholdDb,
    sampleRate,
  };
}
