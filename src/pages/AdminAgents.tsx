import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Check,
  Copy,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  UserX,
} from 'lucide-react';
import { toast } from 'sonner';
import AppShell from '@/components/AppShell';
import DataTable from '@/components/DataTable';
import type { DataTableColumn } from '@/components/DataTable';
import CallAvatar from '@/components/CallAvatar';
import StatusPill from '@/components/StatusPill';
import { trpc } from '@/providers/trpc';
import { cn } from '@/lib/utils';
import { ConsoleSelect, EASE, PrimaryButton, fmtDuration } from '@/components/admin/controls';
import ExtensionMap from '@/components/admin/ExtensionMap';
import AgentDrawer from '@/components/admin/AgentDrawer';
import type { DrawerMode } from '@/components/admin/AgentDrawer';
import type { AgentRow, LogRow, Presence } from '@/components/admin/types';

const PAGE_SIZE = 10;

type PresenceFilter = 'all' | Presence;

const PRESENCE_CHIPS: Array<{ value: PresenceFilter; label: string; dot: string }> = [
  { value: 'all', label: 'All', dot: 'bg-text-mid' },
  { value: 'available', label: 'Available', dot: 'bg-signal' },
  { value: 'busy', label: 'In call', dot: 'bg-danger' },
  { value: 'away', label: 'Away', dot: 'bg-amber' },
  { value: 'offline', label: 'Offline', dot: 'bg-text-low' },
];

