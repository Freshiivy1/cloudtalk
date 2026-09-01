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
import { WebSocketServer, WebSocket } from "ws";
import * as vs from "./verification";
import { getTwilioClient } from "./twilio-voice";
import { SpeakerphoneDetector } from "./relayguard/speakerphone-detector";
import { HoldDetector } from "./relayguard/hold-detector";
import { analyzeClip } from "./relayguard/features";
import { compareVoicePanel } from "./relayguard/voice";

/**
 * POST /api/verify/stream-detected?sid=… — called by the EXTERNAL relay
 * service (see relay/ folder) when its real-time Goertzel detector fires.
 * This is the sub-0.5s merge-detection path: the relay hosts the WebSocket
 * (this platform blocks WS), detects the tone in ~300ms of live audio, and
 * posts here. Protected by the VERIFY_STREAM_SECRET shared secret.
 */
export async function verificationStreamDetectedHandler(c: Context) {
  const secret = process.env.VERIFY_STREAM_SECRET;
  if (!secret || c.req.header("x-verify-secret") !== secret) {
    return c.text("forbidden", 403);
  }
  const sid = c.req.query("sid") ?? "";
  if (!sid) return c.text("ok", 200);
  try {
    await fireMergeDetected(sid);
  } catch (err) {
    console.error("[verify-stream] callback fire error:", err);
  }
  return c.text("ok", 200);
}

