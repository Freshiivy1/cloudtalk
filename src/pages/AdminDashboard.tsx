import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Pause, Play, ShieldAlert } from 'lucide-react';
import AppShell from '@/components/AppShell';
import StatCard from '@/components/StatCard';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { LOGIN_PATH } from '@/const';
import { formatCallDuration } from '@/lib/telephony';
import { cn } from '@/lib/utils';
import LiveCallCard from '@/components/admin/LiveCallCard';
import AnalysisDock from '@/components/admin/AnalysisDock';
import SystemHealth from '@/components/admin/SystemHealth';
import CallDetailDrawer from '@/components/admin/CallDetailDrawer';
import type { ActiveCallRow } from '@/components/admin/adminTypes';
import { EASE } from '@/components/admin/adminTypes';

/** Ticking clock; freezes entirely while the stream is paused (snapshot mode). */
function useNow(paused: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [paused, intervalMs]);
  return now;
}

/** 12 hourly buckets → ~24 sparkline points (midpoint interpolation). */
function toSpark24(v: number[] | undefined): number[] {
  if (!v || v.length < 2) return v ?? [];
  const out: number[] = [];
  for (let i = 0; i < v.length - 1; i++) out.push(v[i]!, (v[i]! + v[i + 1]!) / 2);
  out.push(v[v.length - 1]!);
  return out;
}

/**
 * Live-ticking value: when it changes, the old value slides up 12px and fades
 * while the new one slides in from below (0.25s) with a direction flash.
 */
function TickValue({ value, tone, className }: { value: string; tone: 'up' | 'down' | null; className?: string }) {
  return (
    <span className="relative inline-flex overflow-hidden">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          initial={{ y: 12, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -12, opacity: 0 }}
          transition={{ duration: 0.25, ease: EASE }}
          className={cn(
            className,
            tone === 'up' && 'text-danger',
            tone === 'down' && 'text-signal'
          )}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** KPI card chrome matching StatCard, for metrics StatCard can't express. */
function KpiShell({ label, children, delay = 0 }: { label: string; children: ReactNode; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay, ease: EASE }}
      className="rounded-[14px] border border-line bg-ink-800 p-5"
    >
      <div className="label-caps">{label}</div>
      {children}
    </motion.div>
  );
}

