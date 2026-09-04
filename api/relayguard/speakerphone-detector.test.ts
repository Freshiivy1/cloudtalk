/**
 * SpeakerphoneDetector sustained-masking logic (post-fire repeat emissions).
 *
 * The DSP layer (analyzeClip / compareClips / relayFingerprint) is mocked so
 * each 1s window's suspiciousness is controlled directly; the logic under
 * test is the streak / refire / reset-to-idle state machine in
 * speakerphone-detector.ts. No DB or network involved.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const dsp = vi.hoisted(() => ({ suspicious: false, amberOnly: false, matchAmber: false }));

vi.mock("./features", () => ({
  // speechFrames + a real turn-exchange (≥2 bursts) lets the first window
  // seed the baseline under the detector's seeding rule.
  analyzeClip: () => ({ vad: { speechFrames: [0], burstCount: 2 } }),
}));

vi.mock("./compare", () => ({
  compareClips: () =>
    dsp.suspicious
      ? { verdict: "SUSPICIOUS RELAY", weightedScore: 0.9, confidence: 90, flags: ["test-flag"] }
      : { verdict: "MATCH", weightedScore: 0.05, confidence: 95, flags: [] },
  relayFingerprint: () =>
    dsp.suspicious
      ? dsp.amberOnly
        ? {
            state: "AMBER",
            score: 0.5,
            components: { flatness: 0.5, gapContrast: 0.4, noiseBed: 0.3, hfLeakage: 0.2, fragmentation: 0.1 },
          }
        : {
            state: "RED",
            score: 0.9,
            components: { flatness: 0.9, gapContrast: 0.8, noiseBed: 0.7, hfLeakage: 0.6, fragmentation: 0.5 },
          }
      : dsp.matchAmber
        ? {
            // Borderline mid-episode window: MATCH verdict but a fingerprint
            // AT/ABOVE the clean-episode ceiling (0.5) — the mid-relay AMBER
            // dip zone. Must neither clear suspicion (the clean streak resets)
            // nor be absorbed into the baseline.
            state: "AMBER",
            score: 0.55,
            components: { flatness: 0.55, gapContrast: 0.5, noiseBed: 0.4, hfLeakage: 0.2, fragmentation: 0.2 },
          }
        : {
            state: "GREEN",
            score: 0.1,
            components: { flatness: 0.1, gapContrast: 0.1, noiseBed: 0.1, hfLeakage: 0.1, fragmentation: 0.1 },
          },
}));

import { SpeakerphoneDetector } from "./speakerphone-detector";

/** 1s window of 8 kHz PCM (non-silent so peak-normalization is exercised). */
const WINDOW = new Array(8000).fill(1000);

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

