/**
 * CloudTalk — Simulated Telephony Provider
 *
 * Implements the `TelephonyProvider` contract from design.md §1.
 * The backend graft in a later phase rewires this to a real server —
 * keep the interface EXACTLY as specified:
 *
 *   Methods: dial, answer, hangup, toggleMute, toggleHold, sendDTMF,
 *            toggleSpeaker, setPresence
 *   Events:  incoming_call, call_ringing, call_active, call_held,
 *            call_resumed, call_ended, presence_changed, queue_updated
 *   State machine: idle → dialing → ringing → active ⇄ held → ended
 *                  (with incoming → ringing branch)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CallState =
  | 'idle'
  | 'dialing'
  | 'ringing'
  | 'incoming'
  | 'active'
  | 'held'
  | 'ended';

export type PresenceStatus = 'available' | 'away' | 'dnd' | 'offline';
export type CallDirection = 'inbound' | 'outbound';

export interface CallContact {
  name: string;
  number: string;
  company?: string;
  tags?: string[];
  lastCall?: string;
}

export interface CallInfo {
  id: string;
  number: string;
  direction: CallDirection;
  contact?: CallContact;
  /** epoch ms when the call connected (active) */
  connectedAt: number | null;
  /** epoch ms when the call was put on hold */
  heldAt: number | null;
  /** seconds of accumulated talk time before the current hold */
  heldAccumulated: number;
}

export interface QueuedCaller {
  id: string;
  name: string;
  number: string;
  waitedSecs: number;
  position: number;
}

export interface RecentCall {
  id: string;
  name: string;
  number: string;
  direction: CallDirection;
  missed: boolean;
  /** epoch ms */
  at: number;
  durationSecs: number;
}

export interface TelephonySnapshot {
  callState: CallState;
  call: CallInfo | null;
  muted: boolean;
  speakerOn: boolean;
  presence: PresenceStatus;
  queue: QueuedCaller[];
  recent: RecentCall[];
  dtmfLog: string[];
  /** seconds, set when a call ends */
  lastDuration: number;
  soundEnabled: boolean;
}

export type TelephonyEvent =
  | 'incoming_call'
  | 'call_ringing'
  | 'call_active'
  | 'call_held'
  | 'call_resumed'
  | 'call_ended'
  | 'presence_changed'
  | 'queue_updated'
  | 'speakerphone_toggled'
  | 'listen_live_toggled';

export type TelephonyEventPayload = {
  incoming_call: { call: CallInfo };
  call_ringing: { call: CallInfo };
  call_active: { call: CallInfo };
  call_held: { call: CallInfo };
  call_resumed: { call: CallInfo };
  call_ended: { call: CallInfo | null; durationSecs: number; missed: boolean };
  presence_changed: { presence: PresenceStatus };
  queue_updated: { queue: QueuedCaller[] };
  speakerphone_toggled: { speakerOn: boolean; supported: boolean };
  listen_live_toggled: { listenLiveOn: boolean; supported: boolean };
};

export type TelephonyHandler = (payload: unknown) => void;

/**
 * The exact provider contract (design.md §1). The backend graft will supply
 * a server-backed implementation of this same interface.
 */
export interface TelephonyProvider {
  /**
   * Place an outbound call. `extraParams` are merged into the Twilio
   * device.connect params (e.g. { guarded: sessionId } for guarded inmate
   * calls); the simulated provider ignores them.
   */
  dial(number: string, extraParams?: Record<string, string>): void;
  answer(): void;
  hangup(): void;
  toggleMute(): void;
  toggleHold(): void;
  sendDTMF(tone: string): void;
  toggleSpeaker(): void;
  setPresence(status: PresenceStatus): void;
  on(event: TelephonyEvent, handler: TelephonyHandler): () => void;
}

// ---------------------------------------------------------------------------
// WebAudio sound engine (all sounds generated, no assets)
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null;
let audioArmed = false;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') void audioCtx.resume();
  return audioCtx;
}

/** Browsers gate AudioContext behind a user gesture — arm it on the first one. */
export function armAudioOnFirstGesture(): void {
  if (audioArmed || typeof window === 'undefined') return;
  audioArmed = true;
  const arm = () => {
    getAudioContext();
    window.removeEventListener('pointerdown', arm);
    window.removeEventListener('keydown', arm);
  };
  window.addEventListener('pointerdown', arm);
  window.addEventListener('keydown', arm);
}

const DTMF_FREQS: Record<string, [number, number]> = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477],
};

