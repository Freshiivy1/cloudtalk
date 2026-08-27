import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { format } from 'date-fns';
import {
  AudioWaveform,
  Download,
  Flag,
  Loader2,
  MoreVertical,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Play,
  Search,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { keepPreviousData } from '@tanstack/react-query';
import AppShell from '@/components/AppShell';
import DataTable from '@/components/DataTable';
import type { DataTableColumn } from '@/components/DataTable';
import Drawer from '@/components/Drawer';
import CallAvatar from '@/components/CallAvatar';
import StatusPill from '@/components/StatusPill';
import { trpc } from '@/providers/trpc';
import { cn } from '@/lib/utils';
import { EASE, GhostButton, fmtDuration } from '@/components/admin/controls';
import VolumeHistogram from '@/components/admin/VolumeHistogram';
import RecordingPlayer, { downloadSimulatedWav } from '@/components/admin/RecordingPlayer';
import type { CallEventRow, CallStatus, LogRow } from '@/components/admin/types';

const PAGE_SIZE = 25;

type DirectionFilter = 'all' | 'inbound' | 'outbound' | 'missed';
type StatusFilter = 'all' | 'completed' | 'missed' | 'failed';

const DIRECTION_SEGMENTS: Array<{ value: DirectionFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'inbound', label: 'Inbound' },
  { value: 'outbound', label: 'Outbound' },
  { value: 'missed', label: 'Missed' },
];

const STATUS_PILL: Record<CallStatus, { variant: 'active' | 'ringing' | 'held' | 'missed' | 'completed'; label: string }> = {
  dialing: { variant: 'ringing', label: 'Dialing' },
  ringing: { variant: 'ringing', label: 'Ringing' },
  active: { variant: 'active', label: 'Active' },
  held: { variant: 'held', label: 'Held' },
  completed: { variant: 'completed', label: 'Completed' },
  missed: { variant: 'missed', label: 'Missed' },
  failed: { variant: 'missed', label: 'Dropped' },
};

function loadFlagged(): Set<number> {
  try {
    return new Set<number>(JSON.parse(localStorage.getItem('ct-flagged-calls') ?? '[]') as number[]);
  } catch {
    return new Set<number>();
  }
}

