/**
 * VoiceIdTracker / matchVoiceIdPhrase / decideVoiceId tests.
 *
 * Three layers:
 *  1. matchVoiceIdPhrase — pure string logic (accent/telephone tolerance).
 *  2. decideVoiceId — pure decision matrix on fabricated snapshots.
 *  3. VoiceIdTracker — streaming state machine:
 *     a. MOCKED DSP (./features + ./compare mocked, same pattern as
 *        speakerphone-detector.test.ts) so each 1s window's suspiciousness is
 *        controlled directly while the REAL VAD/section/end-of-speech logic
 *        runs on synthetic μ-law frames;
 *     b. REAL DSP (mock switched to pass-through) with relay-colored vs
 *        direct handset-like speech synthesized through the channel models of
 *        speakerphone-simulation.test.ts — measures the actual relay
 *        decision latency on 20ms μ-law frames.
 *
 * No DB, no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";

/**
 * DSP mock switchboard: when `mocked` is false the module mocks PASS THROUGH
 * to the real implementations (for the real-DSP timing tests).
 */
const dsp = vi.hoisted(() => ({ mocked: true, suspicious: false, score: 0.7 }));

vi.mock("./features", async (importOriginal) => {
  const real = await importOriginal<typeof import("./features")>();
  return {
    ...real,
    analyzeClip: (...args: Parameters<typeof real.analyzeClip>) =>
      dsp.mocked
        ? // speechFrames + ≥2 bursts so clean windows may seed the baseline.
          { vad: { speechFrames: [0], burstCount: 2 } }
        : real.analyzeClip(...args),
  };
});

vi.mock("./compare", async (importOriginal) => {
  const real = await importOriginal<typeof import("./compare")>();
  return {
    ...real,
    compareClips: (...args: Parameters<typeof real.compareClips>) =>
      dsp.mocked
        ? dsp.suspicious
          ? { verdict: "SUSPICIOUS RELAY", weightedScore: 0.9, confidence: 90, flags: ["test-flag"] }
          : { verdict: "MATCH", weightedScore: 0.05, confidence: 95, flags: [] }
        : real.compareClips(...args),
    relayFingerprint: (...args: Parameters<typeof real.relayFingerprint>) =>
      dsp.mocked
        ? dsp.suspicious
          ? {
              state: "RED",
              score: dsp.score,
              components: { flatness: 0.9, gapContrast: 0.8, noiseBed: 0.7, hfLeakage: 0.6, fragmentation: 0.5 },
            }
          : {
              state: "GREEN",
              score: 0.1,
              components: { flatness: 0.1, gapContrast: 0.1, noiseBed: 0.1, hfLeakage: 0.1, fragmentation: 0.1 },
            }
        : real.relayFingerprint(...args),
  };
});

import {
  VoiceIdTracker,
  matchVoiceIdPhrase,
  decideVoiceId,
  type VoiceIdSnapshot,
  type VoiceIdTrackerOptions,
} from "./voice-id-tracker";

const SR = 8000;
const FRAME = 160; // 20 ms at 8 kHz

/* ------------------------------------------------------- μ-law helpers -- */

/** Standard μ-law encoder — exact inverse of decodeMulaw in verification-stream. */
function encodeMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = 0;
  let s = sample;
  if (s < 0) {
    sign = 0x80;
    s = -s;
  }
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; !(s & mask) && exp > 0; mask >>= 1) exp--;
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}

function mulawPayload(pcm: ArrayLike<number>): string {
  const buf = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) buf[i] = encodeMulaw(Math.round(pcm[i]));
  return buf.toString("base64");
}

/** One 20ms frame of digital silence. */
function silenceFrame(): string {
  return mulawPayload(new Array(FRAME).fill(0));
}

/**
 * One 20ms frame of loud "speech-like" audio for the VAD: a 400 Hz tone
 * (exactly 20 periods per frame at 8 kHz, so consecutive frames tile
 * seamlessly) at 0.3 full scale ≈ −13.6 dBFS RMS. Far from the detector's
 * 852/1336 Hz probe pair.
 */