/** Dual-tone keypress, 120ms. */
export function playDTMFTone(key: string): void {
  const freqs = DTMF_FREQS[key];
  const ctx = getAudioContext();
  if (!freqs || !ctx) return;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.06, ctx.currentTime);
  gain.connect(ctx.destination);
  const stop = ctx.currentTime + 0.12;
  for (const f of freqs) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    osc.connect(gain);
    osc.start();
    osc.stop(stop);
  }
}

/** Soft "blip" on connect — 880Hz, 80ms, low gain. */
export function playConnectBlip(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.07, ctx.currentTime);
  gain.connect(ctx.destination);
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 880;
  osc.connect(gain);
  osc.start();
  osc.stop(ctx.currentTime + 0.08);
}

/** Descending two-tone on hangup. */
export function playHangupTone(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.07, ctx.currentTime);
  gain.connect(ctx.destination);
  [660, 440].forEach((f, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    osc.connect(gain);
    const t0 = ctx.currentTime + i * 0.12;
    osc.start(t0);
    osc.stop(t0 + 0.12);
  });
}

// ---------------------------------------------------------------------------
// Phone number utilities — full international (E.164) support incl. Australia
// ---------------------------------------------------------------------------

/**
 * Normalize user input into E.164-ish form:
 * - strips spaces, dashes, parentheses, dots
 * - converts a leading international prefix "00" (e.g. 0011/0061) to "+"
 * - keeps a single leading "+"
 * Returns null if the result isn't a plausible phone number (7–15 digits).
 */
export function normalizePhoneNumber(input: string): string | null {
  let s = input.replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!/^\+?\d{7,15}$/.test(s)) return null;
  return s;
}

/**
 * Format a number for display. Australian numbers get proper AU grouping:
 *   +61 4XX XXX XXX  (mobile)   +61 2 XXXX XXXX  (landline)
 * Other internationals are grouped 3-3-4; locals pass through.
 */
