import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import type { FeedEvent } from './adminTypes';
import { EASE, tickerLine } from './adminTypes';

export interface EventTickerProps {
  events: FeedEvent[];
  /** max visible rows (design: 8) */
  rows?: number;
  className?: string;
}

/**
 * Raw call-event ticker — proof the Live Analysis dock is wired to the real
 * simulated TelephonyProvider event bus. New rows prepend with an 8px slide.
 */
export default function EventTicker({ events, rows = 8, className }: EventTickerProps) {
  const visible = events.slice(0, rows);
  return (
    <div className={cn('overflow-hidden rounded-[10px] bg-ink-950/60 px-2 py-1.5', className)}>
      {visible.length === 0 ? (
        <div className="font-mono text-[11px] leading-5 text-text-low">
          — waiting for call events…
        </div>
      ) : (
        <AnimatePresence initial={false}>
          {visible.map((e) => (
            <motion.div
              key={e.id}
              layout="position"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25, ease: EASE }}
              className="truncate font-mono text-[11px] leading-5 text-text-low"
            >
              {tickerLine(e)}
            </motion.div>
          ))}
        </AnimatePresence>
      )}
    </div>
  );
}
