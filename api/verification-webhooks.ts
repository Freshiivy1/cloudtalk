/**
 * CallVerify port — Twilio webhook handlers (Hono).
 *
 * Mounted in api/boot.ts BEFORE the tRPC handler, following the existing
 * /api/voice/* pattern. Twilio posts application/x-www-form-urlencoded; we
 * parse with c.req.parseBody() exactly like statusCallbackHandler.
 *
 * Routes:
 *   POST /api/verify/twiml/:kind?sid=…         → TwiML documents
 *   POST /api/verify/status/:leg?sid=…         → status callbacks drive the FSM
 *   POST /api/verify/gather/merge?sid=…        → Leg B <Gather> result
 *   POST /api/verify/gather/leg-a-accept?sid=… → Leg A IVR step 1 (press 1 to accept)
 *   POST /api/verify/gather/leg-a-ready?sid=…  → Leg A IVR step 2 (press 1 when ready)
 *
 * Leg A callee IVR (CALL-FLOW.md Phase 2): the callee answers and hears
 * "Press 1 to accept" (DTMF during playback allowed) → CALL_ACCEPTED, then
 * "Press 1 when ready to proceed" → CALLEE_READY, then Leg A holds (long
 * <Pause> self-redirect loop) while Leg B + the ring test are originated.
 * Each step re-prompts on timeout/wrong digit; after LEG_A_MAX_ATTEMPTS the
 * callee is treated as rejecting the call → FAILED.
 *
 * These handlers are best-effort: Twilio must always get a 200 back, so all
 * state-machine errors are caught and logged (same contract as the existing
 * voice status callback).
 */
import twilio from "twilio";
import type { Context } from "hono";
import fs from "fs";
import path from "path";
import * as vs from "./verification";
import { relayStreamUrl } from "./verification-stream";

/**
 * GET /api/verify/tone.wav — serves the in-band DTMF verification tone with a
 * proper audio/wav Content-Type. The generic static server returns
 * application/octet-stream, which Twilio refuses to fetch (error 12300).
 */
export async function verificationToneHandler(c: Context) {
  const candidates = [
    path.resolve(import.meta.dirname, "public", "verify-tone.wav"), // prod bundle: dist/
    path.resolve(import.meta.dirname, "..", "dist", "public", "verify-tone.wav"),
    path.resolve(import.meta.dirname, "..", "public", "verify-tone.wav"), // tsx/vitest: api/
    path.resolve(process.cwd(), "dist", "public", "verify-tone.wav"),
    path.resolve(process.cwd(), "public", "verify-tone.wav"), // dev
  ];
  for (const p of candidates) {
    try {
      const buf = await fs.promises.readFile(p);
      return c.body(buf, 200, {
        "Content-Type": "audio/wav",
        "Content-Length": String(buf.byteLength),
        "Cache-Control": "no-store",
      });
    } catch {
      // try next candidate
    }
  }
  return c.text("tone not found", 404);
}

const VoiceResponse = twilio.twiml.VoiceResponse;

function xml(c: Context, vr: twilio.twiml.VoiceResponse) {
  return c.text(vr.toString(), 200, { "Content-Type": "text/xml" });
}

/** DTMF tone loop replacing the Asterisk 1400Hz merge-test tone. */

/** <Gather> digit timeout per IVR attempt, seconds. */
const IVR_GATHER_TIMEOUT = 8;

function attemptFrom(c: Context): number {
  const a = parseInt(c.req.query("a") ?? "0", 10);
  return Number.isFinite(a) && a >= 0 ? a : 0;
}

/** Append the attempt counter to a twiml URL (twimlUrl already has ?sid=). */
function withAttempt(url: string, attempt: number): string {
  return `${url}&a=${attempt}`;
}

/** AMD rule (CALL-FLOW.md design decision 3): anything not MACHINE → HUMAN. */
function amdIsMachine(answeredBy: string): boolean {
  return answeredBy.startsWith("machine");
}

