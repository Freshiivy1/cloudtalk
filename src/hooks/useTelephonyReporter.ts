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

  useEffect(() => {
    if (!isAuthenticated) return;

    const reportEvent = (type: string, payload?: Record<string, unknown>) => {
      const id = serverCallId.current;
      if (id == null) return;
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
        },
        {
          onSuccess: (r) => {
            serverCallId.current = r.id;
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
      t.on('presence_changed', (p) => {
        const { presence } = p as TelephonyEventPayload['presence_changed'];
        setPresence.mutate({ presence: PRESENCE_MAP[presence] });
      }),
    ];
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);
}
