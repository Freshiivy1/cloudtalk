import { useMemo } from 'react';
import { motion } from 'framer-motion';
import StatCard from '@/components/StatCard';
import { formatCallDuration } from '@/lib/telephony';

const EASE = [0.22, 1, 0.36, 1] as [number, number, number, number];

type StatsToday = {
  total: number;
  completed: number;
  missed: number;
  talkSec: number;
};

export interface InsightsStripProps {
  /** trpc.telephony.calls.myStatsToday output (undefined while loading) */
  stats: StatsToday | null | undefined;
  /** calls per day for the last 7 days (oldest → today) */
  weekCounts: number[];
  /** matching day labels (e.g. Mon, Tue, …) */
  weekLabels: string[];
}

/**
 * Row of quick stat cards above the call-history table: today's volume,
 * answer rate, missed count, talk time — plus a 7-day activity sparkline.
 */
export default function InsightsStrip({ stats, weekCounts, weekLabels }: InsightsStripProps) {
  const answerRate = useMemo(() => {
    if (!stats || stats.total === 0) return 0;
    return Math.round((stats.completed / stats.total) * 100);
  }, [stats]);

  const busiest = useMemo(() => {
    const max = Math.max(...weekCounts, 0);
    if (max === 0) return null;
    const idx = weekCounts.indexOf(max);
    return { label: weekLabels[idx], count: max };
  }, [weekCounts, weekLabels]);

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard label="Calls today" value={stats?.total ?? 0} spark={weekCounts} />
      <StatCard
        label="Answer rate"
        value={answerRate}
        format={(n) => `${n}%`}
        compact={false}
      />
      <StatCard label="Missed today" value={stats?.missed ?? 0} />
      <StatCard
        label="Talk time today"
        value={stats?.talkSec ?? 0}
        format={(n) => formatCallDuration(Math.round(n))}
      />
      {busiest && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, ease: EASE }}
          className="col-span-2 -mt-1 text-[11px] text-text-low lg:col-span-4"
        >
          Busiest day this week: {busiest.label} ({busiest.count}{' '}
          {busiest.count === 1 ? 'call' : 'calls'})
        </motion.div>
      )}
    </div>
  );
}