/* -------------------------------------------------------------------------- */
/* TwiML documents                                                             */
/* -------------------------------------------------------------------------- */

export async function verificationTwimlHandler(c: Context) {
  try {
    vs.setRuntimeBaseUrl(new URL(c.req.url).origin);
  } catch {
    /* ignore */
  }
  const kind = c.req.param("kind");
  const sid = c.req.query("sid") ?? "";
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const answeredBy = String(body.AnsweredBy ?? "");
  const vr = new VoiceResponse();
  const P = vs.verifyPrompts();

  try {
    switch (kind) {
      case "caller-hold": {
        // Caller is parked with hold music; when the session reaches a
        // terminal state the state machine redirects this leg to the matching
        // notify-* verdict announcement (replaces live listen-in).
        vr.say(P.callerHold);
        vr.dial().conference(
          { beep: "false", startConferenceOnEnter: false, endConferenceOnExit: false },
          vs.conferenceName(sid),
        );
        break;
      }

      case "leg-a": {
        // Phase 2, step 1: "Press 1 to accept". <Gather> accepts DTMF during
        // playback. Timeout falls through to the re-prompt redirect; wrong
        // digits re-prompt via the gather handler.
        const a = attemptFrom(c);
        if (a >= vs.LEG_A_MAX_ATTEMPTS) {
          void vs
            .onLegFailed(sid, "legA", "callee rejected/no input")
            .catch((err) => console.error("[verify] leg-a reject error:", err));
          vr.say(P.reject);
          vr.hangup();
          break;
        }
        const gather = vr.gather({
          numDigits: 1,
          timeout: IVR_GATHER_TIMEOUT,
          action: vs.gatherLegAAcceptUrl(sid, a),
          method: "POST",
        });
        gather.say(P.accept);
        vr.redirect({ method: "POST" }, withAttempt(vs.twimlUrl("leg-a", sid), a + 1));
        break;
      }

      case "leg-a-ready": {
        // Phase 2, step 2: "Press 1 when ready to proceed".
        const a = attemptFrom(c);
        if (a >= vs.LEG_A_MAX_ATTEMPTS) {
          void vs
            .onLegFailed(sid, "legA", "callee rejected/no input")
            .catch((err) => console.error("[verify] leg-a-ready reject error:", err));
          vr.say(P.reject);
          vr.hangup();
          break;
        }
        const gather = vr.gather({
          numDigits: 1,
          timeout: IVR_GATHER_TIMEOUT,
          action: vs.gatherLegAReadyUrl(sid, a),
          method: "POST",
        });
        gather.say(P.ready);
        vr.redirect({ method: "POST" }, withAttempt(vs.twimlUrl("leg-a-ready", sid), a + 1));
        break;
      }

      case "leg-a-hold": {
        // CALLEE_READY → Leg A waits (Java Wait(300)) while Leg B + ring test
        // run. Long <Pause> loop via self-redirect keeps the call alive; the
        // state machine redirects/hangs up this leg on terminal states.
        const session = sid ? await vs.findSession(sid) : null;
        if (!session || vs.isTerminal(session)) {
          vr.hangup();
          break;
        }
        vr.pause({ length: 60 });
        vr.redirect({ method: "POST" }, vs.legAHoldUrl(sid));
        break;
      }

      case "leg-a-tone": {
        // Merge-test phase: Leg A loops an IN-BAND audio tone (real sound
        // file — <Play digits> is out-of-band RFC2833 and never traverses a
        // phone's local 3-way merge). If the callee merges, the tone leaks
        // into Leg B's <Gather> → MERGE_DETECTED.
        // Served via /api/verify/tone.wav (explicit audio/wav Content-Type —
        // the static server returns octet-stream and Twilio refuses to fetch it).
        vr.play({ loop: 10 }, `${vs.requirePublicBaseUrl()}/api/verify/tone.wav`);
        vr.redirect({ method: "POST" }, vs.twimlUrl("leg-a-tone", sid));
        break;
      }

      case "leg-b": {
        // Leg B stays in the silent record-chunk loop — merge detection takes
        // priority over live audio (a call in a <Conference> cannot also
        // record). AMD (async) reports voicemail via the status callback;
        // sync AnsweredBy handled too. Anything not MACHINE → human path.
        if (answeredBy && amdIsMachine(answeredBy)) {
          void vs
            .onVoicemailDetected(sid, answeredBy)
            .catch((err) => console.error("[verify] leg-b AMD error:", err));
        }
        // Merge detection: tight loop of 1-second <Record> chunks — each
        // chunk's callback is Goertzel-scanned for the continuous DTMF-9
        // tone leaking across a merge. (Media Streams are blocked by this
        // hosting platform — error 31920 — and <Gather> can't hear in-band
        // tones, so chunked recording analysis is the reliable path.)
        // PRIMARY (when configured): live audio fork to the external relay's
        // real-time detector → sub-0.5s merge detection. The record-chunk
        // loop below stays as the always-on fallback (~2s).
        const relayUrl = relayStreamUrl(sid);
        if (relayUrl) {
          vr.start().stream({ url: relayUrl });
        }
        // SILENT on Leg B: no words, no beep. 1s chunks → merge-to-termination
        // ≈1.5–2.5s typical (chunk + processing + analysis + REST hangups).
        vr.record({
          maxLength: 1,
          timeout: 1,
          playBeep: false,
          trim: "do-not-trim",
          recordingStatusCallback: vs.recordingMergeUrl(sid),
          recordingStatusCallbackMethod: "POST",
        });
        vr.redirect({ method: "POST" }, vs.twimlUrl("leg-b-record", sid));
        break;
      }

      case "leg-b-record": {
        // Re-arm the next recording chunk (loop target — keeps TwiML tiny).
        vr.record({
          maxLength: 1,
          timeout: 1,
          playBeep: false,
          trim: "do-not-trim",
          recordingStatusCallback: vs.recordingMergeUrl(sid),
          recordingStatusCallbackMethod: "POST",
        });
        vr.redirect({ method: "POST" }, vs.twimlUrl("leg-b-record", sid));
        break;
      }

      case "ring-test": {
        // Sync AMD result arrives on this fetch (asyncAmd=false).
        // CALL-FLOW.md: only explicit AMD HUMAN → VoIP; MACHINE → cellular;
        // unknown/notsure → inconclusive, let Leg B decide.
        if (answeredBy === "human") {
          void vs
            .onVoipDetected(sid)
            .catch((err) => console.error("[verify] ring-test AMD error:", err));
        } else if (amdIsMachine(answeredBy)) {
          void vs
            .onCellularConfirmed(sid, answeredBy)
            .catch((err) => console.error("[verify] ring-test AMD error:", err));
        } else {
          void vs
            .logEvent(sid, "RING_TEST_INCONCLUSIVE", `answeredBy=${answeredBy || "(empty)"} — let Leg B decide`)
            .catch((err) => console.error("[verify] ring-test log error:", err));
        }
        vr.pause({ length: 1 });
        vr.hangup();
        break;
      }

      case "conference-leg-b": {
        // Kept for reference but UNUSED: merge detection takes priority over
        // live listen-in, so Leg B never joins the conference.
        vr.dial().conference(
          { beep: "false", startConferenceOnEnter: true, endConferenceOnExit: false },
          vs.conferenceName(sid),
        );
        break;
      }

      case "notify-merge": {
        // Played to the caller (Leg B gets it in the merge gather handler).
        vr.say(P.mergeDetected);
        vr.hangup();
        break;
      }

      case "notify-voip-contact": {
        vr.say(P.voipCallee);
        vr.hangup();
        break;
      }

      case "notify-voip-caller": {
        vr.say(P.voipCaller);
        vr.hangup();
        break;
      }

      case "notify-callwaiting-callee": {
        vr.say(P.callWaitingCallee);
        vr.hangup();
        break;
      }

      case "notify-callwaiting-caller":
      case "notify-callwaiting": {
        // notify-callwaiting kept as an alias for the caller announcement.
        vr.say(P.callWaitingCaller);
        vr.hangup();
        break;
      }

      case "notify-completed": {
        vr.say(P.completed);
        vr.hangup();
        break;
      }

      case "notify-failed": {
        vr.say(P.failed);
        vr.hangup();
        break;
      }

      default: {
        vr.say("Unknown verification step.");
        vr.hangup();
      }
    }
  } catch (err) {
    console.error(`[verify] twiml handler error kind=${kind}`, err);
  }
  return xml(c, vr);
}

