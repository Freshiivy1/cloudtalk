import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarRange,
  Check,
  ChevronDown,
  Copy,
  Download,
  FileText,
  MoreVertical,
  Phone,
  PhoneMissed,
  Search,
  UserPlus,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { format, isToday, subDays } from 'date-fns';
import AppShell from '@/components/AppShell';
import DataTable from '@/components/DataTable';
import type { DataTableColumn } from '@/components/DataTable';
import StatusPill from '@/components/StatusPill';
import InsightsStrip from '@/components/history/InsightsStrip';
import CallDetailDrawer from '@/components/history/CallDetailDrawer';
import { peerNumber, statusPillOf } from '@/components/history/shared';
import type { CallRow } from '@/components/history/shared';
import { trpc } from '@/providers/trpc';
import { cn } from '@/lib/utils';
import { formatCallDuration } from '@/lib/telephony';
import type { PresenceStatus } from '@/lib/telephony';

const EASE = [0.22, 1, 0.36, 1] as [number, number, number, number];
const PAGE_SIZE = 25;
const FETCH_SIZE = 200;

type DirFilter = 'all' | 'inbound' | 'outbound' | 'missed';
type StatusFilter = 'all' | 'completed' | 'missed' | 'failed';
type RangeFilter = 'today' | '7d' | '30d' | 'custom';

const DIR_TABS: Array<{ key: DirFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'inbound', label: 'Inbound' },
  { key: 'outbound', label: 'Outbound' },
  { key: 'missed', label: 'Missed' },
];

const STATUS_OPTIONS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All statuses' },
  { key: 'completed', label: 'Completed' },
  { key: 'missed', label: 'Missed' },
  { key: 'failed', label: 'Dropped' },
];

const RANGE_OPTIONS: Array<{ key: RangeFilter; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'custom', label: 'Custom' },
];

/** Wire the shell presence selector to the telephony backend (dnd ↔ busy). */
function useShellPresence() {
  const utils = trpc.useUtils();
  const mine = trpc.telephony.presence.mine.useQuery();
  const setMut = trpc.telephony.presence.set.useMutation({
    onSuccess: () => utils.telephony.presence.mine.invalidate(),
  });
  const backend = mine.data?.presence;
  const presence: PresenceStatus =
    backend === 'busy' ? 'dnd' : backend === 'available' || backend === 'away' || backend === 'offline' ? backend : 'available';
  const onPresenceChange = (p: PresenceStatus) => setMut.mutate({ presence: p === 'dnd' ? 'busy' : p });
  return { presence, onPresenceChange };
}

function DirectionIcon({ call }: { call: CallRow }) {
  if (call.status === 'missed') return <PhoneMissed className="h-4 w-4 text-danger" />;
  return call.direction === 'inbound' ? (
    <ArrowDownLeft className="h-4 w-4 text-sky" />
  ) : (
    <ArrowUpRight className="h-4 w-4 text-signal" />
  );
}

