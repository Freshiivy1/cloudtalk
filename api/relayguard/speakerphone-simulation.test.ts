/**
 * END-TO-END SPEAKERPHONE-RELAY SIMULATION — real DSP, no mocks of the
 * forensic pipeline. Known-constitution audio:
 *
 *   fixtures/sim-callee-8k.wav  — real TTS speech (female voice), the CALLEE
 *   fixtures/sim-caller-8k.wav  — real TTS speech (male voice), the CALLER
 *
 * Channel models (deterministic, seeded):
 *   direct() — the normal path: 300–3400 Hz telephone bandpass + a bed crushed
 *              ≈60 dB under speech (field anchor: direct bed → −67 dBFS).
 *   relay()  — speakerphone relay double path: dense FIR room reverb
 *              (20 taps to 411 ms), speaker/mic band shaping, soft-clip
 *              nonlinearity, a room bed, then a speakerphone-style AGC that
 *              lifts quiet parts up to +26 dB toward speech level (the
 *              physical origin of the ≈8.5 dB speech-to-bed drowning anchor),
 *              then the relaying phone's own telephone channel.
 *
 * What is asserted (the production contract the user demanded):
 *   1. Relay onset is picked up within 2.0 s (first onSuspicious emission).
 *   2. While relay audio continues (≈19 s), the episode NEVER clears and
 *      emissions keep firing (~every 4 s refire) — the challenge noise would
 *      keep looping the whole time.
 *   3. When normal audio returns, the episode clears only after 6 consecutive
 *      fingerprint-clean hops (absolute relay fingerprint < 0.5 — ≈3 s of
 *      confirmed-normal audio), never on a borderline hop, and never mid-relay
 *      (sustained relay never dips below ≈0.55 in this simulation).
 *   4. The rolling baseline is frozen for the entire episode (relayed audio
 *      can never become the "normal" reference).
 *   5. False-positive guard: long runs of pure direct audio — the callee's
 *      own voice AND a different voice on a direct channel — never arm.
 *
 * Wall-clock functions (warm-up, refire throttle) are driven by a Date.now
 * mock slaved to stream time, so the simulation is exact to the millisecond.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeakerphoneDetector } from "./speakerphone-detector";
import { analyzeClip, type ClipProfile } from "./features";
import { compareClips, relayFingerprint } from "./compare";
import {
  SIM_SAMPLE_RATE,
  loadWavPcm16,
  direct,
  relay,
  peakNorm,
} from "./sim-channel";

const SR = SIM_SAMPLE_RATE;

interface Emission {
  atMs: number;
  score: number;
  detail: string;
}

/**
 * Stream the given segments through a production-configured detector,
 * slaving Date.now() to stream time. Segments are concatenated; each is
 * pushed in 20 ms frames exactly like Twilio media messages.
 */
