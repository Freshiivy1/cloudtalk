import { describe, expect, it } from "vitest";
import { challengeNoiseWav } from "./noise";
import { generateProbeLoop, generateProbe, probeGain } from "./probe";
import { analyzeClip } from "./features";
import { compareClips, relayFingerprint } from "./compare";
import { SpeakerphoneDetector } from "./speakerphone-detector";

describe("relayguard vendored DSP (Node)", () => {
  it("challengeNoiseWav renders the exact 4s 70% probe as a valid 8kHz WAV and caches", () => {
    const wav = challengeNoiseWav();
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(8000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.length).toBe(44 + 4 * 8000 * 2);
    expect(challengeNoiseWav()).toBe(wav); // cached identity
    // non-silent
    let peak = 0;
    for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
    expect(peak).toBeGreaterThan(1000);
  });

  it("probe helpers work at 8kHz", () => {
    expect(generateProbe(1, 8000).length).toBe(8000);
    expect(generateProbeLoop(4, 8000).length).toBe(32000);
    expect(probeGain(70)).toBeCloseTo(0.35);
  });

  it("analyzeClip + compareClips + relayFingerprint run on 8kHz windows", () => {
    const mk = (freqs: number[]) => {
      const s = new Float32Array(16000);
      for (let i = 0; i < s.length; i++) {
        s[i] = 0.2 * freqs.reduce((a, f) => a + Math.sin((2 * Math.PI * f * i) / 8000), 0);
      }
      return s;
    };
    const a = analyzeClip(mk([300, 900]), 8000);
    const b = analyzeClip(mk([300, 900]), 8000);
    const r = compareClips(a, b, "poor");
    expect(["MATCH", "UNCERTAIN", "SUSPICIOUS RELAY"]).toContain(r.verdict);
    const fp = relayFingerprint(b);
    expect(fp.score).toBeGreaterThanOrEqual(0);
    expect(fp.score).toBeLessThanOrEqual(1);
  });

  it("SpeakerphoneDetector consumes μ-law frames without throwing", () => {
    let fired = 0;
    const d = new SpeakerphoneDetector({ onSuspicious: () => fired++ });
    // 6s of synthetic speech-ish audio as 20ms μ-law frames (160 samples).
    for (let f = 0; f < 300; f++) {
      const bytes = Buffer.alloc(160);
      for (let j = 0; j < 160; j++) {
        const i = f * 160 + j;
        const s = 8000 * Math.sin((2 * Math.PI * 440 * i) / 8000) + (Math.random() * 2000 - 1000);
        // crude μ-law encode (test mirror)
        const sign = s < 0 ? 0x80 : 0;
        const mag = Math.min(Math.abs(Math.round(s)), 32604) + 0x84;
        let exp = 7;
        for (let mask = 0x4000; (mag & mask) === 0 && exp > 0; mask >>= 1) exp--;
        bytes[j] = ~(sign | (exp << 4) | ((mag >> (exp + 3)) & 0x0f)) & 0xff;
      }
      d.push(bytes.toString("base64"));
    }
    expect(d.windowsAnalyzed).toBeGreaterThanOrEqual(2);
    expect(fired).toBeGreaterThanOrEqual(0); // advisory; must simply not throw
  });
});