const SPEECH_FRAME = (() => {
  const out = new Array<number>(FRAME);
  for (let i = 0; i < FRAME; i++) {
    out[i] = Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 400 * i) / SR));
  }
  return mulawPayload(out);
})();

function speechFrame(): string {
  return SPEECH_FRAME;
}

/* ----------------------------------------------------------- clock/feed -- */

let now = 1_000_000;
let nowSpy: ReturnType<typeof vi.spyOn> | null = null;

function startClock() {
  now = 1_000_000;
  nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
}

interface TrackerEvents {
  relay: VoiceIdSnapshot[];
  end: VoiceIdSnapshot[];
}

function makeTracker(opts: VoiceIdTrackerOptions = {}): { t: VoiceIdTracker; events: TrackerEvents } {
  const events: TrackerEvents = { relay: [], end: [] };
  const t = new VoiceIdTracker({
    now: () => now,
    onRelayConfirmed: (s) => events.relay.push(s),
    onAttemptEnd: (s) => events.end.push(s),
    ...opts,
  });
  return { t, events };
}

/** Feed `count` copies of `frame`, advancing the fake clock 20ms per frame. */
function feed(t: VoiceIdTracker, frame: string, count: number): void {
  for (let i = 0; i < count; i++) {
    now += 20;
    t.push(frame);
  }
}

afterEach(() => {
  dsp.mocked = true;
  dsp.suspicious = false;
  dsp.score = 0.7;
  nowSpy?.mockRestore();
  nowSpy = null;
});

/* ============================================================ matcher ==== */

describe("matchVoiceIdPhrase", () => {
  const ok = (s: string) => {
    const m = matchVoiceIdPhrase(s);
    expect(m.orderedOk).toBe(true);
    expect(m.anchorsMatched).toBe(4);
    expect(m.coverage).toBe(1);
    expect(m.matchedAnchors).toEqual(["my", "voice", "identifies", "me"]);
    return m;
  };
  const notOk = (s: string) => {
    const m = matchVoiceIdPhrase(s);
    expect(m.orderedOk).toBe(false);
    return m;
  };

  it("accepts the exact phrase", () => {
    const m = ok("my voice identifies me");
    expect(m.tokens).toEqual(["my", "voice", "identifies", "me"]);
  });

  it("accepts case variations and trailing punctuation", () => {
    ok("My Voice Identifies Me");
    ok("my voice identifies me.");
    ok("my voice identifies me!");
  });

  it("accepts accent/telephone-STT variants", () => {
    ok("My voice identify me"); // final 's' softened/omitted (thick accent)
    ok("my vois identifies me"); // clipped 'c'
    ok("my vice identifies me");
    ok("my boice identifies me");
    ok("my woice identifies me");
    ok("mai voice identifies me");
    ok("meh voice identifies me");
    ok("my voice identifies mi");
    ok("my voice identifies mee");
    ok("my voice identified me");
  });

  it("accepts leading filler when all four anchors still align in order", () => {
    ok("um my voice identifies me");
    ok("uh okay my voice identifies me");
  });

  it("REJECTS partial phrases", () => {
    const two = notOk("my voice");
    expect(two.anchorsMatched).toBe(2);
    expect(two.coverage).toBe(0.5);
    expect(two.matchedAnchors).toEqual(["my", "voice"]);
    notOk("identifies me");
    notOk("voice identifies");
  });

  it("REJECTS a single keyword", () => {
    const m = notOk("voice");
    expect(m.anchorsMatched).toBe(0);
  });

  it("REJECTS the correct words in the WRONG ORDER", () => {
    // The 1-edit fuzziness of the short anchors must not let me→my … my→me.
    notOk("me voice identifies my");
    notOk("voice my identifies me");
    notOk("my identifies voice me");
  });

  it("REJECTS unrelated speech of any length", () => {
    const m = notOk("the weather is nice");
    expect(m.anchorsMatched).toBe(0);
    notOk("i would like to schedule an appointment for tomorrow morning please");
    notOk("yes hello this is him speaking right now");
  });

  it("REJECTS an empty transcript", () => {
    const m = notOk("");
    expect(m.tokens).toEqual([]);
    expect(m.anchorsMatched).toBe(0);
    expect(m.coverage).toBe(0);
  });
});

