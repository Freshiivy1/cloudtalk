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
 * sessions then capture the save-only voice-ID phrase (recorded + profiled
 * as call-review evidence, NEVER verified) and proceed STRAIGHT to a SECOND
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
import { legAStreamUrl, relayStreamUrl, streamToken } from "./verification-stream";
import { PROMPT_LIGHT_DURATION_MS, PROMPT_LIGHT_WAV_FILE } from "./generated/prompt-light-asset";
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
 * to the CALLER (inmate) participant only, so the party relaying the call
 * over speakerphone is prompted to take it off speaker to hear clearly (the
 * call continues — no hangup). The callee (Leg A) participant NEVER gets
 * this noise — that announce channel is reserved for the DTMF merge tone.
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
 * GET /api/verify/prompt-light.wav — serves the PHASE 1 challenge asset:
 * pre-rendered speech + the existing merge-tone pair (852+1336 Hz, DTMF-8)
 * attenuated 21 dB below prompt RMS, 8 kHz mono PCM16. The exact measured
 * duration is exported from the generated asset module
 * (api/generated/prompt-light-asset.ts) and surfaced as a response header so
 * deploys can be verified against the constant.
 */
export async function promptLightHandler(c: Context) {
  const candidates = [
    path.resolve(import.meta.dirname, "public", PROMPT_LIGHT_WAV_FILE), // prod bundle: dist/
    path.resolve(import.meta.dirname, "..", "dist", "public", PROMPT_LIGHT_WAV_FILE),
    path.resolve(import.meta.dirname, "..", "public", PROMPT_LIGHT_WAV_FILE), // tsx/vitest: api/
    path.resolve(process.cwd(), "dist", "public", PROMPT_LIGHT_WAV_FILE),
    path.resolve(process.cwd(), "public", PROMPT_LIGHT_WAV_FILE), // dev
  ];
  for (const p of candidates) {
    try {
      const buf = await fs.promises.readFile(p);
      return c.body(new Uint8Array(buf), 200, {
        "Content-Type": "audio/wav",
        "Content-Length": String(buf.byteLength),
        "Cache-Control": "no-store",
        "X-Prompt-Light-Duration-Ms": String(PROMPT_LIGHT_DURATION_MS),
      });
    } catch {
      // try next candidate
    }
  }
  return c.text("prompt-light not found", 404);
}

/**
 * GET /api/verify/merge-tone.wav — serves the BRIDGED in-call merge tone:
 * a beep render of the existing merge-tone pair (852+1336 Hz = DTMF-8,
 * VERIFY_MERGE_TONE_SEC seconds, default 0.5s) produced by
 * relayguard/dtmf.ts. Used as the conference announceUrl for the Leg A
 * participant only while the tone is ARMED (HoldDetector second-call
 * engagement), re-announced every VERIFY_MERGE_TONE_REARM_MS so it is
 * effectively continuous; the instant the callee merges, the tone crosses
 * into Leg A's uplink and the stream-side Goertzel detector fires the
 * in-call verdict.
 */
