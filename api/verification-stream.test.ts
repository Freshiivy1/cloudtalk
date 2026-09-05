/**
 * Pre-bridge recording-chunk analysis tests (WAV + Goertzel) — no DB, no network.
 * The in-call merge detector is the authorised merge-relay A->B path; Leg B never
 * has a detection tone played INTO it, so there is no in-call DTMF-9 detector here.
 * decodeMulaw is still covered because verification-record reuses it.
 */
import { describe, expect, it } from "vitest";
import { decodeMulaw } from "./verification-stream";
import { detectMergeToneMs, wavToPcm16 } from "./verification-record";

/** Textbook μ-law encoder (test-side mirror of decodeMulaw). */
function encodeMulaw(s: number): number {
  const BIAS = 0x84;
  const CLIP = 32604;
  const sign = s < 0 ? 0x80 : 0;
  const mag = Math.min(Math.abs(Math.round(s)), CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (mag & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (mag >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const dtmf9 = (amp = 12000) => (i: number) =>
  amp * Math.sin((2 * Math.PI * 852 * i) / 8000) +
  amp * Math.sin((2 * Math.PI * 1336 * i) / 8000);

describe("μ-law codec (shared with verification-record)", () => {
  it("μ-law codec round-trips", () => {
    expect(Math.abs(decodeMulaw(encodeMulaw(12000)) - 12000)).toBeLessThan(1000);
    expect(Math.abs(decodeMulaw(encodeMulaw(-8000)) + 8000)).toBeLessThan(600);
    expect(Math.abs(decodeMulaw(encodeMulaw(0)))).toBeLessThan(200);
  });
});

/** Minimal 8 kHz 16-bit mono WAV builder for tests. */
function buildWav(pcm: Int16Array): Buffer {
  const dataSize = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

function pcmOf(gen: (i: number) => number, seconds: number): Int16Array {
  const n = 8000 * seconds;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(gen(i));
  return out;
}

describe("recording chunk analysis (WAV + Goertzel)", () => {
  it("wavToPcm16 parses a RIFF wav", () => {
    const pcm = pcmOf((i) => (i % 100) * 100 - 5000, 0.1);
    const parsed = wavToPcm16(buildWav(pcm));
    expect(parsed.length).toBe(pcm.length);
    expect(parsed[50]).toBe(pcm[50]);
  });

  it("detects a continuous merge tone in a chunk (~300ms in)", () => {
    const pcm = pcmOf(dtmf9(), 2);
    const at = detectMergeToneMs(wavToPcm16(buildWav(pcm)));
    expect(at).toBeGreaterThanOrEqual(250);
    expect(at).toBeLessThan(450);
  });

  it("locates a tone that starts mid-chunk (merge at 1.0s)", () => {
    const pcm = pcmOf((i) => (i >= 8000 ? dtmf9()(i) : 0), 2);
    const at = detectMergeToneMs(wavToPcm16(buildWav(pcm)));
    expect(at).toBeGreaterThanOrEqual(1200);
    expect(at).toBeLessThan(1500);
  });

  it("returns -1 for a silent chunk", () => {
    const pcm = pcmOf(() => 0, 2);
    expect(detectMergeToneMs(wavToPcm16(buildWav(pcm)))).toBe(-1);
  });

  it("returns -1 for speech-like noise", () => {
    const pcm = pcmOf(() => 5000 * (Math.random() - 0.5), 2);
    expect(detectMergeToneMs(wavToPcm16(buildWav(pcm)))).toBe(-1);
  });
});