describe("SpeakerphoneDetector arming threshold", () => {
  it("defaults to 3 consecutive suspicious windows — 2 no longer arms", () => {
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fires: Array<{ score: number; detail: string }> = [];
    // No consecutiveWindows option → the 3s default applies.
    const d = new SpeakerphoneDetector({
      onSuspicious: (score, detail) => fires.push({ score, detail }),
    });
    dsp.suspicious = false;
    d.pushSamples(WINDOW); // baseline seed
    expect(fires).toHaveLength(0);
    dsp.suspicious = true;
    d.pushSamples(WINDOW); // streak 1
    expect(fires).toHaveLength(0);
    now += 5_000;
    d.pushSamples(WINDOW); // streak 2 — below the 3s default, must NOT fire
    expect(fires).toHaveLength(0);
    now += 5_000;
    d.pushSamples(WINDOW); // streak 3 — sustained 3s suspicion → arm
    expect(fires).toHaveLength(1);
    expect(fires[0].detail).toContain("streak=3");
  });

  it("clears only after 2 consecutive clean windows (hysteresis) — no re-announces after onClean", () => {
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fires: Array<{ score: number; detail: string }> = [];
    const cleans: string[] = [];
    const d = new SpeakerphoneDetector({
      consecutiveWindows: 2,
      refireMs: 9_000,
      onSuspicious: (score, detail) => fires.push({ score, detail }),
      onClean: (detail) => cleans.push(detail),
    });
    dsp.suspicious = false;
    d.pushSamples(WINDOW); // baseline seed
    dsp.suspicious = true;
    d.pushSamples(WINDOW); // streak 1
    d.pushSamples(WINDOW); // streak 2 → fires
    expect(fires).toHaveLength(1);
    now += 60_000; // well past refire — would re-fire if still suspecting
    dsp.suspicious = false;
    d.pushSamples(WINDOW); // clean #1 — hysteresis: NOT cleared yet
    expect(cleans).toHaveLength(0);
    d.pushSamples(WINDOW); // clean #2 (consecutive) → onClean, back to idle
    expect(cleans).toHaveLength(1);
    // Suspicion cleared: no further emissions without a fresh streak.
    now += 60_000;
    d.pushSamples(WINDOW); // another clean window
    expect(fires).toHaveLength(1);
    expect(cleans).toHaveLength(1); // onClean fires exactly once per episode
  });
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

  it("resets to idle after 2 consecutive clean windows — re-trigger needs 2 consecutive suspicious again", () => {
    const { fires, push } = setup();
    push(true);
    push(true); // fire #1
    expect(fires).toHaveLength(1);

    push(false); // clean #1 — episode survives (hysteresis), baseline frozen
    now += 60_000; // well past the refire interval
    push(true); // still suspecting: refire, NOT a fresh streak
    expect(fires).toHaveLength(2);

    push(false); // clean #1 (consecutive streak restarted by the suspicious window)
    push(false); // clean #2 → cleared (baseline refresh allowed again)
    now += 60_000;
    push(true); // streak 1 — must NOT fire (reset, not cooldown)
    expect(fires).toHaveLength(2);
    push(true); // streak 2 — fresh trigger
    expect(fires).toHaveLength(3);
  });

  it("uncapped: keeps emitting every refire interval for as long as suspicion persists", () => {
    const { fires, push } = setup(); // refireMs 9s
    push(true);
    push(true); // fire #1
    expect(fires).toHaveLength(1);
    // Six more refire cycles — nothing caps the repeats (the ~4s production
    // refire runs until SPEAKERPHONE_CLEARED).
    for (let i = 0; i < 6; i++) {
      now += 9_000;
      push(true);
    }
    expect(fires).toHaveLength(7);
  });
});

describe("SpeakerphoneDetector RED arming bar", () => {
  function setupBar() {
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fires: Array<{ score: number; detail: string }> = [];
    const d = new SpeakerphoneDetector({
      consecutiveWindows: 3,
      onSuspicious: (score, detail) => fires.push({ score, detail }),
    });
    const push = (suspicious: boolean, amberOnly = false) => {
      dsp.suspicious = suspicious;
      dsp.amberOnly = amberOnly;
      d.pushSamples(WINDOW);
      dsp.amberOnly = false;
    };
    push(false); // baseline seed
    return { fires, push };
  }

  it("AMBER×3 (SUSPICIOUS RELAY verdict but fingerprint < 0.6) NEVER arms", () => {
    const { fires, push } = setupBar();
    push(true, true); // streak would be 1 under the old OR rule
    now += 1_000;
    push(true, true);
    now += 1_000;
    push(true, true); // 3 consecutive AMBER suspicious-verdict windows
    now += 1_000;
    push(true, true); // one more for good measure
    expect(fires).toHaveLength(0);
  });

  it("RED×3 (verdict SUSPICIOUS RELAY AND fingerprint >= 0.6) arms", () => {
    const { fires, push } = setupBar();
    push(true);
    now += 1_000;
    push(true);
    expect(fires).toHaveLength(0);
    now += 1_000;
    push(true); // 3rd consecutive RED+SUSPICIOUS window → arm
    expect(fires).toHaveLength(1);
    expect(fires[0].detail).toContain("relayState=RED");
    expect(fires[0].detail).toContain("streak=3");
  });

  it("an AMBER window inside a RED streak breaks the streak", () => {
    const { fires, push } = setupBar();
    push(true); // RED streak 1
    now += 1_000;
    push(true, true); // AMBER → streak resets to 0
    now += 1_000;
    push(true); // RED streak 1 again
    now += 1_000;
    push(true); // streak 2
    expect(fires).toHaveLength(0);
    now += 1_000;
    push(true); // streak 3 → arm
    expect(fires).toHaveLength(1);
  });
});

