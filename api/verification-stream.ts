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
 * server in production. Leg A's TwiML opens a non-blocking <Start><Stream>
 * to this endpoint (inbound track) so the relayguard speakerphone detector
 * can analyze the callee's uplink audio in-process; Leg B merge detection
 * uses the external relay (VERIFY_STREAM_URL) when configured.
 */
import type { Server as HttpServer, IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { Context } from "hono";
import { createHmac } from "crypto";
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
 * wss:// URL of the IN-PROCESS media-stream endpoint for LEG A (callee)
 * speakerphone detection. Unlike Leg B merge detection — which may run on
 * the external relay (VERIFY_STREAM_URL) — the outer-speakerphone analyzer
 * always runs here, on the callee's inbound (uplink) audio track.
 */
export function legAStreamUrl(sessionId: string): string | null {
  const base = vs.getPublicBaseUrl();
  if (!base) return null;
  return `${base.replace(/^http/, "ws")}${STREAM_PATH}?sid=${sessionId}`;
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

/** Analyzers attached to a Leg A (callee) uplink stream. */
interface LegAAnalyzers {
  sp: SpeakerphoneDetector;
  hold: HoldDetector;
}

/**
 * Resolve a stream's Twilio CallSid to a verification session via
 * verification_sessions.legACallSid and build the relayguard analyzers for
 * it (speakerphone detector + second-call hold detector). Returns null —
 * gracefully, no throw — when the CallSid is not a known Leg A call or the
 * lookup fails.
 */
async function legAAnalyzers(callSid: string): Promise<LegAAnalyzers | null> {
  try {
    const session = await vs.findSessionByLegACallSid(callSid);
    if (!session) {
      console.log(
        `[verify-stream] stream start callSid=${callSid} — not a Leg A (callee) call, no speakerphone/hold detection`,
      );
      return null;
    }
    const sid = session.sessionId;
    const sp = new SpeakerphoneDetector({
      // 3 consecutive suspicious 1s windows by default (sustained ~3s
      // speakerphone-relay detection), env-tunable via
      // VERIFY_SPEAKERPHONE_ARM_WINDOWS. Arming requires verdict
      // 'SUSPICIOUS RELAY' AND a RED (>=0.6) relay fingerprint on every one
      // of those windows — AMBER never arms.
      consecutiveWindows: vs.speakerphoneArmWindows(),
      // Calibration warm-up after BRIDGED (default 8s): the detector rebuilds
      // its rolling baseline from live in-call audio and CANNOT arm — normal
      // conversation/ringback no longer false-arms the forensic challenge
      // seconds into the bridge.
      warmupMs: vs.forensicsWarmupMs(),
      // D2: suspicion may only accumulate while BRIDGED — pre-bridge windows
      // (incl. the race between the actual bridge and the bridged-flag
      // refresh) never build a streak, so the warm-up can't be outrun by
      // false-RED windows.
      armOnlyWhenBridged: true,
      bridged: session.state === vs.VState.BRIDGED || vs.isBridgedSession(sid),
      onSuspicious: (score, detail) => handleSpeakerphoneSuspicious(sid, score, detail),
      onClean: (detail) => {
        console.log(`[verify-stream] SPEAKERPHONE CLEARED sid=${sid} ${detail}`);
        void vs
          .onSpeakerphoneCleared(sid, detail)
          .catch((err) => console.error("[verify-stream] onSpeakerphoneCleared error:", err));
      },
    });
    // Second-call (call-waiting / add-call) hold detector. Armed ONLY while
    // the session is BRIDGED — the armed flag is refreshed from the
    // verification store on stream start and periodically thereafter (see
    // the connection handler). Engage arms the continuous merge tone;
    // disengage disarms it unless speakerphone suspicion is active.
    const hold = new HoldDetector({
      sessionId: sid,
      armed: session.state === vs.VState.BRIDGED || vs.isBridgedSession(sid),
      onSecondCallEngaged: (engagedSid) => {
        console.warn(`[verify-stream] SECOND CALL ENGAGED sid=${engagedSid}`);
        void vs
          .onSecondCallEngaged(engagedSid)
          .catch((err) => console.error("[verify-stream] onSecondCallEngaged error:", err));
      },
      onSecondCallDisengaged: (disengagedSid) => {
        if (sp.isSuspecting) {
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
    return { sp, hold };
  } catch (err) {
    console.error(`[verify-stream] Leg A session lookup failed callSid=${callSid}:`, err);
    return null;
  }
}

/**
 * Attach the verification media-stream WebSocket endpoint to the HTTP server.
 * Twilio connects to wss://{PUBLIC_BASE_URL}/api/verify/stream?sid=<sessionId>.
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

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const sid = new URL(req.url ?? "", "http://localhost").searchParams.get("sid") ?? "";
    // Dynamic energy floor: while the merge tone is ARMED (second call
    // engaged via the HoldDetector) a genuine merged echo returns LOUD, so
    // the elevated VERIFY_MERGE_TONE_ENERGY_FLOOR applies; pre-bridge and
    // unarmed audio keeps the legacy 1e6 floor.
    const detector = new MergeToneDetector({
      energyFloor: () => (vs.isMergeToneArmed(sid) ? vs.mergeToneEnergyFloor() : 1e6),
    });
    // Relayguard Leg A analyzers (speakerphone + second-call hold detector)
    // — attached LAZILY on the stream's `start` event, and only when the
    // Twilio CallSid resolves to a session's legACallSid. Only CALLEE-side
    // (Leg A) audio is ANALYZED: the outer speakerphone case is detected on
    // the callee's uplink, but on suspicion the challenge noise is announced
    // to the CALLER (inmate) participant ONLY — the callee/Leg A participant
    // NEVER gets it (that announce channel belongs to the DTMF merge tone),
    // and the call is NEVER hung up or redirected from here. Leg B merge
    // detection runs on the external relay (VERIFY_STREAM_URL), so no
    // analyzers attach there.
    let analyzers: LegAAnalyzers | null = null;
    // Frames since the hold detector's armed flag was last refreshed from
    // the verification store (armed only while the session is BRIDGED).
    let sinceArmedRefresh = 0;
    let frames = 0;
    console.log(`[verify-stream] connected sid=${sid}`);

    ws.on("message", (data: Buffer) => {
      let msg: {
        event?: string;
        media?: { track?: string; payload?: string };
        start?: { callSid?: string };
      };
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (msg.event === "start") {
        const callSid = msg.start?.callSid ?? "";
        if (callSid) {
          void legAAnalyzers(callSid)
            .then((a) => {
              if (a) analyzers = a;
            })
            .catch((err) =>
              console.error("[verify-stream] Leg A analyzer attach error:", err),
            );
        }
        return;
      }
      if (msg.event !== "media" || !msg.media?.payload) return;
      if (msg.media.track && msg.media.track !== "inbound") return;
      frames++;
      analyzers?.sp.push(msg.media.payload);
      if (analyzers) {
        analyzers.hold.push(msg.media.payload);
        // D2: event-driven bridge sync — bridgeGuardedLive() flips an
        // in-process registry flag SYNCHRONOUSLY with the bridge, so the
        // detectors see BRIDGED on the very next media frame (not the next
        // DB poll below) and the forensic warm-up starts immediately.
        if (vs.isBridgedSession(sid)) {
          analyzers.hold.setArmed(true);
          analyzers.sp.setBridged(true);
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
          const hold = analyzers.hold;
          const sp = analyzers.sp;
          void vs
            .findSession(sid)
            .then((s) => {
              const bridged = s?.state === vs.VState.BRIDGED;
              hold.setArmed(bridged);
              sp.setBridged(bridged);
            })
            .catch((err) =>
              console.error("[verify-stream] hold armed refresh error:", err),
            );
        }
      }
      if (detector.push(msg.media.payload)) {
        console.log(
          `[verify-stream] MERGE TONE DETECTED sid=${sid} after ${frames} frames (~${frames * 20}ms of audio)`,
        );
        void handleMergeToneFire(sid)
          .catch((err) => console.error("[verify-stream] fire error:", err));
      }
    });

    ws.on("close", () => {
      console.log(`[verify-stream] closed sid=${sid} frames=${frames}`);
    });
    ws.on("error", (err) => console.error(`[verify-stream] ws error sid=${sid}:`, err));
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
