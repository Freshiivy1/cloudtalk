/**
 * TEST-ONLY scripted callee for end-to-end guarded-call self-tests.
 *
 * Point a spare Twilio number's voice webhook at /api/test/callee-bot, then
 * run a guarded call to that number. The bot walks the callee flow blind:
 *   1. waits out the monitored prompt, "presses 1"  (RFC2833 via <Play digits>)
 *   2. speaks the voice-ID phrase into the engine's <Record>
 *   3. "presses #" to confirm
 *   4. RECORDS 25s of post-bridge conference audio (exactly what a real
 *      callee hears: caller audio + challenge-noise announces) and posts it
 *      to /api/test/callee-bot-record, which logs the RecordingUrl.
 *
 * These endpoints are test fixtures — no session state, no secrets.
 */
import type { Context } from "hono";
import twilio from "twilio";

export async function testCalleeBotHandler(c: Context) {
  const vr = new twilio.twiml.VoiceResponse();
  // 1) monitored prompt (~7s speech) then press 1 inside the gather window.
  vr.pause({ length: 8 });
  vr.play({ digits: "ww1" });
  // 2) voice-ID prompt + beep (~6s), then speak the phrase for the recording
  //    (engine <Record maxLength=8 timeout=3> ends ~3s after we stop).
  vr.pause({ length: 6 });
  vr.say("My name identifies me.");
  // 3) record ends + action webhook + # prompt (~4s) — then press #.
  vr.pause({ length: 6 });
  vr.play({ digits: "ww#" });
  // 4) bridged into the conference: capture what the callee actually hears.
  vr.record({
    maxLength: 25,
    timeout: 3,
    playBeep: false,
    action: "/api/test/callee-bot-record",
    method: "POST",
  });
  vr.hangup();
  return c.text(vr.toString(), 200, { "Content-Type": "text/xml" });
}

export async function testCalleeBotRecordHandler(c: Context) {
  const vr = new twilio.twiml.VoiceResponse();
  try {
    const body = await c.req.parseBody();
    console.log(
      `[test-bot] POST-BRIDGE RECORDING url=${body.RecordingUrl} duration=${body.RecordingDuration}s callSid=${body.CallSid}`,
    );
  } catch {
    /* ignore */
  }
  vr.say("Self test complete. Goodbye.");
  vr.hangup();
  return c.text(vr.toString(), 200, { "Content-Type": "text/xml" });
}