describe("SpeakerphoneDetector calibration warm-up", () => {
  it("does NOT arm during the post-BRIDGED warm-up, then logs completion and arms normally", () => {
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fires: Array<{ score: number; detail: string }> = [];
    const warmups: string[] = [];
    const d = new SpeakerphoneDetector({
      consecutiveWindows: 3,
      warmupMs: 8_000,
      onSuspicious: (score, detail) => fires.push({ score, detail }),
      onWarmupComplete: (detail) => warmups.push(detail),
    });
    const push = (suspicious: boolean) => {
      dsp.suspicious = suspicious;
      d.pushSamples(WINDOW);
    };
    push(false); // pre-bridge baseline seed (ringback/IVR audio)
    push(true);
    push(true);
    // Enter BRIDGED: baseline resets, warm-up starts.
    d.setBridged(true);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("FORENSICS_WARMUP_START"))).toBe(
      true,
    );
    // Suspicious windows DURING the warm-up can never arm, even far past the
    // 3-window streak requirement.
    for (let i = 0; i < 5; i++) {
      now += 1_000;
      push(true);
    }
    expect(fires).toHaveLength(0);
    expect(warmups).toHaveLength(0);
    // Cross the 8s warm-up boundary → completion logged exactly once…
    now += 4_000; // t = bridge + 9s
    push(true); // first post-warm-up suspicious window (streak 1)
    expect(warmups).toHaveLength(1);
    expect(
      logSpy.mock.calls.some((c) => String(c[0]).includes("FORENSICS_WARMUP_COMPLETE")),
    ).toBe(true);
    expect(fires).toHaveLength(0); // streak restarted after the warm-up
    now += 1_000;
    push(true); // streak 2
    now += 1_000;
    push(true); // streak 3 → arm
    expect(fires).toHaveLength(1);
    // Warm-up completion is a one-shot.
    now += 5_000;
    push(false);
    expect(warmups).toHaveLength(1);
    logSpy.mockRestore();
  });

  it("logs throttled FORENSIC_WINDOW score lines while BRIDGED (verdict, fp score/state, top features)", () => {
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const d = new SpeakerphoneDetector({ warmupMs: 0 });
    dsp.suspicious = false;
    d.pushSamples(WINDOW); // baseline seed
    d.setBridged(true);
    d.pushSamples(WINDOW); // first bridged window → logs immediately
    d.pushSamples(WINDOW); // inside the 5s throttle → no second line
    let lines = logSpy.mock.calls.filter((c) => String(c[0]).includes("FORENSIC_WINDOW"));
    expect(lines).toHaveLength(1);
    const line = String(lines[0][0]);
    expect(line).toContain("verdict=MATCH");
    expect(line).toContain("relayState=GREEN");
    expect(line).toContain("relayScore=0.10");
    expect(line).toContain("top=flatness="); // top contributing features
    now += 6_000; // past the throttle
    d.pushSamples(WINDOW);
    lines = logSpy.mock.calls.filter((c) => String(c[0]).includes("FORENSIC_WINDOW"));
    expect(lines).toHaveLength(2);
    logSpy.mockRestore();
  });
});