export async function mergeToneHandler(c: Context) {
  try {
    const buf = mergeToneWav(vs.mergeToneSec());
    return c.body(new Uint8Array(buf), 200, {
      "Content-Type": "audio/wav",
      "Content-Length": String(buf.byteLength),
      "Cache-Control": "no-store",
      "X-Merge-Tone": `dtmf=8;freq=852+1336Hz;duration=${vs.mergeToneSec()}s`,
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

/**
 * Optional Twilio request-signature validation for the /api/verify/*
 * webhooks. Enabled with VERIFY_TWILIO_SIGNATURE_REQUIRED=true (off by
 * default so unsigned dev/test environments keep working). When enabled,
 * requests without a VALID X-Twilio-Signature over the public URL + form
 * params are rejected with 403. Hono caches the parsed body, so the
 * parseBody() here does not consume the stream for the handler.
 */
async function twilioSignatureOk(c: Context): Promise<boolean> {
  if ((process.env.VERIFY_TWILIO_SIGNATURE_REQUIRED ?? "false") !== "true") return true;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const sig = c.req.header("X-Twilio-Signature");
  const base = vs.getPublicBaseUrl();
  if (!authToken || !sig || !base) return false;
  const formParams: Record<string, string> = {};
  try {
    const form = await c.req.parseBody();
    for (const [k, v] of Object.entries(form)) {
      if (typeof v === "string") formParams[k] = v;
    }
  } catch {
    /* no form body — validate against the URL alone */
  }
  const raw = new URL(c.req.url);
  const url = `${base.replace(/\/$/, "")}${raw.pathname}${raw.search}`;
  return twilio.validateRequest(authToken, sig, url, formParams);
}

/** DTMF tone loop replacing the Asterisk 1400Hz merge-test tone. */

/** <Gather> digit timeout per IVR attempt, seconds. */
const IVR_GATHER_TIMEOUT = 8;

/**
 * Caller-wait park cadence (seconds). Short enough that the self-healing
 * bridge check (BRIDGED → join conference from this fetch) recovers from a
 * failed/raced REST redirect within seconds instead of up to a minute.
 */
const CALLER_WAIT_PAUSE_SEC = 10;

/**
 * The live two-way bridge conference TwiML, shared by the `guarded-bridge`
 * document, the `leg-b` document (corrected architecture) and the caller-wait
 * self-heal path.
 *
 * Leg B (the callee's LIVE leg) is the ANCHOR (startConferenceOnEnter: true)
 * — the conference exists the moment the callee enters. The browser caller is
 * the JOINER (false): a leg that cannot start the conference can never spawn
 * a duplicate same-name conference (the classic Twilio race that strands both
 * parties alone in silence); if the caller arrives first it waits in the
 * lobby the few hundred ms until the anchor dials in. Leg A is the Call
 * Waiting canary and NEVER joins the conference.
 *
 * The post-Dial <Redirect> is the ONLY way to tell the surviving party the
 * call is over: a REST redirect cannot reach a call inside an active
 * <Dial><Conference>. When the conference ends, the Dial verb returns and
 * the surviving leg hears notify-partner-ended, then hangs up. (For the
 * party that hung up the call is already over — these verbs never run.)
 */
function serveBridgeConference(
  vr: twilio.twiml.VoiceResponse,
  sid: string,
  leg: "caller" | "legB" | "recall",
) {
  vr.dial().conference(
    {
      beep: "false",
      // Anchor rules: Leg B (or the recall leg) STARTS the room; the caller
      // only ever joins it — a leg that cannot start the conference can never
      // spawn a duplicate same-name conference stranding both in silence.
      startConferenceOnEnter: leg !== "caller",
      // endConferenceOnExit ONLY on the caller leg: the caller hanging up
      // ends the call for everyone. The CALLEE leg (Leg B) exiting must NOT
      // end the room — the bridge supervisor re-dials a dropped callee
      // straight back into this same conference while the caller waits
      // (BRIDGE_RECALL).
      endConferenceOnExit: leg === "caller",
      record: "record-from-start",
      recordingStatusCallback: vs.recordingBridgeUrl(sid),
      recordingStatusCallbackMethod: "POST",
      recordingStatusCallbackEvent: ["completed"],
      // Participant join/leave + conference lifecycle events feed the bridge
      // supervisor (join watchdog + drop recovery) and the session timeline.
      statusCallback: vs.conferenceStatusUrl(sid),
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["start", "end", "join", "leave"],
    },
    vs.conferenceName(sid),
  );
  vr.redirect({ method: "POST" }, vs.twimlUrl("notify-partner-ended", sid));
}

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
  if (!(await twilioSignatureOk(c))) return c.text("forbidden", 403);
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
        // SELF-HEALING BRIDGE: the REST redirect in bridgeGuardedLive is the
        // fast path into the conference, but if it raced an in-flight
        // self-redirect fetch or the REST update failed (transient API error,
        // region mismatch on the SDK leg), the caller would otherwise be
        // parked in silence FOREVER — Leg A alone in the conference, both
        // parties deaf. Check the session on every poll: once BRIDGED, join
        // the bridge conference directly from THIS fetch.
        if (session.state === vs.VState.BRIDGED) {
          serveBridgeConference(vr, sid, "caller");
          break;
        }
        vr.pause({ length: CALLER_WAIT_PAUSE_SEC });
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

      case "leg-a-hold": {
        // CALLEE_READY → Leg A (the canary) waits while Leg B + the ring test
        // run. Long <Pause> loop via self-redirect keeps the call alive; the
        // state machine redirects/hangs up this leg on terminal states and on
        // stream-ready (→ leg-a-challenge). Leg A NEVER joins the conference.
        let session = sid ? await vs.findSession(sid) : null;
        if (!session || vs.isTerminal(session)) {
          vr.hangup();
          break;
        }
        // RESTART-SAFE READINESS FALLBACK: enforce the persisted stream-ready
        // deadline even on runtimes without guaranteed background timers (and
        // after a process restart, when the in-process watchdog is gone).
        if (session.detectionPhase === "AWAITING_STREAM_READY") {
          await vs.checkStreamReadiness(sid);
          session = await vs.findSession(sid);
          if (!session || vs.isTerminal(session)) {
            vr.hangup();
            break;
          }
        }
        vr.pause({ length: 60 });
        vr.redirect({ method: "POST" }, vs.legAHoldUrl(sid));
        break;
      }

      case "leg-a-challenge": {
        // TWO-PHASE CANARY CHALLENGE (corrected architecture). Leg A stays
        // OUTSIDE the conference and plays the deterministic challenge:
        //   Phase 1 — the prompt-light asset ONCE (speech + attenuated
        //             852+1336 Hz watermark, exact measured duration);
        //   Phase 2 — the existing loud verify-tone.wav loop (this document
        //             redirects into leg-a-challenge-tone after Phase 1).
        // Served only after the relay confirmed stream-ready (onStreamReady
        // redirects Leg A here); before that, hold and re-poll.
        const session = sid ? await vs.findSession(sid) : null;
        if (!session || vs.isTerminal(session)) {
          vr.hangup();
          break;
        }
        if (!session.challengeStartedAt) {
          // Challenge not started yet (or a redirect raced a restart): wait
          // for stream-ready instead of playing an untimed prompt.
          vr.pause({ length: 5 });
          vr.redirect({ method: "POST" }, vs.twimlUrl("leg-a-challenge", sid));
          break;
        }
        const base = vs.requirePublicBaseUrl();
        vr.play({ loop: 1 }, `${base}/api/verify/prompt-light.wav`);
        vr.redirect({ method: "POST" }, vs.twimlUrl("leg-a-challenge-tone", sid));
        break;
      }

      case "leg-a-challenge-tone": {
        // Phase 2: loop the existing loud merge tone (852+1336 Hz pair —
        // DTMF-8). A merge leaks it into Leg B's inbound audio where the
        // relay's loud Goertzel detector is decisive on its own.
        const session = sid ? await vs.findSession(sid) : null;
        if (!session || vs.isTerminal(session)) {
          vr.hangup();
          break;
        }
        vr.play({ loop: 10 }, `${vs.requirePublicBaseUrl()}/api/verify/tone.wav`);
        vr.redirect({ method: "POST" }, vs.twimlUrl("leg-a-challenge-tone", sid));
        break;
      }

      case "guarded-bridge": {
        // GUARDED MODE ONLY (corrected architecture): the caller (inmate
        // softphone) and the callee's LIVE Leg B share a two-way conference.
        // The `leg` query param selects the conference role (see
        // serveBridgeConference): "caller" is the JOINER; anything else
        // (legB / recall / legacy URLs without the param) is the ANCHOR.
        // record-from-start captures the whole conversation for call review;
        // Twilio posts the finished recording to /api/verify/recording/bridge
        // when the conference ends.
        const legParam = c.req.query("leg") === "caller" ? "caller" : "legB";
        serveBridgeConference(vr, sid, legParam);
        break;
      }

      case "notify-partner-ended": {
        // Post-Dial landing for the SURVIVING bridge leg: the other party
        // hung up, endConferenceOnExit ended the conference, the Dial verb
        // returned and the bridge TwiML fell through to this redirect. (A
        // REST redirect cannot reach a call inside an active
        // <Dial><Conference>, which is why this notice lives in the TwiML
        // flow itself rather than being pushed by the state machine.)
        vr.say(P.partnerEnded);
        vr.hangup();
        break;
      }

      case "bridge-recall": {
        // GUARDED MODE ONLY: the callee's live leg (Leg B) dropped mid-call
        // and the supervisor is re-dialling them straight into the live
        // conference. The recall leg is the NEW detection leg: it re-opens
        // the inbound-only relay stream (same customParameters identity — the
        // relay dedupes/re-arms by sid) and the readiness deadline is
        // re-armed engine-side, so a recall that cannot be monitored is
        // DETECTION_FAILED, never a silent pass.
        const relayUrl = relayStreamUrl();
        if (relayUrl && process.env.VERIFY_STREAM_SECRET) {
          const start = vr.start().stream({ url: relayUrl, track: "inbound_track" });
          start.parameter({ name: "sid", value: sid });
          start.parameter({ name: "leg", value: "legB" });
          start.parameter({ name: "mode", value: "merge-detection" });
          start.parameter({ name: "token", value: streamToken(sid) });
        }
        vr.say("Reconnecting your call now.");
        serveBridgeConference(vr, sid, "recall");
        break;
      }

      case "notify-reconnecting": {
        // Conference ANNOUNCE document played to the CALLER participant only
        // while the callee is being re-dialled (see BRIDGE_RECALL).
        vr.say("Please hold — the other party disconnected. Reconnecting them now.");
        vr.hangup();
        break;
      }

      case "leg-b": {
        // CORRECTED ARCHITECTURE: Leg B is the LIVE browser-caller ↔ callee
        // call. It opens a NON-BLOCKING inbound-only <Start><Stream> for the
        // merge relay and IMMEDIATELY continues — no prompt, no <Gather>, no
        // keypress, no tone, no blocking <Connect><Stream>, no <Record>
        // fallback, and no dependence on relay audio.
        // AMD (async) reports voicemail via the status callback; sync
        // AnsweredBy handled too. A machine answer NEVER human-confirms.
        if (answeredBy && amdIsMachine(answeredBy)) {
          void vs
            .onVoicemailDetected(sid, answeredBy)
            .catch((err) => console.error("[verify] leg-b AMD error:", err));
        }
        const relayUrl = relayStreamUrl();
        if (!relayUrl || !process.env.VERIFY_STREAM_SECRET) {
          // Fail CLOSED: without the relay there is no detection path — this
          // must surface as DETECTION_FAILED, never a silent pass.
          void vs
            .onStreamFailed(
              sid,
              "DETECTION_FAILED",
              "merge relay not configured (VERIFY_STREAM_URL/VERIFY_STREAM_SECRET)",
            )
            .catch((err) => console.error("[verify] leg-b fail-closed error:", err));
          vr.hangup();
          break;
        }
        // Stream identity travels ONLY in customParameters (sid / leg=legB /
        // mode=merge-detection / token) — the query string is never used.
        const start = vr.start().stream({ url: relayUrl, track: "inbound_track" });
        start.parameter({ name: "sid", value: sid });
        start.parameter({ name: "leg", value: "legB" });
        start.parameter({ name: "mode", value: "merge-detection" });
        start.parameter({ name: "token", value: streamToken(sid) });
        const session = sid ? await vs.findSession(sid) : null;
        if (session?.guarded) {
          // Join the browser caller in the live conference (Leg B = anchor).
          serveBridgeConference(vr, sid, "legB");
        } else {
          // Non-guarded sessions have no live bridge party: hold silently
          // while the relay monitors; the state machine ends the call.
          vr.pause({ length: 30 });
          vr.redirect({ method: "POST" }, vs.twimlUrl("leg-b-hold", sid));
        }
        break;
      }

      case "leg-b-hold": {
        // Non-guarded Leg B park loop (replaces the removed record-chunk
        // fallback): the relay's inbound stream keeps monitoring while Leg B
        // waits. Terminal sessions hang up immediately.
        const session = sid ? await vs.findSession(sid) : null;
        if (!session || vs.isTerminal(session)) {
          vr.hangup();
          break;
        }
        vr.pause({ length: 30 });
        vr.redirect({ method: "POST" }, vs.twimlUrl("leg-b-hold", sid));
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
    // NEVER return an empty TwiML document from a live call's fetch: Twilio
    // treats "no verbs" as an immediate hangup, so any transient error (DB
    // hiccup, slow query, cold dependency) used to KILL the call mid-flow —
    // the "drops randomly" symptom. Pause briefly and re-fetch this exact
    // document instead: a transient error becomes a 2s silence and the call
    // survives. (Terminal notify-* kinds add no failure-prone work before
    // their Say/Hangup, so they never land here with an empty document.)
    try {
      vr.pause({ length: 2 });
      vr.redirect({ method: "POST" }, c.req.url);
    } catch {
      /* ignore — vr stays whatever it was */
    }
  }
  return xml(c, vr);
}

/* -------------------------------------------------------------------------- */
/* Status callbacks → state machine                                            */
/* -------------------------------------------------------------------------- */

const LEGS = new Set(["caller", "legA", "legB", "ringTest"]);

export async function verificationStatusHandler(c: Context) {
  if (!(await twilioSignatureOk(c))) return c.text("forbidden", 403);
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
  if (!(await twilioSignatureOk(c))) return c.text("forbidden", 403);
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
        // GUARDED MODE ONLY: press-1 → save-only voice-ID phrase. The
        // recording is captured as call-review evidence (voiceprint profile
        // built, capture stamped on the session) but NEVER verified — no
        // phrase match, no voice matching, no wait loop. The
        // /api/verify/voiceprint action hands the callee STRAIGHT to the
        // second press-1 gather; the verbs after <Record> are only a
        // fallback for a failed action fetch and land in the same place.
        const P = vs.verifyPrompts();
        vr.say(P.voiceId);
        vr.record({
          maxLength: 8,
          timeout: 3,
          playBeep: true,
          action: vs.voiceprintUrl(sid),
          method: "POST",
        });
        vr.redirect({ method: "POST" }, vs.twimlUrl("leg-a-ready", sid));
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
    // Never empty-TwiML a live call (empty doc = instant hangup). Re-serve
    // the CURRENT IVR step after a short pause — same attempt counter.
    try {
      vr.pause({ length: 2 });
      vr.redirect({ method: "POST" }, withAttempt(vs.twimlUrl("leg-a", sid), a));
    } catch {
      /* ignore */
    }
  }
  return xml(c, vr);
}

export async function verificationGatherLegAReadyHandler(c: Context) {
  if (!(await twilioSignatureOk(c))) return c.text("forbidden", 403);
  const sid = c.req.query("sid") ?? "";
  const a = attemptFrom(c);
  const vr = new VoiceResponse();
  try {
    const body = await c.req.parseBody();
    const digits = String(body.Digits ?? "");

    if (digits === "1") {
      // Callee ready. GUARDED MODE: this second press-1 is the explicit
      // second-call trigger — Leg B is originated here, after the save-only
      // voice-ID recording. There is NO voice-ID verdict gate: the phrase is
      // captured as evidence only, so the press always proceeds.
      const P = vs.verifyPrompts();
      await vs.onCalleeReady(sid);
      // Tell the callee the bridge is being set up before parking them.
      vr.say(P.calleeConnectWait);
      vr.pause({ length: 60 });
      vr.redirect({ method: "POST" }, vs.legAHoldUrl(sid));
    } else {
      vr.redirect({ method: "POST" }, withAttempt(vs.twimlUrl("leg-a-ready", sid), a + 1));
    }
  } catch (err) {
    console.error("[verify] leg-a-ready gather error:", err);
    // Never empty-TwiML a live call — re-serve the current step (same
    // attempt counter) after a short pause.
    try {
      vr.pause({ length: 2 });
      vr.redirect({ method: "POST" }, withAttempt(vs.twimlUrl("leg-a-ready", sid), a));
    } catch {
      /* ignore */
    }
  }
  return xml(c, vr);
}

/* -------------------------------------------------------------------------- */
/* GUARDED MODE ONLY: voiceprint <Record> action                               */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/verify/voiceprint?sid=… — action of the guarded save-only
 * voice-ID <Record> ("my voice identifies me"). The capture is stamped on the
 * session (markVoiceIdCaptured → voiceIdCapturedAt + voiceIdRecordingSid,
 * valid the same UTC calendar day only) and the recording is processed
 * fire-and-forget (voiceprint profile built + clip persisted for call
 * review). NO voice matching, NO phrase verification, NO wait loop: the
 * callee is served the second press-1 gather IMMEDIATELY, and Leg B is
 * originated only by that press through gather/leg-a-ready → onCalleeReady().
 */
export async function verificationVoiceprintHandler(c: Context) {
  if (!(await twilioSignatureOk(c))) return c.text("forbidden", 403);
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

    const recordingSid = String(body.RecordingSid ?? "");
    await vs.markVoiceIdCaptured(sid, recordingSid);
    console.log(`[verify] VOICE_ID_CAPTURE session=${sid} recordingSid=${recordingSid || "(none)"}`);
    void processVoiceprint(sid, { recordingUrl, durationSec, callSid }).catch(
      (err) => console.error("[verify] voiceprint processing error:", err),
    );
    // Proceed IMMEDIATELY: serve the second press-1 gather (the only path to
    // Leg B). Save-only voice ID has no verdict to wait for.
    const P = vs.verifyPrompts();
    const gather = vr.gather({
      numDigits: 1,
      timeout: IVR_GATHER_TIMEOUT,
      action: vs.gatherLegAReadyUrl(sid, 0),
      method: "POST",
    });
    gather.say(P.secondCall);
    vr.redirect({ method: "POST" }, withAttempt(vs.twimlUrl("leg-a-ready", sid), 1));
  } catch (err) {
    console.error("[verify] voiceprint handler error:", err);
    // Never hang up on a transient error here — that used to kill the callee
    // leg mid voice-ID. Hand the callee to the second press-1 step: save-only
    // voice ID never blocks the flow, so proceeding is the designed recovery
    // for a lost voice-ID action.
    try {
      vr.pause({ length: 2 });
      vr.redirect({ method: "POST" }, vs.twimlUrl("leg-a-ready", sid));
    } catch {
      /* ignore */
    }
  }
  return xml(c, vr);
}

/**
 * Fetch + analyze the save-only voice-ID recording and persist the clip for
 * call review. The voiceprint profile is BUILT (VOICEPRINT_CAPTURED evidence
 * with VAD/voiced-frame stats) but NEVER matched against anything. Best-
 * effort: a missed/unusable recording never blocks second-call verification
 * or the eventual bridge.
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
  if (hasRecording) {
    try {
      const profile = await fetchVoiceProfile(pending.recordingUrl);
      // VAD speech seconds (512-sample hop @ 8 kHz = 64 ms/frame) — evidence
      // only; no strength gate is applied to a save-only capture.
      const speechSec = profile.vad.speechFrames.length * 0.064;
      await vs.logEvent(
        sid,
        "VOICEPRINT_CAPTURED",
        `recording=${pending.recordingUrl} duration=${pending.durationSec}s callSid=${pending.callSid} ` +
          `speechFrames=${profile.vad.speechFrames.length} speechSec=${speechSec.toFixed(2)} voicedFrames=${profile.voicePrint.voicedFrames} — save-only voice-ID phrase (no matching)`,
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
      `recording=${pending.recordingUrl || "(none)"} duration=${pending.durationSec ?? 0}s — save-only voice-ID phrase, no usable audio`,
    );
  }
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
  if (!(await twilioSignatureOk(c))) return c.text("forbidden", 403);
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
    // Never empty-TwiML a live Leg B call. Re-POST to this same gather
    // endpoint (no Digits) after a short pause — the timeout branch then
    // re-arms the merge listener (or hangs up cleanly if terminal).
    try {
      vr.pause({ length: 2 });
      vr.redirect({ method: "POST" }, c.req.url);
    } catch {
      /* ignore */
    }
  }
  return xml(c, vr);
}

