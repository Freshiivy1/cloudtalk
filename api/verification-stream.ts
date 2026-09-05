/**
 * CallVerify port — merge detection via Twilio Media Streams + Goertzel DSP.
 *
 * Why this exists: Twilio's <Gather> only hears DTMF sent as RFC2833
 * telephone-event *signaling*. When a callee merges calls on their mobile,
 * the phone mixes raw AUDIO — so an in-band tone crossing the merge arrives
 * at Twilio as plain audio and <Gather> never fires (proven in live test 5:
 * the callee heard the tone on both calls, zero digits captured).
 *
 * The Asterisk original solved this with its own DSP tone detector. We do the
 * same: Leg B's TwiML opens a <Start><Stream> to this WebSocket endpoint and
 * we run a Goertzel detector for the DTMF '9' pair (852 Hz + 1336 Hz) over
 * the inbound audio track. The instant the tone leaks across a merge, we fire
 * onMergeDetected() and redirect Leg B to the verdict TwiML.
 *
 * Wire-up: api/boot.ts attaches attachVerificationStreamServer() to the HTTP
 * server in production. TWO in-process streams connect here, both identified
 * EXCLUSIVELY by <Start><Stream> customParameters (sid / leg / purpose /
 * token) — Twilio does NOT deliver query parameters on Stream URLs:
 *  - Leg A (callee), purpose=hold-canary: the HoldDetector watches the callee
 *    uplink for the Call Waiting hold signature (pure state telemetry —
 *    drives NO audio since the legacy in-call merge-tone path was removed).
 *  - Leg B (live call), purpose=speakerphone: the relayguard SpeakerphoneDetector
 *    on Leg B's inbound audio — speakerphone relay audio enters the ACTIVE
 *    Leg B microphone, so it is detectable ONLY here (Leg A is on hold).
 * Merge detection runs ONLY in the authorised direction: the external merge
 * relay (VERIFY_STREAM_URL) listens on Leg B's inbound stream for Leg A's
 * own prompt/watermark/loud tone crossing over after a physical merge. Leg B
 * never has a detection tone played INTO it.
 */
