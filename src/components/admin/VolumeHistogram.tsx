import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { format, subDays } from 'date-fns';
import { cn } from '@/lib/utils';
import { EASE } from './controls';

/**
 * 30-day call volume histogram filter strip. Clicking a bar sets the date
 * filter to that day onward ("Since Mar 12"); clicking again clears it.
 */
export default function VolumeHistogram({
  data,
  selectedIdx,
  onSelect,
}: {
  /** number[30], idx 0 = oldest day, idx 29 = today */
  data: number[];
  selectedIdx: number | null;
  onSelect: (idx: number | null) => void;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const max = Math.max(1, ...data);

  const days = useMemo(
    () =>
      data.map((count, i) => ({
        count,
        date: subDays(new Date(), data.length - 1 - i),
      })),
    [data]
  );

  return (
    <div>
      <div className="flex h-24 items-end gap-[3px]">
        {days.map((d, i) => {
          const selected = selectedIdx === i;
          const inSelectedRange = selectedIdx != null && i >= selectedIdx;
          return (
            <motion.button
              key={i}
              initial={{ scaleY: 0 }}
              animate={{ scaleY: 1, scale: selected ? [1, 1.15, 1] : 1 }}
              transition={{
                scaleY: { duration: 0.6, ease: EASE, delay: i * 0.02 },
                scale: { duration: 0.3 },
              }}
              onClick={() => onSelect(selected ? null : i)}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
              title={`${format(d.date, 'MMM d')} · ${d.count} calls`}
              className={cn(
                'group relative flex-1 origin-bottom rounded-t-[3px] transition-colors duration-150',
                selected
                  ? 'bg-signal'
                  : inSelectedRange
                    ? 'bg-signal/50 hover:bg-signal/70'
                    : 'bg-gradient-to-t from-ink-700 to-signal/40 hover:to-signal/70'
              )}
              style={{ height: `${Math.max(6, (d.count / max) * 100)}%` }}
            >
              {selected && (
                <span className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-signal">
                  {format(d.date, 'MMM d')}
                </span>
              )}
            </motion.button>
          );
        })}
      </div>

      <div className="mt-2 flex items-center justify-between">
        <span className="flex items-center gap-3 text-[11px] text-text-low">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-[2px] bg-signal/50" /> total
          </span>
          {hoverIdx != null && (
            <span className="font-mono text-text-mid">
              {format(days[hoverIdx].date, 'MMM d')} · {days[hoverIdx].count} calls
            </span>
          )}
        </span>
        <span className="font-mono text-[11px] text-text-low">
          {selectedIdx != null ? `Since ${format(days[selectedIdx].date, 'MMM d')}` : 'Last 30 days'}
        </span>
      </div>
    </div>
  );
}