/* ============================================================ decision === */

function mkSnap(over: Partial<VoiceIdSnapshot> = {}): VoiceIdSnapshot {
  return {
    attemptStartedAtMs: 1_000_000,
    speechStartedAtMs: 1_000_200,
    voicedDurationMs: 2000,
    sectionCount: 4,
    sections: [
      { startMs: 200, endMs: 700 },
      { startMs: 900, endMs: 1500 },
      { startMs: 1600, endMs: 2200 },
      { startMs: 2300, endMs: 2800 },
    ],
    trailingSilenceMs: 650,
    speechEnded: true,
    relayConfidence: 0,
    relayWindows: 0,
    relayConfirmed: false,
    relayEvidence: "",
    relayDecisionMs: null,
    audioQuality: { clippedRatio: 0, meanLevelDb: -20, noiseFloorDb: -55, snrDb: 35 },
    ended: true,
    endReason: "speech-end",
    ...over,
  };
}

describe("decideVoiceId", () => {
  it("pass: complete ordered phrase + usable direct audio", () => {
    const d = decideVoiceId({
      transcript: "my voice identifies me",
      transcriptConfidence: 0.93,
      tracker: mkSnap(),
    });
    expect(d.verdict).toBe("pass");
    expect(d.scores.phraseCoverage).toBe(1);
    expect(d.reasons.join(" ")).toContain("all 4 anchors");
  });

  it("relay confirmed beats EVERYTHING — even a perfect phrase on perfect audio", () => {
    const d = decideVoiceId({
      transcript: "my voice identifies me",
      transcriptConfidence: 0.99,
      tracker: mkSnap({
        relayConfirmed: true,
        relayConfidence: 0.92,
        relayWindows: 2,
        relayEvidence: "verdict=SUSPICIOUS RELAY relayState=RED relayScore=0.92",
        relayDecisionMs: 1500,
      }),
    });
    expect(d.verdict).toBe("retry-relay");
    expect(d.scores.relayConfidence).toBe(0.92);
    expect(d.reasons.join(" ")).toContain("0.92");
  });

  it("tracker null → inconclusive (detector unavailable must NEVER pass)", () => {
    const d = decideVoiceId({
      transcript: "my voice identifies me",
      transcriptConfidence: 0.95,
      tracker: null,
    });
    expect(d.verdict).toBe("inconclusive");
  });

  it("silence → retry-nospeech", () => {
    for (const tracker of [
      mkSnap({ speechStartedAtMs: null, voicedDurationMs: 0, sectionCount: 0, sections: [], endReason: "no-speech" }),
      mkSnap({ voicedDurationMs: 200 }), // some noise, below the 300ms bar
    ]) {
      const d = decideVoiceId({ transcript: null, transcriptConfidence: null, tracker });
      expect(d.verdict).toBe("retry-nospeech");
    }
  });

  it("clipped audio → retry-audio", () => {
    const d = decideVoiceId({
      transcript: "my voice identifies me",
      transcriptConfidence: 0.9,
      tracker: mkSnap({ audioQuality: { clippedRatio: 0.45, meanLevelDb: -12, noiseFloorDb: -50, snrDb: 38 } }),
    });
    expect(d.verdict).toBe("retry-audio");
    expect(d.reasons.join(" ")).toContain("clippedRatio=0.45");
  });

  it("too-quiet audio → retry-audio", () => {
    const d = decideVoiceId({
      transcript: "my voice identifies me",
      transcriptConfidence: 0.9,
      tracker: mkSnap({
        voicedDurationMs: 1200,
        audioQuality: { clippedRatio: 0, meanLevelDb: -52, noiseFloorDb: -60, snrDb: 8 },
      }),
    });
    expect(d.verdict).toBe("retry-audio");
    expect(d.reasons.join(" ")).toContain("meanLevelDb=-52.0");
  });

  it("partial phrase → retry-phrase", () => {
    const d = decideVoiceId({
      transcript: "my voice",
      transcriptConfidence: 0.9,
      tracker: mkSnap(),
    });
    expect(d.verdict).toBe("retry-phrase");
    expect(d.scores.phraseCoverage).toBe(0.5);
  });

  it("voicedDurationMs > maxVoicedMs → retry-phrase even with the complete phrase (background conversation can never pass)", () => {
    const d = decideVoiceId({
      transcript: "my voice identifies me",
      transcriptConfidence: 0.9,
      tracker: mkSnap({ voicedDurationMs: 9000, endReason: "max-duration", speechEnded: false }),
    });
    expect(d.verdict).toBe("retry-phrase");
    expect(d.reasons.join(" ")).toContain("9000");
  });

  it("fast speaker (voiced 900ms, 2 merged sections, complete transcript) → pass", () => {
    const d = decideVoiceId({
      transcript: "my voice identifies me",
      transcriptConfidence: 0.88,
      tracker: mkSnap({
        voicedDurationMs: 900,
        sectionCount: 2,
        sections: [
          { startMs: 100, endMs: 500 },
          { startMs: 600, endMs: 1000 },
        ],
      }),
    });
    expect(d.verdict).toBe("pass");
  });

  it("slow speaker (voiced 4s, 4 distinct sections) → pass", () => {
    const d = decideVoiceId({
      transcript: "my voice identifies me",
      transcriptConfidence: 0.91,
      tracker: mkSnap({
        voicedDurationMs: 4000,
        sectionCount: 4,
        sections: [
          { startMs: 200, endMs: 1200 },
          { startMs: 1700, endMs: 2700 },
          { startMs: 3200, endMs: 4200 },
          { startMs: 4700, endMs: 5700 },
        ],
      }),
    });
    expect(d.verdict).toBe("pass");
  });

  it("long recording without the complete phrase → retry-phrase", () => {
    const d = decideVoiceId({
      transcript: "the weather is nice today and i am feeling good",
      transcriptConfidence: 0.9,
      tracker: mkSnap({
        voicedDurationMs: 7000,
        sectionCount: 6,
        endReason: "max-duration",
        speechEnded: false,
      }),
    });
    expect(d.verdict).toBe("retry-phrase");
  });

  it("empty transcript with usable speech → retry-phrase", () => {
    const d = decideVoiceId({ transcript: "", transcriptConfidence: null, tracker: mkSnap() });
    expect(d.verdict).toBe("retry-phrase");
  });
});