import type { Server as HttpServer, IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { Context } from "hono";
import { createHmac, timingSafeEqual } from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import * as vs from "./verification";
import { getTwilioClient } from "./twilio-voice";
import { SpeakerphoneDetector } from "./relayguard/speakerphone-detector";
import { HoldDetector } from "./relayguard/hold-detector";

/* -------------------------------------------------------------------------- */
/* Cross-service contract (cloudtalk ↔ merge relay)                             */
/* -------------------------------------------------------------------------- */

/** Shared-secret check used by every relay → cloudtalk callback. */
function relayAuthorized(c: Context): boolean {
  const secret = process.env.VERIFY_STREAM_SECRET;
  return Boolean(secret) && c.req.header("x-verify-secret") === secret;
}

/**
 * Per-session stream token placed in Leg B's <Start><Stream> as
 * <Parameter name="token">: hex(HMAC-SHA256(key=VERIFY_STREAM_SECRET,
 * message="merge-relay-stream:" + sid)). The relay recomputes it and rejects
 * missing/invalid tokens with WS close 4403. The raw secret never travels
 * inside TwiML.
 */
export function streamToken(sessionId: string): string {
  const secret = process.env.VERIFY_STREAM_SECRET ?? "";
  return createHmac("sha256", secret)
    .update(`merge-relay-stream:${sessionId}`)
    .digest("hex");
}

/**
 * Constant-time validation of a stream's `token` customParameter against the
 * per-session HMAC (same scheme semantics as the merge relay: missing secret,
 * sid or token is invalid; mismatches rejected). Used by the in-process
 * WebSocket start handler — the raw secret never travels inside TwiML.
 */
export function streamTokenValid(sid: string, token: unknown): boolean {
  const secret = process.env.VERIFY_STREAM_SECRET ?? "";
  if (!secret || !sid || typeof token !== "string" || !token) return false;
  const expected = Buffer.from(streamToken(sid), "utf8");
  const actual = Buffer.from(token, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * POST /api/verify/stream-detected — relay callback: the detector fired.
 * JSON body { sid, verdict: "MERGE_DETECTED", phase: "PROMPT_LIGHT" |
 * "LOUD_DTMF", detectedAt, evidence }. Both phases are independent and final:
 * Phase 1 fired only on prompt fingerprint AND overlapping light DTMF, Phase
 * 2 on the loud tone alone — cloudtalk trusts the relay's phase decision and
 * applies the standard merge verdict + teardown. Idempotent via the
 * terminal-state guard in onMergeDetected.
 */
export async function verificationStreamDetectedHandler(c: Context) {
  if (!relayAuthorized(c)) return c.text("forbidden", 403);
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    /* sid may still arrive via the legacy query param */
  }
  const sid = String(body.sid ?? c.req.query("sid") ?? "");
  if (!sid) return c.text("ok", 200);
  try {
    const phase = String(body.phase ?? "");
    const evidence = body.evidence ? JSON.stringify(body.evidence) : "";
    await vs.logEvent(
      sid,
      "STREAM_DETECTED_CALLBACK",
      `phase=${phase || "n/a"} detectedAt=${String(body.detectedAt ?? "")} evidence=${evidence}`.slice(0, 512),
    );
    await fireMergeDetected(sid);
  } catch (err) {
    console.error("[verify-stream] callback fire error:", err);
  }
  return c.text("ok", 200);
}

/**
 * POST /api/verify/stream-ready — relay callback: the Leg B inbound stream
 * is live and the detector armed. Body { sid, streamSid, readyAt }. The Leg A
 * challenge starts ONLY here (vs.onStreamReady). When the challenge cannot be
 * started (e.g. the Leg A redirect failed) we answer 500 so the relay's
 * bounded retry delivers it again — no silent success.
 */
export async function verificationStreamReadyHandler(c: Context) {
  if (!relayAuthorized(c)) return c.text("forbidden", 403);
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const sid = String(body.sid ?? "");
  if (!sid) return c.json({ ok: false, error: "missing sid" }, 400);
  try {
    const r = await vs.onStreamReady(
      sid,
      String(body.streamSid ?? ""),
      body.readyAt ? String(body.readyAt) : undefined,
    );
    if (!r.ok) {
      return c.json({ ok: false, error: r.reason }, 500);
    }
    return c.json({ ok: true, reason: r.reason }, 200);
  } catch (err) {
    console.error("[verify-stream] stream-ready handler error:", err);
    return c.json({ ok: false, error: "internal" }, 500);
  }
}

/**
 * POST /api/verify/stream-failed — relay callback: the stream/detector
 * failed, timed out, or stopped before a verdict. Body { sid, verdict:
 * "DETECTION_FAILED" | "DETECTION_INCONCLUSIVE", reason, failedAt }. The
 * outcome is NEVER a pass.
 */
export async function verificationStreamFailedHandler(c: Context) {
  if (!relayAuthorized(c)) return c.text("forbidden", 403);
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const sid = String(body.sid ?? "");
  if (!sid) return c.json({ ok: false, error: "missing sid" }, 400);
  const verdict =
    String(body.verdict ?? "") === "DETECTION_INCONCLUSIVE"
      ? ("DETECTION_INCONCLUSIVE" as const)
      : ("DETECTION_FAILED" as const);
  const reason = String(body.reason ?? "relay reported stream failure").slice(0, 400);
  try {
    await vs.onStreamFailed(sid, verdict, reason);
  } catch (err) {
    console.error("[verify-stream] stream-failed handler error:", err);
  }
  // Always 200 once authenticated: the terminal state is idempotent, and a
  // 4xx/5xx would only trigger pointless retries of an already-final outcome.
  return c.json({ ok: true }, 200);
}

/** True when the external merge relay is configured (VERIFY_STREAM_URL). */
export function relayConfigured(): boolean {
  const u = process.env.VERIFY_STREAM_URL?.trim();
  return Boolean(u && /^wss:\/\//.test(u));
}

/**
 * wss:// URL for the external relay, or null when not configured. The stream
 * identity travels EXCLUSIVELY in <Start><Stream> customParameters (sid, leg,
 * mode, token) — no query-string session id is added or relied upon.
 */
export function relayStreamUrl(): string | null {
  const u = process.env.VERIFY_STREAM_URL?.trim();
  if (!u || !/^wss:\/\//.test(u)) return null;
  return u;
}

/** HTTPS base of the relay (derived from VERIFY_STREAM_URL). */
function relayHttpBase(): string | null {
  const u = process.env.VERIFY_STREAM_URL?.trim();
  if (!u || !/^wss:\/\//.test(u)) return null;
  try {
    // Preserve the complete host (the previous regex stripped from the
    // scheme's // and produced https:/path). Path/query belong only to the WS.
    return new URL(u.replace(/^wss:/, "https:")).origin;
  } catch {
    return null;
  }
}

/**
 * HTTPS URL of the relay's /arm endpoint. The app POSTs
 * { sid, legA, legB, mode, tone: { low: 852, high: 1336 },
 *   promptLightDurationMs, promptEndsAt } here when originating Leg B.
 */
export function relayArmUrl(): string | null {
  const base = relayHttpBase();
  return base ? `${base}/arm` : null;
}

/** HTTPS URL of the relay's /challenge-start endpoint. */
export function relayChallengeStartUrl(): string | null {
  const base = relayHttpBase();
  return base ? `${base}/challenge-start` : null;
}

/* -------------------------------------------------------------------------- */
/* Relay cold-start mitigation (Render free tier sleeps after 15 min idle)      */
/* -------------------------------------------------------------------------- */

/** Injectable fetch for the warm-up ping (tests). null restores global fetch. */
let warmupFetch: typeof fetch | null = null;
export function setRelayWarmupFetch(f: typeof fetch | null): void {
  warmupFetch = f;
}

/**
 * Best-effort GET to the relay's /health to start waking a sleeping Render
 * instance (~22s cold start). Fired when a verification session is initiated
 * (INITIATED / CALLER_HOLDING, before Leg A) so the relay is warm by the time
 * Leg B is originated and the readiness deadline starts. NEVER blocks or
 * fails the call: errors are logged and swallowed. No-op when the relay is
 * not configured.
 */
export function wakeRelay(): void {
  const base = relayHttpBase();
  if (!base) return;
  const f = warmupFetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  timer.unref?.();
  void Promise.resolve(f(`${base}/health`, { signal: controller.signal }))
    .then(() => console.log(`[verify-stream] relay warm-up ping sent (${base}/health)`))
    .catch((err) =>
      console.warn(
        `[verify-stream] relay warm-up ping failed (${base}/health):`,
        err instanceof Error ? err.message : err,
      ),
    )
    .finally(() => clearTimeout(timer));
}

export interface RelayPostResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Authenticated JSON POST to the relay with a per-attempt timeout and bounded
 * retries with backoff. 4xx is permanent (no retry); network errors, timeouts
 * and 5xx are retried. Never throws — the caller decides what a failure means
 * (and it must never become a silent success).
 */
export async function postRelayJson(
  url: string,
  body: unknown,
  opts: { attempts?: number; timeoutMs?: number } = {},
): Promise<RelayPostResult> {
  const secret = process.env.VERIFY_STREAM_SECRET ?? "";
  const attempts = Math.max(1, Math.min(opts.attempts ?? 2, 5));
  const timeoutMs = opts.timeoutMs ?? 5_000;
  let last: RelayPostResult = { ok: false, error: "no attempt made" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-verify-secret": secret },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok) return { ok: true, status: res.status };
      last = { ok: false, status: res.status, error: (await res.text().catch(() => "")).slice(0, 200) };
      if (res.status >= 400 && res.status < 500) return last; // permanent
    } catch (err) {
      last = {
        ok: false,
        error: controller.signal.aborted
          ? `timeout after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) {
      await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** (attempt - 1), 2000)));
    }
  }
  return last;
}

/* -------------------------------------------------------------------------- */
/* DSP — μ-law decode + Goertzel (pure functions, unit-tested)                  */
/* -------------------------------------------------------------------------- */

const SAMPLE_RATE = 8000;

/** Decode one μ-law byte to a 16-bit PCM sample. */
export function decodeMulaw(u: number): number {
  u = ~u & 0xff;
  let t = ((u & 0x0f) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  return (u & 0x80) ? 0x84 - t : t - 0x84;
}

/** Goertzel power of `freq` over the given PCM window. */
export function goertzelPower(samples: ArrayLike<number>, freq: number): number {
  const w = (2 * Math.PI * freq) / SAMPLE_RATE;
  const cw = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s0 = samples[i] + cw * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - cw * s1 * s2;
}

/** Mean-square signal energy of a PCM window. */
export function windowEnergy(samples: ArrayLike<number>): number {
  let e = 0;
  for (let i = 0; i < samples.length; i++) e += samples[i] * samples[i];
  return e / samples.length;
}

/* -------------------------------------------------------------------------- */
/* WebSocket server                                                             */
/* -------------------------------------------------------------------------- */

export const STREAM_PATH = "/api/verify/stream";

/**
 * wss:// URL of the IN-PROCESS media-stream endpoint, shared by the Leg A
 * hold-canary stream and the Leg B speakerphone stream. BARE URL — NO query
 * string: Twilio does not deliver query parameters on Stream URLs (production
 * showed `connected sid=` blank and SESSION_NOT_FOUND forever). Stream
 * identity travels EXCLUSIVELY in <Start><Stream> customParameters (sid /
 * leg / purpose / token) and is authenticated by streamTokenValid().
 */
export function inProcessStreamUrl(): string | null {
  const base = vs.getPublicBaseUrl();
  if (!base) return null;
  return `${base.replace(/^http/, "ws")}${STREAM_PATH}`;
}

/**
 * SpeakerphoneDetector.onSuspicious handler (exported for tests): route a
 * detector emission into the strike ladder. On episode ONSET the canary
 * loud-tone loop is silenced FIRST (its acoustic leak can false-fire the
 * relay's loud-tone listener mid-episode and kill the call with the wrong
 * reason). Late frames for terminal/missing sessions are ignored.
 *
 * STRIKE LADDER: `episodeStart` (true on the FIRST emission of a new
 * episode — one continuous suspicious period = ONE strike, refires are
 * no-ops) drives injectSpeakerphoneChallenge in verification.ts: strikes
 * 1–2 are recorded silently, strike 3 is the warning flag (mute → warning
 * to the conference → unmute → resume), strike 4 is the supreme flag.
 */
export function handleSpeakerphoneSuspicious(
  sid: string,
  score: number,
  detail: string,
  episodeStart: boolean,
): void {
  console.warn(
    `[verify-stream] SPEAKERPHONE SUSPECTED sid=${sid} score=${score.toFixed(2)} episodeStart=${episodeStart} ${detail}`,
  );
  void (async () => {
    // On episode onset, silence the canary loud-tone loop FIRST (regardless
    // of merge-system suppression below): while relay audio is present, the
    // loud tone's acoustic leak can false-fire the relay's loud-tone listener
    // and kill the call with the wrong reason.
    if (episodeStart) {
      vs.silenceCanaryLoudTone(sid).catch((err) =>
        console.error("[verify-stream] silenceCanaryLoudTone error:", err),
      );
    }
    const session = await vs.findSession(sid);
    // Terminal/missing sessions: ignore late detector frames (no strike
    // actions on a dead call).
    if (!session || vs.isTerminal(session)) {
      console.log(
        `[verify-stream] SPEAKERPHONE frame IGNORED sid=${sid} — session ${session?.state ?? "missing"} (terminal); late media-stream frame`,
      );
      return;
    }
    await vs.injectSpeakerphoneChallenge(
      sid,
      `score=${score.toFixed(2)} ${detail}`,
      episodeStart,
    );
  })().catch((err) => console.error("[verify-stream] injectSpeakerphoneChallenge error:", err));
}

/**
 * Stream purpose (customParameters `purpose`) → which detectors attach and
 * on which leg's audio:
 *  - "hold-canary" (leg=legA, callee uplink): HoldDetector second-call
 *    engagement (Call Waiting state telemetry — no audio). NO speakerphone
 *    analysis — after Leg B answers Leg A is HELD, so speakerphone relay
 *    audio never reaches this stream.
 *  - "speakerphone" (leg=legB, live-call inbound): the relayguard
 *    SpeakerphoneDetector. Speakerphone-relayed audio enters the ACTIVE
 *    Leg B microphone, so it is detectable ONLY on this stream. The stream
 *    is attached at Leg B ORIGINATION (initial leg-b TwiML) so the
 *    detector's calibration warm-up overlaps ring/setup time.
 */
export type StreamPurpose = "hold-canary" | "speakerphone";

/** Identity carried by <Start><Stream> customParameters. */
export interface StreamIdentity {
  sid: string;
  leg: "legA" | "legB";
  purpose: StreamPurpose;
}

const PURPOSE_LEG: Record<StreamPurpose, "legA" | "legB"> = {
  "hold-canary": "legA",
  speakerphone: "legB",
};

/**
 * Authenticate a media-stream `start` message. Canonical identification is
 * the nested Twilio customParameters ONLY (sid / leg / purpose / HMAC token)
 * — query-string session ids are never consulted (Twilio strips them).
 * Mirrors the merge relay's scheme: missing parameters → 4400, bad token →
 * 4403, and the socket is closed by the caller.
 */
export function authenticateStreamStart(
  start: { customParameters?: Record<string, unknown> } | undefined,
): { ok: true; identity: StreamIdentity } | { ok: false; code: number; reason: string } {
  const p = start?.customParameters;
  if (!p || typeof p !== "object" || Object.keys(p).length === 0) {
    return { ok: false, code: 4400, reason: "missing customParameters" };
  }
  const sid = String(p.sid ?? "");
  const leg = String(p.leg ?? "");
  const purpose = String(p.purpose ?? "") as StreamPurpose;
  const expectedLeg = PURPOSE_LEG[purpose];
  if (!sid || !expectedLeg || leg !== expectedLeg) {
    return {
      ok: false,
      code: 4400,
      reason: `invalid stream parameters (sid=${sid || "?"} leg=${leg || "?"} purpose=${purpose || "?"})`,
    };
  }
  if (!streamTokenValid(sid, p.token)) {
    return { ok: false, code: 4403, reason: `invalid stream token sid=${sid}` };
  }
  return { ok: true, identity: { sid, leg: expectedLeg, purpose } };
}

/**
 * Sessions with ACTIVE speakerphone suspicion (set by the Leg B
 * SpeakerphoneDetector's onSuspicious, cleared by onClean or stream close).
 * Membership BEFORE the add marks an episode ONSET — the strike ladder
 * counts exactly one strike per distinct episode (refires are no-ops).
 */
const speakerphoneSuspicion = new Set<string>();

/** True while the speakerphone detector is suspecting for this session. */
export function isSpeakerphoneSuspecting(sid: string): boolean {
  return speakerphoneSuspicion.has(sid);
}

/** Test hook: mark/unmark an active speakerphone episode for a session. */
export function __testSetSpeakerphoneSuspicion(sid: string, active: boolean): void {
  if (active) speakerphoneSuspicion.add(sid);
  else speakerphoneSuspicion.delete(sid);
}

/**
 * HoldDetector engage wiring (exported for tests). The engagement is
 * ordinary Call Waiting choreography (the callee put Leg A on hold to answer
 * Leg B) — recorded as call state and telemetry ONLY. The legacy merge-tone
 * beep this used to arm into Leg B was removed on 2026-09-05: nothing here
 * plays audio into any leg, and normal Call Waiting can never produce a
 * Leg B tone or a speakerphone strike.
 */
export function handleSecondCallEngaged(sid: string): void {
  console.log(`[verify-stream] SECOND CALL ENGAGED sid=${sid} — Call Waiting hold (state only)`);
  void vs
    .onSecondCallEngaged(sid)
    .catch((err) => console.error("[verify-stream] onSecondCallEngaged error:", err));
}

/** HoldDetector disengage wiring (exported for tests). */
export function handleSecondCallDisengaged(sid: string): void {
  console.log(`[verify-stream] SECOND CALL DISENGAGED sid=${sid}`);
  void vs
    .onSecondCallDisengaged(sid)
    .catch((err) => console.error("[verify-stream] onSecondCallDisengaged error:", err));
}

/** Detectors attached to one stream (at most one of sp/hold is set). */
interface StreamAnalyzers {
  sp: SpeakerphoneDetector | null;
  hold: HoldDetector | null;
}

/**
 * Live per-connection state, exposed for tests/inspection. Entries are added
 * on an authenticated `start` and removed on socket close.
 */
export interface ActiveStream extends StreamAnalyzers {
  sid: string;
  purpose: StreamPurpose;
  frames: number;
}
export const activeStreams = new Set<ActiveStream>();

/**
 * Build the relayguard analyzers for an authenticated stream, routed by
 * purpose (see StreamPurpose). Returns null — gracefully, no throw — when
 * the session is unknown or the lookup fails.
 */
async function buildAnalyzers(
  sid: string,
  purpose: StreamPurpose,
): Promise<StreamAnalyzers | null> {
  try {
    const session = await vs.findSession(sid);
    if (!session) return null; // caller fails CLOSED (VERIFY_STREAM_FAILED)
    const bridged = session.state === vs.VState.BRIDGED || vs.isBridgedSession(sid);
    if (purpose === "speakerphone") {
      const sp = new SpeakerphoneDetector({
      // 2 consecutive suspicious hops by default (0.5s sliding hop over the
      // trailing 1s window → the challenge fires 1.0–2.0s after relay audio
      // starts, inside the 2s pickup budget), env-tunable via
      // VERIFY_SPEAKERPHONE_ARM_WINDOWS. Arming requires verdict
      // 'SUSPICIOUS RELAY' AND a RED (>=0.6) relay fingerprint on every one
      // of those hops — AMBER never arms.
      consecutiveWindows: vs.speakerphoneArmWindows(),
        hopSec: vs.forensicsHopSec(),
        // Clearing requires 6 consecutive STRONGLY-CLEAN hops (MATCH+GREEN,
        // ≈3s of confirmed-normal audio) by default — borderline mid-episode
        // hops can no longer silence the challenge while the relay continues
        // (env VERIFY_SPEAKERPHONE_CLEAR_WINDOWS).
        cleanWindowsToClear: vs.speakerphoneClearWindows(),
        // Calibration warm-up after BRIDGED (default 2s): the detector
        // rebuilds its rolling baseline from live in-call audio and CANNOT
        // arm — normal conversation/ringback no longer false-arms the
        // forensic challenge seconds into the bridge. The stream attaches at
        // Leg B ORIGINATION, so this warm-up overlaps ring/setup time.
        warmupMs: vs.forensicsWarmupMs(),
        // D2: suspicion may only accumulate while BRIDGED — pre-bridge
        // windows (incl. the race between the actual bridge and the
        // bridged-flag refresh) never build a streak, so the warm-up can't
        // be outrun by false-RED windows.
        armOnlyWhenBridged: true,
        bridged,
        onSuspicious: (score, detail) => {
          // Episode onset = the FIRST emission while no episode is tracked.
          // Must be computed BEFORE adding to the set; the strike ladder
          // escalates only on episode onsets (refires just sustain the
          // current episode's challenge).
          const episodeStart = !speakerphoneSuspicion.has(sid);
          speakerphoneSuspicion.add(sid);
          handleSpeakerphoneSuspicious(sid, score, detail, episodeStart);
        },
        onClean: (detail) => {
          speakerphoneSuspicion.delete(sid);
          console.log(`[verify-stream] SPEAKERPHONE CLEARED sid=${sid} ${detail}`);
          void vs
            .onSpeakerphoneCleared(sid, detail)
            .catch((err) => console.error("[verify-stream] onSpeakerphoneCleared error:", err));
        },
      });
      return { sp, hold: null };
    }
    // hold-canary (Leg A uplink): second-call (call-waiting / add-call) hold
    // detector ONLY — speakerphone analysis lives on the Leg B stream. Armed
    // ONLY while the session is BRIDGED — the armed flag is refreshed from
    // the verification store on stream start and periodically thereafter
    // (see the connection handler). Engage/disengage are pure call-state
    // telemetry (Leg A legitimately held via Call Waiting) — they drive NO
    // audio since the legacy Leg B merge-tone path was removed.
    const hold = new HoldDetector({
      sessionId: sid,
      armed: bridged,
      onSecondCallEngaged: handleSecondCallEngaged,
      onSecondCallDisengaged: handleSecondCallDisengaged,
    });
    return { sp: null, hold };
  } catch (err) {
    console.error(`[verify-stream] session lookup failed sid=${sid} purpose=${purpose}:`, err);
    return null;
  }
}

/**
 * Attach the verification media-stream WebSocket endpoint to the HTTP server.
 * Twilio connects to the BARE wss://{PUBLIC_BASE_URL}/api/verify/stream —
 * identity arrives in the `start` message's customParameters (Twilio strips
 * query strings on Stream URLs).
 */
export function attachVerificationStreamServer(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== STREAM_PATH) return; // not ours — leave other upgrades alone
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    // Identity comes EXCLUSIVELY from the `start` message's customParameters
    // (sid / leg / purpose / token) — the connection is unidentified until an
    // authenticated start arrives, and pre-start audio is dropped. The old
    // ?sid= query-string identity is GONE (Twilio strips query strings on
    // Stream URLs, so it never arrived in production).
    let state: ActiveStream | null = null;
    // Frames since the detectors' armed/bridged flags were last refreshed
    // from the verification store (armed only while the session is BRIDGED).
    let sinceArmedRefresh = 0;
    console.log("[verify-stream] connected (awaiting authenticated start)");

    ws.on("message", (data: Buffer) => {
      let msg: {
        event?: string;
        media?: { track?: string; payload?: string };
        start?: {
          callSid?: string;
          streamSid?: string;
          customParameters?: Record<string, unknown>;
        };
      };
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (msg.event === "start") {
        if (state) return; // already identified — ignore duplicate starts
        const auth = authenticateStreamStart(msg.start);
        if (!auth.ok) {
          // FAIL CLOSED: one malformed start = ONE authoritative rejection
          // (precise reason + close). No frames are analysed, no session is
          // touched, nothing is silently treated as clean.
          console.warn(`[verify-stream] VERIFY_STREAM_REJECTED ${auth.reason} — closing (${auth.code})`);
          try {
            ws.close(auth.code, auth.reason.slice(0, 120));
          } catch {
            /* ignore */
          }
          return;
        }
        const { sid, purpose } = auth.identity;
        // NO in-process merge-tone recognizer on any stream (removed
        // 2026-09-05 with the legacy Leg B beep path it served). Merge
        // detection is exclusively the AUTHORISED direction: the external
        // merge relay listens on Leg B's inbound stream for Leg A's own
        // audio (prompt fingerprint / watermark / loud tone) crossing over
        // after a physical merge.
        const st: ActiveStream = { sid, purpose, sp: null, hold: null, frames: 0 };
        state = st;
        activeStreams.add(st);
        const callSid = msg.start?.callSid ?? "";
        const streamSid = msg.start?.streamSid ?? "";
        void buildAnalyzers(sid, purpose)
          .then((a) => {
            if (state !== st || !activeStreams.has(st)) return; // socket gone
            if (!a) {
              // FAIL CLOSED (identity requirement 5: existing verification
              // session): a detector stream that cannot bind to its session
              // must NOT sit connected looking healthy — ONE authoritative
              // failure log + close. Never silently clean, never log spam.
              activeStreams.delete(st);
              state = null;
              console.warn(
                `[verify-stream] VERIFY_STREAM_FAILED session=${sid} leg=${auth.identity.leg} purpose=${purpose} callSid=${callSid} — verification session not found; detector stream rejected (fail-closed)`,
              );
              try {
                ws.close(4404, "verification session not found");
              } catch {
                /* ignore */
              }
              return;
            }
            st.sp = a.sp;
            st.hold = a.hold;
            // The healthy startup line: proves session + leg + purpose +
            // track + owning call for every bound forensic stream. NEVER
            // log the token (secret) — identity fields only.
            console.log(
              `[verify-stream] VERIFY_STREAM_BOUND session=${sid} leg=${auth.identity.leg} purpose=${purpose} track=inbound_track callSid=${callSid} streamSid=${streamSid} detectors=${a.sp ? "speakerphone" : "hold-canary"}`,
            );
          })
          .catch((err) =>
            console.error("[verify-stream] analyzer attach error:", err),
          );
        return;
      }
      if (msg.event !== "media" || !msg.media?.payload) return;
      if (msg.media.track && msg.media.track !== "inbound") return;
      if (!state) return; // unidentified — drop audio
      const st = state;
      st.frames++;
      const payload = msg.media.payload;
      st.sp?.push(payload);
      st.hold?.push(payload);
      if (st.sp || st.hold) {
        // D2: event-driven bridge sync — bridgeGuardedLive() flips an
        // in-process registry flag SYNCHRONOUSLY with the bridge, so the
        // detectors see BRIDGED on the very next media frame (not the next
        // DB poll below) and the forensic warm-up starts immediately.
        if (vs.isBridgedSession(st.sid)) {
          st.hold?.setArmed(true);
          st.sp?.setBridged(true);
        }
        // Refresh the hold detector's armed flag AND the speakerphone
        // detector's BRIDGED flag (calibration warm-up starts on the
        // transition) from the verification store every ~0.5s of audio (the
        // session transitions to BRIDGED on this same call, after the stream
        // has already started). This DB poll is the cross-process fallback
        // for the in-process registry check above.
        sinceArmedRefresh++;
        if (sinceArmedRefresh >= 25) {
          sinceArmedRefresh = 0;
          const hold = st.hold;
          const sp = st.sp;
          void vs
            .findSession(st.sid)
            .then((s) => {
              const bridged = s?.state === vs.VState.BRIDGED;
              hold?.setArmed(Boolean(bridged));
              sp?.setBridged(Boolean(bridged));
            })
            .catch((err) =>
              console.error("[verify-stream] hold armed refresh error:", err),
            );
        }
      }
    });

    ws.on("close", () => {
      if (state) {
        activeStreams.delete(state);
        // The live detector owns suspicion — a dead speakerphone stream must
        // not leave a stale "suspecting" marker blocking episode-onset
        // bookkeeping on a replacement stream.
        if (state.purpose === "speakerphone") speakerphoneSuspicion.delete(state.sid);
        console.log(
          `[verify-stream] closed sid=${state.sid} purpose=${state.purpose} frames=${state.frames}`,
        );
      } else {
        console.log("[verify-stream] closed (unidentified)");
      }
    });
    ws.on("error", (err) =>
      console.error(`[verify-stream] ws error sid=${state?.sid ?? "?"}:`, err),
    );
  });
}

/**
 * Stream-detected merge: run the standard verdict, then tell Leg B.
 * opts.inCall (or a BRIDGED session) routes every leg — including Leg B — to
 * the conference-ending announcement via onMergeDetected; pre-bridge callers
 * keep the original behavior (Leg B redirected to notify-merge here).
 */
export async function fireMergeDetected(
  sid: string,
  opts: { inCall?: boolean } = {},
): Promise<void> {
  if (!sid) return;
  const session = await vs.findSession(sid);
  if (!session || vs.isTerminal(session)) return;
  const inCall = opts.inCall === true || session.state === vs.VState.BRIDGED;
  await vs.logEvent(
    sid,
    "MERGE_STREAM_DETECTED",
    inCall
      ? "Goertzel detector fired on in-call (BRIDGED) audio"
      : "Goertzel detector fired on Leg B inbound audio",
  );
  await vs.onMergeDetected(sid, { inCall }); // verdict + full teardown
  if (inCall) return; // onMergeDetected already redirected every present leg
  const legB = session.legBCallSid;
  if (legB) {
    await getTwilioClient().calls(legB).update({
      method: "POST",
      url: vs.twimlUrl("notify-merge", sid),
    });
  }
}
