/**
 * TwilioTelephonyProvider — the REAL telephony provider.
 *
 * Implements the exact TelephonyProvider contract from telephony.ts using the
 * Twilio Voice JS SDK (WebRTC → Twilio → PSTN). Drop-in: useTelephony() swaps
 * this in when Twilio is configured (VITE_TWILIO_ENABLED=true + token OK).
 *
 * Note on hold: Twilio Voice cannot put a PSTN leg on hold client-side, so
 * hold = mic muted + held UI state (honest limitation until conferencing).
 */
import { Device, Call } from "@twilio/voice-sdk";
import type { Call as TwilioCall } from "@twilio/voice-sdk";
import {
  normalizePhoneNumber,
  type CallContact,
  type CallInfo,
  type PresenceStatus,
  type QueuedCaller,
  type RecentCall,
  type TelephonyEvent,
  type TelephonyEventPayload,
  type TelephonyHandler,
  type TelephonyProvider,
  type TelephonySnapshot,
  type CallState,
} from "./telephony";

const ALL_EVENTS: TelephonyEvent[] = [
  "incoming_call",
  "call_ringing",
  "call_active",
  "call_held",
  "call_resumed",
  "call_ended",
  "presence_changed",
  "queue_updated",
];

let idCounter = 0;
const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${++idCounter}`;

export class TwilioTelephonyProvider implements TelephonyProvider {
  private device: Device | null = null;
  private activeCall: TwilioCall | null = null;

  private state: CallState = "idle";
  private call: CallInfo | null = null;
  private muted = false;
  private speakerOn = false;
  private presence: PresenceStatus = "available";
  private queue: QueuedCaller[] = []; // real queue requires server-side ACD — empty
  private recent: RecentCall[] = [];
  private dtmfLog: string[] = [];
  private lastDuration = 0;
  private soundEnabled = true;
  private contacts: CallContact[] = [];
  private connectedAt: number | null = null;

  private handlers = new Map<TelephonyEvent, Set<TelephonyHandler>>();

  private constructor() {}

  /**
   * Create + initialize. Returns null when Twilio is not configured or the
   * token request fails — callers fall back to the simulated provider.
   */
  static async create(): Promise<TwilioTelephonyProvider | null> {
    try {
      const res = await fetch("/api/trpc/telephony.voice.token?batch=1", {
        credentials: "include",
      });
      if (!res.ok) return null;
      const json = await res.json();
      const token = json?.[0]?.result?.data?.json?.token as string | undefined;
      if (!token) return null;

      const p = new TwilioTelephonyProvider();
      p.device = new Device(token, {
        codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
      });
      p.wireDeviceEvents();
      await p.device.register();
      return p;
    } catch (err) {
      console.warn("[twilio] init failed, staying simulated:", err);
      return null;
    }
  }

  /* ----------------------------- event bus ------------------------------ */
  on(event: TelephonyEvent, handler: TelephonyHandler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  private emit<K extends TelephonyEvent>(
    event: K,
    payload: TelephonyEventPayload[K],
  ): void {
    this.handlers.get(event)?.forEach((h) => h(payload));
  }

  private emitAll() {
    // cheap way to refresh snapshot listeners
    this.emit("queue_updated", { queue: [...this.queue] });
  }

  /* --------------------------- device wiring ---------------------------- */
  private wireDeviceEvents() {
    if (!this.device) return;
    this.device.on("incoming", (call) => {
      const from = String(call.parameters.From ?? "Unknown");
      const contact = this.matchContact(from);
      this.activeCall = call;
      this.call = {
        id: nextId("call"),
        number: from,
        direction: "inbound",
        contact,
        connectedAt: null,
        heldAt: null,
        heldAccumulated: 0,
      };
      this.dtmfLog = [];
      this.state = "incoming";
      this.emit("incoming_call", { call: this.call });
      this.wireCallEvents(call);
      call.on("cancel", () => this.finishCall(true));
      call.on("reject", () => this.finishCall(true));
    });
    this.device.on("error", (e) => console.error("[twilio] device error", e));
  }

  private wireCallEvents(call: TwilioCall) {
    call.on("ringing", () => {
      if (this.state === "dialing") {
        this.state = "ringing";
        if (this.call) this.emit("call_ringing", { call: this.call });
      }
    });
    call.on("accept", () => {
      this.state = "active";
      this.connectedAt = Date.now();
      if (this.call) {
        this.call.connectedAt = this.connectedAt;
        this.emit("call_active", { call: this.call });
      }
    });
    call.on("disconnect", () => this.finishCall(false));
    call.on("error", (e) => {
      console.error("[twilio] call error", e);
      this.finishCall(false);
    });
  }

  private finishCall(missed: boolean) {
    const durationSecs = this.connectedAt
      ? Math.max(1, Math.round((Date.now() - this.connectedAt) / 1000))
      : 0;
    this.lastDuration = durationSecs;
    if (this.call) {
      this.recent.unshift({
        id: nextId("r"),
        name: this.call.contact?.name ?? this.call.number,
        number: this.call.number,
        direction: this.call.direction,
        missed,
        at: Date.now(),
        durationSecs,
      });
      this.recent = this.recent.slice(0, 8);
    }
    const ended = this.call;
    this.state = "idle";
    this.call = null;
    this.activeCall = null;
    this.connectedAt = null;
    this.muted = false;
    this.dtmfLog = [];
    this.emit("call_ended", { call: ended, durationSecs, missed });
  }

  private matchContact(number: string): CallContact | undefined {
    const n = normalizePhoneNumber(number);
    if (!n) return undefined;
    const bare = n.replace(/^\+/, "");
    return this.contacts.find((c) => {
      const cn = normalizePhoneNumber(c.number);
      return cn != null && bare.endsWith(cn.replace(/^\+/, "").slice(-8));
    });
  }

  /* --------------------------- contract methods -------------------------- */
  dial(number: string): void {
    if (!this.device || (this.state !== "idle" && this.state !== "ended")) return;
    const n = normalizePhoneNumber(number);
    if (!n) return;
    const contact = this.matchContact(n);
    this.call = {
      id: nextId("call"),
      number: n,
      direction: "outbound",
      contact,
      connectedAt: null,
      heldAt: null,
      heldAccumulated: 0,
    };
    this.dtmfLog = [];
    this.state = "dialing";
    this.emitAll();
    this.device
      .connect({ params: { To: n } })
      .then((call) => {
        this.activeCall = call;
        this.wireCallEvents(call);
        if (this.call) this.emit("call_ringing", { call: this.call });
        this.state = "ringing";
      })
      .catch((err) => {
        console.error("[twilio] connect failed", err);
        this.finishCall(false);
      });
  }

  answer(): void {
    if (this.state === "incoming" && this.activeCall) {
      this.activeCall.accept();
    }
  }

  hangup(): void {
    if (this.activeCall) {
      this.activeCall.disconnect();
    } else {
      this.device?.disconnectAll();
      if (this.state !== "idle") this.finishCall(false);
    }
  }

  toggleMute(): void {
    this.muted = !this.muted;
    this.activeCall?.mute(this.muted);
    if (this.call) this.emit(this.state === "held" ? "call_held" : "call_active", { call: this.call });
  }

  toggleHold(): void {
    // Twilio Voice can't hold a PSTN leg client-side: hold = muted mic + held UI.
    if (this.state === "active") {
      this.state = "held";
      this.muted = true;
      this.activeCall?.mute(true);
      if (this.call) {
        this.call.heldAt = Date.now();
        this.emit("call_held", { call: this.call });
      }
    } else if (this.state === "held") {
      this.state = "active";
      this.muted = false;
      this.activeCall?.mute(false);
      if (this.call) {
        this.call.heldAt = null;
        this.emit("call_resumed", { call: this.call });
      }
    }
  }

  sendDTMF(tone: string): void {
    this.dtmfLog.push(tone);
    this.activeCall?.sendDigits(tone);
    this.emitAll();
  }

  toggleSpeaker(): void {
    this.speakerOn = !this.speakerOn;
    this.emitAll();
  }

  setPresence(status: PresenceStatus): void {
    this.presence = status;
    this.emit("presence_changed", { presence: status });
  }

  /* --------------------------- extra surface (parity) -------------------- */
  snapshot(): TelephonySnapshot {
    return {
      callState: this.state,
      call: this.call,
      muted: this.muted,
      speakerOn: this.speakerOn,
      presence: this.presence,
      queue: [...this.queue],
      recent: [...this.recent],
      dtmfLog: [...this.dtmfLog],
      lastDuration: this.lastDuration,
      soundEnabled: this.soundEnabled,
    };
  }

  pickUpFromQueue(_id: string): void {
    // no client-side queue with the real provider
  }

  setSoundEnabled(enabled: boolean): void {
    this.soundEnabled = enabled;
    this.emit("presence_changed", { presence: this.presence });
  }

  setContacts(contacts: CallContact[]): void {
    this.contacts = contacts;
  }

  dispose(): void {
    this.device?.destroy();
    this.handlers.clear();
  }
}

export { ALL_EVENTS as TWILIO_EVENTS };