/* ============================================ tracker (mocked DSP) ====== */

describe("VoiceIdTracker VAD / end-of-attempt (mocked DSP)", () => {
  it("pure silence input ends 'no-speech' after noSpeechTimeoutMs", () => {
    startClock();
    const { t, events } = makeTracker();
    feed(t, silenceFrame(), 299); // 5980ms — just under the 6000ms default
    expect(t.snapshot().ended).toBe(false);
    feed(t, silenceFrame(), 1); // 6000ms exactly
    expect(events.end).toHaveLength(1);
    const snap = events.end[0];
    expect(snap.endReason).toBe("no-speech");
    expect(snap.speechStartedAtMs).toBeNull();
    expect(snap.voicedDurationMs).toBe(0);
    expect(snap.sectionCount).toBe(0);
    expect(snap.ended).toBe(true);
    // Late frames are a no-op: callbacks never double-fire.
    feed(t, silenceFrame(), 50);
    feed(t, speechFrame(), 50);
    expect(events.end).toHaveLength(1);
    expect(events.relay).toHaveLength(0);
    expect(t.snapshot().voicedDurationMs).toBe(0);
  });

  it("speech then silence ends 'speech-end' with trailingSilenceMs >= 650", () => {
    startClock();
    const { t, events } = makeTracker();
    feed(t, speechFrame(), 50); // 1000ms of speech
    expect(t.snapshot().voicedDurationMs).toBe(1000);
    feed(t, silenceFrame(), 32); // 640ms of trailing silence — still open
    expect(t.snapshot().ended).toBe(false);
    feed(t, silenceFrame(), 1); // 660ms >= 650ms → speech-end
    expect(events.end).toHaveLength(1);
    const snap = events.end[0];
    expect(snap.endReason).toBe("speech-end");
    expect(snap.speechEnded).toBe(true);
    expect(snap.trailingSilenceMs).toBeGreaterThanOrEqual(650);
    expect(snap.voicedDurationMs).toBe(1000);
    expect(snap.sectionCount).toBe(1);
    expect(snap.speechStartedAtMs).not.toBeNull();
    expect(snap.audioQuality.meanLevelDb).toBeGreaterThan(-45);
    expect(snap.audioQuality.snrDb).toBeGreaterThan(3);
  });

  it("4 speech bursts separated by >= sectionGapMs pauses → sectionCount 4", () => {
    startClock();
    const { t } = makeTracker();
    for (let b = 0; b < 3; b++) {
      feed(t, speechFrame(), 25); // 500ms burst
      feed(t, silenceFrame(), 25); // 500ms gap (>= 250ms → split)
    }
    feed(t, speechFrame(), 25); // 4th burst
    const snap = t.snapshot();
    expect(snap.sectionCount).toBe(4);
    expect(snap.sections).toEqual([
      { startMs: 0, endMs: 500 },
      { startMs: 1000, endMs: 1500 },
      { startMs: 2000, endMs: 2500 },
      { startMs: 3000, endMs: 3500 },
    ]);
    expect(snap.voicedDurationMs).toBe(2000);
    expect(snap.ended).toBe(false);
  });

  it("short natural word pauses (< sectionGapMs) stay in-section", () => {
    startClock();
    const { t } = makeTracker();
    for (let b = 0; b < 4; b++) {
      feed(t, speechFrame(), 10); // 200ms word
      if (b < 3) feed(t, silenceFrame(), 10); // 200ms pause < 250ms → no split
    }
    const snap = t.snapshot();
    expect(snap.sectionCount).toBe(1);
    expect(snap.sections[0].startMs).toBe(0);
    expect(snap.sections[0].endMs).toBe(1400);
  });

  it("maxAttemptMs caps a runaway attempt → 'max-duration'", () => {
    startClock();
    const { t, events } = makeTracker({ maxAttemptMs: 3000 });
    // Continuous loud audio: VAD never sees trailing silence.
    feed(t, speechFrame(), 150); // 3000ms
    expect(events.end).toHaveLength(1);
    expect(events.end[0].endReason).toBe("max-duration");
    expect(events.end[0].voicedDurationMs).toBe(3000);
  });
});

