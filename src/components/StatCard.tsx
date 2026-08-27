import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface StatCardProps {
  label: string;
  /** numeric value — counts up 0→value over 0.8s */
  value: number;
  format?: (n: number) => string;
  /** signed % delta vs. yesterday */
  delta?: number;
  /** 40px sparkline data points (signal gradient stroke) */
  spark?: number[];
  compact?: boolean;
  className?: string;
}

function useCountUp(target: number, durationMs = 800): number {
  const [value, setValue] = useState(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    let raf = 0;
    startRef.current = null;
    const tick = (now: number) => {
      if (startRef.current == null) startRef.current = now;
      const p = Math.min(1, (now - startRef.current) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(target * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
}

function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const w = 100;
  const h = 40;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = w / (data.length - 1);
  const points = data.map((d, i) => `${i * step},${h - 4 - ((d - min) / range) * (h - 8)}`);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-10 w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="spark-signal" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#134E3F" />
          <stop offset="1" stopColor="#2EE6A8" />
        </linearGradient>
      </defs>
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke="url(#spark-signal)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Admin KPI card: label, big Space Grotesk number (counts up), delta chip, sparkline. */
export default function StatCard({ label, value, format, delta, spark, compact = false, className }: StatCardProps) {
  const animated = useCountUp(value);
  const display = format ? format(animated) : String(Math.round(animated));

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        'rounded-[14px] border border-line bg-ink-800',
        compact ? 'p-3' : 'p-5',
        className
      )}
    >
      <div className="label-caps">{label}</div>
      <div className={cn('mt-1 flex items-end justify-between gap-2', compact && 'mt-0.5')}>
        <span
          className={cn(
            'font-display font-semibold tracking-tight text-text-hi',
            compact ? 'text-xl' : 'text-[28px] leading-[34px]'
          )}
        >
          {display}
        </span>
        {delta != null && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-mono text-[10px]',
              delta >= 0 ? 'bg-signal/10 text-signal' : 'bg-danger/10 text-danger'
            )}
          >
            {delta >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {delta >= 0 ? '+' : ''}
            {delta}%
          </span>
        )}
      </div>
      {spark && !compact && <div className="mt-3"><Sparkline data={spark} /></div>}
    </motion.div>
  );
}