/* -------------------------------------------------------------------------- */
/* Status callbacks → state machine                                            */
/* -------------------------------------------------------------------------- */

const LEGS = new Set(["caller", "legA", "legB", "ringTest"]);

export async function verificationStatusHandler(c: Context) {
  try {
    const leg = c.req.param("leg") as vs.VerifyLeg;
    const sid = c.req.query("sid") ?? "";
    if (!LEGS.has(leg) || !sid) return c.text("ok");

    const body = await c.req.parseBody();
    const callSid = String(body.CallSid ?? "");
    const status = String(body.CallStatus ?? "");
    const answeredBy = String(body.AnsweredBy ?? "");
    const duration = String(body.CallDuration ?? "");

    await vs.storeCallSid(sid, leg, callSid);

    switch (status) {
      case "ringing":
        await vs.logEvent(sid, `RINGING_${leg.toUpperCase()}`, `sid=${callSid}`);
        break;

      case "answered":
      case "in-progress": {
        if (leg === "caller") {
          await vs.onCallerAnswered(sid, callSid);
        } else if (leg === "legA") {
          // Answer ≠ acceptance: CALL_ACCEPTED is driven by the press-1 IVR
          // (gather/leg-a-accept). But PSTN origination takes seconds, so we
          // pre-originate Leg B the instant the callee picks up — the second
          // call is then already ringing/answered by the ready press.
          await vs.onLegAAnswered(sid, callSid);
        } else if (leg === "legB") {
          // AMD: anything not MACHINE (human/unknown/notsure/empty) → human path.
          if (answeredBy && amdIsMachine(answeredBy)) {
            await vs.onVoicemailDetected(sid, answeredBy);
          } else {
            await vs.onLegBAnswered(sid, callSid);
          }
        } else if (leg === "ringTest") {
          // asyncAmd=false on the ring test, so AnsweredBy is already final.
          // CALL-FLOW.md: only explicit HUMAN → VoIP; MACHINE → cellular;
          // anything else is inconclusive — let Leg B decide.
          if (answeredBy === "human") await vs.onVoipDetected(sid);
          else if (amdIsMachine(answeredBy)) await vs.onCellularConfirmed(sid, answeredBy);
          else await vs.logEvent(sid, "RING_TEST_INCONCLUSIVE", `answeredBy=${answeredBy || "(empty)"} — let Leg B decide`);
        }
        break;
      }

      case "completed":
        await vs.onCallCompleted(sid, leg, callSid, `duration=${duration}s`);
        break;

      case "busy":
      case "no-answer":
      case "failed":
      case "canceled":
        // Ring-test specials (busy → CELLULAR_CONFIRMED; others → inconclusive
        // log only) are handled inside onLegFailed.
        await vs.onLegFailed(sid, leg, status);
        break;

      default:
        await vs.logEvent(sid, `STATUS_${leg.toUpperCase()}`, `${status} sid=${callSid}`);
    }
  } catch (err) {
    console.error("[verify] status callback error:", err);
  }
  return c.text("ok");
}