/**
 * POST /api/verify/sms/inbound — inbound SMS webhook for the two-way AI SMS
 * reply channel (the upgrade the Asterisk version never had). Two provider
 * formats are accepted:
 *   - Twilio (default): the number's "A message comes in" webhook — form posts
 *     with From/To/Body, optionally signed (X-Twilio-Signature);
 *   - Crazytel: Virtual Mobile Number "JSON Web Request" — JSON
 *     {"from":"+614…","to":"+614…","text":"iphone 13"}.
 * The reply itself is a model-specific call-waiting walkthrough (see
 * vs.handleInboundSms).
 *
 * Auth (first match wins):
 *   1. SMS_INBOUND_TOKEN set → ?token= query must match (works for both
 *      providers — put the token in the webhook URL you give them);
 *   2. otherwise, an X-Twilio-Signature header is cryptographically validated
 *      against the request URL + form params (invalid → 403);
 *   3. otherwise the request is accepted unsigned (Crazytel cannot sign).
 * Processing errors always return 200 so providers don't retry-storm us.
 */
export async function verificationSmsInboundHandler(c: Context) {
  // 1) Parse (JSON = Crazytel; form = Twilio). Hono caches the body, so the
  //    parsed form is reused for signature validation below.
  let from = "";
  let text = "";
  let formParams: Record<string, string> | null = null;
  if ((c.req.header("Content-Type") ?? "").includes("application/json")) {
    try {
      const body = (await c.req.json()) as { from?: string; text?: string; message?: string };
      from = String(body.from ?? "");
      text = String(body.text ?? body.message ?? "");
    } catch {
      /* fall through to validation */
    }
  } else {
    try {
      const form = await c.req.parseBody();
      formParams = {};
      for (const [k, v] of Object.entries(form)) {
        if (typeof v === "string") formParams[k] = v;
      }
      // Twilio posts capitalised From/Body; Crazytel-style forms use lowercase.
      from = String(form.From ?? form.from ?? "");
      text = String(form.Body ?? form.text ?? form.message ?? "");
    } catch {
      /* fall through to validation */
    }
  }

  // 2) Auth
  const expected = process.env.SMS_INBOUND_TOKEN;
  if (expected) {
    if (c.req.query("token") !== expected) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
  } else {
    const sig = c.req.header("X-Twilio-Signature");
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const base = process.env.PUBLIC_BASE_URL;
    if (sig && authToken && base) {
      const raw = new URL(c.req.url);
      const url = `${base.replace(/\/$/, "")}${raw.pathname}${raw.search}`;
      if (!twilio.validateRequest(authToken, sig, url, formParams ?? {})) {
        return c.json({ ok: false, error: "invalid signature" }, 403);
      }
    }
  }

  // 3) Validate + handle
  if (!from || !text) {
    return c.json({ ok: false, error: "missing from/text" }, 400);
  }
  try {
    const result = await vs.handleInboundSms(from, text);
    // Twilio expects TwiML; an empty <Response/> means "no auto-reply SMS"
    // (we reply ourselves via REST). JSON keeps Crazytel/simple probes happy.
    if (formParams) {
      return c.body("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response/>", 200, {
        "Content-Type": "application/xml",
      });
    }
    return c.json({ ok: true, result });
  } catch (err) {
    console.error("[verify] SMS_INBOUND_ERROR", err);
    if (formParams) {
      return c.body("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response/>", 200, {
        "Content-Type": "application/xml",
      });
    }
    return c.json({ ok: false, error: "internal" }, 200);
  }
}

