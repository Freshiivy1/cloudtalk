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
 *  - Leg A (callee), purpose=hold-canary: HoldDetector (second-call
 *    engagement) + the in-call armed MergeToneDetector on the callee uplink.
 *  - Leg B (live call), purpose=speakerphone: the relayguard SpeakerphoneDetector
 *    on Leg B's inbound audio — speakerphone relay audio enters the ACTIVE
 *    Leg B microphone, so it is detectable ONLY here (Leg A is on hold).
 * Leg B merge-tone detection stays on the external relay (VERIFY_STREAM_URL).
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

export interface ToneDetectorOptions {
  /** Analysis window length in samples (default 400 = 50 ms). */
  windowSamples?: number;
  /**
   * Min normalized Goertzel power per tone frequency (default 0.05).
   * Normalization is p / (E·N²): a clean dual-tone scores ≈0.25 per
   * frequency, white noise ≈1/N (0.0025 at N=400) — huge separation.
   */
  toneRatio?: number;
  /**
   * Min mean-square energy to rise above line noise (default 1e6). May be a
   * function for a DYNAMIC floor: the Leg A in-call stream passes a getter
   * that returns the elevated VERIFY_MERGE_TONE_ENERGY_FLOOR (default 2e6)
   * while the merge tone is armed (a genuine merged echo returns loud) and
   * the legacy 1e6 otherwise.
   */
  energyFloor?: number | (() => number);
  /** Consecutive detecting windows required to fire (default 6 = 300 ms). */
  consecutiveWindows?: number;
}

/**
 * Incremental DTMF-'9' (852+1336 Hz) detector. Feed inbound μ-law frames;
 * returns true exactly once when a continuous tone has been present for
 * `consecutiveWindows` consecutive analysis windows (~300 ms default).
 */
export class MergeToneDetector {
  private readonly win: number;
  private readonly ratio: number;
  private readonly floor: number | (() => number);
  private readonly need: number;
  private buf: number[] = [];
  private streak = 0;
  private fired = false;

  constructor(opts: ToneDetectorOptions = {}) {
    this.win = opts.windowSamples ?? 400;
    this.ratio = opts.toneRatio ?? 0.05;
    this.floor = opts.energyFloor ?? 1e6;
    this.need = opts.consecutiveWindows ?? 6;
  }

  /** Feed one Twilio media payload (base64 μ-law, 8 kHz mono). */
  push(payloadB64: string): boolean {
    if (this.fired) return false;
    const bytes = Buffer.from(payloadB64, "base64");
    for (const b of bytes) this.buf.push(decodeMulaw(b));
    while (this.buf.length >= this.win) {
      const window = this.buf.slice(0, this.win);
      this.buf = this.buf.slice(this.win);
      const floor = typeof this.floor === "function" ? this.floor() : this.floor;
      const e = windowEnergy(window);
      const norm = e * window.length * window.length; // p/(E·N²) scaling
      const hit =
        e > floor &&
        goertzelPower(window, 852) / norm > this.ratio &&
        goertzelPower(window, 1336) / norm > this.ratio;
      this.streak = hit ? this.streak + 1 : 0;
      if (this.streak >= this.need) {
        this.fired = true;
        return true;
      }
    }
    return false;
  }