describe("VoiceIdTracker relay confirmation (mocked DSP)", () => {
  it("one suspicious emission below high confidence does NOT confirm; the consecutive counter survives clean windows (no onClean mid-attempt)", () => {
    startClock();
    const { t, events } = makeTracker();
    dsp.score = 0.7; // RED but < relayHighConfidence (0.9)
    dsp.suspicious = true;
    feed(t, speechFrame(), 60); // 1.2s — exactly ONE analysis window (at 1.0s)
    let snap = t.snapshot();
    expect(snap.relayConfidence).toBeCloseTo(0.7);
    expect(snap.relayWindows).toBe(1);
    expect(snap.relayConfirmed).toBe(false);
    expect(snap.ended).toBe(false);
    expect(events.relay).toHaveLength(0);
    // Clean speech: the detector's cleanWindowsToClear=9999 means onClean
    // never arrives mid-attempt, so the consecutive counter is NOT reset…
    dsp.suspicious = false;
    feed(t, speechFrame(), 40);
    expect(t.snapshot().relayConfirmed).toBe(false);
    // …so the next suspicious emission is the 2nd CONSECUTIVE one → confirm.
    dsp.suspicious = true;
    feed(t, speechFrame(), 50);
    expect(events.relay).toHaveLength(1);
    expect(events.end).toHaveLength(1);
    snap = events.end[0];
    expect(snap.relayConfirmed).toBe(true);
    expect(snap.endReason).toBe("relay");
    expect(snap.relayWindows).toBe(2);
  });

  it("2 consecutive suspicious emissions confirm → endReason 'relay', onRelayConfirmed fired ONCE before onAttemptEnd", () => {
    startClock();
    const order: string[] = [];
    const events: TrackerEvents = { relay: [], end: [] };
    const t = new VoiceIdTracker({
      now: () => now,
      onRelayConfirmed: (s) => {
        events.relay.push(s);
        order.push("relay");
      },
      onAttemptEnd: (s) => {
        events.end.push(s);
        order.push("end");
      },
    });
    dsp.score = 0.7;
    dsp.suspicious = true;
    feed(t, speechFrame(), 80); // 1.6s → emissions at 1.0s and 1.5s
    expect(events.relay).toHaveLength(1);
    expect(events.end).toHaveLength(1);
    expect(order).toEqual(["relay", "end"]);
    const snap = events.relay[0];
    // The confirmation snapshot already reads as a finished relay attempt.
    expect(snap.relayConfirmed).toBe(true);
    expect(snap.ended).toBe(true);
    expect(snap.endReason).toBe("relay");
    expect(snap.relayWindows).toBe(2);
    expect(snap.relayDecisionMs).toBe(1500); // speech started at offset 0
    expect(snap.relayEvidence).toContain("relayScore=0.70");
    // Late frames are a no-op — callbacks never double-fire.
    feed(t, speechFrame(), 100);
    expect(events.relay).toHaveLength(1);
    expect(events.end).toHaveLength(1);
    // Relay confirmed at frame 75 (emission 2 at 1.5s) — the remaining
    // frames of the 80-frame feed and all later frames are no-ops.
    expect(t.snapshot().voicedDurationMs).toBe(1500);
  });

  it("a single >= 0.9 emission confirms immediately (high-confidence fast path)", () => {
    startClock();
    const { t, events } = makeTracker();
    dsp.score = 0.95;
    dsp.suspicious = true;
    feed(t, speechFrame(), 50); // 1.0s — ONE analysis window only
    expect(events.relay).toHaveLength(1);
    expect(events.end).toHaveLength(1);
    const snap = events.relay[0];
    expect(snap.relayWindows).toBe(1);
    expect(snap.relayConfidence).toBeCloseTo(0.95);
    expect(snap.endReason).toBe("relay");
    expect(snap.relayDecisionMs).toBe(1000);
  });

  it("relayDecisionMs is null when relay confirms before any speech was detected", () => {
    startClock();
    const { t, events } = makeTracker();
    dsp.score = 0.95;
    dsp.suspicious = true;
    feed(t, silenceFrame(), 50); // 1.0s of silence, but the (mocked) DSP says RED
    expect(events.relay).toHaveLength(1);
    expect(events.relay[0].relayDecisionMs).toBeNull();
    expect(events.relay[0].speechStartedAtMs).toBeNull();
    expect(events.relay[0].endReason).toBe("relay");
  });

  it("dispose() makes push a no-op without firing callbacks", () => {
    startClock();
    const { t, events } = makeTracker();
    feed(t, speechFrame(), 20);
    t.dispose();
    feed(t, speechFrame(), 100);
    feed(t, silenceFrame(), 100);
    expect(events.relay).toHaveLength(0);
    expect(events.end).toHaveLength(0);
    expect(t.snapshot().ended).toBe(false);
    expect(t.snapshot().voicedDurationMs).toBe(400);
  });
});