/**
 * POST /api/verify/conference?sid=… — bridge conference status callback.
 * Twilio posts conference-start / conference-end / participant-join /
 * participant-leave with the participant's CallSid. This is the bridge
 * supervisor's ground truth: which party actually JOINED the room (the join
 * watchdog re-redirects a leg that never did) and who LEFT (the drop-recall
 * path). Every event lands on the session timeline, so a live call can be
 * diagnosed from the dashboard instead of guesswork.
 */
export async function verificationConferenceHandler(c: Context) {
  if (!(await twilioSignatureOk(c))) return c.text("forbidden", 403);
  try {
    const sid = c.req.query("sid") ?? "";
    const body = await c.req.parseBody();
    const event = String(body.StatusCallbackEvent ?? "");
    const callSid = String(body.CallSid ?? "");
    const confSid = String(body.ConferenceSid ?? "");
    if (!sid) return c.text("ok", 200);

    if (event === "participant-join" && callSid) {
      vs.noteConferenceJoin(sid, callSid);
      const session = await vs.findSession(sid);
      const leg =
        session?.callerCallSid === callSid
          ? "caller"
          : session?.legACallSid === callSid
            ? "legA"
            : session?.legBCallSid === callSid
              ? "legB"
              : "unknown";
      await vs.logEvent(sid, "CONF_PARTICIPANT_JOINED", `leg=${leg} sid=${callSid} conf=${confSid}`);
    } else if (event === "participant-leave" && callSid) {
      vs.noteConferenceLeave(sid, callSid);
      const session = await vs.findSession(sid);
      const leg =
        session?.callerCallSid === callSid
          ? "caller"
          : session?.legACallSid === callSid
            ? "legA"
            : session?.legBCallSid === callSid
              ? "legB"
              : "unknown";
      await vs.logEvent(sid, "CONF_PARTICIPANT_LEFT", `leg=${leg} sid=${callSid} conf=${confSid}`);
    } else if (event === "conference-start") {
      await vs.logEvent(sid, "CONF_STARTED", `conf=${confSid}`);
    } else if (event === "conference-end") {
      await vs.logEvent(sid, "CONF_ENDED", `conf=${confSid}`);
    }
    return c.text("ok", 200);
  } catch (err) {
    console.error("[verify] conference status error:", err);
    return c.text("ok", 200); // never error Twilio on a status callback
  }
}

/**
 * GET /api/verify/version — deployment marker so we can always tell WHICH
 * code the live service is running (Render injects RENDER_GIT_COMMIT).
 */
export async function verificationVersionHandler(c: Context) {
  return c.json({
    commit: process.env.RENDER_GIT_COMMIT ?? "unknown",
    branch: process.env.RENDER_GIT_BRANCH ?? "unknown",
    service: process.env.RENDER_SERVICE_NAME ?? "local",
    time: new Date().toISOString(),
  });
}
