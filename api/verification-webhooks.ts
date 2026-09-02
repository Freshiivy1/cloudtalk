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
 *   POST /api/verify/gather/leg-a-ready?sid=…  → guarded second press-1 (receive second call)
 *
 * Leg A callee IVR (CALL-FLOW.md Phase 2): the callee answers and hears
 * "Press 1 to accept" (DTMF during playback allowed) → CALL_ACCEPTED. Guarded
 * sessions then capture the explicit voice-ID phrase and require a SECOND
 * press-1 to originate Leg B; Leg A holds (long <Pause> self-redirect loop)
 * while second-call/merge verification runs.
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
import { legAStreamUrl, relayStreamUrl } from "./verification-stream";
import {
  CHALLENGE_NOISE_LEVEL,
  CHALLENGE_NOISE_LOOP_SEC,
  CHALLENGE_NOISE_SEED,
  challengeNoiseWav,
} from "./relayguard/noise";
import { mergeToneWav } from "./relayguard/dtmf";
import { wavToPcm16 } from "./verification-record";
import { analyzeClip, type ClipProfile } from "./relayguard/features";

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

/**
 * GET /api/verify/challenge-noise.wav — serves the EXACT relayguard
 * challenge-noise probe used by the detector: seed 0x5eed, bass-free
 * 500 Hz–6 kHz band, +4 dB presence at 2 kHz, 70% relayguard slider level,
 * 4-second seamless loop. The production callee path uses the telephony-grade
 * 16 kHz WAV asset; an in-process 8 kHz render is kept as a fallback. Used as
 * the conference announceUrl for the OUTER speakerphone case: Twilio plays it
 * to the CALLEE (Leg A) participant only, so the callee is prompted to get
 * off speakerphone to hear clearly (the call continues — no hangup).
 */
export async function challengeNoiseHandler(c: Context) {
  const candidates = [
    path.resolve(import.meta.dirname, "public", "relayguard-challenge-noise-70pct-16k.wav"),
    path.resolve(import.meta.dirname, "..", "dist", "public", "relayguard-challenge-noise-70pct-16k.wav"),
    path.resolve(import.meta.dirname, "..", "public", "relayguard-challenge-noise-70pct-16k.wav"),
    path.resolve(process.cwd(), "dist", "public", "relayguard-challenge-noise-70pct-16k.wav"),
    path.resolve(process.cwd(), "public", "relayguard-challenge-noise-70pct-16k.wav"),
  ];
  for (const p of candidates) {
    try {
      const buf = await fs.promises.readFile(p);
      return c.body(new Uint8Array(buf), 200, {
        "Content-Type": "audio/wav",
        "Content-Length": String(buf.byteLength),
        "Cache-Control": "no-store",
        "X-Relayguard-Probe": `seed=0x${CHALLENGE_NOISE_SEED.toString(16)};level=${CHALLENGE_NOISE_LEVEL};loop=${CHALLENGE_NOISE_LOOP_SEC}s;band=500-6000Hz;presence=+4dB@2kHz`,
      });
    } catch {
      // try next candidate
    }
  }
  try {
    const buf = challengeNoiseWav();
    return c.body(new Uint8Array(buf), 200, {
      "Content-Type": "audio/wav",
      "Content-Length": String(buf.byteLength),
      "Cache-Control": "no-store",
      "X-Relayguard-Probe": `seed=0x${CHALLENGE_NOISE_SEED.toString(16)};level=${CHALLENGE_NOISE_LEVEL};loop=${CHALLENGE_NOISE_LOOP_SEC}s;band=500-6000Hz;presence=+4dB@2kHz`,
    });
  } catch (err) {
    console.error("[verify] challenge-noise render failed:", err);
    return c.text("noise unavailable", 500);
  }
}

/**
 * GET /api/verify/merge-tone.wav — serves the BRIDGED in-call merge tone:
 * a continuous DTMF-'9' render (852+1336 Hz, VERIFY_MERGE_TONE_SEC seconds,
 * default 5s) produced by relayguard/dtmf.ts. Used as the conference
 * announceUrl for the Leg A participant only while the tone is ARMED
 * (HoldDetector second-call engagement), re-announced every
 * VERIFY_MERGE_TONE_REARM_MS so it is effectively continuous; the instant
 * the callee merges, the tone crosses into Leg A's uplink and the
 * stream-side Goertzel detector fires the in-call verdict.
 */