describe("SpeakerphoneDetector BRIDGED-gated streak freeze (D2)", () => {
  function setupFreeze(warmupMs = 8_000) {
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fires: Array<{ score: number; detail: string }> = [];
    const d = new SpeakerphoneDetector({
      consecutiveWindows: 3,
      warmupMs,
      armOnlyWhenBridged: true,
      onSuspicious: (score, detail) => fires.push({ score, detail }),
    });
    const push = (suspicious: boolean) => {
      dsp.suspicious = suspicious;
      d.pushSamples(WINDOW);
    };
    push(false); // pre-bridge baseline seed (ringback/IVR audio)
    return { d, fires, push, logSpy };
  }

  it("pre-bridge RED windows NEVER accumulate a streak — no arm before the bridge lands", () => {
    const { fires, push, logSpy } = setupFreeze();
    // Well past the 3-window arming requirement while NOT bridged: the
    // challenge can never fire on pre-bridge (ringback/IVR-era) audio.
    for (let i = 0; i < 6; i++) {
      now += 1_000;
      push(true);
      expect(fires).toHaveLength(0);
    }
    logSpy.mockRestore();
  });

  it("bridge via setBridged (event-driven registry path, poll not yet run) → warm-up starts immediately", () => {
    const { d, fires, push, logSpy } = setupFreeze();
    // False-RED windows in the race window before the flag arrives: frozen.
    now += 1_000;
    push(true);
    now += 1_000;
    push(true);
    expect(fires).toHaveLength(0);
    // The bridge lands: the registry flip reaches the detector per window.
    d.setBridged(true);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("FORENSICS_WARMUP_START"))).toBe(
      true,
    );
    // Warm-up suppression is live IMMEDIATELY — RED windows during the
    // warm-up cannot arm, and the frozen pre-bridge streak does not carry.
    for (let i = 0; i < 5; i++) {
      now += 1_000;
      push(true);
    }
    expect(fires).toHaveLength(0);
    // Past the warm-up the detector arms normally from a fresh streak.
    now += 4_000; // t = bridge + 9s
    push(true); // streak 1 (post-warm-up)
    now += 1_000;
    push(true); // streak 2
    expect(fires).toHaveLength(0);
    now += 1_000;
    push(true); // streak 3 → arm
    expect(fires).toHaveLength(1);
    logSpy.mockRestore();
  });

  it("without armOnlyWhenBridged the legacy pre-bridge arming behavior is unchanged", () => {
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fires: Array<{ score: number; detail: string }> = [];
    const d = new SpeakerphoneDetector({
      consecutiveWindows: 2,
      onSuspicious: (score, detail) => fires.push({ score, detail }),
    });
    dsp.suspicious = false;
    d.pushSamples(WINDOW); // baseline seed
    dsp.suspicious = true;
    d.pushSamples(WINDOW); // streak 1
    d.pushSamples(WINDOW); // streak 2 → arms even though never bridged
    expect(fires).toHaveLength(1);
  });
});

describe("SpeakerphoneDetector calibration warm-up (continued)", () => {
  it("a session already BRIDGED at construction warm-ups from t0", () => {
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fires: number[] = [];
    const d = new SpeakerphoneDetector({
      consecutiveWindows: 1,
      warmupMs: 8_000,
      bridged: true,
      onSuspicious: (score) => fires.push(score),
    });
    dsp.suspicious = false;
    d.pushSamples(WINDOW); // baseline seed
    dsp.suspicious = true;
    now += 1_000;
    d.pushSamples(WINDOW); // inside warm-up → suppressed despite need=1
    expect(fires).toHaveLength(0);
    now += 8_000;
    d.pushSamples(WINDOW); // warm-up done → arms
    expect(fires).toHaveLength(1);
  });
});

