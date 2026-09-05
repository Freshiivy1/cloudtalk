/**
 * CALLEE-ONLY ENFORCEMENT — the caller-activity arming gate, proven on real
 * DSP with known-constitution audio (same fixtures + channel models as the
 * speakerphone simulation, via sim-channel.ts).
 *
 * User directive (2026-09-05): "it's also detecting speakerphone for caller
 * when I'm only wanting it for callee". The Leg B detector physically hears
 * ONLY the callee's microphone; the caller's voice arrives there as
 * speakerphone echo (actionable) OR same-room/earpiece bleed (never the
 * callee's fault) — acoustically indistinguishable on that uplink alone, and
 * BOTH require the caller to be speaking. The suppressArming gate therefore
 * marks every suspicious window captured while the caller is active on Leg A
 * NEUTRAL: episodes can arm ONLY from audio captured while the caller is
 * silent — produced on the callee's side.
 *
 * What is asserted (the production contract):
 *   1. USER'S BUG: relay audio carrying the CALLER's voice while the caller
 *      is speaking (gate suppressing) NEVER arms — not once in ~19 s, even
 *      though the SAME audio arms in ≤2 s with the gate open (control, proven
 *      by the speakerphone-simulation scenario).
 *   2. GATE RELEASE: when the caller goes silent mid-relay, the SAME audio
 *      arms promptly — the gate suppresses, it does not blind.
 *   3. DETECTION PRESERVED: the CALLEE's own voice through the speakerphone
 *      relay (callee talking on speakerphone, caller silent — the gate open)
 *      still arms.
 *   4. NEUTRAL ≠ RESET: arming progress made before a caller-speech overlap
 *      survives it (the gate does not reset the streak), so a relay that
 *      starts just before the caller speaks still arms right after.
 *   5. Normal direct conversation with the gate wired never arms.
 *
 * Wall-clock functions (warm-up, refire throttle) are driven by a Date.now
 * mock slaved to stream time, so the simulation is exact to the millisecond.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeakerphoneDetector } from "./speakerphone-detector";
import { SIM_SAMPLE_RATE, loadWavPcm16, direct, relay } from "./sim-channel";

const SR = SIM_SAMPLE_RATE;

interface Emission {
  atMs: number;
  score: number;
  detail: string;
}

/**
 * EXACT production wiring (verification-stream.ts) plus the caller-activity
 * gate. `gateActiveAt(tMs)` models "the caller was speaking on Leg A within
 * the gate window at stream time tMs".
 */
function simulate(
  segments: { label: string; pcm: Float32Array }[],
  opts: { warmupMs?: number; gateActiveAt?: (tMs: number) => boolean } = {},
) {
  let now = 1_000_000;
  const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
  const emissions: Emission[] = [];
  const clears: { atMs: number; detail: string }[] = [];
  const gate = opts.gateActiveAt ?? (() => false);
  const d = new SpeakerphoneDetector({
    windowSec: 1,
    hopSec: 0.5,
    consecutiveWindows: 2,
    cleanWindowsToClear: 6,
    refireMs: 4_000,
    warmupMs: opts.warmupMs ?? 2_000,
    armOnlyWhenBridged: true,
    suppressArming: () => gate(now - 1_000_000),
    onSuspicious: (score, detail) => emissions.push({ atMs: now - 1_000_000, score, detail }),
    onClean: (detail) => clears.push({ atMs: now - 1_000_000, detail }),
  });
  expect(d.callerGateArmed).toBe(true);
  d.setBridged(true); // session enters BRIDGED at t=0 — warm-up starts
  const frame = 160; // 20 ms at 8 kHz
  let t = 0;
  for (const seg of segments) {
    for (let off = 0; off < seg.pcm.length; off += frame) {
      now = 1_000_000 + t;
      d.pushSamples(seg.pcm.subarray(off, Math.min(off + frame, seg.pcm.length)));
      t += 20;
    }
  }
  nowSpy.mockRestore();
  return { d, emissions, clears, totalMs: t };
}

afterEach(() => vi.restoreAllMocks());