export async function mergeToneHandler(c: Context) {
  try {
    const buf = mergeToneWav(vs.mergeToneSec());
    return c.body(new Uint8Array(buf), 200, {
      "Content-Type": "audio/wav",
      "Content-Length": String(buf.byteLength),
      "Cache-Control": "no-store",
      "X-Merge-Tone": `dtmf=9;freq=852+1336Hz;duration=${vs.mergeToneSec()}s`,
    });
  } catch (err) {
    console.error("[verify] merge-tone render failed:", err);
    return c.text("tone unavailable", 500);
  }
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

      case "caller-wait": {
        // GUARDED MODE ONLY: non-blocking park for the SDK caller leg. A
        // call sitting in <Pause> accepts REST redirects immediately (unlike
        // one inside <Dial><Conference>), so the engine can move this leg
        // into the bridge conference the moment the call is BRIDGED.
        const session = sid ? await vs.findSession(sid) : null;
        if (!session || vs.isTerminal(session)) {
          vr.hangup();
          break;
        }
        vr.pause({ length: 60 });
        vr.redirect({ method: "POST" }, vs.twimlUrl("caller-wait", sid));
        break;
      }

      case "leg-a": {
        const a = attemptFrom(c);
        // Phase 2, step 1: "Press 1 to accept". Guarded and legacy sessions
        // both start here — the callee must explicitly accept the inmate call
        // before any voice-ID recording, second call, merge watch, or bridge.
        if (a >= vs.LEG_A_MAX_ATTEMPTS) {
          void vs
            .onLegFailed(sid, "legA", "callee rejected/no input")
            .catch((err) => console.error("[verify] leg-a reject error:", err));
          vr.say(P.reject);
          vr.hangup();
          break;
        }
        // Outer speakerphone detection: open a NON-BLOCKING <Start><Stream>
        // of the callee's uplink (inbound track) to the in-process relayguard
        // analyzer. <Start> does not hold or alter the call — the gather
        // flow below is untouched — and the stream persists for the rest of
        // the call, so it is started once (first prompt only, not on
        // re-prompt redirects). Detection always uses the in-process stream
        // endpoint; Leg B merge detection stays on the external relay.
        if (a === 0) {
          const streamUrl = legAStreamUrl(sid);
          if (streamUrl) {
            vr.start().stream({ url: streamUrl, track: "inbound_track" });
          }
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
        // Phase 2, guarded step 3: after voice-ID, "Press 1 to receive the
        // second verification call". This press is the only guarded Leg B trigger.
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

      case "voice-id-wait": {
        // GUARDED MODE ONLY: voice-ID verdict wait loop. The callee recorded
        // the voice-ID phrase; the recording is being profiled and Twilio is
        // transcribing it. Hold here (short pause + self-redirect, same
        // pattern as leg-a-hold) until the verdict lands:
        //   PASSED → serve the second press-1 gather (the only path to Leg B)
        //   FAILED → re-prompt + re-record, up to VOICE_ID_MAX_ATTEMPTS, then
        //            a polite failure prompt + hangup (session FAILED)
        //   pending → keep waiting (transcript timeout handled by the verdict)
        const session = sid ? await vs.findSession(sid) : null;
        if (!session || !session.guarded || vs.isTerminal(session)) {
          vr.hangup();
          break;
        }
        const verdict = await vs.voiceIdVerdict(sid);
        if (verdict.status === "passed") {
          const gather = vr.gather({
            numDigits: 1,
            timeout: IVR_GATHER_TIMEOUT,
            action: vs.gatherLegAReadyUrl(sid, 0),
            method: "POST",
          });
          gather.say(P.secondCall);
          vr.redirect({ method: "POST" }, withAttempt(vs.twimlUrl("leg-a-ready", sid), 1));
        } else if (verdict.status === "failed") {
          if (verdict.attempts >= vs.VOICE_ID_MAX_ATTEMPTS) {
            // All attempts exhausted: fail the session (caller notified via
            // notify-failed) and give the callee the polite goodbye — the
            // TwiML hangs the leg up itself (outer-call system untouched).
            void vs
              .onVoiceIdFailed(sid)
              .catch((err) => console.error("[verify] voice-id fail error:", err));
            vr.say(P.voiceIdFailed);
            vr.hangup();
          } else {
            // Re-prompt the voice-ID and re-record (transcribed, same gate).
            vr.say(P.voiceIdRetry);
            vr.record({
              maxLength: 8,
              timeout: 3,
              playBeep: true,
              action: vs.voiceprintUrl(sid),
              method: "POST",
              transcribe: true,
              transcribeCallback: vs.voiceprintTranscriptionUrl(sid),
            });
            vr.redirect({ method: "POST" }, vs.twimlUrl("voice-id-wait", sid));
          }
        } else {
          vr.pause({ length: 2 });
          vr.redirect({ method: "POST" }, vs.twimlUrl("voice-id-wait", sid));
        }
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
        //
        // GUARDED MODE ONLY: this self-redirect loop doubles as the timer-free
        // poll for the merge-detection watch (fallback for runtimes without
        // guaranteed background timers). Once the watch elapses with no merge
        // the session has PASSED: bridge inline (this fetch IS Leg A, so we
        // serve the bridge TwiML directly instead of a REST redirect) and the
        // caller leg is redirected by maybeBridgeGuarded. Guarded sessions get
        // loop=1 so the poll cadence is one tone-play instead of ten.
        // NON-guarded sessions render the exact legacy TwiML below.
        if (sid) {
          const session = await vs.findSession(sid);
          if (session?.guarded) {
            const bridged =
              session.state === vs.VState.BRIDGED ||
              (await vs.maybeBridgeGuarded(sid, { legAInline: true }));
            if (bridged) {
              vr.dial().conference(
                { beep: "false", startConferenceOnEnter: true, endConferenceOnExit: true },
                vs.conferenceName(sid),
              );
              break;
            }
            vr.play({ loop: 1 }, `${vs.requirePublicBaseUrl()}/api/verify/tone.wav`);
            vr.redirect({ method: "POST" }, vs.twimlUrl("leg-a-tone", sid));
            break;
          }
        }
        vr.play({ loop: 10 }, `${vs.requirePublicBaseUrl()}/api/verify/tone.wav`);
        vr.redirect({ method: "POST" }, vs.twimlUrl("leg-a-tone", sid));
        break;
      }

      case "guarded-bridge": {
        // GUARDED MODE ONLY: verification passed — bridge the caller (inmate
        // softphone) and the callee (Leg A) into a LIVE two-way conference.
        // endConferenceOnExit on both legs: when either party hangs up the
        // other is dropped and the status callback marks the session
        // COMPLETED. Leg A's <Start><Stream> persists across the redirect
        // into this TwiML, so speakerphone detection continues in-call.
        // record-from-start captures the whole conversation for call review;
        // Twilio posts the finished recording to /api/verify/recording/bridge
        // when the conference ends.
        vr.dial().conference(
          {
            beep: "false",
            startConferenceOnEnter: true,
            endConferenceOnExit: true,
            record: "record-from-start",
            recordingStatusCallback: vs.recordingBridgeUrl(sid),
            recordingStatusCallbackMethod: "POST",
            recordingStatusCallbackEvent: ["completed"],
          },
          vs.conferenceName(sid),
        );
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
        // Merge detection strategy:
        // PRIMARY (when VERIFY_STREAM_URL is configured): DUPLEX stream —
        // <Connect><Stream> holds Leg B on the relay's WebSocket; the relay's
        // Goertzel detector fires on ~300ms of leaked tone and speaks the
        // verdict straight into the open socket (merge→verdict ≈ 0.3–0.4s,
        // no Twilio round-trip). Leg A is torn down by the armed relay.
        // FALLBACK (no relay): tight loop of 1-second <Record> chunks —
        // each chunk's callback is Goertzel-scanned (~2s detection).
        const relayUrl = relayStreamUrl(sid);
        if (relayUrl) {
          const connect = vr.connect();
          const stream = connect.stream({ url: relayUrl });
          stream.parameter({ name: "sid", value: sid });
          stream.parameter({ name: "mode", value: "duplex" });
          break;
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

      case "notify-conference-merge": {
        // IN-CALL (BRIDGED) merge detection: every leg hears the
        // conference-ending notice; the engine also completes the conference
        // by SID so all participants drop even mid-<Dial><Conference>.
        vr.say(P.conferenceEnding);
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

      case "notify-first-call-ended": {
        vr.say(P.firstCallEnded);
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
          // (gather/leg-a-accept). This callback only records the answer.
          // (Guarded Leg B origination waits for voice-ID plus the second
          // press-1 — the callee explicitly controls when the next call arrives.)
          await vs.logEvent(sid, "ANSWERED_LEGA", `sid=${callSid} — awaiting press-1 accept`);
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
  try {
    const body = await c.req.parseBody();
    const digits = String(body.Digits ?? "");

    if (digits === "1") {
      // Callee accepted → CALL_ACCEPTED. Guarded sessions then require TWO
      // more explicit actions: the voice-ID phrase and a second press-1.
      // Leg B is originated only by that second press (leg-a-ready).
      const session = await vs.onCallAccepted(sid, String(body.CallSid ?? ""));
      if (session?.guarded) {
        // GUARDED MODE ONLY: press-1 → explicit voice-ID phrase, ENFORCED.
        // The recording is transcribed (transcribe + transcribeCallback) so
        // the phrase itself is verified, and the /api/verify/voiceprint action
        // profiles the clip — BOTH must pass before the second press-1 gather
        // is ever served (see the voice-id-wait TwiML). The verbs after
        // <Record> are only a fallback for a failed action fetch, so they
        // land in the same voice-ID wait loop rather than the ready gather.
        const P = vs.verifyPrompts();
        vr.say(P.voiceId);
        vr.record({
          maxLength: 8,
          timeout: 3,
          playBeep: true,
          action: vs.voiceprintUrl(sid),
          method: "POST",
          transcribe: true,
          transcribeCallback: vs.voiceprintTranscriptionUrl(sid),
        });
        vr.redirect({ method: "POST" }, vs.twimlUrl("voice-id-wait", sid));
      } else {
        vr.say("Thank you. Please stay on the line while your call is connected.");
        vr.pause({ length: 60 });
        vr.redirect({ method: "POST" }, vs.legAHoldUrl(sid));
      }
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
      // Callee ready. GUARDED MODE: this second press-1 is the explicit
      // second-call trigger — Leg B is originated here, after voice-ID.
      // onCalleeReady refuses (false) when a guarded voice-ID has NOT passed:
      // the callee is bounced back into the voice-ID wait loop instead of
      // being parked (NO BRIDGE without a passing voice-ID).
      const P = vs.verifyPrompts();
      const ready = await vs.onCalleeReady(sid);
      if (!ready) {
        vr.redirect({ method: "POST" }, vs.twimlUrl("voice-id-wait", sid));
        return xml(c, vr);
      }
      // Tell the callee the bridge is being set up before parking them.
      vr.say(P.calleeConnectWait);
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
/* GUARDED MODE ONLY: voiceprint <Record> action                               */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/verify/voiceprint?sid=… — action of the guarded voice-ID
 * <Record> ("my voice identifies me"). A new voice-ID attempt begins here;
 * the recording is processed fire-and-forget (relayguard baseline + the
 * usable/strong voiceprint note) and the callee is handed to the
 * voice-id-wait loop, which holds them until the transcript/voiceprint
 * verdict lands. The second press-1 gather is served ONLY from that loop
 * once the voice-ID has PASSED; Leg B is originated only by that second
 * press through gather/leg-a-ready → onCalleeReady().
 */
export async function verificationVoiceprintHandler(c: Context) {
  const sid = c.req.query("sid") ?? "";
  const vr = new VoiceResponse();
  try {
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const recordingUrl = String(body.RecordingUrl ?? "");
    const durationSec = Number(body.RecordingDuration ?? 0);
    const callSid = String(body.CallSid ?? "");
    const session = sid ? await vs.findSession(sid) : null;
    if (!sid || !session || !session.guarded || vs.isTerminal(session)) {
      vr.hangup();
      return xml(c, vr);
    }

    const attempt = vs.voiceIdBeginAttempt(sid, String(body.RecordingSid ?? ""));
    console.log(`[verify] VOICE_ID_ATTEMPT session=${sid} attempt=${attempt}`);
    void processVoiceprint(sid, { recordingUrl, durationSec, callSid }).catch((err) =>
      console.error("[verify] voiceprint processing error:", err),
    );
    // Hold in the voice-ID wait loop until the verdict (pass → second
    // press-1 gather; fail → re-record / end; pending → keep waiting).
    vr.redirect({ method: "POST" }, vs.twimlUrl("voice-id-wait", sid));
  } catch (err) {
    console.error("[verify] voiceprint handler error:", err);
    try {
      vr.hangup();
    } catch {
      /* ignore */
    }
  }
  return xml(c, vr);
}

/**
 * POST /api/verify/voiceprint-transcription?sid=… — Twilio transcribeCallback
 * of the guarded voice-ID <Record>. Feeds the transcript into the voice-ID
 * state machine (fuzzy phrase match happens in verification.ts). Twilio
 * expects a plain 200 — no TwiML is executed from this callback.
 */
export async function verificationVoiceprintTranscriptionHandler(c: Context) {
  try {
    const sid = c.req.query("sid") ?? "";
    if (!sid) return c.text("ok");
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    await vs.voiceIdNoteTranscript(sid, {
      status: String(body.TranscriptionStatus ?? ""),
      text: String(body.TranscriptionText ?? ""),
      recordingSid: String(body.RecordingSid ?? ""),
    });
  } catch (err) {
    console.error("[verify] voiceprint transcription callback error:", err);
  }
  return c.text("ok");
}

/**
 * Fetch + analyze the explicit voice-ID recording and store it as the
 * relayguard voice baseline. Best-effort: a missed/unusable recording never
 * blocks second-call verification or the eventual bridge.
 */
async function processVoiceprint(
  sid: string,
  pending: { recordingUrl: string; durationSec: number; callSid: string },
): Promise<void> {
  const session = await vs.findSession(sid);
  if (!session || !session.guarded || vs.isTerminal(session)) return;
  // Persist the clip for call review regardless of profiling outcome.
  if (pending.recordingUrl) {
    await vs
      .storeVoiceRecording(sid, pending.recordingUrl, pending.durationSec || 0)
      .catch((err) => console.error("[verify] store voice recording error:", err));
  }
  const hasRecording =
    Boolean(pending.recordingUrl) &&
    Number.isFinite(pending.durationSec) &&
    pending.durationSec >= 1;
  let captured = false;
  let strong = false;
  if (hasRecording) {
    try {
      const profile = await fetchVoiceProfile(pending.recordingUrl);
      vs.setVoiceBaseline(sid, profile);
      // VAD speech seconds (512-sample hop @ 8 kHz = 64 ms/frame). The
      // voiceprint is STRONG (usable for the voice-ID gate) only with
      // >= VOICE_ID_MIN_SPEECH_SEC of actual speech.
      const speechSec = profile.vad.speechFrames.length * 0.064;
      strong = speechSec >= vs.VOICE_ID_MIN_SPEECH_SEC;
      await vs.logEvent(
        sid,
        "VOICEPRINT_CAPTURED",
        `recording=${pending.recordingUrl} duration=${pending.durationSec}s callSid=${pending.callSid} ` +
          `speechFrames=${profile.vad.speechFrames.length} speechSec=${speechSec.toFixed(2)} strong=${strong} voicedFrames=${profile.voicePrint.voicedFrames} — explicit voice-ID phrase`,
      );
      captured = true;
    } catch (err) {
      console.error(`[verify] VOICEPRINT_MISSED session=${sid}:`, err);
    }
  }
  if (!captured) {
    await vs.logEvent(
      sid,
      "VOICEPRINT_MISSED",
      `recording=${pending.recordingUrl || "(none)"} duration=${pending.durationSec ?? 0}s — explicit voice-ID phrase, no usable audio`,
    );
  }
  // Feed the voice-ID state machine: the recording is USABLE when it exists
  // with real audio AND profiling succeeded; STRONG when it also carries
  // enough VAD speech. Anything less fails the attempt (re-record).
  vs.voiceIdNoteRecording(sid, {
    usable: hasRecording && captured,
    strong,
    detail: `recording=${pending.recordingUrl || "(none)"} duration=${pending.durationSec ?? 0}s captured=${captured}`,
  });
}

/** Download the Twilio recording as 8 kHz WAV and profile it (relayguard). */
async function fetchVoiceProfile(recordingUrl: string): Promise<ClipProfile> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
  const auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
  // Twilio sometimes lags making media available after the callback — retry
  // briefly (same policy as the Leg B recording-chunk analysis).
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${recordingUrl}.wav`, {
        headers: { Authorization: auth },
      });
      if (!res.ok) throw new Error(`recording fetch failed: ${res.status}`);
      const pcm = wavToPcm16(Buffer.from(await res.arrayBuffer()));
      // int16 → float, peak-normalized (same convention as SpeakerphoneDetector).
      let peak = 0;
      for (const s of pcm) {
        const a = Math.abs(s);
        if (a > peak) peak = a;
      }
      const scale = peak > 0 ? 0.9 / peak : 1;
      const samples = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] * scale;
      return analyzeClip(samples, 8000);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastErr;
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
