/**
 * Challenge-noise WAV renderer (server side of the relayguard probe).
 *
 * Renders the deterministic probe loop from probe.ts to an 8 kHz mono
 * 16-bit PCM WAV buffer — the exact format Twilio accepts for <Play> and
 * conference participant announcements (`announceUrl`). The buffer is
 * deterministic (seeded PRNG) and cached after the first render.
 */
import { generateProbeLoop } from "./probe";

const WAV_SAMPLE_RATE = 8000;

/** Encode float samples (-1..1) as a mono 16-bit PCM WAV buffer. */
export function encodeWavPcm16(samples: Float32Array, sampleRate = WAV_SAMPLE_RATE): Buffer {
  const n = samples.length;
  const dataBytes = n * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

const cache = new Map<string, Buffer>();

/**
 * The probe's shaping chain (6 kHz lowpass) is only stable well below its
 * corner frequency, so the loop is rendered at 16 kHz and decimated to
 * 8 kHz with a 4-tap moving-average anti-alias filter.
 */
function probeLoop8k(loopSec: number): Float32Array {
  const hi = generateProbeLoop(loopSec, WAV_SAMPLE_RATE * 2);
  const n = Math.floor(hi.length / 2);
  const out = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < hi.length; i++) acc += hi[i];
  const mean = acc / hi.length;
  for (let i = 0; i < n; i++) {
    const a = hi[i * 2] - mean;
    const b = hi[i * 2 + 1] - mean;
    out[i] = (a + b) / 2;
  }
  return out;
}

/**
 * Probe-loop challenge noise as a WAV buffer, ready to serve to Twilio.
 * Samples are scaled by `level / 100` (default level 40 → 0.4 = 40% gain,
 * ≈ −20 dBFS against the probe's normalized 0.25 RMS).
 */
export function challengeNoiseWav(loopSec = 3, level = 40): Buffer {
  const key = `${loopSec}:${level}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const gain = Math.max(0, Math.min(100, level)) / 100;
  const loop = probeLoop8k(loopSec);
  const scaled = new Float32Array(loop.length);
  for (let i = 0; i < loop.length; i++) scaled[i] = loop[i] * gain;
  const wav = encodeWavPcm16(scaled, WAV_SAMPLE_RATE);
  cache.set(key, wav);
  return wav;
}