/* -------------------------------------------------------------------------- */
/* Leg A callee IVR — press-1 accept / ready                                   */
/* -------------------------------------------------------------------------- */

export async function verificationGatherLegAAcceptHandler(c: Context) {
  const sid = c.req.query("sid") ?? "";
  const a = attemptFrom(c);
  const vr = new VoiceResponse();
  const P = vs.verifyPrompts();
  try {
    const body = await c.req.parseBody();
    const digits = String(body.Digits ?? "");

    if (digits === "1") {
      // Callee accepted → CALL_ACCEPTED, then immediately ask step 2.
      await vs.onCallAccepted(sid, String(body.CallSid ?? ""));
      const gather = vr.gather({
        numDigits: 1,
        timeout: IVR_GATHER_TIMEOUT,
        action: vs.gatherLegAReadyUrl(sid, 0),
        method: "POST",
      });
      gather.say(P.ready);
      vr.redirect({ method: "POST" }, withAttempt(vs.twimlUrl("leg-a-ready", sid), 1));
    } else {
      // Wrong/partial digit → re-prompt (counts as an attempt).
      vr.redirect({ method: "POST" }, withAttempt(vs.twimlUrl("leg-a", sid), a + 1));
    }
  } catch (err) {
    console.error("[verify] leg-a-accept gather error:", err);
  }
  return xml(c, vr);
}

