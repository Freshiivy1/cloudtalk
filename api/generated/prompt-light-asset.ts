/**
 * GENERATED ASSET MODULE — Phase 1 (prompt-light) challenge asset metadata.
 *
 * Measured from the rendered WAV `public/call-waiting-prompt-light.wav`
 * (8 kHz mono PCM16): 170,880 frames = exactly 21.360 s. The speech prompt is
 * mixed with the existing merge-tone pair (852 Hz + 1336 Hz, DTMF-8)
 * attenuated 21 dB below prompt RMS; mixed peak 0.854 (no clipping).
 *
 * Do NOT edit by hand — regenerate from the WAV when the asset changes.
 * Source metadata: call-waiting-prompt-light.json (pcmSha256 below).
 */
export const PROMPT_LIGHT_WAV_FILE = "call-waiting-prompt-light.wav";

/** Exact measured duration of the Phase 1 asset, milliseconds. */
export const PROMPT_LIGHT_DURATION_MS = 21_360;

/** Exact measured duration of the Phase 1 asset, seconds (21.36). */
export const PROMPT_LIGHT_DURATION_SEC = 21.36;

export const PROMPT_LIGHT_SAMPLE_RATE = 8_000;
export const PROMPT_LIGHT_CHANNELS = 1;
export const PROMPT_LIGHT_FRAMES = 170_880;

/** SHA-256 of the PCM payload (asset provenance / drift detection). */
export const PROMPT_LIGHT_PCM_SHA256 =
  "3c494619ddd8396688cbe480c9ccd839a76b12eb84c3ce193d1f7bdd7ddab9c6";

/** Light watermark: existing merge-tone pair (DTMF-8), 21 dB below prompt RMS. */
export const PROMPT_LIGHT_TONE_LOW_HZ = 852;
export const PROMPT_LIGHT_TONE_HIGH_HZ = 1336;
export const PROMPT_LIGHT_WATERMARK_DB_BELOW_PROMPT = 21;

/** Spoken prompt text rendered into the asset. */
export const PROMPT_LIGHT_TEXT =
  "You are still on the first verification call. A second verification call " +
  "should now be arriving. Please answer the second call to continue. Once " +
  "connected, stay on the second call and do not merge the calls. If the " +
  "second call never arrives, your Call Waiting is switched off. Please turn " +
  "on Call Waiting in your phone settings, then try again.";
