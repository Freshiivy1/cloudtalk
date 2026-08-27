import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { format } from 'date-fns';
import { trpc } from '@/providers/trpc';
import { cn } from '@/lib/utils';
import { EASE } from './controls';
import type { FeedEvent } from './types';

const TYPE_COLOR: Record<string, string> = {
  call_active: 'text-signal',
  call_ringing: 'text-amber',
  incoming_call: 'text-sky',
  call_ended: 'text-danger',
  call_missed: 'text-danger',
  call_held: 'text-amber',
  call_resumed: 'text-signal',
  presence_changed: 'text-violet',
  queue_updated: 'text-text-mid',
};

/**
 * Live event-schema preview stream — the same feed the future analysis module
 * will consume. Polls the global event bus every 3s and prepends new events.
 */
export default function EventTicker({ limit = 12, maxRows = 8 }: { limit?: number; maxRows?: number }) {
  const feedQuery = trpc.admin.dashboard.eventFeed.useQuery(
    { limit },
    { refetchInterval: 3000 }
  );
  const events = (feedQuery.data ?? []) as FeedEvent[];
  // ids seen before this render commit — anything newer animates in
  const maxSeen = useRef(0);
  useEffect(() => {
    for (const e of events) maxSeen.current = Math.max(maxSeen.current, e.id);
  }, [events]);

  return (
    <div className="overflow-hidden rounded-[10px] border border-violet/25 bg-ink-950/70">
      <div className="flex items-center justify-between border-b border-line/60 px-3 py-2">
        <span className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.08em] text-violet">
          <span className="h-1.5 w-1.5 rounded-full bg-violet animate-live-dot" />
          Live event preview
        </span>
        <span className="font-mono text-[10px] text-text-low">poll 3s · {events.length} events</span>
      </div>
      <div className="max-h-56 overflow-hidden px-3 py-1.5 font-mono text-[11px] leading-5">
        <AnimatePresence initial={false}>
          {events.slice(0, maxRows).map((e) => {
            const isFresh = e.id > maxSeen.current;
            return (
              <motion.div
                key={e.id}
                initial={isFresh ? { opacity: 0, x: -8 } : false}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25, ease: EASE }}
                className="flex items-baseline gap-2 border-b border-line/30 py-1 last:border-0"
              >
                <span className={cn('shrink-0', TYPE_COLOR[e.type] ?? 'text-text-mid')}>{e.type}</span>
                <span className="min-w-0 flex-1 truncate text-text-low">
                  {e.contactName ?? (e.direction === 'inbound' ? e.fromNumber : e.toNumber)} · call #{e.callId}
                </span>
                <span className="shrink-0 text-text-low">{format(new Date(e.createdAt), 'HH:mm:ss')}</span>
              </motion.div>
            );
          })}
        </AnimatePresence>
        {events.length === 0 && (
          <div className="py-4 text-center text-text-low">Listening for events…</div>
        )}
      </div>
    </div>
  );
}