export async function verificationGatherLegAReadyHandler(c: Context) {
  const sid = c.req.query("sid") ?? "";
  const a = attemptFrom(c);
  const vr = new VoiceResponse();
  try {
    const body = await c.req.parseBody();
    const digits = String(body.Digits ?? "");

    if (digits === "1") {
      // Callee ready. Leg B was PRE-ORIGINATED at the first press-1 so the
      // second call is already ringing (effectively instant); onCalleeReady
      // just confirms (or originates as a fallback). Leg A then waits on a
      // long-pause hold loop that keeps the call alive.
      await vs.onCalleeReady(sid);
      vr.pause({ length: 60 });
      vr.redirect({ method: "POST" }, vs.legAHoldUrl(sid));
    } else {
      vr.redirect({ method: "POST" }, withAttempt(vs.twimlUrl("leg-a-ready", sid), a + 1));
    }
  } catch (err) {
    console.error("[verify] leg-a-ready gather error:", err);
  }
  return xml(c, vr);
}

/* -------------------------------------------------------------------------- */
/* Leg B <Gather> result — merge detection                                     */
/* -------------------------------------------------------------------------- */

export async function verificationGatherHandler(c: Context) {
  const sid = c.req.query("sid") ?? "";
  const vr = new VoiceResponse();
  const P = vs.verifyPrompts();
  try {
    const body = await c.req.parseBody();
    const digits = String(body.Digits ?? "");

    if (digits.includes(vs.MERGE_TONE_DIGIT)) {
      // Leaked DTMF-9 from Leg A's continuous tone stream → the callee merged
      // the calls. Instant verdict: Leg B hears it and both legs are hung up.
      await vs.onMergeDetected(sid);
      vr.say(P.mergeDetected);
      vr.hangup();
      return xml(c, vr);
    }
    if (digits.length > 0) {
      // A stray keypress that is NOT our tone digit — log and keep listening.
      await vs
        .logEvent(sid, "MERGE_LISTEN_STRAY_DIGIT", `digits=${digits} (not tone digit ${vs.MERGE_TONE_DIGIT}) — re-arming listener`)
        .catch(() => {});
    }

    // Gather timed out (or stray digit): Leg B ALWAYS stays in the Gather loop
    // (merge-detection priority — a call in a <Conference> cannot also run a
    // <Gather>), holding until the session terminates.
    const session = await vs.findSession(sid);
    if (session && !vs.isTerminal(session)) {
      vr.gather({
        numDigits: 1,
        timeout: 30,
        action: vs.gatherMergeUrl(sid),
        method: "POST",
      });
      // Silent listen — no repeated prompt while waiting for a merge.
      vr.redirect({ method: "POST" }, vs.gatherMergeUrl(sid));
    } else {
      vr.hangup();
    }
  } catch (err) {
    console.error("[verify] gather handler error:", err);
  }
  return xml(c, vr);
}
