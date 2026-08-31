/**
 * Mirrors the softphone's local simulated call lifecycle to the backend so
 * history, recordings and the admin live monitor share one source of truth.
 * The client-side simulation stays authoritative for UX (latency, DTMF, audio);
 * this reporter is fire-and-forget and never blocks the UI.
 */
import { useEffect, useRef } from 'react';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import type {
  PresenceStatus,
  TelephonyEvent,
  TelephonyEventPayload,
  TelephonyHandler,
} from '@/lib/telephony';

type ReporterSource = {
  on: (event: TelephonyEvent, handler: TelephonyHandler) => () => void;
  /** Used only as a subscription dependency so we resubscribe after provider swaps. */
  provider: unknown;
};

const PRESENCE_MAP: Record<
  PresenceStatus,
  'available' | 'busy' | 'away' | 'offline'
> = {
  available: 'available',
  away: 'away',
  dnd: 'busy',
  offline: 'offline',
};

export function useTelephonyReporter(t: ReporterSource) {
  const { isAuthenticated } = useAuth();
  const originate = trpc.telephony.calls.originate.useMutation();
  const event = trpc.telephony.calls.event.useMutation();
  const setPresence = trpc.telephony.presence.set.useMutation();

  const serverCallId = useRef<number | null>(null);
  const pendingEvents = useRef<Array<{ type: string; payload?: Record<string, unknown> }>>([]);

  useEffect(() => {
    if (!isAuthenticated) return;

    const flushPending = () => {
      const id = serverCallId.current;
      if (id == null || id === 0) {
        if (id === 0) pendingEvents.current = [];
        return;
      }
      const queued = pendingEvents.current.splice(0);
      queued.forEach((e) => event.mutate({ callId: id, type: e.type, payload: e.payload }));
    };

    const reportEvent = (type: string, payload?: Record<string, unknown>) => {
      const id = serverCallId.current;
      if (id == null) {
        // Provider events can fire before originate.onSuccess returns; queue them
        // briefly so fast-answering real calls do not lose call_active/call_ended.
        pendingEvents.current.push({ type, payload });
        return;
      }
      if (id === 0) return; // no-history mode
      event.mutate({ callId: id, type, payload });
    };

    const beginCall = (
      call: TelephonyEventPayload['call_ringing']['call'],
    ) => {
      originate.mutate(
        {
          direction: call.direction,
          fromNumber: call.direction === 'inbound' ? call.number : 'softphone',
          toNumber: call.direction === 'inbound' ? 'softphone' : call.number,
          contactName: call.contact?.name,
          clientCallId: call.id,
        },
        {
          onSuccess: (r) => {
            serverCallId.current = r.id;
            if (r.id === 0) {
              pendingEvents.current = [];
            } else {
              flushPending();
            }
          },
          onError: () => {
            // Never leak a failed call's queued events onto the next call.
            serverCallId.current = null;
            pendingEvents.current = [];
          },
        },
      );
    };

    const unsubs = [
      t.on('call_ringing', (p) => {
        const { call } = p as TelephonyEventPayload['call_ringing'];
        if (call.direction === 'outbound') beginCall(call);
      }),
      t.on('incoming_call', (p) => {
        const { call } = p as TelephonyEventPayload['incoming_call'];
        beginCall(call);
      }),
      t.on('call_active', () => reportEvent('call_active')),
      t.on('call_held', () => reportEvent('call_held')),
      t.on('call_resumed', () => reportEvent('call_resumed')),
      t.on('call_ended', (p) => {
        const { durationSecs, missed } =
          p as TelephonyEventPayload['call_ended'];
        reportEvent('call_ended', { durationSecs, missed });
        serverCallId.current = null;
      }),
      t.on('speakerphone_toggled', (p) => {
        const { speakerOn, supported } =
          p as TelephonyEventPayload['speakerphone_toggled'];
        reportEvent('speakerphone_attempted', { enabled: speakerOn, supported });
        reportEvent(speakerOn ? 'speakerphone_enabled' : 'speakerphone_disabled', {
          supported,
        });
      }),
      t.on('listen_live_toggled', (p) => {
        const { listenLiveOn, supported } =
          p as TelephonyEventPayload['listen_live_toggled'];
        reportEvent('listen_live_attempted', { enabled: listenLiveOn, supported });
        reportEvent(listenLiveOn ? 'listen_live_started' : 'listen_live_stopped', {
          supported,
        });
      }),
      t.on('presence_changed', (p) => {
        const { presence } = p as TelephonyEventPayload['presence_changed'];
        setPresence.mutate({ presence: PRESENCE_MAP[presence] });
      }),
    ];
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, t.provider]);
}
