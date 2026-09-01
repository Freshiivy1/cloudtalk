/**
 * CallVerify port — merge detection via short <Record> chunks + Goertzel DSP.
 *
 * Why: the hosting platform blocks WebSocket upgrades (Twilio Media Streams
 * fail with error 31920), and <Gather> only hears RFC2833 signaling, never
 * in-band audio tones (proven live). So instead of a live stream, Leg B runs
 * a tight loop of 1-second <Record> chunks; each chunk's recording webhook
 * fetches the WAV from Twilio and scans it for the continuous DTMF-'9' merge
 * tone (852+1336 Hz) with the same Goertzel core as the stream detector.
 * Detection latency ≈ chunk length + processing ≈ 2–3 s after a merge starts.
 */
import type { Context } from "hono";
import { goertzelPower, windowEnergy } from "./verification-stream";
import * as vs from "./verification";
import { getTwilioClient } from "./twilio-voice";
import { authenticateRequest } from "./kimi/auth";
import { isAuthDisabled } from "./local-auth";

/* -------------------------------------------------------------------------- */
/* WAV + tone analysis (pure, unit-tested)                                      */
/* -------------------------------------------------------------------------- */

/** Extract 16-bit mono PCM samples from a RIFF/WAV buffer (any data chunk offset). */
export function wavToPcm16(buf: Buffer): Int16Array {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("not a RIFF wav");
  }
  let off = 12; // skip RIFF header
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      const start = off + 8;
      const n = Math.floor(Math.min(size, buf.length - start) / 2);
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(start + i * 2);
      return out;
    }
    off += 8 + size + (size % 2); // chunks are word-aligned
  }
  throw new Error("no data chunk");
}

const WIN = 400; // 50 ms @ 8 kHz
const TONE_RATIO = 0.05; // matches MergeToneDetector defaults
const ENERGY_FLOOR = 1e6;
const NEED_WINDOWS = 6; // 300 ms continuous

/**
 * Scan PCM audio for the continuous merge tone. Returns the detection offset
 * in ms, or -1 if not present. Same thresholds as the stream detector.
 */
export function detectMergeToneMs(pcm: Int16Array, sampleRate = 8000): number {
  let streak = 0;
  for (let off = 0; off + WIN <= pcm.length; off += WIN) {
    const window = pcm.subarray(off, off + WIN);
    const e = windowEnergy(window);
    const norm = e * WIN * WIN;
    const hit =
      e > ENERGY_FLOOR &&
      goertzelPower(window, 852) / norm > TONE_RATIO &&
      goertzelPower(window, 1336) / norm > TONE_RATIO;
    streak = hit ? streak + 1 : 0;
    if (streak >= NEED_WINDOWS) {
      return ((off + WIN) / sampleRate) * 1000; // end of the detecting streak
    }
  }
  return -1;
}

/* -------------------------------------------------------------------------- */
/* Recording status callback                                                    */
/* -------------------------------------------------------------------------- */

/** POST /api/verify/recording/merge?sid=… — Twilio sends this per chunk. */
export async function verificationRecordingHandler(c: Context) {
  try {
    const sid = c.req.query("sid") ?? "";
    const body = await c.req.parseBody();
    const recordingUrl = String(body.RecordingUrl ?? "");
    if (!sid || !recordingUrl) return c.text("ok", 200);

    const session = await vs.findSession(sid);
    if (!session || vs.isTerminal(session)) return c.text("ok", 200);

    const atMs = await analyzeRecording(recordingUrl);
    if (atMs >= 0) {
      console.log(`[verify-record] MERGE TONE in chunk sid=${sid} at ${atMs}ms`);
      await vs.logEvent(
        sid,
        "MERGE_RECORD_DETECTED",
        `Goertzel fired on Leg B recording chunk (tone at ${Math.round(atMs)}ms into chunk)`,
      );
      await vs.onMergeDetected(sid); // caller verdict + hangup Leg A + ring test
      // Break Leg B out of the record loop → verdict announcement + hangup.
      if (session.legBCallSid) {
        await getTwilioClient().calls(session.legBCallSid).update({
          method: "POST",
          url: vs.twimlUrl("notify-merge", sid),
        });
      }
    }
  } catch (err) {
    console.error("[verify-record] handler error:", err);
  }
  return c.text("ok", 200); // Twilio must always get 200
}

/* -------------------------------------------------------------------------- */
/* Call review — bridge recording callback + authenticated playback proxy       */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/verify/recording/bridge?sid=… — Twilio posts the finished
 * guarded-bridge conference recording here when the live call ends
 * (record-from-start on the guarded-bridge Conference noun).
 */
export async function verificationBridgeRecordingHandler(c: Context) {
  try {
    const sid = c.req.query("sid") ?? "";
    const body = await c.req.parseBody();
    const recordingSid = String(body.RecordingSid ?? "");
    const recordingUrl = String(body.RecordingUrl ?? "");
    const durationSec = Number(body.RecordingDuration ?? 0);
    if (sid && recordingUrl) {
      await vs.storeBridgeRecording(sid, { recordingSid, recordingUrl, durationSec });
    }
  } catch (err) {
    console.error("[verify-record] bridge recording handler error:", err);
  }
  return c.text("ok", 200); // Twilio must always get 200
}

/**
 * GET /api/verify/recording/:sid/:kind — authenticated playback proxy for
 * call review (kind = "voice" | "bridge"). Twilio recording media requires
 * account basic-auth the browser does not have, so this streams the MP3
 * through under the app's own session cookie. Admin-only, matching the
 * verification tRPC router; open-access mode (AUTH_DISABLED) passes through.
 */
export async function verificationRecordingAudioHandler(c: Context) {
  if (!isAuthDisabled()) {
    const user = await authenticateRequest(c.req.raw.headers).catch(() => undefined);
    if (!user || user.role !== "admin") return c.text("forbidden", 403);
  }
  const sid = c.req.param("sid") ?? "";
  const kind = c.req.param("kind") ?? "";
  const session = sid ? await vs.findSession(sid).catch(() => null) : null;
  const url =
    kind === "voice"
      ? session?.voiceRecordingUrl
      : kind === "bridge"
        ? session?.bridgeRecordingUrl
        : null;
  if (!url) return c.text("not found", 404);

  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
  const auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
  try {
    const res = await fetch(`${url}.mp3`, { headers: { Authorization: auth } });
    if (!res.ok || !res.body) return c.text("recording unavailable", 502);
    const headers: Record<string, string> = {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "private, max-age=3600",
    };
    const len = res.headers.get("content-length");
    if (len) headers["Content-Length"] = len;
    return new Response(res.body, { status: 200, headers });
  } catch (err) {
    console.error("[verify-record] audio proxy error:", err);
    return c.text("recording unavailable", 502);
  }
}

/** Download a Twilio recording as WAV and scan it for the merge tone. */
async function analyzeRecording(recordingUrl: string): Promise<number> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
  const auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
  // Twilio sometimes lags making media available after the callback — retry
  // briefly instead of discarding the chunk (a missed chunk = +1s latency).
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${recordingUrl}.wav`, {
        headers: { Authorization: auth },
      });
      if (!res.ok) throw new Error(`recording fetch failed: ${res.status}`);
      const pcm = wavToPcm16(Buffer.from(await res.arrayBuffer()));
      return detectMergeToneMs(pcm);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastErr;
}