/* ===================================== tracker (REAL DSP timing) ======= */

/* Channel models mirrored from speakerphone-simulation.test.ts — see that
 * file for the physical justification of every stage. */

function loadWavPcm16(name: string): Float32Array {
  const buf = fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      const out = new Float32Array(size / 2);
      for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + size + (size & 1);
  }
  throw new Error(`fixture ${name}: no data chunk`);
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function biquad(type: "lowpass" | "highpass" | "peaking", f0: number, q: number, gainDb = 0) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / SR;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * q);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (type === "lowpass") { b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2; }
  else if (type === "highpass") { b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2; }
  else { b0 = 1 + alpha * A; b1 = -2 * cosw; b2 = 1 - alpha * A; }
  a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
function runBiquad(x: Float32Array, f: ReturnType<typeof biquad>): Float32Array {
  const out = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y0 = f.b0 * x[i] + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y0;
    out[i] = y0;
  }
  return out;
}

function telephone(x: Float32Array): Float32Array {
  let y = runBiquad(x, biquad("highpass", 300, 0.707));
  y = runBiquad(y, biquad("highpass", 300, 0.9));
  y = runBiquad(y, biquad("lowpass", 3400, 0.707));
  y = runBiquad(y, biquad("lowpass", 3400, 0.9));
  return y;
}

