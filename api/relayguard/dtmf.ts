/**
 * Merge-tone DTMF WAV renderer (BRIDGED in-call merge detection).
 *
 * Pre-bridge, Leg A loops the continuous DTMF-'9' tone (852+1336 Hz) so a
 * callee-side 3-way merge leaks it into Leg B's detectors. That tone STOPS at
 * the bridge — so once the session is BRIDGED the MergeToneDetector on Leg
 * A's uplink has nothing to hear. This module renders short probe bursts of
 * the exact same dual tone: the engine announces one burst every probe
 * interval to the Leg A conference participant only; if the callee has merged
 * the call into a conference, the burst echoes back up Leg A's own uplink
 * stream and the existing Goertzel detector fires inside a known guard
 * window (a measured echo), distinguishing a real mid-call merge from any
 * stray in-call audio that happens to contain the tone pair.
 *
 * 8 kHz mono 16-bit PCM WAV — the format Twilio accepts for <Play> and
 * conference participant announcements (announceUrl). Renders are cached.
 */
import { encodeWavPcm16 } from "./noise";

/** DTMF '9' row/column frequencies (must match MergeToneDetector). */
export const MERGE_TONE_LOW_HZ = 852;
export const MERGE_TONE_HIGH_HZ = 1336;

/** Per-component amplitude (sum peaks at 0.6 — no clipping). */
const COMPONENT_AMPLITUDE = 0.3;

const cache = new Map<string, Buffer>();

/**
 * Continuous dual-tone 852+1336 Hz (DTMF '9') as a 16-bit PCM WAV buffer.
 * Short raised-cosine fades at the edges avoid the playback click a hard
 * on/off gate would produce; the body is a steady-state tone so the Goertzel
 * detector's ~300 ms streak requirement is met well inside 1.2 s.
 */
export function mergeToneWav(durationSec = 1.2, sampleRate = 8000): Buffer {
  const key = `${durationSec}:${sampleRate}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const n = Math.max(1, Math.round(durationSec * sampleRate));
  const samples = new Float32Array(n);
  const wLow = (2 * Math.PI * MERGE_TONE_LOW_HZ) / sampleRate;
  const wHigh = (2 * Math.PI * MERGE_TONE_HIGH_HZ) / sampleRate;
  const fade = Math.min(Math.round(0.005 * sampleRate), Math.floor(n / 2)); // 5 ms
  for (let i = 0; i < n; i++) {
    let env = 1;
    if (i < fade) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    else if (i >= n - fade) env = 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / fade);
    samples[i] =
      env *
      (COMPONENT_AMPLITUDE * Math.sin(wLow * i) +
        COMPONENT_AMPLITUDE * Math.sin(wHigh * i));
  }
  const wav = encodeWavPcm16(samples, sampleRate);
  cache.set(key, wav);
  return wav;
}
