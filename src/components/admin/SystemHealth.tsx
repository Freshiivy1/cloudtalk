import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { EASE } from './adminTypes';

/** Tiny live latency sparkline — points shift left every 2s, new point pops in. */
function LatencySpark({ data }: { data: number[] }) {
  const w = 72;
  const h = 24;
  const min = Math.min(...data) - 1;
  const max = Math.max(...data) + 1;
  const range = max - min || 1;
  const step = w / (data.length - 1);
  const pts = data.map((d, i) => `${(i * step).toFixed(1)},${(h - 3 - ((d - min) / range) * (h - 6)).toFixed(1)}`);
  const last = pts[pts.length - 1]?.split(',').map(Number) ?? [0, 0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-6 w-[72px]" aria-hidden>
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke="#2EE6A8"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.8"
      />
      <motion.circle
        key={data[data.length - 1]}
        cx={last[0]}
        cy={last[1]}
        r="2.5"
        fill="#2EE6A8"
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ duration: 0.25, ease: EASE }}
      />
    </svg>
  );
}

const rowVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: EASE } },
};

function jitter(): number {
  return 18 + (Math.random() * 12 - 6);
}

export interface SystemHealthProps {
  paused: boolean;
}

/** Compact system-health panel — trunks, media relay, storage, event stream. */
export default function SystemHealth({ paused }: SystemHealthProps) {
  const [latency, setLatency] = useState<number[]>(() => Array.from({ length: 20 }, jitter));

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => {
      setLatency((prev) => [...prev.slice(1), jitter()]);
    }, 2000);
    return () => clearInterval(t);
  }, [paused]);

  const currentLatency = Math.round(latency[latency.length - 1] ?? 18);

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.45, ease: EASE }}
      className="instrument-panel p-4"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-[15px] font-semibold leading-5 text-text-hi">System</h2>
        <span className="flex items-center gap-1.5 text-xs text-signal">
          <span className="h-1.5 w-1.5 rounded-full bg-signal" />
          All systems nominal
        </span>
      </div>

      <motion.div
        initial="hidden"
        animate="show"
        variants={{ hidden: {}, show: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } } }}
        className="mt-3 space-y-3"
      >
        {/* SIP trunk */}
        <motion.div variants={rowVariants} className="flex items-center justify-between gap-2">
          <span className="text-sm text-text-mid">SIP trunk</span>
          <span className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs text-signal">
              <span className="h-1.5 w-1.5 rounded-full bg-signal" />
              Connected
            </span>
            <span className="font-mono text-xs text-text-low">2/2 trunks</span>
          </span>
        </motion.div>

        {/* Media relay */}
        <motion.div variants={rowVariants} className="flex items-center justify-between gap-2">
          <span className="text-sm text-text-mid">Media relay</span>
          <span className="flex items-center gap-2">
            <LatencySpark data={latency} />
            <span className="font-mono text-xs text-signal">{currentLatency}ms</span>
          </span>
        </motion.div>

        {/* Recording storage */}
        <motion.div variants={rowVariants}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-text-mid">Recording storage</span>
            <span className="font-mono text-xs text-text-low">61% of 50 GB</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-700">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: '61%' }}
              transition={{ duration: 0.8, ease: 'easeOut', delay: 0.3 }}
              className="h-full rounded-full bg-amber"
            />
          </div>
        </motion.div>

        {/* Event stream */}
        <motion.div variants={rowVariants} className="flex items-center justify-between gap-2">
          <span className="text-sm text-text-mid">Event stream</span>
          <span className="rounded-full border border-amber/40 bg-amber/10 px-2 py-0.5 font-mono text-[10px] tracking-[0.06em] text-amber">
            simulated
          </span>
        </motion.div>
      </motion.div>

      <div className="mt-3 border-t border-line pt-2.5 font-mono text-[11px] text-text-low">
        Uptime 99.98% · Last incident 12 days ago
      </div>
    </motion.section>
  );
}