function simulate(
  segments: { label: string; pcm: Float32Array }[],
  opts: { warmupMs?: number; relayOnsetMs?: number } = {},
) {
  let now = 1_000_000;
  const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
  const emissions: Emission[] = [];
  const clears: { atMs: number; detail: string }[] = [];
  // EXACT production wiring (verification-stream.ts): 1s window, 0.5s hop,
  // 2-hop arming, 6-hop strongly-clean clearing, 2s warm-up, bridged-only.
  const d = new SpeakerphoneDetector({
    windowSec: 1,
    hopSec: 0.5,
    consecutiveWindows: 2,
    cleanWindowsToClear: 6,
    refireMs: 4_000,
    warmupMs: opts.warmupMs ?? 2_000,
    armOnlyWhenBridged: true,
    onSuspicious: (score, detail) => emissions.push({ atMs: now - 1_000_000, score, detail }),
    onClean: (detail) => clears.push({ atMs: now - 1_000_000, detail }),
  });
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

/* --------------------------------------------------------------- tests -- */

describe("speakerphone-relay simulation (real DSP, known audio)", () => {
  // Prepared once for the whole file (deterministic channel models).
  const calleePcm = loadWavPcm16("sim-callee-8k.wav");
  const callerPcm = loadWavPcm16("sim-caller-8k.wav");
  const calleeDirect = direct(calleePcm, 101);
  const callerRelay = relay(callerPcm, 202);
  const callerDirect = direct(callerPcm, 303);

  it("calibration: relay windows are SUSPICIOUS+RED, direct windows MATCH and not RED", () => {
    // Baseline = the callee's direct voice, seeded exactly like the detector
    // does: the first window with a real turn-exchange (≥2 VAD bursts).
    let baseline: ClipProfile | null = null;
    for (let w = 0; w < 8 && !baseline; w++) {
      const p = analyzeClip(peakNorm(calleeDirect.subarray(w * SR, (w + 1) * SR)), SR);
      if (p.vad.speechFrames.length > 0 && p.vad.burstCount >= 2) baseline = p;
    }
    expect(baseline).not.toBeNull();

    // Relay: the detector runs on a 0.5 s hop grid, so calibrate on that
    // grid — within the first 2 s of relay audio (the pickup budget) there
    // must be TWO CONSECUTIVE hops that each clear the full arming bar
    // (SUSPICIOUS verdict AND RED fingerprint), i.e. the arming streak can
    // complete inside the budget. Individual onset hops may read AMBER
    // (TTS onset pause → deep measured gaps) — what matters is the streak.
    const hopBar: boolean[] = [];
    for (let h = 0; h < 4; h++) {
      const p = analyzeClip(peakNorm(callerRelay.subarray(h * (SR / 2), h * (SR / 2) + SR)), SR);
      const fp = relayFingerprint(p);
      const cmp = compareClips(baseline!, p, "poor");
      hopBar.push(cmp.verdict === "SUSPICIOUS RELAY" && fp.state === "RED");
    }
    const hasConsecutivePair = hopBar.some((ok, i) => ok && hopBar[i + 1]);
    expect(hopBar.filter(Boolean).length).toBeGreaterThanOrEqual(2);
    expect(hasConsecutivePair).toBe(true);
    // Direct callee voice vs its own baseline: the FULL ARMING BAR
    // (SUSPICIOUS verdict AND RED fingerprint together) must never clear.
    // A bare SUSPICIOUS verdict is possible on atypical content windows —
    // same-voice 1 s windows differ in thinness by up to ~0.4 from phoneme
    // content alone, past the 0.08 channel-vote margin — so the absolute RED
    // fingerprint is the guard that makes a stray verdict harmless. The
    // end-to-end false-positive guards below prove that guard over 37 s of
    // continuous direct audio.
    for (const w of [1, 2, 3, 4]) {
      const p = analyzeClip(peakNorm(calleeDirect.subarray(w * SR, (w + 1) * SR)), SR);
      const fp = relayFingerprint(p);
      const cmp = compareClips(baseline!, p, "poor");
      expect(fp.state).not.toBe("RED");
      expect(cmp.verdict === "SUSPICIOUS RELAY" && fp.state === "RED").toBe(false);
    }
  });

  it("SCENARIO: relay starts mid-call → picked up ≤2s, challenge sustains the whole relay, clears only on real normal audio", () => {
    const NORMAL_LEAD_S = 8;
    const lead = calleeDirect.subarray(0, NORMAL_LEAD_S * SR);
    const relayLenS = Math.floor(callerRelay.length / SR);
    const normalTailS = 10;
    const tail = calleeDirect.subarray(0, normalTailS * SR);

    const { emissions, clears } = simulate([
      { label: "normal", pcm: lead },
      { label: "relay", pcm: callerRelay.subarray(0, relayLenS * SR) },
      { label: "normal-again", pcm: tail },
    ]);

    const relayOnsetMs = NORMAL_LEAD_S * 1_000;
    const relayEndMs = relayOnsetMs + relayLenS * 1_000;

    // 1) PICKUP: first emission within 2.0 s of relay onset (and not before
    //    0.9 s — one full 1 s window must complete first).
    expect(emissions.length).toBeGreaterThan(0);
    const first = emissions[0];
    console.log(
      `PICKUP: relay onset t=${relayOnsetMs}ms, first emission t=${first.atMs}ms ` +
        `(+${first.atMs - relayOnsetMs}ms) score=${first.score.toFixed(2)}`,
    );
    expect(first.atMs - relayOnsetMs).toBeLessThanOrEqual(2_000);
    expect(first.atMs - relayOnsetMs).toBeGreaterThanOrEqual(900);

    // 2) SUSTAIN: zero clears while the relay is playing, and emissions keep
    //    firing for the whole episode (challenge noise would loop ~4s each).
    expect(clears.filter((c) => c.atMs < relayEndMs)).toHaveLength(0);
    const duringRelay = emissions.filter((e) => e.atMs < relayEndMs);
    const minExpected = Math.floor((relayLenS * 1_000 - 2_000) / 4_000);
    console.log(
      `SUSTAIN: ${duringRelay.length} emissions over ${relayLenS}s of relay ` +
        `(expected ≥ ${minExpected}); scores=${duringRelay.map((e) => e.score.toFixed(2)).join(",")}`,
    );
    expect(duringRelay.length).toBeGreaterThanOrEqual(minExpected);

    // 3) CLEAR: only after normal audio resumes — never before 2s of it
    //    (6 consecutive fingerprint-clean hops ≈ 2.5–3s), and exactly once.
    expect(clears).toHaveLength(1);
    const clear = clears[0];
    console.log(
      `CLEAR: normal resumed t=${relayEndMs}ms, cleared t=${clear.atMs}ms ` +
        `(+${clear.atMs - relayEndMs}ms) — ${clear.detail}`,
    );
    expect(clear.atMs - relayEndMs).toBeGreaterThanOrEqual(2_000);
    expect(clear.atMs - relayEndMs).toBeLessThanOrEqual(8_000);

    // 4) No more emissions after the clear (noise stopped for real).
    expect(emissions.filter((e) => e.atMs > clear.atMs)).toHaveLength(0);
  });

  it("FALSE-POSITIVE GUARD: 18s of normal direct conversation (callee voice) never arms", () => {
    const { emissions, clears } = simulate([{ label: "normal", pcm: calleeDirect }]);
    expect(emissions).toHaveLength(0);
    expect(clears).toHaveLength(0);
  });

  it("FALSE-POSITIVE GUARD: a DIFFERENT voice on a direct channel (no relay) never arms", () => {
    // The control that exposed the channel-vote voice/thinness confusion:
    // verdict may go SUSPICIOUS on some windows, but the fingerprint must
    // stay below RED on every hop — so nothing can ever arm.
    const { emissions } = simulate([{ label: "direct-caller", pcm: callerDirect }]);
    expect(emissions).toHaveLength(0);
  });

  it("SCENARIO: relay ALREADY playing at bridge → NO_BASELINE absolute arming fires, episode clears on real normal audio, baseline seeds after", () => {
    // 2026-09-04 live incident regression: the relay was running when the
    // bridge landed, so the rolling baseline seeded from relayed audio and
    // every later relay window compared MATCH — the detector stayed silent
    // forever. The fix: GREEN-fingerprint-gated seeding (relay audio can
    // never become the reference) + absolute arming on `need` consecutive
    // RED hops while no baseline exists.
    const RELAY_S = 6;
    const NORMAL_TAIL_S = 10;
    const { d, emissions, clears } = simulate([
      { label: "relay-from-bridge", pcm: callerRelay.subarray(0, RELAY_S * SR) },
      { label: "normal", pcm: calleeDirect.subarray(0, NORMAL_TAIL_S * SR) },
    ]);

    // 1) The relay audio must NEVER have seeded the baseline before arming:
    //    the first emission carries the NO_BASELINE absolute-arming marker.
    expect(emissions.length).toBeGreaterThan(0);
    const first = emissions[0];
    console.log(
      `NO_BASELINE PICKUP: first emission t=${first.atMs}ms score=${first.score.toFixed(2)} — ${first.detail}`,
    );
    expect(first.detail).toContain("NO_BASELINE absolute arming");
    // Warm-up is 2 s; the fixture's opening seconds score borderline AMBER
    // (they neither advance nor reset the RED streak), then 2 RED hops arm —
    // measured at ≈5.5 s from the bridge (≈3 s after warm-up ends).
    expect(first.atMs).toBeGreaterThanOrEqual(2_000);
    expect(first.atMs).toBeLessThanOrEqual(6_500);

    // 2) Zero clears while the relay keeps playing.
    const relayEndMs = RELAY_S * 1_000;
    expect(clears.filter((c) => c.atMs < relayEndMs)).toHaveLength(0);

    // 3) When normal audio resumes, the episode clears exactly once on the
    //    6-hop fingerprint-clean streak (~3 s of confirmed-normal audio).
    expect(clears).toHaveLength(1);
    const clear = clears[0];
    console.log(
      `NO_BASELINE CLEAR: normal resumed t=${relayEndMs}ms, cleared t=${clear.atMs}ms ` +
        `(+${clear.atMs - relayEndMs}ms) — ${clear.detail}`,
    );
    expect(clear.detail).toContain("NO_BASELINE episode");
    expect(clear.atMs - relayEndMs).toBeGreaterThanOrEqual(2_000);
    expect(clear.atMs - relayEndMs).toBeLessThanOrEqual(8_000);

    // 4) After the clear, a GREEN direct window finally seeds the baseline —
    //    the detector transitions from absolute to relative supervision.
    expect(d.baselineAbsorptions).toBeGreaterThan(0);

    // 5) No more emissions after the clear.
    expect(emissions.filter((e) => e.atMs > clear.atMs)).toHaveLength(0);
  });

  it("SCENARIO: own 852+1336Hz probe leaking into Leg B never arms and never seeds — a genuine relay right after is still picked up ≤2s", () => {
    // 2026-09-04 retest regression: the canary's loud-tone loop leaked from
    // the held line into Leg B's mic and false-armed the detector 6s after
    // the bridge (RED 0.68), and the merge-tone beep echo (same pair) then
    // sustained false episodes all call. The probe-tone mask must make those
    // windows NEUTRAL — and must not blunt real relay detection.
    const tone = new Float32Array(5 * SR);
    for (let i = 0; i < tone.length; i++) {
      tone[i] =
        0.3 * Math.sin((2 * Math.PI * 852 * i) / SR) +
        0.3 * Math.sin((2 * Math.PI * 1336 * i) / SR);
    }
    const NORMAL_S = 8;
    const RELAY_S = 6;
    const TAIL_S = 10;
    const { d, emissions, clears } = simulate([
      { label: "probe-tone-leak", pcm: tone },
      { label: "normal", pcm: calleeDirect.subarray(0, NORMAL_S * SR) },
      { label: "relay", pcm: callerRelay.subarray(0, RELAY_S * SR) },
      { label: "normal-again", pcm: calleeDirect.subarray(0, TAIL_S * SR) },
    ]);

    const relayOnsetMs = (5 + NORMAL_S) * 1_000;
    const relayEndMs = relayOnsetMs + RELAY_S * 1_000;

    // 1) Zero emissions during the probe-tone leak AND the normal lead-in.
    expect(emissions.filter((e) => e.atMs < relayOnsetMs)).toHaveLength(0);

    // 2) The genuine relay still arms within 2s — via the BASELINE path,
    //    which proves the tone never poisoned/blocked baseline seeding.
    expect(emissions.length).toBeGreaterThan(0);
    const first = emissions[0];
    console.log(
      `MASK+PICKUP: relay onset t=${relayOnsetMs}ms, first emission t=${first.atMs}ms ` +
        `(+${first.atMs - relayOnsetMs}ms) — ${first.detail}`,
    );
    expect(first.atMs - relayOnsetMs).toBeLessThanOrEqual(2_000);
    expect(first.detail).toContain("verdict=SUSPICIOUS RELAY");
    expect(d.baselineAbsorptions).toBeGreaterThan(0);

    // 3) Episode clears exactly once on the real normal tail.
    expect(clears).toHaveLength(1);
    expect(clears[0].atMs - relayEndMs).toBeGreaterThanOrEqual(2_000);
    expect(clears[0].atMs - relayEndMs).toBeLessThanOrEqual(8_000);
  });

});