  get hasFired(): boolean {
    return this.fired;
  }
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
 * SpeakerphoneDetector.onSuspicious handler (exported for tests): inject the
 * challenge noise toward the CALLER (inmate) participant ONLY. This is the
 * OUTER-CALL FORENSIC system — it NEVER arms the continuous merge tone and
 * NEVER hangs up: arming from here would give relay detection a hangup path
 * (armed recognizer + loud tone loopback → false MERGE verdict) and would
 * make the family hear DTMF beeping during a pure speakerphone relay. The
 * merge tone is armed EXCLUSIVELY by the in-call merge system (HoldDetector
 * second-call engagement). While suspicion persists the detector re-invokes
 * this handler every refireMs (~4s), so the noise is SUSTAINED, not a
 * one-shot — re-injection stops on the first clean window.
 *
 * MUTUAL EXCLUSION with the in-call merge system: if the merge tone is
 * already ARMED (i.e. the HoldDetector engaged a second call first) or the
 * session is MERGE_DETECTED/terminal, the merge system owns the moment —
 * the challenge noise is SUPPRESSED (NOISE_SUPPRESSED_MERGE_ACTIVE event)
 * and skipped entirely. This guarantees the noise can NEVER interrupt the
 * DTMF merge tone or mask its detection: the two announces target different
 * participants (caller vs Leg A), and the noise never fires while the merge
 * system is active.
 */
export function handleSpeakerphoneSuspicious(
  sid: string,
  score: number,
  detail: string,
): void {
  console.warn(
    `[verify-stream] SPEAKERPHONE SUSPECTED sid=${sid} score=${score.toFixed(2)} ${detail}`,
  );
  void (async () => {
    const mergeToneArmed = vs.isMergeToneArmed(sid);
    const session = await vs.findSession(sid);
    const mergeActive =
      mergeToneArmed || !session || vs.isTerminal(session);
    if (mergeActive) {
      const reason =
        `merge system active (mergeToneArmed=${mergeToneArmed} state=${session?.state ?? "unknown"}) — ` +
        `challenge noise SUPPRESSED so it cannot interrupt the DTMF merge tone | score=${score.toFixed(2)} ${detail}`;
      console.log(`[verify-stream] NOISE_SUPPRESSED_MERGE_ACTIVE sid=${sid} ${reason}`);
      await vs.logEvent(sid, "NOISE_SUPPRESSED_MERGE_ACTIVE", reason.slice(0, 512));
      return;
    }
    await vs.injectChallengeNoise(sid, `score=${score.toFixed(2)} ${detail}`);
  })().catch((err) => console.error("[verify-stream] injectChallengeNoise error:", err));
}

/**
 * Stream purpose (customParameters `purpose`) → which detectors attach and
 * on which leg's audio:
 *  - "hold-canary" (leg=legA, callee uplink): HoldDetector second-call
 *    engagement + the in-call armed MergeToneDetector. NO speakerphone
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
 * Cross-connection replacement for the old same-connection `sp.isSuspecting`
 * check: the HoldDetector's disengage path consults this so the merge tone
 * stays armed while suspicion is active.
 */
const speakerphoneSuspicion = new Set<string>();

/** True while the speakerphone detector is suspecting for this session. */
export function isSpeakerphoneSuspecting(sid: string): boolean {
  return speakerphoneSuspicion.has(sid);
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
  /** Armed in-call merge-tone recognizer (hold-canary streams only). */
  merge: MergeToneDetector | null;
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
    if (!session) {
      console.log(
        `[verify-stream] stream start sid=${sid} purpose=${purpose} — session not found, no detectors attached`,
      );
      return null;
    }
    const bridged = session.state === vs.VState.BRIDGED || vs.isBridgedSession(sid);
    if (purpose === "speakerphone") {
      const sp = new SpeakerphoneDetector({
      // 3 consecutive suspicious 1s windows by default (sustained ~3s
      // speakerphone-relay detection), env-tunable via
      // VERIFY_SPEAKERPHONE_ARM_WINDOWS. Arming requires verdict
      // 'SUSPICIOUS RELAY' AND a RED (>=0.6) relay fingerprint on every one
      // of those windows — AMBER never arms.
      consecutiveWindows: vs.speakerphoneArmWindows(),
        // Calibration warm-up after BRIDGED (default 8s): the detector
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
          speakerphoneSuspicion.add(sid);
          handleSpeakerphoneSuspicious(sid, score, detail);
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
    // (see the connection handler). Engage arms the continuous merge tone;
    // disengage disarms it unless speakerphone suspicion is active.
    const hold = new HoldDetector({
      sessionId: sid,
      armed: bridged,
      onSecondCallEngaged: (engagedSid) => {
        console.warn(`[verify-stream] SECOND CALL ENGAGED sid=${engagedSid}`);
        void vs
          .onSecondCallEngaged(engagedSid)
          .catch((err) => console.error("[verify-stream] onSecondCallEngaged error:", err));
      },
      onSecondCallDisengaged: (disengagedSid) => {
        if (isSpeakerphoneSuspecting(disengagedSid)) {
          // Speakerphone suspicion is active — the merge tone stays armed
          // (suspicion is itself a merge-risk signal); skip the disarm.
          console.log(
            `[verify-stream] SECOND CALL DISENGAGED sid=${disengagedSid} — suspicion active, tone stays armed`,
          );
          return;
        }
        console.log(`[verify-stream] SECOND CALL DISENGAGED sid=${disengagedSid}`);
        void vs
          .onSecondCallDisengaged(disengagedSid)
          .catch((err) => console.error("[verify-stream] onSecondCallDisengaged error:", err));
      },
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
          console.warn(`[verify-stream] ${auth.reason} — closing (${auth.code})`);
          try {
            ws.close(auth.code, auth.reason.slice(0, 120));
          } catch {
            /* ignore */
          }
          return;
        }
        const { sid, purpose } = auth.identity;
        // The in-call ARMED merge-tone recognizer runs on the Leg A
        // hold-canary stream only. Dynamic energy floor: while the merge tone
        // is ARMED (second call engaged via the HoldDetector) a genuine
        // merged echo returns LOUD, so the elevated
        // VERIFY_MERGE_TONE_ENERGY_FLOOR applies; pre-bridge and unarmed
        // audio keeps the legacy 1e6 floor. Leg B merge-tone detection is the
        // external relay's job — the speakerphone stream gets NO merge
        // recognizer here.
        const merge =
          purpose === "hold-canary"
            ? new MergeToneDetector({
                energyFloor: () =>
                  vs.isMergeToneArmed(sid) ? vs.mergeToneEnergyFloor() : 1e6,
              })
            : null;
        state = { sid, purpose, sp: null, hold: null, merge, frames: 0 };
        activeStreams.add(state);
        console.log(
          `[verify-stream] stream start sid=${sid} leg=${auth.identity.leg} purpose=${purpose} streamSid=${msg.start?.streamSid ?? ""} callSid=${msg.start?.callSid ?? ""}`,
        );
        void buildAnalyzers(sid, purpose)
          .then((a) => {
            if (a && state) {
              state.sp = a.sp;
              state.hold = a.hold;
            }
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
      if (st.merge?.push(payload)) {
        console.log(
          `[verify-stream] MERGE TONE DETECTED sid=${st.sid} after ${st.frames} frames (~${st.frames * 20}ms of audio)`,
        );
        void handleMergeToneFire(st.sid)
          .catch((err) => console.error("[verify-stream] fire error:", err));
      }
    });

    ws.on("close", () => {
      if (state) {
        activeStreams.delete(state);
        // The live detector owns suspicion — a dead speakerphone stream must
        // not leave a stale "suspecting" marker blocking merge-tone disarm.
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
 * MergeToneDetector fire path (Leg A uplink stream / Leg B relay stream).
 *
 * BRIDGED in-call detection (v3): the continuous merge tone is announced to
 * the Leg A participant ONLY while ARMED (HoldDetector second-call
 * engagement — the speakerphone suspicion path NEVER arms it). A tone fire
 * while armed is real tone
 * leakage across a merge — and must clear the ELEVATED energy floor (see the
 * detector's dynamic energyFloor) — so the verdict fires immediately, within
 * ~1-3s of the merge. A tone fire while NOT armed is self-echo/ambient audio
 * and is ignored (MERGE_TONE_UNARMED). Pre-bridge sessions keep the original
 * behavior (instant verdict, legacy floor).
 *
 * Returns "merge" when the verdict fired, "ignored" otherwise.
 */
export async function handleMergeToneFire(
  sid: string,
): Promise<"merge" | "ignored"> {
  const session = await vs.findSession(sid);
  if (!session || vs.isTerminal(session)) return "ignored";
  if (session.state === vs.VState.BRIDGED) {
    if (!vs.isMergeToneArmed(sid)) {
      console.log(
        `[verify-stream] MERGE_TONE_UNARMED sid=${sid} — tone fire with no armed tone; ignoring (self-echo/ambient guard)`,
      );
      await vs.logEvent(
        sid,
        "MERGE_TONE_UNARMED",
        "merge tone fired while BRIDGED but NOT armed (no second call engaged) — ignored",
      );
      return "ignored";
    }
    await fireMergeDetected(sid, { inCall: true });
    return "merge";
  }
  await fireMergeDetected(sid);
  return "merge";
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