export default function AdminLogs() {
  /* ------------------------------ filter state -------------------------- */
  const [page, setPage] = useState(1);
  const [direction, setDirection] = useState<DirectionFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [dayIdx, setDayIdx] = useState<number | null>(null); // histogram selection
  const [hasRecordingOnly, setHasRecordingOnly] = useState(false);
  const [flagged, setFlagged] = useState<Set<number>>(loadFlagged);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [kbIndex, setKbIndex] = useState(-1);

  const [drawerCall, setDrawerCall] = useState<LogRow | null>(null);
  const [drawerTab, setDrawerTab] = useState<'recording' | 'details'>('details');
  const [confirmDeleteRec, setConfirmDeleteRec] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const days = dayIdx != null ? 30 - dayIdx : 30;

  /* -------------------------------- queries ----------------------------- */
  const histogramQuery = trpc.admin.logs.histogram.useQuery({ days: 30 });

  const effectiveStatus: StatusFilter = direction === 'missed' ? 'missed' : status;
  const effectiveDirection = direction === 'missed' ? 'all' : direction;

  const listQuery = trpc.admin.logs.list.useQuery(
    {
      page: hasRecordingOnly ? 1 : page,
      pageSize: hasRecordingOnly ? 200 : PAGE_SIZE,
      direction: effectiveDirection === 'all' ? undefined : effectiveDirection,
      status: effectiveStatus === 'all' ? undefined : effectiveStatus,
      search: debouncedSearch || undefined,
      days,
    },
    { refetchInterval: 10000, placeholderData: keepPreviousData }
  );

  // full window for caption counts + CSV export
  const exportQuery = trpc.admin.logs.list.useQuery({ page: 1, pageSize: 500, days: 30 });

  // recording metadata for the drawer player
  const recordingQuery = trpc.admin.logs.recording.useQuery(
    { callId: drawerCall?.call.id ?? 0 },
    { enabled: drawerCall != null && drawerCall.call.hasRecording }
  );
  // call detail + event timeline
  const detailQuery = trpc.telephony.calls.getById.useQuery(
    { id: drawerCall?.call.id ?? 0 },
    { enabled: drawerCall != null }
  );

  /* ------------------------------ derivation ---------------------------- */
  const rawRows = useMemo(() => (listQuery.data?.rows ?? []) as LogRow[], [listQuery.data]);
  const rows = useMemo(
    () => (hasRecordingOnly ? rawRows.filter((r) => r.call.hasRecording) : rawRows),
    [rawRows, hasRecordingOnly]
  );
  const total = hasRecordingOnly ? rows.length : (listQuery.data?.total ?? 0);
  const pagedRows = useMemo(
    () => (hasRecordingOnly ? rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : rows),
    [rows, hasRecordingOnly, page]
  );

  const recordingsRetained = useMemo(
    () => (exportQuery.data?.rows ?? []).filter((r) => r.call.hasRecording).length,
    [exportQuery.data]
  );

  /* live-prepend: the 10s poll keeps the log fresh — new org-wide calls
     appear at the top as the simulated event bus completes them */


  /* keyboard row navigation (↑↓ Enter) */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (drawerCall) return; // player owns the keyboard while open
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setKbIndex((i) => Math.min(pagedRows.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setKbIndex((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter' && kbIndex >= 0 && pagedRows[kbIndex]) {
        openDrawer(pagedRows[kbIndex], 'details');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pagedRows, kbIndex, drawerCall]);

  /* -------------------------------- actions ----------------------------- */
  function openDrawer(row: LogRow, tab: 'recording' | 'details') {
    setDrawerCall(row);
    setDrawerTab(tab);
    setConfirmDeleteRec(false);
  }

  function toggleFlag(id: number) {
    setFlagged((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem('ct-flagged-calls', JSON.stringify([...next]));
      return next;
    });
    toast.success('Call flagged for review');
  }

  function exportCsv() {
    const all = (exportQuery.data?.rows ?? []) as LogRow[];
    const header = 'id,direction,status,from,to,contact,agent,extension,duration_sec,started_at,has_recording';
    const lines = all.map((r) =>
      [
        r.call.id,
        r.call.direction,
        r.call.status,
        r.call.fromNumber,
        r.call.toNumber,
        JSON.stringify(r.call.contactName ?? ''),
        JSON.stringify(r.agentName ?? ''),
        r.extensionNumber ?? '',
        r.call.durationSec,
        new Date(r.call.startedAt).toISOString(),
        r.call.hasRecording ? 1 : 0,
      ].join(',')
    );
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cloudtalk-call-logs.csv';
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${all.length} rows`);
  }

  const hasActiveFilters =
    direction !== 'all' || status !== 'all' || debouncedSearch !== '' || dayIdx != null || hasRecordingOnly;

  function clearFilters() {
    setDirection('all');
    setStatus('all');
    setSearch('');
    setDebouncedSearch('');
    setDayIdx(null);
    setHasRecordingOnly(false);
    setPage(1);
  }

  /* -------------------------------- columns ----------------------------- */
  const columns: Array<DataTableColumn<LogRow>> = [
    {
      key: 'direction',
      header: '',
      className: 'w-12',
      render: (r) =>
        r.call.status === 'missed' ? (
          <PhoneMissed className="h-4 w-4 text-danger" />
        ) : r.call.direction === 'inbound' ? (
          <PhoneIncoming className="h-4 w-4 text-sky" />
        ) : (
          <PhoneOutgoing className="h-4 w-4 text-signal" />
        ),
    },
    {
      key: 'contact',
      header: 'Contact / Number',
      render: (r) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2 truncate text-sm text-text-hi">
            {r.call.contactName ?? 'Unknown'}
            {flagged.has(r.call.id) && <Flag className="h-3 w-3 fill-amber text-amber" />}
          </div>
          <div className="font-mono text-[11px] text-text-low">
            {r.call.direction === 'inbound' ? r.call.fromNumber : r.call.toNumber}
          </div>
        </div>
      ),
    },
    {
      key: 'agent',
      header: 'Agent',
      render: (r) =>
        r.agentName ? (
          <div className="flex items-center gap-2">
            <CallAvatar name={r.agentName} size={28} />
            <div>
              <div className="text-sm text-text-hi">{r.agentName}</div>
              <div className="font-mono text-[10px] text-text-low">ext {r.extensionNumber ?? '—'}</div>
            </div>
          </div>
        ) : (
          <span className="text-text-low">—</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const s = STATUS_PILL[r.call.status];
        return <StatusPill variant={s.variant} label={s.label} />;
      },
    },
    {
      key: 'duration',
      header: 'Duration',
      mono: true,
      render: (r) => <span>{fmtDuration(r.call.durationSec)}</span>,
    },
    {
      key: 'recording',
      header: 'Recording',
      render: (r) =>
        r.call.hasRecording ? (
          <span title={`0:00 / ${fmtDuration(r.call.durationSec)}`}>
            <AudioWaveform className="h-4 w-4 text-violet" />
          </span>
        ) : (
          <span className="text-text-low">—</span>
        ),
    },
    {
      key: 'time',
      header: 'Time',
      render: (r) => (
        <span className="font-mono text-[12px] text-text-mid">
          {format(new Date(r.call.startedAt), 'MMM d, HH:mm')}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-28',
      render: (r) => (
        <div className="relative flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {r.call.hasRecording && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                openDrawer(r, 'recording');
              }}
              className="rounded-lg p-1.5 text-violet transition-all hover:bg-violet/10 hover:shadow-glow-violet"
              title="Play recording"
            >
              <Play className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenuFor(menuFor === r.call.id ? null : r.call.id);
            }}
            className="rounded-lg p-1.5 text-text-low transition-colors hover:bg-ink-800 hover:text-text-hi"
            title="More actions"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          {menuFor === r.call.id && (
            <div
              className="absolute right-0 top-8 z-20 w-52 overflow-hidden rounded-[10px] border border-line bg-ink-800 py-1 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              {r.call.hasRecording && (
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text-mid hover:bg-ink-700 hover:text-text-hi"
                  onClick={() => {
                    setMenuFor(null);
                    downloadSimulatedWav(`cloudtalk-call-${r.call.id}.wav`);
                    toast.success('Recording downloaded (simulated tone)');
                  }}
                >
                  <Download className="h-3.5 w-3.5" /> Download recording .wav
                </button>
              )}
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text-mid hover:bg-ink-700 hover:text-text-hi"
                onClick={() => {
                  setMenuFor(null);
                  toast.success('Note saved to the call record');
                }}
              >
                <StickyNote className="h-3.5 w-3.5" /> Add note
              </button>
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text-mid hover:bg-ink-700 hover:text-text-hi"
                onClick={() => {
                  setMenuFor(null);
                  toggleFlag(r.call.id);
                }}
              >
                <Flag className="h-3.5 w-3.5" /> Flag call
              </button>
            </div>
          )}
        </div>
      ),
    },
  ];

  /* -------------------------------- render ------------------------------ */
  return (
    <AppShell variant="admin" title="Call Logs">
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
          className="flex flex-wrap items-end justify-between gap-3"
        >
          <div>
            <h1 className="font-display text-[28px] font-semibold leading-[34px] tracking-tight text-text-hi">
              Call Logs
            </h1>
            <p className="mt-1 text-sm text-text-low">
              {exportQuery.data?.total ?? '…'} calls in the last 30 days · {recordingsRetained} recordings retained
            </p>
          </div>
          <GhostButton onClick={exportCsv}>
            <Download className="h-4 w-4" />
            Export CSV
          </GhostButton>
        </motion.div>

        {/* Volume strip */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE, delay: 0.06 }}
          className="rounded-[14px] border border-line bg-ink-900 p-4"
        >
          {histogramQuery.data ? (
            <VolumeHistogram
              data={histogramQuery.data}
              selectedIdx={dayIdx}
              onSelect={(i) => {
                setDayIdx(i);
                setPage(1);
                if (i != null) toast.success(`Filtering since ${format(new Date(Date.now() - (29 - i) * 864e5), 'MMM d')}`);
              }}
            />
          ) : (
            <div className="flex h-24 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-signal" />
            </div>
          )}
        </motion.div>

        {/* Filter bar (sticky) */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE, delay: 0.12 }}
          className="sticky top-14 z-20 -mx-2 flex flex-wrap items-center gap-3 rounded-[14px] border border-line bg-ink-900/90 px-4 py-3 backdrop-blur-md"
        >
          <div className="flex w-64 items-center gap-2 rounded-[10px] border border-line bg-ink-800 px-3 py-2 transition-colors focus-within:border-signal/50">
            <Search className="h-4 w-4 text-text-low" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search contact, number, or agent…"
              className="w-full bg-transparent text-sm text-text-hi outline-none placeholder:text-text-low"
            />
          </div>

          {/* Direction segmented */}
          <div className="flex items-center rounded-[10px] border border-line bg-ink-800 p-1">
            {DIRECTION_SEGMENTS.map((seg) => (
              <button
                key={seg.value}
                onClick={() => {
                  setDirection(seg.value);
                  setPage(1);
                }}
                className={cn(
                  'relative rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                  direction === seg.value ? 'text-ink-950' : 'text-text-mid hover:text-text-hi'
                )}
              >
                {direction === seg.value && (
                  <motion.span
                    layoutId="dir-pill"
                    className="absolute inset-0 rounded-lg bg-signal"
                    transition={{ duration: 0.2, ease: EASE }}
                  />
                )}
                <span className="relative">{seg.label}</span>
              </button>
            ))}
          </div>

          {/* Status select */}
          <div className="relative">
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as StatusFilter);
                setPage(1);
              }}
              className="cursor-pointer appearance-none rounded-[10px] border border-line bg-ink-800 py-2 pl-3 pr-8 text-sm text-text-hi outline-none transition-colors hover:border-signal/40"
            >
              <option value="all" className="bg-ink-800">All statuses</option>
              <option value="completed" className="bg-ink-800">Completed</option>
              <option value="missed" className="bg-ink-800">Missed</option>
              <option value="failed" className="bg-ink-800">Dropped</option>
            </select>
          </div>

          {/* Has recording switch (violet) */}
          <button
            onClick={() => {
              setHasRecordingOnly((v) => !v);
              setPage(1);
            }}
            className={cn(
              'flex items-center gap-2 rounded-[10px] border px-3 py-2 text-xs font-medium transition-colors',
              hasRecordingOnly
                ? 'border-violet/50 bg-violet/10 text-violet'
                : 'border-line bg-ink-800 text-text-mid hover:text-text-hi'
            )}
          >
            <AudioWaveform className="h-3.5 w-3.5" />
            Has recording
            <span
              className={cn(
                'relative h-4 w-7 rounded-full border transition-colors',
                hasRecordingOnly ? 'border-violet/60 bg-violet/30' : 'border-line bg-ink-700'
              )}
            >
              <span
                className={cn(
                  'absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full transition-all',
                  hasRecordingOnly ? 'left-3.5 bg-violet' : 'left-0.5 bg-text-low'
                )}
              />
            </span>
          </button>

          {/* active filter chips */}
          {hasActiveFilters && (
            <div className="flex flex-wrap items-center gap-1.5">
              {direction !== 'all' && (
                <FilterChip label={`Direction: ${direction}`} onClear={() => setDirection('all')} />
              )}
              {status !== 'all' && <FilterChip label={`Status: ${status === 'failed' ? 'Dropped' : status}`} onClear={() => setStatus('all')} />}
              {debouncedSearch && <FilterChip label={`“${debouncedSearch}”`} onClear={() => { setSearch(''); setDebouncedSearch(''); }} />}
              {dayIdx != null && (
                <motion.span key="daychip" initial={{ scale: 0.9 }} animate={{ scale: [1.08, 1] }} transition={{ duration: 0.3 }}>
                  <FilterChip
                    label={`Since ${format(new Date(Date.now() - (29 - dayIdx) * 864e5), 'MMM d')}`}
                    onClear={() => setDayIdx(null)}
                  />
                </motion.span>
              )}
              {hasRecordingOnly && <FilterChip label="Has recording" onClear={() => setHasRecordingOnly(false)} />}
              <button onClick={clearFilters} className="text-xs text-text-low underline-offset-2 hover:text-signal hover:underline">
                Clear all
              </button>
            </div>
          )}
        </motion.div>

        {/* Table */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE, delay: 0.18 }}
        >
          {listQuery.isLoading ? (
            <div className="flex h-64 items-center justify-center rounded-[14px] border border-line bg-ink-900">
              <Loader2 className="h-5 w-5 animate-spin text-signal" />
            </div>
          ) : pagedRows.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: EASE }}
              className="flex flex-col items-center gap-3 rounded-[14px] border border-line bg-ink-900 px-6 py-16 text-center"
            >
              <div className="rounded-[14px] border border-dashed border-line p-4">
                <img src="/empty-calls.svg" alt="" className="h-24 w-auto opacity-80" />
              </div>
              <div className="text-sm font-medium text-text-hi">No calls match these filters</div>
              <GhostButton onClick={clearFilters} className="mt-1 px-3 py-1.5 text-xs">
                Clear filters
              </GhostButton>
            </motion.div>
          ) : (
            <DataTable<LogRow>
              columns={columns}
              rows={pagedRows}
              getRowId={(r) => r.call.id}
              onRowClick={(r) => openDrawer(r, 'details')}
              emptyImage="/empty-calls.svg"
              emptyTitle="No calls match these filters"
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              onPageChange={setPage}
            />
          )}
          {/* keyboard highlight helper */}
          <div className="mt-2 hidden items-center gap-3 font-mono text-[10px] text-text-low lg:flex">
            <span>↑↓ navigate</span>
            <span>Enter details</span>
            <span>Space / ←→ in player</span>
            {kbIndex >= 0 && <span className="text-signal">row {kbIndex + 1} selected</span>}
          </div>
        </motion.div>
      </div>

      {/* ------------------------- Detail / Player drawer ------------------------ */}
      <LogDrawer
        row={drawerCall}
        tab={drawerTab}
        setTab={setDrawerTab}
        onClose={() => setDrawerCall(null)}
        recording={recordingQuery.data ?? null}
        detail={detailQuery.data ?? null}
        flagged={drawerCall ? flagged.has(drawerCall.call.id) : false}
        onFlag={() => drawerCall && toggleFlag(drawerCall.call.id)}
        confirmDeleteRec={confirmDeleteRec}
        setConfirmDeleteRec={setConfirmDeleteRec}
      />
    </AppShell>
  );
}

/* ------------------------------------------------------------------------- */

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <motion.span
      initial={{ opacity: 0, x: 8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="flex items-center gap-1.5 rounded-full border border-signal/40 bg-signal/10 px-2.5 py-1 text-[11px] font-medium text-signal"
    >
      {label}
      <button onClick={onClear} className="rounded-full p-0.5 hover:bg-signal/20" title="Remove filter">
        <X className="h-3 w-3" />
      </button>
    </motion.span>
  );
}

/* ------------------------------------------------------------------------- */

function LogDrawer({
  row,
  tab,
  setTab,
  onClose,
  recording,
  detail,
  flagged,
  onFlag,
  confirmDeleteRec,
  setConfirmDeleteRec,
}: {
  row: LogRow | null;
  tab: 'recording' | 'details';
  setTab: (t: 'recording' | 'details') => void;
  onClose: () => void;
  recording: { id: number; callId: number; durationSec: number; createdAt: Date } | null;
  detail: { call: LogRow['call']; events: CallEventRow[]; recording: unknown } | null;
  flagged: boolean;
  onFlag: () => void;
  confirmDeleteRec: boolean;
  setConfirmDeleteRec: (v: boolean) => void;
}) {
  const call = row?.call ?? null;
  const statusPill = call ? STATUS_PILL[call.status] : null;

  return (
    <Drawer
      open={row != null}
      onClose={onClose}
      width={440}
      title={
        call ? (
          <span className="flex items-center gap-2">
            {call.direction === 'inbound' ? (
              <PhoneIncoming className="h-4 w-4 text-sky" />
            ) : (
              <PhoneOutgoing className="h-4 w-4 text-signal" />
            )}
            {call.contactName ?? (call.direction === 'inbound' ? call.fromNumber : call.toNumber)}
          </span>
        ) : (
          'Call'
        )
      }
      footer={
        call && (
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={() => setConfirmDeleteRec(true)}
              className="flex items-center gap-1.5 rounded-[10px] border border-danger/40 bg-danger/10 px-3 py-2 text-xs font-medium text-danger transition-colors hover:bg-danger/20"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete recording
            </button>
            <div className="flex gap-2">
              <GhostButton onClick={onFlag} className="px-3 py-2 text-xs">
                <Flag className={cn('h-3.5 w-3.5', flagged && 'fill-amber text-amber')} />
                {flagged ? 'Flagged' : 'Flag call'}
              </GhostButton>
              <GhostButton
                onClick={() => {
                  downloadSimulatedWav(`cloudtalk-call-${call.id}.wav`);
                  toast.success('Recording downloaded (simulated tone)');
                }}
                className="px-3 py-2 text-xs"
              >
                <Download className="h-3.5 w-3.5" />
                Download
              </GhostButton>
            </div>
          </div>
        )
      }
    >
      {call && statusPill && (
        <div className="space-y-5">
          {/* header meta */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-text-low">
                {call.direction === 'inbound' ? 'Inbound' : 'Outbound'} · agent {row?.agentName ?? '—'} · ext{' '}
                {row?.extensionNumber ?? '—'}
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-text-low">
                {format(new Date(call.startedAt), 'EEEE, MMM d yyyy · HH:mm')}
              </div>
            </div>
            <StatusPill variant={statusPill.variant} label={statusPill.label} />
          </div>

          {/* tabs */}
          <div className="flex gap-1 border-b border-line">
            {(
              [
                ['recording', 'Recording'],
                ['details', 'Details'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={cn(
                  'relative px-3 pb-2 pt-1 text-sm transition-colors',
                  tab === key ? 'text-text-hi' : 'text-text-low hover:text-text-mid'
                )}
              >
                {label}
                {tab === key && (
                  <motion.span layoutId="log-tab" className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-violet" />
                )}
              </button>
            ))}
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2, ease: EASE }}
            >
              {tab === 'recording' ? (
                <div className="space-y-4">
                  {call.hasRecording ? (
                    <RecordingPlayer
                      callId={call.id}
                      durationSec={recording?.durationSec ?? call.durationSec}
                    />
                  ) : (
                    <div className="rounded-[14px] border border-dashed border-line p-6 text-center text-xs text-text-low">
                      No recording retained for this call.
                    </div>
                  )}

                  {/* analysis placeholder — violet module-slot language */}
                  <div className="rounded-[14px] border border-dashed border-violet/40 bg-violet/5 p-4">
                    <div className="flex items-center gap-2">
                      <AudioWaveform className="h-4 w-4 text-violet" />
                      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-violet">
                        Analysis module slot
                      </span>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-text-mid">
                      Transcript & analysis for this recording will render here once the analysis module is
                      connected.
                    </p>
                    <Link
                      to="/admin/settings#integrations"
                      onClick={onClose}
                      className="mt-2 inline-block text-xs font-medium text-violet underline-offset-2 hover:underline"
                    >
                      Configure in Settings → Integrations
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="space-y-5">
                  {/* metadata grid */}
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      ['Call ID', `CT-${String(call.id).padStart(6, '0')}`],
                      ['Trunk', 'sip-gw-02 · simulated'],
                      ['Codec', 'Opus 48kHz'],
                      ['MOS', call.status === 'completed' ? '4.3' : '—'],
                      ['Duration', fmtDuration(call.durationSec)],
                      ['Cost', '$0.00 · simulated'],
                    ].map(([k, v]) => (
                      <div key={k} className="rounded-[10px] border border-line bg-ink-800 px-3 py-2">
                        <div className="text-[10px] uppercase tracking-[0.08em] text-text-low">{k}</div>
                        <div className="mt-0.5 truncate font-mono text-[12px] text-text-hi">{v}</div>
                      </div>
                    ))}
                  </div>

                  {/* event timeline */}
                  <div>
                    <div className="label-caps mb-3">Call event timeline</div>
                    {detail == null ? (
                      <div className="flex items-center gap-2 text-xs text-text-low">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading events…
                      </div>
                    ) : detail.events.length === 0 ? (
                      <div className="text-xs text-text-low">No events recorded.</div>
                    ) : (
                      <div className="relative space-y-0 pl-5">
                        <span className="absolute bottom-2 left-[5px] top-2 w-px bg-line" />
                        {detail.events.map((ev, i) => (
                          <motion.div
                            key={ev.id}
                            initial={{ opacity: 0, x: 8 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ duration: 0.25, ease: EASE, delay: i * 0.05 }}
                            className="relative py-2"
                          >
                            <span
                              className={cn(
                                'absolute -left-5 top-3 h-[11px] w-[11px] rounded-full border-2 border-ink-900',
                                ev.type === 'call_ended' || ev.type === 'call_missed'
                                  ? 'bg-danger'
                                  : ev.type === 'call_active'
                                    ? 'bg-signal'
                                    : 'bg-text-low'
                              )}
                            />
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="font-mono text-[12px] text-text-hi">{ev.type}</span>
                              <span className="font-mono text-[10px] text-text-low">
                                {format(new Date(ev.createdAt), 'HH:mm:ss')}
                              </span>
                            </div>
                            {ev.payload && (
                              <div className="mt-0.5 truncate font-mono text-[10px] text-text-low">{ev.payload}</div>
                            )}
                          </motion.div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>

          {/* delete recording confirm */}
          <AnimatePresence>
            {confirmDeleteRec && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.2, ease: EASE }}
                className="rounded-[10px] border border-danger/40 bg-danger/5 p-3"
              >
                <div className="text-xs text-text-hi">Delete this recording? This can't be undone.</div>
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-text-mid hover:text-text-hi"
                    onClick={() => setConfirmDeleteRec(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="rounded-lg border border-danger/50 bg-danger/15 px-2.5 py-1 text-[11px] font-medium text-danger hover:bg-danger/25"
                    onClick={() => {
                      setConfirmDeleteRec(false);
                      toast.success('Recording deleted');
                    }}
                  >
                    Delete
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </Drawer>
  );
}
