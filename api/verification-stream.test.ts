/**
 * Merge-tone detector (Goertzel DSP) tests — no DB, no network.
 * Synthesizes μ-law audio frames exactly as Twilio Media Streams delivers
 * them (base64, 8 kHz mono) and asserts the detector fires only on the
 * continuous DTMF-'9' merge tone (852 Hz + 1336 Hz).
 */
import { describe, expect, it } from "vitest";
import { MergeToneDetector, decodeMulaw } from "./verification-stream";
import { detectMergeToneMs, wavToPcm16 } from "./verification-record";

/** Textbook μ-law encoder (test-side mirror of decodeMulaw). */
function encodeMulaw(s: number): number {
  const BIAS = 0x84;
  const CLIP = 32604;
  const sign = s < 0 ? 0x80 : 0;
  let mag = Math.min(Math.abs(Math.round(s)), CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (mag & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (mag >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Build base64 μ-law frames (160 samples = 20 ms each) from a PCM generator. */
function frames(gen: (i: number) => number, seconds: number): string[] {
  const total = 8000 * seconds;
  const out: string[] = [];
  for (let off = 0; off + 160 <= total; off += 160) {
    const bytes = Buffer.alloc(160);
    for (let j = 0; j < 160; j++) bytes[j] = encodeMulaw(gen(off + j));
    out.push(bytes.toString("base64"));
  }
  return out;
}

const dtmf9 = (amp = 12000) => (i: number) =>
  amp * Math.sin((2 * Math.PI * 852 * i) / 8000) +
  amp * Math.sin((2 * Math.PI * 1336 * i) / 8000);

describe("MergeToneDetector (Goertzel DTMF-9)", () => {
  it("μ-law codec round-trips", () => {
    expect(Math.abs(decodeMulaw(encodeMulaw(12000)) - 12000)).toBeLessThan(1000);
    expect(Math.abs(decodeMulaw(encodeMulaw(-8000)) + 8000)).toBeLessThan(600);
    expect(Math.abs(decodeMulaw(encodeMulaw(0)))).toBeLessThan(200);
  });

  it("fires on a continuous 852+1336 Hz stream within ~500ms", () => {
    const d = new MergeToneDetector();
    let firedAt = -1;
    frames(dtmf9(), 2).forEach((f, idx) => {
      if (d.push(f) && firedAt < 0) firedAt = idx;
    });
    expect(d.hasFired).toBe(true);
    expect(firedAt).toBeGreaterThanOrEqual(13); // needs ≥6×50ms windows (300ms)
    expect(firedAt).toBeLessThan(25); // well under 500ms of audio
  });

  it("still fires on quiet, codec-degraded tone (amplitude 3000)", () => {
    const d = new MergeToneDetector();
    frames(dtmf9(3000), 1).forEach((f) => d.push(f));
    expect(d.hasFired).toBe(true);
  });

  it("does NOT fire on silence", () => {
    const d = new MergeToneDetector();
    frames(() => 0, 2).forEach((f) => d.push(f));
    expect(d.hasFired).toBe(false);
  });

  it("does NOT fire on a single lone frequency (852 Hz only)", () => {
    const d = new MergeToneDetector();
    frames((i) => 12000 * Math.sin((2 * Math.PI * 852 * i) / 8000), 2).forEach((f) =>
      d.push(f),
    );
    expect(d.hasFired).toBe(false);
  });

  it("does NOT fire on white noise / babble", () => {
    const d = new MergeToneDetector();
    frames(() => 8000 * (Math.random() - 0.5), 2).forEach((f) => d.push(f));
    expect(d.hasFired).toBe(false);
  });

  it("does NOT fire on short 100ms blips (key-click robustness)", () => {
    const d = new MergeToneDetector();
    // 100ms tone, 300ms silence, repeat — never 300ms continuous
    const blip = (i: number) => {
      const phase = i % 3200; // 400ms cycle
      return phase < 800 ? dtmf9()(i) : 0;
    };
    frames(blip, 4).forEach((f) => d.push(f));
    expect(d.hasFired).toBe(false);
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
    const pcm = pcmOf((i) => 5000 * (Math.random() - 0.5), 2);
    expect(detectMergeToneMs(wavToPcm16(buildWav(pcm)))).toBe(-1);
  });
});
