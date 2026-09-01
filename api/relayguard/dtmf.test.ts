/**
 * Merge-probe DTMF tone renderer tests (api/relayguard/dtmf.ts) — pure DSP,
 * no DB, no network. Asserts the rendered burst is a valid WAV whose Goertzel
 * power at the DTMF-'9' pair (852+1336 Hz) dominates every other DTMF
 * frequency, and that the existing MergeToneDetector accepts the burst.
 */
import { describe, expect, it } from "vitest";
import {
  MERGE_TONE_HIGH_HZ,
  MERGE_TONE_LOW_HZ,
  mergeToneWav,
} from "./dtmf";
import { goertzelPower, MergeToneDetector } from "../verification-stream";
import { wavToPcm16 } from "../verification-record";

/** All DTMF row/column frequencies. */
const DTMF_FREQS = [697, 770, 852, 941, 1209, 1336, 1477, 1633];

/** Textbook μ-law encoder (mirror of verification-stream.test.ts). */
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

describe("mergeToneWav (DTMF-9 probe renderer)", () => {
  it("renders a valid 8 kHz 16-bit mono WAV of the requested duration", () => {
    const wav = mergeToneWav(1.2, 8000);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(8000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    const pcm = wavToPcm16(wav);
    expect(pcm.length).toBe(Math.round(1.2 * 8000));
    // No clipping: peak amplitude stays under full scale (0.3 + 0.3 = 0.6).
    let peak = 0;
    for (const s of pcm) peak = Math.max(peak, Math.abs(s));
    expect(peak).toBeLessThan(32767 * 0.65);
    expect(peak).toBeGreaterThan(32767 * 0.4);
  });

  it("Goertzel power at 852/1336 Hz dominates all other DTMF frequencies", () => {
    const pcm = wavToPcm16(mergeToneWav());
    // Use the detector's analysis window so the numbers line up with the
    // runtime thresholds (skip the 5 ms edge fades).
    const win = pcm.subarray(400, 800);
    const pLow = goertzelPower(win, MERGE_TONE_LOW_HZ);
    const pHigh = goertzelPower(win, MERGE_TONE_HIGH_HZ);
    for (const f of DTMF_FREQS) {
      const p = goertzelPower(win, f);
      if (f === MERGE_TONE_LOW_HZ || f === MERGE_TONE_HIGH_HZ) continue;
      expect(pLow).toBeGreaterThan(p * 10);
      expect(pHigh).toBeGreaterThan(p * 10);
    }
  });

  it("the existing MergeToneDetector fires on the rendered burst", () => {
    const pcm = wavToPcm16(mergeToneWav());
    const d = new MergeToneDetector();
    let fired = false;
    for (let off = 0; off + 160 <= pcm.length; off += 160) {
      const bytes = Buffer.alloc(160);
      for (let j = 0; j < 160; j++) bytes[j] = encodeMulaw(pcm[off + j]);
      if (d.push(bytes.toString("base64"))) fired = true;
    }
    expect(fired).toBe(true);
  });

  it("caches renders (identical buffer returned for identical params)", () => {
    expect(mergeToneWav()).toBe(mergeToneWav());
    expect(mergeToneWav(0.8, 8000)).toBe(mergeToneWav(0.8, 8000));
    expect(mergeToneWav(0.8, 8000)).not.toBe(mergeToneWav());
  });
});
