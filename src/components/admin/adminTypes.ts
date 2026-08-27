import { format } from 'date-fns';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../api/router';

type DashboardOutputs = inferRouterOutputs<AppRouter>['admin']['dashboard'];

/** Row from admin.dashboard.activeCalls — { call, agentName, extensionNumber }. */
export type ActiveCallRow = DashboardOutputs['activeCalls'][number];
/** Row from admin.dashboard.eventFeed — the real TelephonyProvider event bus. */
export type FeedEvent = DashboardOutputs['eventFeed'][number];
/** Row from admin.dashboard.stats. */
export type DashboardStats = DashboardOutputs['stats'];

export const EASE = [0.22, 1, 0.36, 1] as [number, number, number, number];

/** Live statuses the simulated engine reports for in-flight calls. */
export type LiveCallStatus = 'dialing' | 'ringing' | 'active' | 'held';

export function isLiveStatus(s: string): s is LiveCallStatus {
  return s === 'dialing' || s === 'ringing' || s === 'active' || s === 'held';
}

/** Compact mono ticker line: `14:32:11 call_active id=c-1042 in`. */
export function tickerLine(e: FeedEvent): string {
  const ts = format(new Date(e.createdAt), 'HH:mm:ss');
  const dir = e.direction === 'inbound' ? 'in' : 'out';
  return `${ts} ${e.type} id=c-${e.callId} ${dir}`;
}