describe("caller-activity arming gate (real DSP, known audio)", () => {
  // Prepared once for the whole file (deterministic channel models).
  const calleePcm = loadWavPcm16("sim-callee-8k.wav");
  const callerPcm = loadWavPcm16("sim-caller-8k.wav");
  const calleeDirect = direct(calleePcm, 101);
  const callerRelay = relay(callerPcm, 202); // caller's voice through a speakerphone relay = echo/bleed class
  const calleeRelay = relay(calleePcm, 404); // callee's own voice through a speakerphone relay

  it("USER'S BUG: caller-voice relay audio (echo/bleed class) while the caller is speaking NEVER arms", () => {
    // 8 s of normal callee conversation (baseline seeds), then the caller's
    // voice arriving relayed (speakerphone echo OR same-room bleed — same
    // acoustic class) with the gate suppressing throughout: the caller is
    // talking, so none of this audio is attributable to the callee.
    const lead = calleeDirect.subarray(0, 8 * SR);
    const relayLenS = Math.floor(callerRelay.length / SR);
    const { emissions, clears } = simulate(
      [
        { label: "normal", pcm: lead },
        { label: "caller-relay", pcm: callerRelay.subarray(0, relayLenS * SR) },
      ],
      { gateActiveAt: () => true }, // caller speaking the whole time
    );
    expect(emissions).toHaveLength(0);
    expect(clears).toHaveLength(0);
  });

  it("CONTROL: the identical audio with the gate open arms in ≤2s (the gate — not the audio — makes the difference)", () => {
    const lead = calleeDirect.subarray(0, 8 * SR);
    const relayLenS = Math.floor(callerRelay.length / SR);
    const { emissions } = simulate(
      [
        { label: "normal", pcm: lead },
        { label: "caller-relay", pcm: callerRelay.subarray(0, relayLenS * SR) },
      ],
      { gateActiveAt: () => false }, // caller silent — audio is callee-attributable
    );
    expect(emissions.length).toBeGreaterThan(0);
    expect(emissions[0].atMs - 8_000).toBeLessThanOrEqual(2_000);
  });

  it("GATE RELEASE: caller goes silent mid-relay → the SAME relay audio arms promptly after release", () => {
    const lead = calleeDirect.subarray(0, 8 * SR);
    const relayLenS = Math.floor(callerRelay.length / SR);
    const callerSilentAtMs = 8_000 + 6_000; // caller stops talking 6 s into the relay
    const { emissions } = simulate(
      [
        { label: "normal", pcm: lead },
        { label: "caller-relay", pcm: callerRelay.subarray(0, relayLenS * SR) },
      ],
      { gateActiveAt: (t) => t < callerSilentAtMs },
    );
    expect(emissions.length).toBeGreaterThan(0);
    const first = emissions[0];
    console.log(
      `RELEASE: caller silent t=${callerSilentAtMs}ms, first emission t=${first.atMs}ms ` +
        `(+${first.atMs - callerSilentAtMs}ms after release)`,
    );
    // No arming while the gate was suppressing (beyond a one-window edge:
    // the gate window in production covers the trailing 1 s analysis span;
    // here the release is instantaneous, so allow the first post-release
    // window pair to complete).
    expect(first.atMs).toBeGreaterThanOrEqual(callerSilentAtMs);
    expect(first.atMs - callerSilentAtMs).toBeLessThanOrEqual(2_000);
  });

  it("DETECTION PRESERVED: the CALLEE's own voice through the speakerphone relay (caller silent) still arms", () => {
    // Callee talking while on speakerphone: the far-field audio IS the
    // callee's own voice — exactly the audio the user wants enforced. The
    // gate is open (caller silent), so this must arm. Measured on this clip:
    // 10/36 hops clear the full arming bar with 2 onset pairs (female voice
    // scores lower on the relay fingerprint than the male caller fixture).
    const lead = calleeDirect.subarray(0, 8 * SR);
    const relayLenS = Math.floor(calleeRelay.length / SR);
    const { emissions } = simulate(
      [
        { label: "normal", pcm: lead },
        { label: "callee-relay", pcm: calleeRelay.subarray(0, relayLenS * SR) },
      ],
      { gateActiveAt: () => false },
    );
    expect(emissions.length).toBeGreaterThan(0);
    const first = emissions[0];
    console.log(
      `CALLEE-RELAY: onset t=8000ms, first emission t=${first.atMs}ms (+${first.atMs - 8_000}ms) ` +
        `— ${emissions.length} emissions over ${relayLenS}s`,
    );
  });

  it("MID-EPISODE: caller speech during an armed episode suppresses refires but NEVER clears the episode", () => {
    // Relay starts with the gate open → episode arms. The caller then speaks
    // for 8 s over the still-active relay (gate suppressing): gated windows
    // must NOT refire (no emissions) and must NOT clear the episode (they
    // are still relay-like). When the caller goes silent the refires resume.
    const lead = calleeDirect.subarray(0, 8 * SR);
    const relayLenS = Math.floor(callerRelay.length / SR);
    const overlapStart = 14_000; // caller speaks 6 s into the relay…
    const overlapEnd = 22_000; // …for 8 s, relay still running
    const { emissions, clears } = simulate(
      [
        { label: "normal", pcm: lead },
        { label: "caller-relay", pcm: callerRelay.subarray(0, relayLenS * SR) },
      ],
      { gateActiveAt: (t) => t >= overlapStart && t < overlapEnd },
    );
    // Episode armed before the overlap.
    const pre = emissions.filter((e) => e.atMs < overlapStart);
    expect(pre.length).toBeGreaterThan(0);
    // No refires while the caller speaks (the suspicious audio may now be
    // the caller's own voice — never actionable against the callee)…
    const during = emissions.filter((e) => e.atMs >= overlapStart && e.atMs < overlapEnd);
    expect(during).toHaveLength(0);
    // …and the episode NEVER clears across gated windows (relay audio is
    // still relay-like; the suspicion survives the overlap)…
    expect(clears.filter((c) => c.atMs < overlapEnd)).toHaveLength(0);
    // …then refires resume once the caller goes silent.
    const post = emissions.filter((e) => e.atMs >= overlapEnd);
    expect(post.length).toBeGreaterThan(0);
    console.log(
      `MID-EPISODE: armed t=${pre[0].atMs}ms, ${pre.length} pre-overlap emissions, ` +
        `0 during [${overlapStart}, ${overlapEnd}), resumed t=${post[0].atMs}ms`,
    );
  });

  it("FALSE-POSITIVE GUARD: normal direct conversation with the gate wired never arms", () => {
    const { emissions, clears } = simulate([{ label: "normal", pcm: calleeDirect }]);
    expect(emissions).toHaveLength(0);
    expect(clears).toHaveLength(0);
  });
});
