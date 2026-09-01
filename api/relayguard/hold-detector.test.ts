/**
 * HoldDetector tests (api/relayguard/hold-detector.ts) — pure DSP, no DB, no
 * network. Synthesizes μ-law frames exactly as Twilio Media Streams delivers
 * them (base64, 8 kHz mono, 20 ms) and asserts the engage/disengage rules:
 * speech-then-sustained-hold fires once; speech resumption disengages.
 */
import { describe, expect, it } from "vitest";
import { HoldDetector } from "./hold-detector";

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

/**
 * Speech-like synthetic: a 200 Hz carrier with a 3 Hz amplitude envelope —
 * energy varies strongly within the 0.5 s steadiness window, so the detector
 * classifies it as speech (not a steady tone).
 */
const speech = (amp = 6000) => (i: number) =>
  amp * (0.4 + 0.6 * Math.abs(Math.sin((2 * Math.PI * 3 * i) / 8000))) *
  Math.sin((2 * Math.PI * 200 * i) / 8000);

/** Steady narrowband hold tone (e.g. 440 Hz music-on-hold beep bed). */
const holdTone = (amp = 3000) => (i: number) =>
  amp * Math.sin((2 * Math.PI * 440 * i) / 8000);

const silence = () => () => 0;

interface Rec {
  engagedAt: number[]; // seconds of audio consumed when the callback fired
  disengagedAt: number[];
}

/** Feed frames, tracking virtual audio time and recording callback times. */
function makeDetector(opts: Partial<ConstructorParameters<typeof HoldDetector>[0]> = {}) {
  const rec: Rec = { engagedAt: [], disengagedAt: [] };
  let consumedSec = 0;
  const d = new HoldDetector({
    sessionId: "test-sid",
    armed: true,
    ...opts,
    onSecondCallEngaged: () => rec.engagedAt.push(consumedSec),
    onSecondCallDisengaged: () => rec.disengagedAt.push(consumedSec),
  });
  const feed = (fs: string[]) => {
    for (const f of fs) {
      d.push(f);
      consumedSec += 0.02;
    }
  };
  return { d, rec, feed };
}

describe("HoldDetector (second-call engagement)", () => {
  it("silence after ≥3s of speech fires engage at ~2.5s of hold", () => {
    const { d, rec, feed } = makeDetector();
    feed(frames(speech(), 3.5)); // 3.5s live conversation
    expect(rec.engagedAt).toHaveLength(0);
    feed(frames(silence(), 2.0));
    expect(rec.engagedAt).toHaveLength(0); // 2.0s < 2.5s hold requirement
    feed(frames(silence(), 1.5)); // hold reaches 2.5s somewhere in here
    expect(rec.engagedAt).toHaveLength(1);
    const holdDuration = rec.engagedAt[0] - 3.5;
    expect(holdDuration).toBeGreaterThanOrEqual(2.4);
    expect(holdDuration).toBeLessThan(3.0);
    expect(d.isEngaged).toBe(true);
  });

  it("speech resumption ≥1s after an engagement fires disengage", () => {
    const { rec, feed } = makeDetector();
    feed(frames(speech(), 3.5));
    feed(frames(silence(), 3.0)); // engages at ~6.0s
    expect(rec.engagedAt).toHaveLength(1);
    feed(frames(speech(), 0.6));
    expect(rec.disengagedAt).toHaveLength(0); // 0.6s < 1s resume requirement
    feed(frames(speech(), 0.8)); // resumed speech reaches 1s
    expect(rec.disengagedAt).toHaveLength(1);
    // Engage fired 2.5s into the 3.0s hold, so 0.5s of hold remained; the
    // disengage then lands ~1.0s after speech resumed = ~1.5s after engage.
    const sinceEngage = rec.disengagedAt[0] - rec.engagedAt[0];
    expect(sinceEngage).toBeGreaterThanOrEqual(1.4);
    expect(sinceEngage).toBeLessThan(1.8);
  });

  it("does NOT fire without ≥3s of prior speech", () => {
    const { rec, feed } = makeDetector();
    feed(frames(silence(), 10)); // held from the start — no conversation yet
    expect(rec.engagedAt).toHaveLength(0);
    // Short speech (2s) then a long hold: still under the 3s requirement.
    feed(frames(speech(), 2));
    feed(frames(silence(), 5));
    expect(rec.engagedAt).toHaveLength(0);
  });

  it("fires ONCE per engagement — continued hold does not re-fire", () => {
    const { rec, feed } = makeDetector();
    feed(frames(speech(), 4));
    feed(frames(silence(), 8)); // long hold, engagement fires once early on
    expect(rec.engagedAt).toHaveLength(1);
    expect(rec.disengagedAt).toHaveLength(0);
  });

  it("re-engages after disengage (fresh prior-speech accumulation)", () => {
    const { rec, feed } = makeDetector();
    feed(frames(speech(), 3.5));
    feed(frames(silence(), 3)); // engage #1
    feed(frames(speech(), 4)); // disengage (~1s in) + 3s more speech
    feed(frames(silence(), 3)); // engage #2
    expect(rec.engagedAt).toHaveLength(2);
    expect(rec.disengagedAt).toHaveLength(1);
  });

  it("a steady narrowband hold tone (above the silence band) engages", () => {
    const { rec, feed } = makeDetector();
    feed(frames(speech(), 3.5));
    // Steady 440 Hz tone: energy is ABOVE the speech floor, but the ~0.5s
    // steadiness window marks it as tone-like, not speech. The steadiness
    // warm-up (~0.5s) slightly delays the hold start.
    feed(frames(holdTone(), 4));
    expect(rec.engagedAt).toHaveLength(1);
    const holdDuration = rec.engagedAt[0] - 3.5;
    expect(holdDuration).toBeGreaterThanOrEqual(2.4);
    expect(holdDuration).toBeLessThan(3.6);
  });

  it("a steady tone does NOT count as resumed speech (stays engaged)", () => {
    const { d, rec, feed } = makeDetector();
    feed(frames(speech(), 3.5));
    feed(frames(silence(), 3)); // engage
    feed(frames(holdTone(), 3)); // hold music continues — not speech
    expect(rec.disengagedAt).toHaveLength(0);
    expect(d.isEngaged).toBe(true);
  });

  it("is inert while disarmed (stream arms it only when BRIDGED)", () => {
    const { d, rec, feed } = makeDetector({ armed: false });
    feed(frames(speech(), 4));
    feed(frames(silence(), 5));
    expect(rec.engagedAt).toHaveLength(0);
    // Arming starts fresh — the pre-arm speech does not count.
    d.setArmed(true);
    feed(frames(silence(), 3));
    expect(rec.engagedAt).toHaveLength(0); // no prior speech since arm
    feed(frames(speech(), 3.5));
    feed(frames(silence(), 3));
    expect(rec.engagedAt).toHaveLength(1);
  });

  it("comfort noise below the speech floor engages like silence", () => {
    const { rec, feed } = makeDetector();
    feed(frames(speech(), 3.5));
    // Low-amplitude random comfort noise (energy ~1e4, far under 5e5 floor).
    let seed = 42;
    const noise = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return ((seed / 0x7fffffff) - 0.5) * 300;
    };
    feed(frames(noise, 3.2));
    expect(rec.engagedAt).toHaveLength(1);
  });
});