describe("SpeakerphoneDetector baseline-adaptation guard (live 'fires 3-4 times then stops' regression)", () => {
  function setupGuard() {
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fires: Array<{ score: number; detail: string }> = [];
    const cleans: string[] = [];
    const d = new SpeakerphoneDetector({
      consecutiveWindows: 2,
      refireMs: 4_000,
      onSuspicious: (score, detail) => fires.push({ score, detail }),
      onClean: (detail) => cleans.push(detail),
    });
    const push = (suspicious: boolean, matchAmber = false) => {
      dsp.suspicious = suspicious;
      dsp.matchAmber = matchAmber;
      d.pushSamples(WINDOW);
      dsp.matchAmber = false;
    };
    push(false); // baseline seed (absorption #1)
    expect(d.baselineAbsorptions).toBe(1);
    return { d, fires, cleans, push };
  }

  it("a borderline MATCH window mid-episode neither clears suspicion nor poisons the baseline — refires continue past 3-4 pickups", () => {
    const { d, fires, cleans, push } = setupGuard();
    push(true);
    push(true); // fire #1
    expect(fires).toHaveLength(1);

    // Sustained relay with a borderline MATCH+GREEN window after the 4th
    // pickup — the exact live-calls pattern that used to end the episode.
    now += 4_000;
    push(true); // fire #2
    now += 4_000;
    push(true); // fire #3
    now += 4_000;
    push(true); // fire #4
    expect(fires).toHaveLength(4);

    const absorbsBefore = d.baselineAbsorptions;
    push(false); // borderline MATCH+GREEN mid-episode
    expect(cleans).toHaveLength(0); // hysteresis: 1 clean window never clears
    expect(d.baselineAbsorptions).toBe(absorbsBefore); // baseline FROZEN during the episode

    now += 4_000;
    push(true); // suspicion still active → refire #5 (old code: silence from here on)
    expect(fires).toHaveLength(5);
    now += 4_000;
    push(true); // #6
    now += 4_000;
    push(true); // #7
    expect(fires).toHaveLength(7);

    // Genuine sustained clean audio ends the episode: 2 consecutive cleans.
    push(false);
    push(false);
    expect(cleans).toHaveLength(1);
    // After clearing, clearly-clean audio may refresh the baseline again.
    push(false);
    expect(d.baselineAbsorptions).toBeGreaterThan(absorbsBefore);
  });

  it("MATCH+AMBER windows never clear the episode and are never absorbed", () => {
    const { d, fires, cleans, push } = setupGuard();
    push(true);
    push(true); // fire #1
    const absorbsBefore = d.baselineAbsorptions;
    now += 4_000;
    push(false, true); // MATCH verdict but AMBER fingerprint
    expect(cleans).toHaveLength(0);
    expect(d.baselineAbsorptions).toBe(absorbsBefore);
    now += 4_000;
    push(true); // episode continues → refire #2
    expect(fires).toHaveLength(2);
  });

  it("baseline absorbs only MATCH+GREEN while idle — AMBER audio never becomes the reference", () => {
    const { d, push } = setupGuard();
    expect(d.baselineAbsorptions).toBe(1); // seed only
    push(false, true); // MATCH+AMBER, not suspecting → NOT absorbed
    expect(d.baselineAbsorptions).toBe(1);
    push(false); // MATCH+GREEN, not suspecting → absorbed
    expect(d.baselineAbsorptions).toBe(2);
  });

  it("cleanWindowsToClear: 1 preserves single-clean clearing", () => {
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fires: number[] = [];
    const cleans: string[] = [];
    const d = new SpeakerphoneDetector({
      consecutiveWindows: 2,
      refireMs: 4_000,
      cleanWindowsToClear: 1,
      onSuspicious: (score) => fires.push(score),
      onClean: (detail) => cleans.push(detail),
    });
    dsp.suspicious = false;
    d.pushSamples(WINDOW); // seed
    dsp.suspicious = true;
    d.pushSamples(WINDOW);
    d.pushSamples(WINDOW); // fires
    expect(fires).toHaveLength(1);
    dsp.suspicious = false;
    d.pushSamples(WINDOW); // one clean window clears under the legacy setting
    expect(cleans).toHaveLength(1);
  });
});