function rmsActive(x: Float32Array): number {
  let s = 0, n = 0;
  for (let i = 0; i < x.length; i++) {
    const a = x[i] * x[i];
    if (a > 1e-8) { s += a; n++; }
  }
  return n ? Math.sqrt(s / n) : 1e-6;
}

/** Direct handset: telephone channel + bed ≈60 dB under speech RMS. */
function direct(x: Float32Array, seed: number, bedRelDb = -60): Float32Array {
  const y = telephone(x);
  const rng = lcg(seed);
  const bed = Math.pow(10, bedRelDb / 20) * rmsActive(y);
  const out = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) out[i] = y[i] + (rng() * 2 - 1) * bed;
  return out;
}

/** Speakerphone relay double path (room reverb + band shaping + soft-clip +
 *  room bed + speakerphone AGC lifting the bed toward speech level). */
function relay(x: Float32Array, seed: number, bedRelDb = -14): Float32Array {
  const taps: [number, number][] = [
    [0.017, 0.5], [0.031, 0.48], [0.047, 0.44], [0.063, 0.4], [0.081, 0.36],
    [0.101, 0.33], [0.123, 0.3], [0.147, 0.27], [0.173, 0.24], [0.201, 0.21],
    [0.231, 0.19], [0.263, 0.17], [0.297, 0.15], [0.333, 0.13], [0.371, 0.11],
    [0.411, 0.09],
  ];
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let v = x[i];
    for (const [t, g] of taps) {
      const d = Math.floor(t * SR);
      if (i >= d) v += g * x[i - d];
    }
    y[i] = v;
  }
  let z = runBiquad(y, biquad("highpass", 350, 0.8));
  z = runBiquad(z, biquad("lowpass", 3200, 0.8));
  z = runBiquad(z, biquad("peaking", 1000, 2.5, -5));
  for (let i = 0; i < z.length; i++) z[i] = Math.tanh(1.4 * z[i]);
  const rng = lcg(seed);
  const bed = Math.pow(10, bedRelDb / 20) * rmsActive(z);
  for (let i = 0; i < z.length; i++) z[i] += (rng() * 2 - 1) * bed;
  const atk = Math.exp(-1 / (0.005 * SR));
  const rel = Math.exp(-1 / (0.15 * SR));
  let env = 1e-6;
  const envs = new Float32Array(z.length);
  for (let i = 0; i < z.length; i++) {
    const a = Math.abs(z[i]);
    env = a > env ? atk * env + (1 - atk) * a : rel * env + (1 - rel) * a;
    envs[i] = env;
  }
  const sorted = Float32Array.from(envs).sort();
  const ref = sorted[Math.floor(sorted.length * 0.9)] || 1e-6;
  const maxBoost = Math.pow(10, 26 / 20);
  let g = 1;
  for (let i = 0; i < z.length; i++) {
    const want = Math.min(maxBoost, ref / Math.max(envs[i], 1e-6));
    g = rel * g + (1 - rel) * want;
    z[i] *= g;
  }
  return telephone(z);
}

