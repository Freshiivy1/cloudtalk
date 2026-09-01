/**
 * Twilio Voice integration — the REAL telephony provider backend.
 *
 * - `generateVoiceToken(identity)` — mints a Twilio Access Token with a Voice
 *   grant so the browser SDK (@twilio/voice-sdk) can place/receive calls.
 * - `voiceWebhookHandler` — Twilio fetches this URL (configured on the TwiML
 *   App) when the browser dials; we respond with TwiML <Dial> to the target.
 * - `statusCallbackHandler` — Twilio posts call lifecycle events here; each is
 *   funneled into the shared `call_events` stream via logCallEvent(), so real
 *   calls feed history, monitoring and the future live-analysis dock exactly
 *   like simulated ones.
 *
 * All credentials come from env (TWILIO_*) — never shipped to the browser.
 */
import twilio from "twilio";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import * as schema from "@db/schema";
import { getDbOrNull } from "./queries/connection";
import { logCallEvent } from "./simulator";

function cfg() {
  const e = process.env;
  return {
    accountSid: e.TWILIO_ACCOUNT_SID ?? "",
    authToken: e.TWILIO_AUTH_TOKEN ?? "",
    apiKeySid: e.TWILIO_API_KEY_SID ?? "",
    apiKeySecret: e.TWILIO_API_KEY_SECRET ?? "",
    twimlAppSid: e.TWILIO_TWIML_APP_SID ?? "",
    callerId: e.TWILIO_CALLER_ID ?? "",
  };
}

export function twilioConfigured(): boolean {
  const c = cfg();
  return Boolean(
    c.accountSid && c.authToken && c.apiKeySid && c.apiKeySecret && c.twimlAppSid,
  );
}

/** Twilio REST credentials (account SID + auth token) — enough for calls.create/update. */
export function twilioRestConfigured(): boolean {
  const c = cfg();
  return Boolean(c.accountSid && c.authToken);
}

/** Verified PSTN caller ID used as `from` on outbound REST calls. */
export function twilioCallerId(): string {
  return cfg().callerId;
}

/**
 * Leg-aware caller ID. Leg B (the "second call") uses TWILIO_CALLER_ID_LEG_B
 * when set, so the callee never sees the same number calling twice in a row —
 * back-to-back calls from one number trip carrier/handset spam screening.
 * Falls back to TWILIO_CALLER_ID.
 */
export function twilioCallerIdFor(leg?: string): string {
  if (leg === "legB" && process.env.TWILIO_CALLER_ID_LEG_B?.trim()) {
    return process.env.TWILIO_CALLER_ID_LEG_B.trim();
  }
  return cfg().callerId;
}

let restClient: ReturnType<typeof twilio> | null = null;

/**
 * Shared Twilio REST client for outbound call orchestration (verification
 * engine). Throws when TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are missing.
 */
export function getTwilioClient(): ReturnType<typeof twilio> {
  const c = cfg();
  if (!c.accountSid || !c.authToken) {
    throw new Error(
      "Twilio REST credentials not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)",
    );
  }
  if (!restClient) restClient = twilio(c.accountSid, c.authToken);
  return restClient;
}

/** Mint a Voice access token for a logged-in user (identity = user id). */
export function generateVoiceToken(identity: string): string {
  const c = cfg();
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const grant = new VoiceGrant({
    outgoingApplicationSid: c.twimlAppSid,
    incomingAllow: true,
  });
  const token = new AccessToken(c.accountSid, c.apiKeySid, c.apiKeySecret, {
    identity,
    ttl: 3600,
  });
  token.addGrant(grant);
  return token.toJwt();
}

/**
 * TwiML App voice webhook. The browser SDK passes the dialed number as the
 * `To` parameter; we bridge to the PSTN with our caller ID.
 */
export async function voiceWebhookHandler(c: Context) {
  const body = await c.req.parseBody();
  const to = String(body.To ?? "");
  const { callerId } = cfg();

  const VoiceResponse = twilio.twiml.VoiceResponse;
  const vr = new VoiceResponse();

  // GUARDED INMATE CALL: the softphone placed an OUTBOUND SDK call carrying
  // the verification sessionId as the `guarded` custom param (the `To` param
  // is unused in this branch). Validate + advance the engine (stores the
  // caller CallSid, INITIATED → CALLER_HOLDING, originates Leg A), then park
  // the caller in the session conference exactly like the caller-hold TwiML.
  // Dynamic import: verification.ts already imports this module statically.
  const guardedSid = String(body.guarded ?? "").trim();
  if (guardedSid) {
    const vs = await import("./verification");
    try {
      vs.setRuntimeBaseUrl(new URL(c.req.url).origin);
    } catch {
      /* ignore */
    }
    let ok = false;
    try {
      ok = await vs.onGuardedCallerConnected(guardedSid, String(body.CallSid ?? ""));
    } catch (err) {
      console.error("[twilio] guarded caller connect error:", err);
    }
    if (ok) {
      const P = vs.verifyPrompts();
      vr.say(P.callerConnect);
      vr.dial().conference(
        { beep: "false", startConferenceOnEnter: false, endConferenceOnExit: false },
        vs.conferenceName(guardedSid),
      );
    } else {
      vr.say(vs.verifyPrompts().failed);
      vr.hangup();
    }
    return c.text(vr.toString(), 200, { "Content-Type": "text/xml" });
  }

  if (/^\+?\d{7,15}$/.test(to)) {
    vr.dial({ callerId: callerId || undefined, answerOnBridge: true }).number(
      to.startsWith("+") ? to : `+${to}`,
    );
  } else {
    vr.say("Sorry, that number cannot be completed as dialed.");
  }
  return c.text(vr.toString(), 200, { "Content-Type": "text/xml" });
}

const STATUS_MAP: Record<string, string> = {
  ringing: "call_ringing",
  "in-progress": "call_active",
  completed: "call_ended",
  busy: "call_ended",
  "no-answer": "call_ended",
  failed: "call_ended",
  canceled: "call_ended",
};

/**
 * Twilio status callback → our event stream. Matches the call row by the
 * `cloudtalkCallId` param we attach on connect (or falls back to latest live
 * call for the caller). Best-effort — never throws back at Twilio.
 */
export async function statusCallbackHandler(c: Context) {
  try {
    const body = await c.req.parseBody();
    const callSid = String(body.CallSid ?? "");
    const status = String(body.CallStatus ?? "");
    const ourId = Number(body.cloudtalkCallId ?? 0);
    const type = STATUS_MAP[status] ?? `twilio_${status}`;

    const db = getDbOrNull();
    if (!db) return c.text("ok"); // history optional; never fail Twilio callbacks

    // Prefer the explicit cloudtalkCallId, but also support Twilio SID matching
    // for REST-originated calls where the callback only carries CallSid.
    let callId = ourId;
    if (!callId && callSid) {
      const rows = await db
        .select({ id: schema.calls.id })
        .from(schema.calls)
        .where(eq(schema.calls.twilioSid, callSid))
        .limit(1);
      callId = Number(rows.at(0)?.id ?? 0);
    }

    if (callId) {
      await logCallEvent(callId, type, { twilioSid: callSid, status });
      if (status === "completed" || status === "busy" || status === "no-answer" || status === "failed") {
        const duration = Number(body.CallDuration ?? 0);
        await db
          .update(schema.calls)
          .set({
            status: status === "completed" ? "completed" : "failed",
            endedAt: new Date(),
            durationSec: duration,
          })
          .where(eq(schema.calls.id, callId));
      }
    }
  } catch (err) {
    console.error("[twilio] status callback error:", err);
  }
  return c.text("ok");
}
