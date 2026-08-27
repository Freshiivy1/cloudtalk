import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../api/router';

type RouterOutputs = inferRouterOutputs<AppRouter>;

export type Contact = RouterOutputs['telephony']['contacts']['list'][number];
export type CallRow = RouterOutputs['telephony']['calls']['listMine']['rows'][number];

const digitsOf = (v: string): string => v.replace(/\D/g, '');

/** The "other end" of a call from the agent's perspective. */
export function peerNumber(call: CallRow): string {
  return call.direction === 'outbound' ? call.toNumber : call.fromNumber;
}

/**
 * Loose phone-number equality: digit-only comparison, tolerating country-code
 * prefixes by matching on the trailing 8+ digits (AU contacts are stored in
 * local format like "0412 345 678" while calls carry E.164 "+61412…").
 */
export function sameNumber(a: string, b: string): boolean {
  const da = digitsOf(a);
  const db = digitsOf(b);
  if (!da || !db) return false;
  if (da === db) return true;
  const [shorter, longer] = da.length <= db.length ? [da, db] : [db, da];
  return shorter.length >= 8 && longer.endsWith(shorter);
}