export default function CallHistory() {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const { presence, onPresenceChange } = useShellPresence();
  const [searchParams, setSearchParams] = useSearchParams();

  /* ---------------------- filter state (URL-backed) --------------------- */
  const dir = (searchParams.get('dir') ?? 'all') as DirFilter;
  const status = (searchParams.get('status') ?? 'all') as StatusFilter;
  const range = (searchParams.get('range') ?? '30d') as RangeFilter;
  const q = searchParams.get('q') ?? '';
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  const drawerCallId = searchParams.get('call') ? Number(searchParams.get('call')) : null;

  const setParam = (key: string, value: string | null) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value == null || value === '') next.delete(key);
        else next.set(key, value);
        if (key !== 'page' && key !== 'call') next.delete('page');
        return next;
      },
      { replace: true }
    );
  };

  const [searchInput, setSearchInput] = useState(q);
  useEffect(() => setSearchInput(q), [q]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (searchInput.trim() !== q) setParam('q', searchInput.trim() || null);
    }, 150);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const [statusOpen, setStatusOpen] = useState(false);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  /* -------------------------------- data -------------------------------- */
  const listQuery = trpc.telephony.calls.listMine.useQuery(
    { page: 1, pageSize: FETCH_SIZE },
    { refetchInterval: 5000 }
  );
  const statsQuery = trpc.telephony.calls.myStatsToday.useQuery();
  const saveContactMut = trpc.telephony.contacts.create.useMutation({
    onSuccess: () => {
      toast('Contact saved');
      void utils.telephony.contacts.list.invalidate();
    },
    onError: (e) => toast.error('Could not save contact', { description: e.message }),
  });

  const allRows = useMemo(() => listQuery.data?.rows ?? [], [listQuery.data]);
  const serverTotal = listQuery.data?.total ?? 0;

  /* live prepend: flash rows that appear after the initial load */
  const seenRef = useRef<Set<number> | null>(null);
  const [flashIds, setFlashIds] = useState<Set<number>>(new Set());
  useEffect(() => {
    const ids = new Set(allRows.map((r) => r.id));
    if (seenRef.current == null) {
      seenRef.current = ids;
      return;
    }
    const prevSeen = seenRef.current;
    const fresh = [...ids].filter((id) => !prevSeen.has(id));
    seenRef.current = ids;
    if (fresh.length > 0) {
      setFlashIds((prev) => new Set([...prev, ...fresh]));
      const t = window.setTimeout(() => {
        setFlashIds((prev) => {
          const next = new Set(prev);
          fresh.forEach((id) => next.delete(id));
          return next;
        });
      }, 2000);
      return () => window.clearTimeout(t);
    }
  }, [allRows]);

  /* ---------------------------- derived data ---------------------------- */
  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    const now = new Date();
    return allRows.filter((c) => {
      if (dir === 'inbound' && c.direction !== 'inbound') return false;
      if (dir === 'outbound' && c.direction !== 'outbound') return false;
      if (dir === 'missed' && c.status !== 'missed') return false;
      if (status !== 'all' && c.status !== status) return false;
      const started = new Date(c.startedAt);
      if (range === 'today' && !isToday(started)) return false;
      if (range === '7d' && started < subDays(now, 7)) return false;
      if (range === '30d' && started < subDays(now, 30)) return false;
      if (range === 'custom') {
        if (customFrom && started < new Date(`${customFrom}T00:00:00`)) return false;
        if (customTo && started > new Date(`${customTo}T23:59:59`)) return false;
      }
      if (needle) {
        const hay = `${c.contactName ?? ''} ${c.fromNumber} ${c.toNumber}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [allRows, dir, status, range, customFrom, customTo, q]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage]
  );

  const counts = useMemo(
    () => ({
      all: allRows.length,
      inbound: allRows.filter((c) => c.direction === 'inbound').length,
      outbound: allRows.filter((c) => c.direction === 'outbound').length,
      missed: allRows.filter((c) => c.status === 'missed').length,
    }),
    [allRows]
  );

  const { weekCounts, weekLabels } = useMemo(() => {
    const countsArr: number[] = [];
    const labels: string[] = [];
    for (let i = 6; i >= 0; i--) {
      const day = subDays(new Date(), i);
      labels.push(format(day, 'EEE'));
      countsArr.push(
        allRows.filter((c) => {
          const d = new Date(c.startedAt);
          return d.getFullYear() === day.getFullYear() && d.getMonth() === day.getMonth() && d.getDate() === day.getDate();
        }).length
      );
    }
    return { weekCounts: countsArr, weekLabels: labels };
  }, [allRows]);

  /* ------------------------------ actions ------------------------------- */
  const redial = (number: string, name: string | null) => {
    toast(`Dialing ${name ?? number}…`, { description: number });
    navigate('/app', { state: { dial: { number, name } } });
  };

  const exportCsv = () => {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = [
      'Date,Direction,Contact,Number,Status,Duration (sec)',
      ...filtered.map((c) =>
        [
          format(new Date(c.startedAt), 'yyyy-MM-dd HH:mm'),
          c.direction,
          esc(c.contactName ?? 'Unknown'),
          esc(peerNumber(c)),
          c.status,
          String(c.durationSec ?? 0),
        ].join(',')
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'call-history.csv';
    a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${filtered.length} rows`);
  };

  /* ------------------------------ keyboard ------------------------------ */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      if (e.key === 'Escape') {
        if (drawerCallId != null) setParam('call', null);
        return;
      }
      if (typing || drawerCallId != null) return;
      const idx = pageRows.findIndex((r) => r.id === selectedId);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = pageRows[Math.min(pageRows.length - 1, idx + 1)] ?? pageRows[0];
        if (next) setSelectedId(next.id);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = pageRows[Math.max(0, idx - 1)] ?? pageRows[0];
        if (prev) setSelectedId(prev.id);
      } else if (e.key === 'Enter' && idx >= 0) {
        setParam('call', String(pageRows[idx].id));
      } else if ((e.key === 'r' || e.key === 'R') && idx >= 0) {
        const row = pageRows[idx];
        redial(peerNumber(row), row.contactName);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /* --------------------------- table columns ---------------------------- */
  const columns: Array<DataTableColumn<CallRow & Record<string, unknown>>> = [
    {
      key: 'direction',
      header: 'Direction',
      render: (row) => (
        <span className="relative flex items-center">
          {row.status === 'missed' && (
            <span className="absolute -left-4 h-5 w-[2px] rounded-full bg-danger/40" />
          )}
          {selectedId === row.id && row.status !== 'missed' && (
            <span className="absolute -left-4 h-5 w-[2px] rounded-full bg-signal" />
          )}
          <motion.span
            initial={flashIds.has(row.id) ? { backgroundColor: 'rgba(46,230,168,0.18)' } : false}
            animate={{ backgroundColor: 'rgba(46,230,168,0)' }}
            transition={{ duration: 2 }}
            className="-m-1.5 rounded-lg p-1.5"
            title={
              row.status === 'missed'
                ? 'Missed call'
                : row.direction === 'inbound'
                  ? 'Inbound call'
                  : 'Outbound call'
            }
          >
            <DirectionIcon call={row} />
          </motion.span>
        </span>
      ),
    },
    {
      key: 'contact',
      header: 'Contact / Number',
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-sm font-medium text-text-hi">{row.contactName ?? 'Unknown'}</span>
          <span className="font-mono text-xs text-text-low">{peerNumber(row)}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => {
        const pill = statusPillOf(row.status);
        return <StatusPill variant={pill.variant} label={pill.label} />;
      },
    },
    {
      key: 'duration',
      header: 'Duration',
      mono: true,
      render: (row) => (row.durationSec > 0 ? formatCallDuration(row.durationSec) : '—'),
    },
    {
      key: 'date',
      header: 'Date',
      render: (row) => {
        const d = new Date(row.startedAt);
        return (
          <span className="text-text-mid">
            {isToday(d) ? `Today, ${format(d, 'HH:mm')}` : format(d, 'MMM d, HH:mm')}
          </span>
        );
      },
    },
    {
      key: 'recording',
      header: 'Recording',
      render: (row) =>
        row.hasRecording ? (
          <span title="Recording available" className="text-violet">
            <svg width="18" height="14" viewBox="0 0 18 14" fill="none" className="inline-block">
              {[1, 4, 7, 10, 13, 16].map((x, i) => (
                <rect
                  key={x}
                  x={x}
                  y={7 - [3, 6, 4, 7, 5, 3][i]}
                  width="2"
                  height={[3, 6, 4, 7, 5, 3][i] * 2}
                  rx="1"
                  fill="currentColor"
                  opacity={0.6 + 0.1 * (i % 3)}
                />
              ))}
            </svg>
          </span>
        ) : (
          <span className="text-text-low">—</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-[120px]',
      render: (row) => (
        <span className="relative flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={(e) => {
              e.stopPropagation();
              redial(peerNumber(row), row.contactName);
            }}
            title="Redial"
            className="rounded-lg p-1.5 text-text-mid transition-colors hover:bg-signal/10 hover:text-signal"
          >
            <Phone className="h-4 w-4" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setParam('call', String(row.id));
            }}
            title="Note"
            className="rounded-lg p-1.5 text-text-mid transition-colors hover:bg-ink-700 hover:text-text-hi"
          >
            <FileText className="h-4 w-4" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenuFor(menuFor === row.id ? null : row.id);
            }}
            title="More actions"
            className="rounded-lg p-1.5 text-text-mid transition-colors hover:bg-ink-700 hover:text-text-hi"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          {menuFor === row.id && (
            <>
              <span className="fixed inset-0 z-10 cursor-default" onClick={(e) => { e.stopPropagation(); setMenuFor(null); }} />
              <span className="absolute right-0 top-8 z-20 w-44 overflow-hidden rounded-[10px] border border-line bg-ink-800 shadow-lg">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuFor(null);
                    saveContactMut.mutate({ name: row.contactName ?? peerNumber(row), phone: peerNumber(row) });
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-[13px] text-text-mid transition-colors hover:bg-ink-700 hover:text-text-hi"
                >
                  <UserPlus className="h-3.5 w-3.5" /> Save contact
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuFor(null);
                    void navigator.clipboard.writeText(peerNumber(row));
                    toast('Number copied', { description: peerNumber(row) });
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-[13px] text-text-mid transition-colors hover:bg-ink-700 hover:text-text-hi"
                >
                  <Copy className="h-3.5 w-3.5" /> Copy number
                </button>
              </span>
            </>
          )}
        </span>
      ),
    },
  ];

  /* --------------------------- filter chips ----------------------------- */
  const chips: Array<{ key: string; label: string; clear: () => void }> = [];
  if (dir !== 'all') chips.push({ key: 'dir', label: DIR_TABS.find((t) => t.key === dir)?.label ?? dir, clear: () => setParam('dir', null) });
  if (status !== 'all') chips.push({ key: 'status', label: STATUS_OPTIONS.find((s) => s.key === status)?.label ?? status, clear: () => setParam('status', null) });
  if (range !== '30d')
    chips.push({
      key: 'range',
      label: range === 'custom' ? `Custom${customFrom ? ` ${customFrom}` : ''}${customTo ? ` → ${customTo}` : ''}` : (RANGE_OPTIONS.find((r) => r.key === range)?.label ?? range),
      clear: () => setParam('range', null),
    });
  if (q) chips.push({ key: 'q', label: `“${q}”`, clear: () => { setSearchInput(''); setParam('q', null); } });

  return (
    <AppShell variant="agent" title="Call History" presence={presence} onPresenceChange={onPresenceChange}>
      <div className="flex min-h-0 flex-1 flex-col p-6">
        {/* -------------------------- header -------------------------- */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: EASE }}
          className="mb-5"
        >
          <h2 className="font-display text-[28px] font-semibold leading-[34px] tracking-tight text-text-hi">
            Call History
          </h2>
          <p className="mt-1 text-sm text-text-mid">Your last 30 days · {serverTotal} calls</p>
        </motion.div>

        {/* ------------------------ insights strip ------------------------ */}
        <div className="mb-5">
          <InsightsStrip stats={statsQuery.data} weekCounts={weekCounts} weekLabels={weekLabels} />
        </div>

        {/* ---------------------- filter bar (sticky) ---------------------- */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1, ease: EASE }}
          className="sticky top-14 z-20 -mx-6 mb-4 border-b border-line bg-ink-900/80 px-6 py-3 backdrop-blur-md"
        >
          <div className="flex flex-wrap items-center gap-3">
            {/* direction segmented control */}
            <div className="flex items-center gap-1 rounded-full border border-line bg-ink-950 p-1">
              {DIR_TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setParam('dir', t.key === 'all' ? null : t.key)}
                  className={cn(
                    'relative rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors',
                    dir === t.key ? 'text-signal' : 'text-text-mid hover:text-text-hi'
                  )}
                >
                  {dir === t.key && (
                    <motion.span
                      layoutId="history-dir-pill"
                      className="absolute inset-0 rounded-full bg-signal-dim/50"
                      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                    />
                  )}
                  <span className="relative">
                    {t.label}
                    {t.key !== 'all' && <span className="ml-1 font-mono text-[10px] text-text-low">{counts[t.key]}</span>}
                  </span>
                </button>
              ))}
            </div>

            {/* date range dropdown */}
            <div className="relative">
              <button
                onClick={() => {
                  setRangeOpen((v) => !v);
                  setStatusOpen(false);
                }}
                className="flex items-center gap-2 rounded-[10px] border border-line bg-ink-800 px-3 py-2 text-[13px] text-text-mid transition-colors hover:border-signal/40 hover:text-text-hi"
              >
                <CalendarRange className="h-3.5 w-3.5 text-text-low" />
                {range === 'custom' ? 'Custom range' : (RANGE_OPTIONS.find((r) => r.key === range)?.label ?? 'Last 30 days')}
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', rangeOpen && 'rotate-180')} />
              </button>
              {rangeOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setRangeOpen(false)} />
                  <div className="absolute left-0 z-20 mt-1 w-56 overflow-hidden rounded-[10px] border border-line bg-ink-800 p-1 shadow-lg">
                    {RANGE_OPTIONS.map((r) => (
                      <button
                        key={r.key}
                        onClick={() => {
                          if (r.key !== 'custom') {
                            setParam('range', r.key === '30d' ? null : r.key);
                            setRangeOpen(false);
                          } else {
                            setParam('range', 'custom');
                          }
                        }}
                        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-[13px] text-text-mid transition-colors hover:bg-ink-700 hover:text-text-hi"
                      >
                        {r.label}
                        {range === r.key && <Check className="h-3.5 w-3.5 text-signal" />}
                      </button>
                    ))}
                    {range === 'custom' && (
                      <div className="space-y-2 border-t border-line p-2">
                        <input
                          type="date"
                          value={customFrom}
                          onChange={(e) => setCustomFrom(e.target.value)}
                          className="w-full rounded-lg border border-line bg-ink-700 px-2 py-1.5 font-mono text-xs text-text-hi outline-none focus:border-signal/50"
                        />
                        <input
                          type="date"
                          value={customTo}
                          onChange={(e) => setCustomTo(e.target.value)}
                          className="w-full rounded-lg border border-line bg-ink-700 px-2 py-1.5 font-mono text-xs text-text-hi outline-none focus:border-signal/50"
                        />
                        <button
                          onClick={() => setRangeOpen(false)}
                          className="w-full rounded-lg bg-signal px-3 py-1.5 text-xs font-semibold text-ink-950"
                        >
                          Apply
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* status dropdown */}
            <div className="relative">
              <button
                onClick={() => {
                  setStatusOpen((v) => !v);
                  setRangeOpen(false);
                }}
                className="flex items-center gap-2 rounded-[10px] border border-line bg-ink-800 px-3 py-2 text-[13px] text-text-mid transition-colors hover:border-signal/40 hover:text-text-hi"
              >
                {STATUS_OPTIONS.find((s) => s.key === status)?.label ?? 'All statuses'}
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', statusOpen && 'rotate-180')} />
              </button>
              {statusOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setStatusOpen(false)} />
                  <div className="absolute left-0 z-20 mt-1 w-44 overflow-hidden rounded-[10px] border border-line bg-ink-800 p-1 shadow-lg">
                    {STATUS_OPTIONS.map((s) => (
                      <button
                        key={s.key}
                        onClick={() => {
                          setParam('status', s.key === 'all' ? null : s.key);
                          setStatusOpen(false);
                        }}
                        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-[13px] text-text-mid transition-colors hover:bg-ink-700 hover:text-text-hi"
                      >
                        {s.label}
                        {status === s.key && <Check className="h-3.5 w-3.5 text-signal" />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* active filter chips */}
            <AnimatePresence>
              {chips.map((chip) => (
                <motion.span
                  key={chip.key}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                  transition={{ duration: 0.2 }}
                  className="flex items-center gap-1.5 rounded-full border border-signal/30 bg-signal/10 px-2.5 py-1 text-xs text-signal"
                >
                  {chip.label}
                  <button onClick={chip.clear} className="rounded-full p-0.5 hover:bg-signal/20" title="Remove filter">
                    <X className="h-3 w-3" />
                  </button>
                </motion.span>
              ))}
            </AnimatePresence>

            {/* search */}
            <div className="ml-auto flex w-64 max-w-full items-center gap-2 rounded-[10px] border border-line bg-ink-800 px-3 py-2 text-sm transition-colors focus-within:border-signal/50">
              <Search className="h-4 w-4 shrink-0 text-text-low" />
              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search number or contact…"
                className="w-full bg-transparent text-text-hi outline-none placeholder:text-text-low"
              />
              {searchInput && (
                <button onClick={() => { setSearchInput(''); setParam('q', null); }} className="shrink-0 text-text-low hover:text-text-hi" title="Clear search">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* export */}
            <button
              onClick={exportCsv}
              className="flex items-center gap-2 rounded-[10px] border border-line bg-ink-800 px-3 py-2 text-[13px] text-text-mid transition-colors hover:border-signal/40 hover:text-text-hi"
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </button>
          </div>
        </motion.div>

        {/* ---------------------------- table ----------------------------- */}
        <AnimatePresence mode="wait">
          {listQuery.isLoading ? (
            <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="overflow-hidden rounded-[14px] border border-line bg-ink-900">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-[52px] animate-pulse border-b border-line/60 bg-ink-800/50 last:border-b-0" />
              ))}
            </motion.div>
          ) : filtered.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: EASE }}
              className="flex flex-1 flex-col items-center justify-center gap-3 rounded-[14px] border border-line bg-ink-900 py-16 text-center"
            >
              <div className="rounded-[14px] border border-dashed border-line p-4">
                <img src="/empty-calls.svg" alt="" className="h-28 w-auto opacity-80" />
              </div>
              <div className="text-sm font-medium text-text-hi">No calls in this view</div>
              <div className="max-w-xs text-xs text-text-low">
                Adjust your filters, or make your first call from the Softphone.
              </div>
              <button
                onClick={() => navigate('/app')}
                className="mt-1 flex items-center gap-2 rounded-[10px] bg-signal px-4 py-2 text-sm font-semibold text-ink-950 transition-transform hover:scale-[1.02] active:scale-[0.97]"
              >
                <Phone className="h-4 w-4" />
                Open dialer
              </button>
            </motion.div>
          ) : (
            <motion.div
              key={`table-${dir}-${status}-${range}-${q}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15, ease: EASE }}
            >
              <DataTable
                columns={columns}
                rows={pageRows as Array<CallRow & Record<string, unknown>>}
                getRowId={(row) => row.id}
                onRowClick={(row) => setParam('call', String(row.id))}
                emptyImage="/empty-calls.svg"
                emptyTitle="No calls in this view"
                emptyHint="Adjust your filters, or make your first call from the Softphone."
                page={safePage}
                pageSize={PAGE_SIZE}
                total={filtered.length}
                onPageChange={(p) => setParam('page', p > 1 ? String(p) : null)}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <CallDetailDrawer
        callId={drawerCallId}
        onClose={() => setParam('call', null)}
        onRedial={redial}
      />
    </AppShell>
  );
}
