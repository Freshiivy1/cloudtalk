/**
 * TEST-ONLY scripted callee for end-to-end guarded-call self-tests.
 *
 * Point a spare Twilio number's voice webhook at /api/test/callee-bot, then
 * run a guarded call to that number. The guarded flow expects the callee to
 * press 1, speak the explicit voice-ID phrase, then press 1 again for Leg B.
 * The bot:
 *   1. speaks "my voice identifies me" (~4-5s of speech) so the
 *      /api/verify/voiceprint webhook gets usable audio,
 *   2. RECORDS 25s of call audio (exactly what a real callee hears:
 *      caller audio + challenge-noise announces) and posts it to
 *      /api/test/callee-bot-record, which logs the RecordingUrl,
 *   3. hangs up.
 *
 * These endpoints are test fixtures — no session state, no secrets.
 */
import type { Context } from "hono";
import twilio from "twilio";

export async function testCalleeBotHandler(c: Context) {
  const vr = new twilio.twiml.VoiceResponse();
  // 1) speak right after answer — the explicit voice-ID <Record> needs usable
  //    speech; this phrase runs ~4-5s.
  vr.say("My voice identifies me. I am the automated test callee, speaking for the voice baseline.");
  // 2) capture what the callee actually hears in the bridged conference.
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
