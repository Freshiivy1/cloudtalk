/**
 * SpeechActivityVad unit tests — the adaptive RMS caller-activity tracker
 * behind the callee-only speakerphone arming gate. Driven by an injectable
 * clock; frames are 20 ms (160 samples @ 8 kHz), int16-range values.
 */
import { describe, expect, it } from "vitest";
import { SpeechActivityVad } from "./caller-activity";

const FRAME = 160;

function frame(amp: number): number[] {
  return new Array<number>(FRAME).fill(amp);
}

/** Speech-like frame: −12 dBFS. */
const SPEECH = frame(8400);
/** μ-law silence / line hiss: ≈ −68 dBFS — below the −45 dBFS guard. */
const SILENCE = frame(8);
/** Audible but quiet line noise: ≈ −36 dBFS — above the guard, must be
 *  absorbed into the adaptive floor rather than judged speech forever. */
const LINE_NOISE = frame(500);

function make(nowRef: { t: number }): SpeechActivityVad {
  return new SpeechActivityVad({ now: () => nowRef.t });
}

describe("SpeechActivityVad", () => {
  it("silence never registers activity", () => {
    const now = { t: 0 };
    const vad = make(now);
    for (let i = 0; i < 200; i++) {
      expect(vad.noteFrame(SILENCE)).toBe(false);
      now.t += 20;
    }
    expect(vad.active(1_200)).toBe(false);
    expect(vad.speechFrames).toBe(0);
  });

  it("a speech burst registers activity immediately and for the gate window", () => {
    const now = { t: 0 };
    const vad = make(now);
    for (let i = 0; i < 50; i++) {
      vad.noteFrame(SILENCE);
      now.t += 20;
    }
    for (let i = 0; i < 25; i++) {
      expect(vad.noteFrame(SPEECH)).toBe(true);
      now.t += 20;
    }
    // Active right after the burst...
    expect(vad.active(1_200)).toBe(true);
    // ...and still active at the window edge (covers the Leg B detector's
    // trailing 1 s analysis span + echo latency)...
    now.t += 1_100;
    expect(vad.active(1_200)).toBe(true);
    // ...but expired past it.
    now.t += 200;
    expect(vad.active(1_200)).toBe(false);
  });

  it("intra-word silence gaps keep activity alive through the window", () => {
    const now = { t: 0 };
    const vad = make(now);
    for (let i = 0; i < 25; i++) {
      vad.noteFrame(SPEECH);
      now.t += 20;
    }
    // 900 ms of silence (a between-sentences pause) — still "speaking" for
    // gate purposes.
    for (let i = 0; i < 45; i++) {
      vad.noteFrame(SILENCE);
      now.t += 20;
    }
    expect(vad.active(1_200)).toBe(true);
  });

  it("a CONSTANT loud caller-side source (TV/crowd) re-classifies as noise within seconds — it cannot suppress the gate forever", () => {
    const now = { t: 0 };
    const vad = make(now);
    let speechCount = 0;
    // 20 s of constant −36 dBFS noise: indistinguishable from speech at
    // first (it IS above the floor + margin), so the SLOW upward drift
    // (α=0.005) must lift the floor past it within ~6 s (~300 frames).
    for (let i = 0; i < 1000; i++) {
      if (vad.noteFrame(LINE_NOISE)) speechCount++;
      now.t += 20;
    }
    expect(speechCount).toBeGreaterThan(0); // initially counts — conservative
    expect(speechCount).toBeLessThan(400); // but stops within ~8 s
    expect(vad.active(1_200)).toBe(false);
    // And real speech on top of that line noise is still caught.
    expect(vad.noteFrame(SPEECH)).toBe(true);
  });

  it("a single loud click cannot drag the floor up and mask speech afterwards", () => {
    const now = { t: 0 };
    const vad = make(now);
    for (let i = 0; i < 50; i++) {
      vad.noteFrame(SILENCE);
      now.t += 20;
    }
    const floorBefore = vad.noiseFloorDb;
    // One click (non-speech after the first frame? a click IS loud — the
    // first frame may count as speech; the floor update is capped either
    // way).
    vad.noteFrame(frame(30000));
    now.t += 20;
    for (let i = 0; i < 5; i++) {
      vad.noteFrame(SILENCE);
      now.t += 20;
    }
    // Floor moved at most marginDb from where it was (cap at floor+margin).
    expect(vad.noiseFloorDb).toBeLessThanOrEqual(floorBefore + 12.5);
    expect(vad.noteFrame(SPEECH)).toBe(true);
  });

  it("activity with no frames ever seen is false (fail-open for the gate)", () => {
    const vad = new SpeechActivityVad();
    expect(vad.active(1_200)).toBe(false);
  });
});