export function formatPhoneDisplay(number: string): string {
  const n = normalizePhoneNumber(number) ?? number;
  if (n.startsWith('+61')) {
    const rest = n.slice(3);
    if (rest.startsWith('4') && rest.length === 9) {
      return `+61 ${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6)}`;
    }
    if (rest.length === 9) {
      return `+61 ${rest.slice(0, 1)} ${rest.slice(1, 5)} ${rest.slice(5)}`;
    }
    return `+61 ${rest}`;
  }
  if (n.startsWith('+')) {
    const d = n.slice(1);
    if (d.length <= 3) return n;
    const cc = d.slice(0, d.length - 10 > 0 && d.length - 10 <= 3 ? d.length - 10 : 2);
    const body = d.slice(cc.length);
    const groups = body.match(/.{1,4}/g) ?? [];
    return `+${cc} ${groups.join(' ')}`;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Simulation data — starts EMPTY. The provider is fed the user's real
// contacts (from the backend) via setContacts(); until then the directory,
// queue and inbound simulation stay empty rather than showing fake people.
// ---------------------------------------------------------------------------

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

// ---------------------------------------------------------------------------
// Simulated provider
// ---------------------------------------------------------------------------

export class SimulatedTelephonyProvider implements TelephonyProvider {
  private state: CallState = 'idle';
  private call: CallInfo | null = null;
  private muted = false;
  private speakerOn = false;
  private presence: PresenceStatus = 'available';
  private contacts: CallContact[] = [];
  private queue: QueuedCaller[] = [];
  private recent: RecentCall[] = [];
  private dtmfLog: string[] = [];
  private lastDuration = 0;
  private soundEnabled = true;

  private handlers = new Map<TelephonyEvent, Set<TelephonyHandler>>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private intervals = new Set<ReturnType<typeof setInterval>>();
  private ringOscillators: OscillatorNode[] = [];
  private ringGain: GainNode | null = null;
  private disposed = false;

  constructor() {
    armAudioOnFirstGesture();
    this.scheduleInbound();
    this.startQueueTicker();
    this.scheduleQueueArrival();
  }

  // -- event plumbing ------------------------------------------------------

  on(event: TelephonyEvent, handler: TelephonyHandler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  private emit<K extends TelephonyEvent>(event: K, payload: TelephonyEventPayload[K]): void {
    this.handlers.get(event)?.forEach((h) => h(payload));
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(t);
  }

  /** Every action carries 300–900ms simulated network latency. */
  private withLatency(fn: () => void): void {
    this.later(fn, rand(300, 900));
  }

  // -- snapshot (additive helper for the React hook; not part of the spec) --

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

  // -- contract methods ------------------------------------------------------

  dial(number: string): void {
    if (this.state !== 'idle' && this.state !== 'ended') return;
    const normalized = normalizePhoneNumber(number);
    if (!normalized) return;
    const contact = this.contacts.find((c) => {
      const cn = normalizePhoneNumber(c.number);
      return cn != null && cn.replace(/^\+/, '').endsWith(normalized.replace(/^\+/, '').slice(-8));
    });
    this.call = {
      id: nextId('call'),
      number: normalized,
      direction: 'outbound',
      contact,
      connectedAt: null,
      heldAt: null,
      heldAccumulated: 0,
    };
    this.dtmfLog = [];
    this.state = 'dialing';
    // latency → ringing
    this.withLatency(() => {
      if (this.state !== 'dialing' || !this.call) return;
      this.state = 'ringing';
      this.emit('call_ringing', { call: this.call });
      // simulated remote answers after 1.5–4s of ringing
      this.later(() => {
        if (this.state !== 'ringing' || !this.call) return;
        this.connectCall();
      }, rand(1500, 4000));
    });
  }

  answer(): void {
    if (this.state !== 'incoming' || !this.call) return;
    this.withLatency(() => {
      if (this.state !== 'incoming' || !this.call) return;
      this.stopRingSound();
      this.connectCall();
    });
  }

  hangup(): void {
    const from = this.state;
    if (from === 'idle' || from === 'ended') return;
    this.withLatency(() => {
      if (this.state === 'idle' || this.state === 'ended') return;
      this.stopRingSound();
      if (from === 'active' || from === 'held') playHangupTone();
      this.endCall(false);
    });
  }

  toggleMute(): void {
    if (this.state !== 'active' && this.state !== 'held') return;
    this.withLatency(() => {
      this.muted = !this.muted;
      // mute doesn't change the call state machine; re-emit current state so
      // listeners refresh
      if (this.call) {
        this.emit(this.state === 'held' ? 'call_held' : 'call_resumed', { call: this.call });
      }
    });
  }

  toggleHold(): void {
    if (this.state !== 'active' && this.state !== 'held' || !this.call) return;
    this.withLatency(() => {
      if (!this.call) return;
      if (this.state === 'active') {
        this.call.heldAt = Date.now();
        this.call.heldAccumulated = this.call.connectedAt
          ? (this.call.heldAt - this.call.connectedAt) / 1000 - 0
          : 0;
        this.state = 'held';
        this.emit('call_held', { call: this.call });
      } else if (this.state === 'held') {
        // accumulate held time so the talk timer stays honest
        if (this.call.heldAt && this.call.connectedAt) {
          const heldFor = (Date.now() - this.call.heldAt) / 1000;
          this.call.connectedAt += heldFor * 1000;
        }
        this.call.heldAt = null;
        this.state = 'active';
        this.emit('call_resumed', { call: this.call });
      }
    });
  }

  sendDTMF(tone: string): void {
    if (this.state !== 'active' && this.state !== 'held') return;
    playDTMFTone(tone);
    this.dtmfLog.push(tone);
    if (this.call) {
      this.emit(this.state === 'held' ? 'call_held' : 'call_resumed', { call: this.call });
    }
  }

  toggleSpeaker(): void {
    this.withLatency(() => {
      this.speakerOn = !this.speakerOn;
      this.emit('speakerphone_toggled', { speakerOn: this.speakerOn, supported: true });
      if (this.call) {
        this.emit(this.state === 'held' ? 'call_held' : this.state === 'active' ? 'call_resumed' : 'call_ringing', { call: this.call });
      }
    });
  }

  setPresence(status: PresenceStatus): void {
    if (status === this.presence) return;
    this.presence = status;
    this.emit('presence_changed', { presence: status });
    if (status === 'available') this.scheduleInbound();
  }

  // -- additive simulation helpers (used by demo UI, safe to rewire) --------

  /** Agent picks a caller out of the queue → inbound ringing flow. */
  pickUpFromQueue(id: string): void {
    if (this.state !== 'idle') return;
    const idx = this.queue.findIndex((q) => q.id === id);
    if (idx === -1) return;
    const [caller] = this.queue.splice(idx, 1);
    this.reindexQueue();
    this.emit('queue_updated', { queue: [...this.queue] });
    this.call = {
      id: nextId('call'),
      number: caller.number,
      direction: 'inbound',
      contact: { name: caller.name, number: caller.number },
      connectedAt: null,
      heldAt: null,
      heldAccumulated: 0,
    };
    this.dtmfLog = [];
    this.state = 'incoming';
    this.startRingSound();
    this.emit('incoming_call', { call: this.call });
  }

  setSoundEnabled(enabled: boolean): void {
    this.soundEnabled = enabled;
    if (!enabled) this.stopRingSound();
    this.emit('presence_changed', { presence: this.presence });
  }

  /**
   * Feed the provider the user's REAL contacts (from the backend). The dial
   * matcher, inbound simulation and queue simulation all draw from this list —
   * when it's empty they stay quiet instead of showing fake people.
   */
  setContacts(contacts: CallContact[]): void {
    this.contacts = contacts;
  }

  dispose(): void {
    this.disposed = true;
    this.timers.forEach(clearTimeout);
    this.intervals.forEach(clearInterval);
    this.stopRingSound();
    this.handlers.clear();
  }

  // -- internals -------------------------------------------------------------

  private connectCall(): void {
    if (!this.call) return;
    this.call.connectedAt = Date.now();
    this.call.heldAt = null;
    this.state = 'active';
    this.muted = false;
    playConnectBlip();
    this.emit('call_active', { call: this.call });
  }

  private endCall(missed: boolean): void {
    const ended = this.call;
    const duration =
      ended?.connectedAt != null
        ? Math.max(1, Math.round((Date.now() - ended.connectedAt) / 1000))
        : 0;
    this.lastDuration = duration;
    this.state = missed ? 'idle' : 'ended';
    this.emit('call_ended', { call: ended, durationSecs: duration, missed });
    if (ended) {
      this.recent = [
        {
          id: nextId('r'),
          name: ended.contact?.name ?? 'Unknown caller',
          number: ended.number,
          direction: ended.direction,
          missed,
          at: Date.now(),
          durationSecs: duration,
        },
        ...this.recent,
      ].slice(0, 12);
    }
    this.muted = false;
    if (!missed) {
      // wrap-up window: 4s, then back to idle
      this.later(() => {
        if (this.state === 'ended') {
          this.state = 'idle';
          this.call = null;
          this.emit('queue_updated', { queue: [...this.queue] }); // poke listeners
        }
      }, 4000);
    } else {
      this.call = null;
    }
    this.scheduleInbound();
  }

  private scheduleInbound(): void {
    if (this.presence !== 'available') return;
    // simulated inbound call every 45–90s while Available
    this.later(() => {
      if (this.state !== 'idle' || this.presence !== 'available') {
        this.scheduleInbound();
        return;
      }
      const contact = this.contacts[Math.floor(Math.random() * this.contacts.length)];
      if (!contact) {
        // No real contacts yet — stay quiet rather than inventing a caller.
        this.scheduleInbound();
        return;
      }
      this.call = {
        id: nextId('call'),
        number: contact.number,
        direction: 'inbound',
        contact,
        connectedAt: null,
        heldAt: null,
        heldAccumulated: 0,
      };
      this.dtmfLog = [];
      this.state = 'incoming';
      this.startRingSound();
      this.emit('incoming_call', { call: this.call });
      // caller gives up after ~24s → missed
      this.later(() => {
        if (this.state === 'incoming') {
          this.stopRingSound();
          this.endCall(true);
        }
      }, 24_000);
    }, rand(45_000, 90_000));
  }

  private startQueueTicker(): void {
    const t = setInterval(() => {
      this.queue.forEach((q) => {
        q.waitedSecs += 1;
      });
      this.emit('queue_updated', { queue: [...this.queue] });
    }, 1000);
    this.intervals.add(t);
  }

  private scheduleQueueArrival(): void {
    this.later(() => {
      const c = this.contacts[Math.floor(Math.random() * this.contacts.length)];
      if (c) {
        this.queue.push({ id: nextId('q'), name: c.name, number: c.number, waitedSecs: 0, position: this.queue.length + 1 });
        if (this.queue.length > 5) this.queue.shift();
        this.reindexQueue();
        this.emit('queue_updated', { queue: [...this.queue] });
      }
      this.scheduleQueueArrival();
    }, rand(60_000, 120_000));
  }

  private reindexQueue(): void {
    this.queue.forEach((q, i) => {
      q.position = i + 1;
    });
  }

  /** Incoming ring: dual sine 440/480Hz, 1s on / 2s off, gain 0.08. */
  private startRingSound(): void {
    if (!this.soundEnabled) return;
    const ctx = getAudioContext();
    if (!ctx) return;
    this.stopRingSound();
    const gain = ctx.createGain();
    gain.gain.value = 0.08;
    gain.connect(ctx.destination);
    const oscs = [440, 480].map((f) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      osc.connect(gain);
      osc.start();
      return osc;
    });
    // 1s on / 2s off cadence via gain envelope
    const cycle = 3;
    const now = ctx.currentTime;
    for (let i = 0; i < 12; i++) {
      gain.gain.setValueAtTime(0.08, now + i * cycle);
      gain.gain.setValueAtTime(0.0001, now + i * cycle + 1);
    }
    this.ringGain = gain;
    this.ringOscillators = oscs;
  }

  private stopRingSound(): void {
    this.ringOscillators.forEach((o) => {
      try { o.stop(); } catch { /* already stopped */ }
      o.disconnect();
    });
    this.ringOscillators = [];
    this.ringGain?.disconnect();
    this.ringGain = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatCallDuration(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function formatRelativeTime(at: number, now = Date.now()): string {
  const diff = Math.max(0, now - at);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';

const ALL_EVENTS: TelephonyEvent[] = [
  'incoming_call',
  'call_ringing',
  'call_active',
  'call_held',
  'call_resumed',
  'call_ended',
  'presence_changed',
  'queue_updated',
  'speakerphone_toggled',
  'listen_live_toggled',
];

/**
 * Structural supertype both providers satisfy (simulated + Twilio).
 * Defined here to avoid a circular import with twilio-provider.ts.
 */
export type AnyTelephonyProvider = TelephonyProvider & {
  snapshot(): TelephonySnapshot;
  dispose(): void;
  pickUpFromQueue(id: string): void;
  setSoundEnabled(enabled: boolean): void;
  setContacts(contacts: CallContact[]): void;
};

export interface UseTelephony {
  snapshot: TelephonySnapshot;
  provider: AnyTelephonyProvider;
  /** The exact TelephonyProvider contract methods, bound. */
  dial: (number: string, extraParams?: Record<string, string>) => void;
  answer: () => void;
  hangup: () => void;
  toggleMute: () => void;
  toggleHold: () => void;
  sendDTMF: (tone: string) => void;
  toggleSpeaker: () => void;
  setPresence: (status: PresenceStatus) => void;
  /** Subscribe to raw provider events; returns unsubscribe. */
  on: (event: TelephonyEvent, handler: TelephonyHandler) => () => void;
}

/**
 * Wires a SimulatedTelephonyProvider into React state. Subscribes to every
 * provider event and mirrors `provider.snapshot()` — the backend graft will
 * swap the provider without touching consumers.
 */
export function useTelephony(): UseTelephony {
  const [provider, setProvider] = useState<AnyTelephonyProvider>(() => new SimulatedTelephonyProvider());
  const [snapshot, setSnapshot] = useState<TelephonySnapshot>(() => provider.snapshot());

  // Swap in the REAL Twilio provider when the backend says it is configured.
  // This intentionally does NOT depend on a build-time VITE_* flag: Render
  // Docker images are built before runtime env vars are reliable for Vite.
  // The simulated provider stays as an automatic fallback so the app never
  // dead-ends if Twilio is down or misconfigured.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/trpc/telephony.voice.status?batch=1', {
          credentials: 'include',
        });
        if (!res.ok) return;
        const json = await res.json();
        const enabled = Boolean(json?.[0]?.result?.data?.json?.enabled);
        if (!enabled || cancelled) return;
        const { TwilioTelephonyProvider } = await import('./twilio-provider');
        const p = await TwilioTelephonyProvider.create();
        if (p && !cancelled) {
          setProvider((old) => {
            old.dispose();
            return p;
          });
        }
      } catch (err) {
        console.warn('[telephony] provider probe failed; staying simulated:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const refresh = () => setSnapshot(provider.snapshot());
    const unsubs = ALL_EVENTS.map((e) => provider.on(e, refresh));
    refresh();
    return () => {
      unsubs.forEach((u) => u());
      provider.dispose();
    };
  }, [provider]);

  return {
    snapshot,
    provider,
    dial: (n, extra) => provider.dial(n, extra),
    answer: () => provider.answer(),
    hangup: () => provider.hangup(),
    toggleMute: () => provider.toggleMute(),
    toggleHold: () => provider.toggleHold(),
    sendDTMF: (t) => provider.sendDTMF(t),
    toggleSpeaker: () => provider.toggleSpeaker(),
    setPresence: (s) => provider.setPresence(s),
    on: (e, h) => provider.on(e, h),
  };
}