export default function AdminAgents() {
  const utils = trpc.useUtils();
  const agentsQuery = trpc.admin.agents.list.useQuery(undefined, { refetchInterval: 5000 });
  const extensionsQuery = trpc.admin.extensions.list.useQuery(undefined, { refetchInterval: 5000 });
  const activeCallsQuery = trpc.admin.dashboard.activeCalls.useQuery(undefined, { refetchInterval: 5000 });
  // per-agent activity aggregates (calls today, 7-day sparkline, avg duration)
  const activityQuery = trpc.admin.logs.list.useQuery({ page: 1, pageSize: 200, days: 7 });

  const [search, setSearch] = useState('');
  const [presenceFilter, setPresenceFilter] = useState<PresenceFilter>('all');
  const [page, setPage] = useState(1);
  const [invited, setInvited] = useState<AgentRow[]>([]);
  const [copiedExt, setCopiedExt] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<AgentRow | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<DrawerMode>('view');
  const [selected, setSelected] = useState<AgentRow | null>(null);
  const [preselectedExt, setPreselectedExt] = useState<string | null>(null);

  // 1s ticker for live "In call mm:ss" captions
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const agents: AgentRow[] = useMemo(
    () => [...((agentsQuery.data as AgentRow[] | undefined) ?? []), ...invited],
    [agentsQuery.data, invited]
  );
  const extensions = useMemo(
    () => extensionsQuery.data ?? [],
    [extensionsQuery.data]
  );

  const range = useMemo(() => {
    const nums = extensions.map((r) => parseInt(r.extension.number, 10)).filter(Number.isFinite);
    return nums.length ? { min: Math.min(...nums), max: Math.max(...nums) } : { min: 100, max: 131 };
  }, [extensions]);

  /** live call start per extension number, for ticking "In call" captions */
  const callStartByExt = useMemo(() => {
    const m = new Map<string, number>();
    for (const row of activeCallsQuery.data ?? []) {
      if (row.extensionNumber && row.call.startedAt) {
        m.set(row.extensionNumber, new Date(row.call.startedAt).getTime());
      }
    }
    return m;
  }, [activeCallsQuery.data]);

  /** per-agent stats from the last-7-days activity window */
  const statsByAgent = useMemo(() => {
    const m = new Map<string, { callsToday: number; talkSec: number; avgSec: number; spark: number[] }>();
    const rows = (activityQuery.data?.rows ?? []) as LogRow[];
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    for (const r of rows) {
      if (!r.agentName) continue;
      const s = m.get(r.agentName) ?? { callsToday: 0, talkSec: 0, avgSec: 0, spark: [0, 0, 0, 0, 0, 0, 0] };
      const started = new Date(r.call.startedAt);
      const dayIdx = Math.min(6, Math.max(0, Math.floor((started.getTime() - (dayStart.getTime() - 6 * 864e5)) / 864e5)));
      s.spark[dayIdx] += 1;
      if (started >= dayStart) {
        s.callsToday += 1;
        if (r.call.status === 'completed') s.talkSec += r.call.durationSec;
      }
      m.set(r.agentName, s);
    }
    for (const s of m.values()) {
      s.avgSec = s.callsToday ? Math.round(s.talkSec / s.callsToday) : 0;
    }
    return m;
  }, [activityQuery.data]);

  const recentCallsByAgent = useMemo(() => {
    const m = new Map<string, LogRow[]>();
    for (const r of ((activityQuery.data?.rows ?? []) as LogRow[])) {
      if (!r.agentName) continue;
      const list = m.get(r.agentName) ?? [];
      if (list.length < 5) list.push(r);
      m.set(r.agentName, list);
    }
    return m;
  }, [activityQuery.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return agents.filter((a) => {
      if (presenceFilter !== 'all' && (a.presence ?? 'offline') !== presenceFilter) return false;
      if (!q) return true;
      return (
        (a.name ?? '').toLowerCase().includes(q) ||
        (a.email ?? '').toLowerCase().includes(q) ||
        (a.extensionNumber ?? '').includes(q)
      );
    });
  }, [agents, search, presenceFilter]);

  const paged = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page]
  );

  const counts = useMemo(() => {
    const c: Record<PresenceFilter, number> = { all: agents.length, available: 0, busy: 0, away: 0, offline: 0 };
    for (const a of agents) c[a.presence ?? 'offline'] += 1;
    return c;
  }, [agents]);

  const freeExtensions = useMemo(
    () =>
      extensions
        .filter((r) => !r.agentId)
        .map((r) => ({ id: r.extension.id, number: r.extension.number })),
    [extensions]
  );

  /* ------------------------------- actions ------------------------------ */

  function openDrawer(mode: DrawerMode, agent: AgentRow | null, preExt?: string | null) {
    setDrawerMode(mode);
    setSelected(agent);
    setPreselectedExt(preExt ?? null);
    setDrawerOpen(true);
  }

  async function copyExtension(num: string) {
    try {
      await navigator.clipboard.writeText(num);
      setCopiedExt(num);
      setTimeout(() => setCopiedExt((c) => (c === num ? null : c)), 1200);
    } catch {
      toast.error('Clipboard unavailable');
    }
  }

  const updateAgent = trpc.admin.agents.update.useMutation();
  async function disableAgent(a: AgentRow) {
    setConfirmDisable(null);
    setMenuFor(null);
    await updateAgent.mutateAsync({ userId: a.id, presence: 'offline' });
    await utils.admin.agents.list.invalidate();
    toast.success('Agent disabled');
  }

  /* ------------------------------- columns ------------------------------ */

  const columns: Array<DataTableColumn<AgentRow>> = [
    {
      key: 'agent',
      header: 'Agent',
      render: (a) => (
        <div className="flex items-center gap-3">
          <CallAvatar
            name={a.name ?? '?'}
            size={40}
            state={
              a.presence === 'busy'
                ? 'active'
                : a.presence === 'away'
                  ? 'held'
                  : a.presence == null || a.presence === 'offline'
                    ? 'offline'
                    : 'idle'
            }
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-text-hi">{a.name ?? 'Unknown'}</div>
            <div className="truncate text-xs text-text-low">{a.email ?? '—'}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'extension',
      header: 'Extension',
      render: (a) =>
        a.extensionNumber ? (
          <span className="group/ext flex items-center gap-1.5">
            <span className="font-mono text-sm text-text-hi">{a.extensionNumber}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                void copyExtension(a.extensionNumber!);
              }}
              className="rounded p-1 text-text-low opacity-0 transition-opacity hover:bg-ink-800 hover:text-signal group-hover/ext:opacity-100"
              title="Copy extension"
            >
              {copiedExt === a.extensionNumber ? (
                <Check className="h-3 w-3 text-signal" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
          </span>
        ) : (
          <span className="text-text-low">—</span>
        ),
    },
    {
      key: 'role',
      header: 'Role',
      render: (a) => (
        <span
          className={cn(
            'rounded-full border px-2.5 py-0.5 text-xs font-medium',
            a.role === 'admin'
              ? 'border-violet/40 bg-violet/10 text-violet'
              : 'border-line bg-ink-700 text-text-mid'
          )}
        >
          {a.role === 'admin' ? 'Admin' : 'Agent'}
        </span>
      ),
    },
    {
      key: 'presence',
      header: 'Presence',
      render: (a) => {
        const p = a.presence ?? 'offline';
        const variant = p === 'busy' ? 'busy' : p;
        const inCallStart = a.extensionNumber ? callStartByExt.get(a.extensionNumber) : undefined;
        return (
          <div>
            <StatusPill
              variant={variant}
              label={p === 'busy' ? 'In call' : p.charAt(0).toUpperCase() + p.slice(1)}
            />
            {p === 'busy' && inCallStart && (
              <div className="mt-0.5 font-mono text-[11px] text-signal">
                In call {fmtDuration(Math.floor((now - inCallStart) / 1000))}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: 'callsToday',
      header: 'Calls today',
      render: (a) => {
        const s = statsByAgent.get(a.name ?? '');
        const max = Math.max(1, ...(s?.spark ?? [1]));
        return (
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13px] text-text-hi">{s?.callsToday ?? 0}</span>
            <span className="flex items-end gap-[2px]">
              {(s?.spark ?? [0, 0, 0, 0, 0, 0, 0]).map((v, i) => (
                <span
                  key={i}
                  className={cn('w-[3px] rounded-sm', v > 0 ? 'bg-signal/70' : 'bg-ink-700')}
                  style={{ height: Math.max(3, Math.round((v / max) * 14)) }}
                />
              ))}
            </span>
          </div>
        );
      },
    },
    {
      key: 'avg',
      header: 'Avg. duration',
      mono: true,
      render: (a) => <span>{fmtDuration(statsByAgent.get(a.name ?? '')?.avgSec ?? 0)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (a) =>
        a.invited ? (
          <StatusPill variant="ringing" label="Invited" />
        ) : (
          <StatusPill variant="available" label="Active" />
        ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-20',
      render: (a) => (
        <div className="relative flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={(e) => {
              e.stopPropagation();
              openDrawer('edit', a);
            }}
            className="rounded-lg p-1.5 text-text-low transition-colors hover:bg-ink-800 hover:text-signal"
            title="Edit agent"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenuFor(menuFor === a.id ? null : a.id);
            }}
            className="rounded-lg p-1.5 text-text-low transition-colors hover:bg-ink-800 hover:text-text-hi"
            title="More actions"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          {menuFor === a.id && (
            <div
              className="absolute right-0 top-8 z-20 w-44 overflow-hidden rounded-[10px] border border-line bg-ink-800 py-1 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                className="w-full px-3 py-2 text-left text-sm text-text-mid hover:bg-ink-700 hover:text-text-hi"
                onClick={() => {
                  setMenuFor(null);
                  toast.success('Password reset link sent');
                }}
              >
                Reset password
              </button>
              <button
                className="w-full px-3 py-2 text-left text-sm text-text-mid hover:bg-ink-700 hover:text-text-hi"
                onClick={() => setConfirmDisable(a)}
              >
                Disable agent
              </button>
              <button
                className="w-full px-3 py-2 text-left text-sm text-danger hover:bg-danger/10"
                onClick={() => {
                  setMenuFor(null);
                  toast.error('Deletion is disabled in the simulated provider');
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      ),
    },
  ];

  /* -------------------------------- render ------------------------------ */

  return (
    <AppShell variant="admin" title="Agents & Extensions">
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
              Agents & Extensions
            </h1>
            <p className="mt-1 text-sm text-text-low">
              {agents.length} agents · {extensions.length} extensions in range {range.min}–{range.max}
            </p>
          </div>
          <PrimaryButton onClick={() => openDrawer('create', null)}>
            <Plus className="h-4 w-4" />
            Add agent
          </PrimaryButton>
        </motion.div>

        {/* Controls */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE, delay: 0.06 }}
          className="flex flex-wrap items-center gap-3"
        >
          <div className="flex w-72 items-center gap-2 rounded-[10px] border border-line bg-ink-800 px-3 py-2 transition-colors focus-within:border-signal/50">
            <Search className="h-4 w-4 text-text-low" />
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search agents or extensions…"
              className="w-full bg-transparent text-sm text-text-hi outline-none placeholder:text-text-low"
            />
          </div>
          <ConsoleSelect
            value={presenceFilter}
            onChange={(v) => {
              setPresenceFilter(v as PresenceFilter);
              setPage(1);
            }}
            options={[
              { value: 'all', label: 'All presence' },
              { value: 'available', label: 'Available' },
              { value: 'busy', label: 'In call' },
              { value: 'away', label: 'Away' },
              { value: 'offline', label: 'Offline' },
            ]}
          />
        </motion.div>

        {/* Presence summary chips */}
        <div className="flex flex-wrap items-center gap-2">
          {PRESENCE_CHIPS.map((chip, i) => (
            <motion.button
              key={chip.value}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, ease: EASE, delay: 0.1 + i * 0.05 }}
              onClick={() => {
                setPresenceFilter(chip.value);
                setPage(1);
              }}
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150',
                presenceFilter === chip.value
                  ? 'border-signal/60 bg-signal/10 text-text-hi'
                  : 'border-line bg-ink-800 text-text-mid hover:border-signal/30 hover:text-text-hi'
              )}
            >
              <span className={cn('h-2 w-2 rounded-full', chip.dot)} />
              <span className="font-mono">{counts[chip.value]}</span>
              {chip.label}
            </motion.button>
          ))}
        </div>

        {/* Main split: table + extension map */}
        <div className="flex min-h-0 flex-1 items-start gap-4">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE, delay: 0.12 }}
            className="min-w-0 flex-1"
          >
            {agentsQuery.isLoading ? (
              <div className="flex h-64 items-center justify-center rounded-[14px] border border-line bg-ink-900">
                <Loader2 className="h-5 w-5 animate-spin text-signal" />
              </div>
            ) : (
              <DataTable<AgentRow>
                columns={columns}
                rows={paged}
                getRowId={(a) => a.id}
                onRowClick={(a) => openDrawer('view', a)}
                emptyImage="/empty-contacts.svg"
                emptyTitle="No agents match"
                emptyHint="Try a different search or presence filter."
                page={page}
                pageSize={PAGE_SIZE}
                total={filtered.length}
                onPageChange={setPage}
              />
            )}
          </motion.div>

          <ExtensionMap
            extensions={extensions}
            onProvisionNumber={(num) => openDrawer('create', null, num)}
            className="hidden xl:flex"
          />
        </div>
      </div>

      {/* Disable confirm popover */}
      {confirmDisable && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={() => setConfirmDisable(null)}>
          <div className="absolute inset-0 bg-ink-950/60 backdrop-blur-[2px]" />
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.18, ease: EASE }}
            className="relative w-80 rounded-[14px] border border-line bg-ink-800 p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-danger/10 p-2">
                <UserX className="h-4 w-4 text-danger" />
              </div>
              <div>
                <div className="text-sm font-medium text-text-hi">
                  Disable {confirmDisable.name?.split(' ')[0] ?? 'agent'}?
                </div>
                <p className="mt-1 text-xs leading-4 text-text-low">
                  They'll be signed out immediately.
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-[10px] border border-line px-3 py-1.5 text-sm text-text-mid hover:text-text-hi"
                onClick={() => setConfirmDisable(null)}
              >
                Cancel
              </button>
              <button
                className="rounded-[10px] border border-danger/50 bg-danger/15 px-3 py-1.5 text-sm font-medium text-danger hover:bg-danger/25"
                onClick={() => void disableAgent(confirmDisable)}
              >
                Disable
              </button>
            </div>
          </motion.div>
        </div>
      )}

      <AgentDrawer
        open={drawerOpen}
        mode={drawerMode}
        agent={selected}
        freeExtensions={freeExtensions}
        preselectedExtension={preselectedExt}
        stats={selected ? statsByAgent.get(selected.name ?? '') ?? null : null}
        recentCalls={selected ? recentCallsByAgent.get(selected.name ?? '') ?? [] : []}
        onClose={() => setDrawerOpen(false)}
        onModeChange={setDrawerMode}
        onInvited={(a) => setInvited((list) => [a, ...list])}
      />
    </AppShell>
  );
}
