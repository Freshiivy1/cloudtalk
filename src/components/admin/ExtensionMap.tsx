import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronsUpDown, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EASE, GhostButton } from './controls';
import type { ExtensionRow, ExtensionStatus } from './types';

/**
 * Extension Map — the visual "switchboard" grid of the extension range.
 * Cells are tinted by live extension status (polled by the parent every 5s,
 * so the map breathes with the simulated event bus).
 */
export default function ExtensionMap({
  extensions,
  onProvisionNumber,
  className,
}: {
  extensions: ExtensionRow[];
  /** free-cell "+" shortcut — assign/provision that number */
  onProvisionNumber: (num: string) => void;
  className?: string;
}) {
  const [expandOpen, setExpandOpen] = useState(false);

  const byNumber = useMemo(() => {
    const m = new Map<string, ExtensionRow>();
    for (const row of extensions) m.set(row.extension.number, row);
    return m;
  }, [extensions]);

  const { rangeStart, cells } = useMemo(() => {
    const nums = extensions
      .map((r) => parseInt(r.extension.number, 10))
      .filter((n) => Number.isFinite(n));
    const start = nums.length ? Math.min(...nums) : 100;
    const end = nums.length ? Math.max(...nums) : 131;
    const list: string[] = [];
    for (let n = start; n <= end; n++) list.push(String(n));
    return { rangeStart: start, cells: list };
  }, [extensions]);

  const freeCount = useMemo(
    () => cells.filter((n) => !byNumber.get(n)?.agentId).length,
    [cells, byNumber]
  );

  return (
    <motion.aside
      initial={{ x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.5, ease: EASE, delay: 0.15 }}
      className={cn('flex w-80 shrink-0 flex-col rounded-[14px] border border-line bg-ink-900', className)}
    >
      <div className="border-b border-line px-4 py-3.5">
        <h2 className="font-display text-[15px] font-semibold text-text-hi">Extension Map</h2>
        <p className="mt-0.5 font-mono text-[11px] text-text-low">
          Range {rangeStart}–{cells.length ? cells[cells.length - 1] : '—'}
        </p>
      </div>

      <div className="grid flex-1 grid-cols-4 content-start gap-2 overflow-y-auto p-4">
        {cells.map((num, i) => {
          const row = byNumber.get(num);
          return (
            <MapCell
              key={num}
              num={num}
              row={row}
              index={i}
              onPlus={() => onProvisionNumber(num)}
            />
          );
        })}
      </div>

      <div className="relative border-t border-line px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-low">{freeCount} extensions free</span>
          <GhostButton className="px-2.5 py-1.5 text-xs" onClick={() => setExpandOpen((v) => !v)}>
            <ChevronsUpDown className="h-3.5 w-3.5" />
            Expand range
          </GhostButton>
        </div>
        {expandOpen && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="absolute bottom-full right-3 mb-2 w-64 rounded-[14px] border border-line bg-ink-800 p-4 shadow-xl"
          >
            <div className="label-caps mb-2">Provision range</div>
            <div className="flex items-center gap-2">
              <input
                defaultValue={String(rangeStart)}
                className="w-20 rounded-[10px] border border-line bg-ink-700 px-2.5 py-1.5 font-mono text-[13px] text-text-hi outline-none"
              />
              <span className="text-text-low">–</span>
              <input
                defaultValue={cells.length ? cells[cells.length - 1] : ''}
                className="w-20 rounded-[10px] border border-line bg-ink-700 px-2.5 py-1.5 font-mono text-[13px] text-text-hi outline-none"
              />
            </div>
            <p className="mt-2.5 text-[11px] leading-4 text-text-low">
              Provisioned by the telephony provider — simulated. Use a free cell's + to add a single
              extension now.
            </p>
          </motion.div>
        )}
      </div>
    </motion.aside>
  );
}

/* ------------------------------------------------------------------------- */

function MapCell({
  num,
  row,
  index,
  onPlus,
}: {
  num: string;
  row: ExtensionRow | undefined;
  index: number;
  onPlus: () => void;
}) {
  const status: ExtensionStatus | 'free' = !row?.agentId ? 'free' : row.extension.status;
  const inCall = status === 'in_call' || status === 'ringing';

  return (
    <motion.button
      type="button"
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.3, ease: EASE, delay: index * 0.015 }}
      whileHover={{ y: -2 }}
      onClick={status === 'free' ? onPlus : undefined}
      title={
        status === 'free'
          ? `Assign extension ${num}`
          : `${num} · ${row?.agentName ?? 'Unassigned'} · ${status}`
      }
      className={cn(
        'group relative flex h-14 flex-col items-center justify-center rounded-[10px] border transition-colors duration-400',
        status === 'free' && 'border-dashed border-line text-text-low hover:border-signal/50 hover:text-signal',
        status === 'idle' && 'border-signal/20 bg-signal-dim/40 text-signal',
        status === 'held' && 'border-amber/30 bg-amber/10 text-amber',
        status === 'offline' && 'border-line bg-ink-700 text-text-low',
        inCall && 'border-signal/40 bg-signal/25 text-signal',
        status !== 'free' && 'cursor-default'
      )}
      style={inCall ? { boxShadow: '0 0 18px rgba(46,230,168,0.18)' } : undefined}
    >
      <span className="font-mono text-[13px] font-medium leading-4">{num}</span>

      {status === 'free' ? (
        <Plus className="mt-0.5 h-3 w-3 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
      ) : inCall ? (
        /* tiny animated waveform dots (3-dot bounce) */
        <span className="mt-1 flex items-end gap-[3px]">
          {[0, 1, 2].map((d) => (
            <motion.span
              key={d}
              className="h-1 w-1 rounded-full bg-signal"
              animate={{ scaleY: [1, 2.2, 1], opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 0.9, repeat: Infinity, delay: d * 0.15 }}
            />
          ))}
        </span>
      ) : (
        <span className="mt-0.5 max-w-full truncate px-1 text-[9px] font-medium uppercase tracking-wide text-text-low">
          {row?.agentName
            ? row.agentName
                .split(' ')
                .map((p) => p[0])
                .slice(0, 2)
                .join('')
            : '—'}
        </span>
      )}
    </motion.button>
  );
}
