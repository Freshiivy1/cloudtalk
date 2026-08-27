import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../api/router';
import type { StatusPillVariant } from '@/components/StatusPill';

type RouterOutputs = inferRouterOutputs<AppRouter>;

export type CallRow = RouterOutputs['telephony']['calls']['listMine']['rows'][number];
export type CallDetail = NonNullable<RouterOutputs['telephony']['calls']['getById']>;
export type CallEventRow = CallDetail['events'][number];

/** The "other end" of a call from the agent's perspective. */
export function peerNumber(call: CallRow): string {
  return call.direction === 'outbound' ? call.toNumber : call.fromNumber;
}

/** Call status → StatusPill variant + label (dropped = failed, amber). */
export function statusPillOf(status: CallRow['status']): { variant: StatusPillVariant; label: string } {
  switch (status) {
    case 'completed':
      return { variant: 'completed', label: 'Completed' };
    case 'missed':
      return { variant: 'missed', label: 'Missed' };
    case 'failed':
      return { variant: 'held', label: 'Dropped' };
    case 'active':
      return { variant: 'active', label: 'Active' };
    case 'held':
      return { variant: 'held', label: 'Held' };
    case 'ringing':
      return { variant: 'ringing', label: 'Ringing' };
    default:
      return { variant: 'ringing', label: 'Dialing' };
  }
}

const EVENT_LABELS: Record<string, string> = {
  incoming_call: 'Incoming call',
  call_ringing: 'Ringing',
  call_active: 'Connected',
  call_held: 'Held',
  call_resumed: 'Resumed',
  call_muted: 'Muted',
  call_unmuted: 'Unmuted',
  dtmf: 'Keypad tone',
  call_ended: 'Ended',
};

export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type.replace(/_/g, ' ');
}

/** Extract a human suffix like "(agent hangup)" from a stringified JSON payload. */
export function eventSuffix(payload: string | null): string {
  if (!payload) return '';
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const by = parsed.by ?? parsed.reason ?? parsed.actor;
    return typeof by === 'string' ? ` (${by})` : '';
  } catch {
    return '';
  }
}

/** Simulated telecom flavor cost estimate, e.g. $0.04. */
export function estimatedCost(durationSec: number | null | undefined): string {
  const secs = Math.max(0, durationSec ?? 0);
  if (secs === 0) return '$0.00';
  return `$${((secs / 60) * 0.012).toFixed(2)}`;
}
