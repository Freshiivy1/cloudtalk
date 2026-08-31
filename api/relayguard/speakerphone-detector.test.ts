/**
 * SpeakerphoneDetector sustained-masking logic (post-fire repeat emissions).
 *
 * The DSP layer (analyzeClip / compareClips / relayFingerprint) is mocked so
 * each 2s window's suspiciousness is controlled directly; the logic under
 * test is the streak / refire / reset-to-idle state machine in
 * speakerphone-detector.ts. No DB or network involved.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const dsp = vi.hoisted(() => ({ suspicious: false }));

vi.mock("./features", () => ({
  // Any non-empty speechFrames lets the first window seed the baseline.
  analyzeClip: () => ({ vad: { speechFrames: [0] } }),
}));

vi.mock("./compare", () => ({
  compareClips: () =>
    dsp.suspicious
      ? { verdict: "SUSPICIOUS RELAY", weightedScore: 0.9, confidence: 90, flags: ["test-flag"] }
      : { verdict: "MATCH", weightedScore: 0.05, confidence: 95, flags: [] },
  relayFingerprint: () =>
    dsp.suspicious ? { state: "RED", score: 0.9 } : { state: "GREEN", score: 0.1 },
}));

import { SpeakerphoneDetector } from "./speakerphone-detector";

/** 2s window of 8 kHz PCM (non-silent so peak-normalization is exercised). */
const WINDOW = new Array(16000).fill(1000);

let now = 1_000_000;
let nowSpy: ReturnType<typeof vi.spyOn>;

function setup() {
  nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
  const fires: Array<{ score: number; detail: string }> = [];
  const d = new SpeakerphoneDetector({
    consecutiveWindows: 2,
    refireMs: 9_000,
    onSuspicious: (score, detail) => fires.push({ score, detail }),
  });
  const push = (suspicious: boolean) => {
    dsp.suspicious = suspicious;
    d.pushSamples(WINDOW);
  };
  push(false); // first speech window seeds the rolling baseline
  expect(fires).toHaveLength(0);
  return { d, fires, push };
}

afterEach(() => {
  nowSpy?.mockRestore();
});

describe("SpeakerphoneDetector sustained repeat-fire", () => {
  it("fires once after 2 consecutive suspicious windows, not on the first", () => {
    const { fires, push } = setup();
    push(true); // streak 1 — below threshold
    expect(fires).toHaveLength(0);
    push(true); // streak 2 — initial trigger
    expect(fires).toHaveLength(1);
    expect(fires[0].detail).toContain("streak=2");
  });

  it("keeps emitting while suspicion persists, throttled to the refire interval", () => {
    const { fires, push } = setup();
    push(true);
    push(true); // fire #1 at t0
    expect(fires).toHaveLength(1);

    now += 4_000;
    push(true); // suspicion persists but refire interval (9s) not elapsed
    expect(fires).toHaveLength(1);

    now += 5_000; // 9s since the last emission
    push(true); // sustained masking: RE-FIRE on the next suspicious window
    expect(fires).toHaveLength(2);
    expect(fires[1].detail).toContain("streak=4");

    now += 9_000;
    push(true); // …and again — the old 30s cooldown lockout is gone
    expect(fires).toHaveLength(3);
  });

  it("resets to idle on a clean window — re-trigger needs 2 consecutive again", () => {
    const { fires, push } = setup();
    push(true);
    push(true); // fire #1
    expect(fires).toHaveLength(1);

    push(false); // clean window → idle (baseline refreshed on MATCH)
    now += 60_000; // well past the refire interval
    push(true); // streak 1 — must NOT fire (reset, not cooldown)
    expect(fires).toHaveLength(1);
    push(true); // streak 2 — fresh trigger
    expect(fires).toHaveLength(2);
  });
});