export default function AdminDashboard() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const isAdmin = user?.role === 'admin';
  const enabled = isAuthenticated && isAdmin;

  const [paused, setPaused] = useState(false);
  const [resumeTick, setResumeTick] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const now = useNow(paused);

  // ---------------- Live data (lazy-tick simulation advances on each poll) ----------------
  const refetchInterval = paused ? false : 2500;
  const statsQ = trpc.admin.dashboard.stats.useQuery(undefined, { refetchInterval, enabled });
  const callsQ = trpc.admin.dashboard.activeCalls.useQuery(undefined, { refetchInterval, enabled });
  const feedQ = trpc.admin.dashboard.eventFeed.useQuery({ limit: 30 }, { refetchInterval, enabled });
  const agentsQ = trpc.admin.agents.list.useQuery(undefined, { enabled, staleTime: 15_000 });

  const calls = useMemo(() => callsQ.data ?? [], [callsQ.data]);
  const events = useMemo(() => feedQ.data ?? [], [feedQ.data]);
  const stats = statsQ.data;

  // Arrival / departure toasts off the live call set (skip the initial batch).
  const prevCallsRef = useRef<Map<number, ActiveCallRow> | null>(null);
  useEffect(() => {
    const next = new Map(calls.map((r) => [r.call.id, r]));
    const prev = prevCallsRef.current;
    prevCallsRef.current = next;
    if (prev === null) return;
    for (const [id, row] of next) {
      if (!prev.has(id)) {
        toast.success(
          `Call connected: ${row.call.contactName ?? row.call.fromNumber} → ${row.extensionNumber ? `Ext ${row.extensionNumber}` : (row.agentName ?? 'unassigned')}`
        );
      }
    }
    for (const [id, row] of prev) {
      if (!next.has(id)) {
        toast(`Call ended: ${row.call.contactName ?? row.call.fromNumber}`);
      }
    }
  }, [calls]);

  // Avg. wait time — real ring→answer pairing from the event stream.
  const avgWaitSec = useMemo(() => {
    const ringStart = new Map<number, number>();
    const samples: number[] = [];
    for (const e of [...events].reverse()) {
      const t = new Date(e.createdAt).getTime();
      if ((e.type === 'call_ringing' || e.type === 'incoming_call') && !ringStart.has(e.callId)) {
        ringStart.set(e.callId, t);
      } else if (e.type === 'call_active') {
        const s = ringStart.get(e.callId);
        if (s != null && t >= s) samples.push((t - s) / 1000);
        ringStart.delete(e.callId);
      }
    }
    return samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
  }, [events]);

  // Direction flash for the wait-time tick (longer waits flash red, shorter
  // flash green) — derived-state adjustment during render, no effect needed.
  const [waitState, setWaitState] = useState<{ prev: number | null; tone: 'up' | 'down' | null }>({
    prev: null,
    tone: null,
  });
  if (avgWaitSec !== waitState.prev) {
    const prev = waitState.prev;
    const tone =
      avgWaitSec == null || prev == null || Math.round(avgWaitSec) === Math.round(prev)
        ? null
        : avgWaitSec > prev
          ? 'up'
          : 'down';
    setWaitState({ prev: avgWaitSec, tone });
  }
  const waitTone = waitState.tone;

  // Presence breakdown for the agents-online stacked bar.
  const presence = useMemo(() => {
    const rows = agentsQ.data ?? [];
    const count = { available: 0, busy: 0, away: 0, offline: 0 };
    for (const r of rows) {
      const p = r.presence ?? 'offline';
      if (p in count) count[p as keyof typeof count] += 1;
      else count.offline += 1;
    }
    return count;
  }, [agentsQ.data]);

  // Drawer selection — keeps the last snapshot so an ended call stays inspectable.
  const liveSelected = selectedId == null ? null : (calls.find((r) => r.call.id === selectedId) ?? null);
  const [drawerRow, setDrawerRow] = useState<ActiveCallRow | null>(null);
  // Derived-state adjustment during render: keep the drawer fed with the live
  // row while the call is in flight; retain the last snapshot after it ends.
  if (liveSelected && liveSelected !== drawerRow) {
    setDrawerRow(liveSelected);
  } else if (selectedId == null && drawerRow != null) {
    setDrawerRow(null);
  }

  const togglePause = () => {
    setPaused((v) => {
      const next = !v;
      if (next) toast('Stream paused');
      else {
        toast.success('Stream resumed — catching up');
        setResumeTick((t) => t + 1);
      }
      return next;
    });
  };

  const updatedSec = callsQ.dataUpdatedAt
    ? Math.max(0, Math.floor((now - callsQ.dataUpdatedAt) / 1000))
    : 0;

  const spark24 = toSpark24(stats?.hourlyVolume);
  const lastHour = stats?.hourlyVolume?.[11] ?? 0;
  const liveCount = stats?.liveCalls ?? calls.length;

  // ---------------- Gates ----------------
  let body: ReactNode;
  if (isLoading) {
    body = (
      <div className="grid flex-1 grid-cols-1 gap-4 p-6 xl:grid-cols-[2fr_1fr]">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-32 animate-pulse rounded-[14px] border border-line bg-ink-800" />
            ))}
          </div>
          <div className="h-96 animate-pulse rounded-[14px] border border-line bg-ink-900" />
        </div>
        <div className="h-[480px] animate-pulse rounded-[14px] border border-violet/30 bg-ink-900" />
      </div>
    );
  } else if (!isAuthenticated) {
    body = (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="instrument-panel flex max-w-md flex-col items-center gap-3 p-10 text-center">
          <ShieldAlert className="h-6 w-6 text-violet" />
          <h2 className="font-display text-xl font-semibold text-text-hi">Sign in required</h2>
          <p className="text-sm text-text-mid">The operations console requires an authenticated admin session.</p>
          <Link
            to={LOGIN_PATH}
            className="mt-2 rounded-[10px] border border-signal/40 bg-signal/10 px-4 py-2 text-sm font-medium text-signal transition-colors hover:bg-signal/20"
          >
            Sign in
          </Link>
        </div>
      </div>
    );
  } else if (!isAdmin) {
    body = (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="instrument-panel flex max-w-md flex-col items-center gap-3 p-10 text-center">
          <ShieldAlert className="h-6 w-6 text-amber" />
          <h2 className="font-display text-xl font-semibold text-text-hi">Admin access required</h2>
          <p className="text-sm text-text-mid">This console is restricted to administrators.</p>
          <Link
            to="/app"
            className="mt-2 rounded-[10px] border border-line bg-ink-700 px-4 py-2 text-sm font-medium text-text-hi transition-colors hover:border-signal/50"
          >
            Back to softphone
          </Link>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-6 xl:h-[calc(100dvh-3.5rem)] xl:grid-cols-[2fr_1fr]">
        {/* ================= Left column — KPIs + live monitor ================= */}
        <div className="flex min-h-0 flex-col gap-4 xl:overflow-y-auto xl:pr-1">
          {/* Header & live status bar */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
          >
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="font-display text-[28px] font-semibold leading-[34px] tracking-tight text-text-hi">
                  Overview
                </h2>
                <p className="mt-0.5 font-mono text-xs text-text-low">
                  {paused ? 'Real-time operations · stream paused' : `Real-time operations · updated ${updatedSec}s ago`}
                </p>
              </div>
              <span
                className={cn(
                  'flex items-center gap-2 rounded-full border px-3 py-1.5',
                  paused ? 'border-amber/40 bg-amber/10' : 'border-signal/40 bg-signal/10'
                )}
              >
                <span
                  className={cn(
                    'h-2 w-2 rounded-full',
                    paused ? 'bg-amber' : 'animate-live-dot bg-signal'
                  )}
                />
                <span
                  className={cn(
                    'font-mono text-[11px] font-medium tracking-[0.08em]',
                    paused ? 'text-amber' : 'text-signal'
                  )}
                >
                  {paused ? 'PAUSED' : 'LIVE'}
                </span>
              </span>
              <button
                onClick={togglePause}
                title={paused ? 'Resume stream' : 'Pause stream'}
                className={cn(
                  'flex items-center gap-1.5 rounded-[10px] border px-3 py-1.5 text-xs font-medium transition-colors duration-150',
                  paused
                    ? 'border-amber/40 bg-amber/10 text-amber hover:bg-amber/20'
                    : 'border-line bg-ink-800 text-text-mid hover:border-signal/50 hover:text-text-hi'
                )}
              >
                {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                {paused ? 'Resume stream' : 'Pause stream'}
              </button>
            </div>
            {/* signal-flow hairline */}
            <motion.div
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 0.8, ease: EASE }}
              className="mt-3 h-px origin-left"
              style={{
                background:
                  'linear-gradient(90deg, transparent, rgba(46,230,168,0.6) 30%, rgba(46,230,168,0.6) 70%, transparent)',
              }}
            />
          </motion.div>

          {/* KPI row */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label="Active calls now"
              value={liveCount}
              spark={spark24}
              className={cn(liveCount > 0 && 'border-signal/30')}
            />
            <KpiShell label="Agents online" delay={0.08}>
              <div className="mt-1 font-display text-[28px] font-semibold leading-[34px] tracking-tight text-text-hi">
                {stats?.agentsOnline ?? 0}
                <span className="text-text-low">/{stats?.agentsTotal ?? 0}</span>
              </div>
              <div className="mt-3">
                <div className="flex h-1 overflow-hidden rounded-full bg-ink-700">
                  {(
                    [
                      ['available', 'bg-signal'],
                      ['busy', 'bg-danger'],
                      ['away', 'bg-amber'],
                      ['offline', 'bg-text-low'],
                    ] as const
                  ).map(([k, cls]) => {
                    const total = stats?.agentsTotal ?? 0;
                    const pct = total > 0 ? (presence[k] / total) * 100 : 0;
                    return pct > 0 ? (
                      <span
                        key={k}
                        title={`${k}: ${presence[k]}`}
                        className={cn('h-full', cls)}
                        style={{ width: `${pct}%` }}
                      />
                    ) : null;
                  })}
                </div>
                <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-text-low">
                  <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-signal" />{presence.available}</span>
                  <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-danger" />{presence.busy}</span>
                  <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-amber" />{presence.away}</span>
                  <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-text-low" />{presence.offline}</span>
                </div>
              </div>
            </KpiShell>
            <KpiShell label="Avg. wait time" delay={0.16}>
              <div className="mt-1">
                <TickValue
                  value={avgWaitSec == null ? '—' : formatCallDuration(avgWaitSec)}
                  tone={waitTone}
                  className="font-mono text-[28px] font-medium leading-[34px] text-text-hi"
                />
              </div>
              <div className="mt-3 font-mono text-[10px] text-text-low">ring → answer, live stream</div>
            </KpiShell>
            <StatCard label="Calls today" value={stats?.callsToday ?? 0} spark={spark24} />
          </div>

          {/* Live active calls monitor */}
          <motion.section
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="instrument-panel relative flex-1 p-4"
          >
            {resumeTick > 0 && (
              <motion.div
                key={resumeTick}
                initial={{ opacity: 0.3 }}
                animate={{ opacity: 0 }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
                className="pointer-events-none absolute inset-0 z-10 rounded-[14px] bg-signal/15"
              />
            )}
            <div className="flex items-center gap-2.5">
              <h3 className="font-display text-[18px] font-semibold leading-6 tracking-tight text-text-hi">
                Active Calls
              </h3>
              <span className="rounded-full bg-signal/10 px-2 py-0.5 font-mono text-[11px] font-medium text-signal">
                {calls.length}
              </span>
              <span className="ml-auto hidden font-mono text-[11px] text-text-low sm:block">
                Tap a call to inspect
              </span>
            </div>

            {calls.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <img src="/empty-calls.svg" alt="" className="h-28 w-auto opacity-80" />
                <p className="text-sm text-text-mid">No active calls — all lines quiet.</p>
                {lastHour > 0 && (
                  <p className="font-mono text-[11px] text-text-low">+{lastHour} in last hour</p>
                )}
              </div>
            ) : (
              <motion.div
                layout
                className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3"
              >
                <AnimatePresence>
                  {calls.map((row) => (
                    <LiveCallCard
                      key={row.call.id}
                      row={row}
                      now={now}
                      paused={paused}
                      onDetails={(r) => setSelectedId(r.call.id)}
                    />
                  ))}
                </AnimatePresence>
              </motion.div>
            )}
          </motion.section>
        </div>

        {/* ================= Right column — analysis dock + system health ================= */}
        <div className="flex min-h-0 flex-col gap-4 xl:overflow-y-auto xl:pr-1">
          <AnalysisDock events={events} focusCallId={selectedId} />
          <SystemHealth paused={paused} />
        </div>
      </div>
    );
  }

  return (
    <AppShell variant="admin" title="Overview">
      {body}
      <CallDetailDrawer
        row={drawerRow}
        open={selectedId != null && drawerRow != null}
        events={events}
        now={now}
        paused={paused}
        onClose={() => setSelectedId(null)}
      />
    </AppShell>
  );
}