/** wss:// URL for the external relay, or null when not configured. */
export function relayStreamUrl(sessionId: string): string | null {
  const u = process.env.VERIFY_STREAM_URL?.trim();
  if (!u || !/^wss:\/\//.test(u)) return null;
  return `${u}${u.includes("?") ? "&" : "?"}sid=${sessionId}`;
}

/**
 * HTTPS URL of the relay's /arm endpoint (derived from VERIFY_STREAM_URL).
 * The app POSTs {sid, legA} here when originating Leg B so the relay can
 * speak the verdict in-band and tear down Leg A the instant the merge tone
 * fires — the sub-0.5s path needs no Twilio REST round-trip.
 */
export function relayArmUrl(): string | null {
  const u = process.env.VERIFY_STREAM_URL?.trim();
  if (!u || !/^wss:\/\//.test(u)) return null;
  return `${u.replace(/^wss:\/\//, "https://").replace(/[/?].*$/, "")}/arm`;
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

/**
 * GUARDED MODE ONLY: in-call voice comparison against the callee voiceprint
 * baseline captured by the /api/verify/voiceprint webhook. Buffers a rolling
 * 6 s window of decoded PCM; every ~10 s of incoming audio it profiles the
 * window (whole-clip extraction — the vendored panel has no incremental API)
 * and runs compareVoicePanel(baseline, live). A 'different' consensus fires
 * vs.onVoiceMismatch (VOICE_MISMATCH event, throttled 30 s — detection only;
 * challenge noise is reserved for the SpeakerphoneDetector suspicion path).
 * DETECTION ONLY — never hangs up, never injects noise.
 * Entirely inert until a baseline exists for the session.
 */
class VoiceMatchMonitor {
  /** Rolling analysis window: 6 s @ 8 kHz. */
  private static readonly WINDOW_SAMPLES = 48_000;
  /** Compare cadence: every ~10 s of incoming audio. */
  private static readonly CHECK_EVERY_SAMPLES = 80_000;
  private buf: number[] = [];
  private sinceCheck = 0;

  private readonly sid: string;

  constructor(sid: string) {
    this.sid = sid;
  }

  /** Feed one Twilio media payload (base64 μ-law, 8 kHz mono). */
  push(payloadB64: string): void {
    if (!this.sid || !vs.getVoiceBaseline(this.sid)) return; // no baseline yet
    const bytes = Buffer.from(payloadB64, "base64");
    for (const b of bytes) this.buf.push(decodeMulaw(b));
    if (this.buf.length > VoiceMatchMonitor.WINDOW_SAMPLES) {
      this.buf = this.buf.slice(-VoiceMatchMonitor.WINDOW_SAMPLES);
    }
    this.sinceCheck += bytes.length;
    if (this.sinceCheck < VoiceMatchMonitor.CHECK_EVERY_SAMPLES) return;
    this.sinceCheck = 0;
    this.check();
  }

  private check(): void {
    try {
      const baseline = vs.getVoiceBaseline(this.sid);
      if (!baseline) return;
      const window = this.buf;
      // int16 → float, peak-normalized (same convention as capture time).
      let peak = 0;
      for (const s of window) {
        const a = Math.abs(s);
        if (a > peak) peak = a;
      }
      const scale = peak > 0 ? 0.9 / peak : 1;
      const samples = new Float32Array(window.length);
      for (let i = 0; i < window.length; i++) samples[i] = window[i] * scale;
      const live = analyzeClip(samples, SAMPLE_RATE);
      const panel = compareVoicePanel(baseline, live);
      if (panel.consensus === "different") {
        const detail =
          `VOICE_MISMATCH consensus=different same=${panel.sameCount} ` +
          `different=${panel.differentCount} abstain=${panel.abstainCount} — ` +
          `live Leg A voice differs from the voiceprint baseline`;
        void vs
          .onVoiceMismatch(this.sid, detail)
          .catch((err) => console.error("[verify-stream] onVoiceMismatch error:", err));
      }
    } catch (err) {
      // DSP must never break the media path.
      console.warn("[verify-stream] voice comparison failed:", (err as Error).message);
    }
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
 * challenge noise toward the callee AND arm the continuous merge tone as a
 * backstop trigger — a suspicious window is exactly when a mid-call merge is
 * most likely, so the tone starts playing immediately instead of waiting for
 * the HoldDetector's hold signature. armMergeTone is idempotent while armed.
 */
export function handleSpeakerphoneSuspicious(
  sid: string,
  score: number,
  detail: string,
): void {
  console.warn(
    `[verify-stream] SPEAKERPHONE SUSPECTED sid=${sid} score=${score.toFixed(2)} ${detail}`,
  );
  void vs
    .injectChallengeNoise(sid, `score=${score.toFixed(2)} ${detail}`)
    .catch((err) => console.error("[verify-stream] injectChallengeNoise error:", err));
  // Backstop trigger: arm the continuous merge tone (BRIDGED-gated inside).
  void vs
    .armMergeTone(sid)
    .catch((err) => console.error("[verify-stream] armMergeTone error:", err));
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
      armed: session.state === vs.VState.BRIDGED,
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
    // engaged / suspicion backstop) a genuine merged echo returns LOUD, so
    // the elevated VERIFY_MERGE_TONE_ENERGY_FLOOR applies; pre-bridge and
    // unarmed audio keeps the legacy 1e6 floor.
    const detector = new MergeToneDetector({
      energyFloor: () => (vs.isMergeToneArmed(sid) ? vs.mergeToneEnergyFloor() : 1e6),
    });
    // Relayguard Leg A analyzers (speakerphone + second-call hold detector)
    // — attached LAZILY on the stream's `start` event, and only when the
    // Twilio CallSid resolves to a session's legACallSid. Only CALLEE-side
    // (Leg A) audio is analyzed: the outer speakerphone case is the CALLEE
    // having the call on speaker, so on suspicion the challenge noise goes to
    // the callee participant — never the caller/inmate leg, and the call is
    // NEVER hung up or redirected from here. Leg B merge detection runs on
    // the external relay (VERIFY_STREAM_URL), so no analyzers attach there.
    let analyzers: LegAAnalyzers | null = null;
    // Frames since the hold detector's armed flag was last refreshed from
    // the verification store (armed only while the session is BRIDGED).
    let sinceArmedRefresh = 0;
    // GUARDED MODE ONLY: voiceprint comparison — inert until the explicit
    // voice-ID <Record> webhook stores a baseline for this session. It
    // re-checks vs.getVoiceBaseline on every push, so it picks the baseline up
    // lazily the moment the recording has been processed.
    const voiceMonitor = new VoiceMatchMonitor(sid);
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
        // Refresh the hold detector's armed flag from the verification store
        // every ~2s of audio (the session transitions to BRIDGED on this same
        // call, after the stream has already started).
        sinceArmedRefresh++;
        if (sinceArmedRefresh >= 100) {
          sinceArmedRefresh = 0;
          const hold = analyzers.hold;
          void vs
            .findSession(sid)
            .then((s) => hold.setArmed(s?.state === vs.VState.BRIDGED))
            .catch((err) =>
              console.error("[verify-stream] hold armed refresh error:", err),
            );
        }
      }
      voiceMonitor.push(msg.media.payload);
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
 * the Leg A participant ONLY while ARMED (second call engaged, or the
 * speakerphone-suspicion backstop). A tone fire while armed is real tone
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
        "merge tone fired while BRIDGED but NOT armed (no second call engaged, no suspicion backstop) — ignored",
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