/** Stream float PCM through the tracker as 20ms μ-law frames on the fake clock. */
function feedPcm(t: VoiceIdTracker, pcm: Float32Array): void {
  const frame = new Array<number>(FRAME);
  for (let off = 0; off + FRAME <= pcm.length; off += FRAME) {
    now += 20;
    for (let i = 0; i < FRAME; i++) frame[i] = Math.round(pcm[off + i] * 32767);
    t.push(mulawPayload(frame));
  }
}

function concat(...parts: Float32Array[]): Float32Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe("VoiceIdTracker REAL-DSP relay timing (synthesized channels, real forensic pipeline)", () => {
  it("relay-colored speech is CONFIRMED — decision lands ≤ 2500ms after speech start", () => {
    dsp.mocked = false; // pass through to the real analyzeClip/compareClips/relayFingerprint
    startClock();
    const caller = loadWavPcm16("sim-caller-8k.wav");
    const relayed = relay(caller, 202);
    // ~6s of relay-colored speech, preceded by 0.5s and followed by 1s of
    // digital silence (the handset before/after the phrase).
    const lead = new Float32Array(SR / 2);
    const speech = relayed.subarray(0, 6 * SR);
    const tail = new Float32Array(SR);
    const { t, events } = makeTracker();
    feedPcm(t, concat(lead, speech, tail));

    expect(events.relay).toHaveLength(1);
    expect(events.end).toHaveLength(1);
    const snap = events.relay[0];
    expect(snap.relayConfirmed).toBe(true);
    expect(snap.endReason).toBe("relay");
    expect(snap.speechStartedAtMs).not.toBeNull();
    // Spec target: 0.8–1.5s after suspicious speech becomes available
    // (1s analysis window + 0.5s hop grid); the measured number is logged.
    console.log(
      `REAL-DSP RELAY DECISION: relayDecisionMs=${snap.relayDecisionMs}ms ` +
        `(speechStartOffset=${snap.speechStartedAtMs! - snap.attemptStartedAtMs}ms, ` +
        `confidence=${snap.relayConfidence.toFixed(2)}, windows=${snap.relayWindows}) — ${snap.relayEvidence}`,
    );
    expect(snap.relayDecisionMs).not.toBeNull();
    expect(snap.relayDecisionMs!).toBeLessThanOrEqual(2500);
  });

  it("direct (clean handset-like) speech is NOT confirmed as relay", () => {
    dsp.mocked = false;
    startClock();
    const callee = loadWavPcm16("sim-callee-8k.wav");
    const directPcm = direct(callee, 101);
    const lead = new Float32Array(SR / 2);
    const speech = directPcm.subarray(0, 10 * SR);
    const { t, events } = makeTracker();
    feedPcm(t, concat(lead, speech));

    expect(events.relay).toHaveLength(0);
    const snap = t.snapshot();
    expect(snap.relayConfirmed).toBe(false);
    expect(snap.relayWindows).toBe(0);
    // The direct attempt ends on its own (speech-end or max-duration), never on relay.
    expect(snap.endReason).not.toBe("relay");
    expect(snap.voicedDurationMs).toBeGreaterThan(1000);
    console.log(
      `REAL-DSP DIRECT CONTROL: endReason=${snap.endReason} voiced=${snap.voicedDurationMs}ms ` +
        `sections=${snap.sectionCount} relayConfidence=${snap.relayConfidence.toFixed(2)}`,
    );
  });
});
