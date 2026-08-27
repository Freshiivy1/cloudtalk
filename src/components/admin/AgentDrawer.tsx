import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { format, formatDistanceToNow } from 'date-fns';
import { Loader2, PhoneIncoming, PhoneOutgoing } from 'lucide-react';
import { toast } from 'sonner';
import Drawer from '@/components/Drawer';
import CallAvatar from '@/components/CallAvatar';
import StatusPill from '@/components/StatusPill';
import { trpc } from '@/providers/trpc';
import { cn } from '@/lib/utils';
import {
  ConsoleInput,
  ConsoleSelect,
  ConsoleSwitch,
  EASE,
  GhostButton,
  PrimaryButton,
  fmtDuration,
} from './controls';
import type { AgentRow, LogRow, Presence } from './types';

export type DrawerMode = 'view' | 'edit' | 'create';

const PERMISSIONS = [
  { key: 'intl', label: 'Can make international calls' },
  { key: 'recordings', label: 'Can access recordings' },
  { key: 'contacts', label: 'Can manage contacts' },
] as const;

export default function AgentDrawer({
  open,
  mode,
  agent,
  freeExtensions,
  preselectedExtension,
  stats,
  recentCalls,
  onClose,
  onModeChange,
  onInvited,
}: {
  open: boolean;
  mode: DrawerMode;
  agent: AgentRow | null;
  /** extensions with no agent attached */
  freeExtensions: Array<{ id: number; number: string }>;
  /** number pre-selected from the Extension Map "+" shortcut */
  preselectedExtension?: string | null;
  stats: { callsToday: number; talkSec: number; avgSec: number } | null;
  recentCalls: LogRow[];
  onClose: () => void;
  onModeChange: (m: DrawerMode) => void;
  onInvited: (a: AgentRow) => void;
}) {
  const utils = trpc.useUtils();
  const updateAgent = trpc.admin.agents.update.useMutation();
  const createExtension = trpc.admin.extensions.create.useMutation();

  const [tab, setTab] = useState<'details' | 'calls' | 'permissions'>('details');
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState(false);

  // form state
  const [fName, setFName] = useState('');
  const [fEmail, setFEmail] = useState('');
  const [fRole, setFRole] = useState<'user' | 'admin'>('user');
  const [fDepartment, setFDepartment] = useState('');
  const [fTitle, setFTitle] = useState('');
  const [fPresence, setFPresence] = useState<Presence>('offline');
  const [fExtensionId, setFExtensionId] = useState<number | null>(null);
  const [perms, setPerms] = useState<Record<string, boolean>>({
    intl: false,
    recordings: true,
    contacts: true,
  });

  // reset form whenever drawer target changes
  useEffect(() => {
    if (!open) return;
    setTab('details');
    setSaving(false);
    setFName(agent?.name ?? '');
    setFEmail(agent?.email ?? '');
    setFRole(agent?.role ?? 'user');
    setFDepartment(agent?.department ?? '');
    setFTitle(agent?.title ?? '');
    setFPresence(agent?.presence ?? 'offline');
    if (mode === 'create') {
      const pre = preselectedExtension
        ? freeExtensions.find((e) => e.number === preselectedExtension)
        : undefined;
      setFExtensionId(pre?.id ?? null);
    } else {
      setFExtensionId(agent?.extensionId ?? null);
    }
  }, [open, agent, mode, preselectedExtension, freeExtensions]);

  const extensionOptions = useMemo(() => {
    const opts = [{ value: 'none', label: 'No extension' }];
    const sorted = [...freeExtensions].sort((a, b) => a.number.localeCompare(b.number));
    for (const e of sorted) opts.push({ value: String(e.id), label: `${e.number} · free` });
    // keep the agent's current extension selectable even though it's taken
    if (agent?.extensionId && agent.extensionNumber) {
      opts.push({ value: String(agent.extensionId), label: `${agent.extensionNumber} · current` });
    }
    return opts;
  }, [freeExtensions, agent]);

  const presence = agent?.presence ?? null;
  const presenceVariant =
    presence === 'available' ? 'available' : presence === 'busy' ? 'busy' : presence === 'away' ? 'away' : 'offline';
  const presenceLabel =
    presence === 'busy' ? 'In call' : presence ? presence.charAt(0).toUpperCase() + presence.slice(1) : 'Offline';

  async function handleSaveEdit() {
    if (!agent) return;
    setSaving(true);
    const nextExtNumber =
      fExtensionId != null ? extensionOptions.find((o) => o.value === String(fExtensionId))?.label : undefined;
    try {
      await updateAgent.mutateAsync({
        userId: agent.id,
        role: fRole,
        presence: fPresence,
        title: fTitle || undefined,
        department: fDepartment || undefined,
        extensionId: fExtensionId,
      });
      await utils.admin.agents.list.invalidate();
      await utils.admin.extensions.list.invalidate();
      if (fExtensionId != null && fExtensionId !== agent.extensionId) {
        const num = nextExtNumber?.split(' ')[0] ?? '';
        toast.success(`Extension ${num} assigned to ${fName.split(' ')[0] || 'agent'}`);
      } else {
        toast.success('Agent updated');
      }
      setFlash(true);
      setTimeout(() => setFlash(false), 700);
      onModeChange('view');
    } finally {
      setSaving(false);
    }
  }

  async function handleInvite() {
    if (!fEmail.trim()) {
      toast.error('Enter an email address to send the invite');
      return;
    }
    setSaving(true);
    // simulate invite latency, then provision the chosen extension if needed
    await new Promise((r) => setTimeout(r, 400));
    let extNumber: string | null = null;
    if (fExtensionId != null) {
      extNumber = freeExtensions.find((e) => e.id === fExtensionId)?.number ?? preselectedExtension ?? null;
    } else if (preselectedExtension) {
      // came from an unprovisioned map cell — provision it so the map fills in
      try {
        await createExtension.mutateAsync({ number: preselectedExtension, label: fName });
        await utils.admin.extensions.list.invalidate();
        extNumber = preselectedExtension;
      } catch {
        /* already exists — fine */
      }
    }
    onInvited({
      id: -Math.floor(Math.random() * 1e6) - 1,
      name: fName || fEmail.split('@')[0],
      email: fEmail,
      role: fRole,
      lastSignInAt: new Date(),
      presence: null,
      title: fTitle || null,
      department: fDepartment || null,
      extensionId: fExtensionId,
      extensionNumber: extNumber,
      extensionStatus: null,
      invited: true,
    });
    toast.success(`Invitation sent to ${fEmail}`);
    setSaving(false);
    onClose();
  }

  function savePermissions() {
    setSaving(true);
    setTimeout(() => {
      setSaving(false);
      toast.success('Permissions saved');
    }, 400);
  }

  const title =
    mode === 'create' ? 'Add agent' : mode === 'edit' ? `Edit ${agent?.name ?? 'agent'}` : agent?.name ?? 'Agent';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={title}
      footer={
        mode === 'view' ? (
          <div className="flex justify-end gap-2">
            <GhostButton onClick={onClose}>Close</GhostButton>
            {!agent?.invited && <PrimaryButton onClick={() => onModeChange('edit')}>Edit agent</PrimaryButton>}
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <GhostButton onClick={() => (mode === 'edit' ? onModeChange('view') : onClose())} disabled={saving}>
              Cancel
            </GhostButton>
            <PrimaryButton onClick={mode === 'edit' ? handleSaveEdit : handleInvite} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === 'edit' ? 'Save changes' : 'Send invite'}
            </PrimaryButton>
          </div>
        )
      }
    >
      {/* green edge flash after a successful save */}
      <AnimatePresence>
        {flash && (
          <motion.div
            initial={{ opacity: 0.9 }}
            animate={{ opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.7 }}
            className="pointer-events-none absolute inset-0 z-10 rounded-none border-2 border-signal/70"
          />
        )}
      </AnimatePresence>

      {mode === 'create' || mode === 'edit' ? (
        <AgentForm
          mode={mode}
          fName={fName}
          setFName={setFName}
          fEmail={fEmail}
          setFEmail={setFEmail}
          fRole={fRole}
          setFRole={setFRole}
          fDepartment={fDepartment}
          setFDepartment={setFDepartment}
          fTitle={fTitle}
          setFTitle={setFTitle}
          fPresence={fPresence}
          setFPresence={setFPresence}
          fExtensionId={fExtensionId}
          setFExtensionId={setFExtensionId}
          extensionOptions={extensionOptions}
        />
      ) : (
        agent && (
          <div className="space-y-5">
            {/* identity header */}
            <div className="flex items-center gap-4">
              <CallAvatar
                name={agent.name ?? '?'}
                size={64}
                state={presence === 'busy' ? 'active' : presence === 'offline' || presence == null ? 'offline' : 'idle'}
              />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-display text-lg font-semibold text-text-hi">
                    {agent.name ?? 'Unknown'}
                  </span>
                  <span
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em]',
                      agent.role === 'admin'
                        ? 'border-violet/40 bg-violet/10 text-violet'
                        : 'border-line bg-ink-700 text-text-mid'
                    )}
                  >
                    {agent.role === 'admin' ? 'Admin' : 'Agent'}
                  </span>
                </div>
                <div className="mt-1.5">
                  {agent.invited ? (
                    <StatusPill variant="ringing" label="Invited" />
                  ) : (
                    <StatusPill variant={presenceVariant} label={presenceLabel} />
                  )}
                </div>
              </div>
            </div>

            {/* stats triplet */}
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Calls today', value: String(stats?.callsToday ?? 0) },
                { label: 'Talk time', value: fmtDuration(stats?.talkSec ?? 0) },
                { label: 'Avg', value: fmtDuration(stats?.avgSec ?? 0) },
              ].map((s) => (
                <div key={s.label} className="rounded-[10px] border border-line bg-ink-800 px-3 py-2.5">
                  <div className="text-[10px] uppercase tracking-[0.08em] text-text-low">{s.label}</div>
                  <div className="mt-1 font-mono text-base font-medium text-text-hi">{s.value}</div>
                </div>
              ))}
            </div>

            {/* tabs */}
            <div className="flex gap-1 border-b border-line">
              {(
                [
                  ['details', 'Details'],
                  ['calls', 'Recent calls'],
                  ['permissions', 'Permissions'],
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
                    <motion.span layoutId="agent-tab" className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-signal" />
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
                {tab === 'details' && (
                  <div className="space-y-1">
                    {[
                      ['Email', agent.email ?? '—'],
                      ['Extension', agent.extensionNumber ?? '—'],
                      ['Title', agent.title ?? '—'],
                      ['Department', agent.department ?? '—'],
                      [
                        'Last sign-in',
                        agent.invited
                          ? 'Not signed in yet'
                          : formatDistanceToNow(agent.lastSignInAt, { addSuffix: true }),
                      ],
                    ].map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between border-b border-line/50 py-2.5 last:border-0">
                        <span className="text-xs uppercase tracking-[0.08em] text-text-low">{k}</span>
                        <span className="font-mono text-[13px] text-text-hi">{v}</span>
                      </div>
                    ))}
                  </div>
                )}

                {tab === 'calls' && (
                  <div className="space-y-1">
                    {recentCalls.length === 0 && (
                      <div className="py-6 text-center text-xs text-text-low">No recent calls in the loaded window.</div>
                    )}
                    {recentCalls.map((r) => (
                      <div key={r.call.id} className="flex items-center gap-3 rounded-[10px] px-2 py-2 hover:bg-ink-700">
                        {r.call.direction === 'inbound' ? (
                          <PhoneIncoming className="h-4 w-4 shrink-0 text-sky" />
                        ) : (
                          <PhoneOutgoing className="h-4 w-4 shrink-0 text-signal" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-text-hi">{r.call.contactName ?? r.call.toNumber}</div>
                          <div className="font-mono text-[11px] text-text-low">
                            {format(r.call.startedAt, 'MMM d, HH:mm')}
                          </div>
                        </div>
                        <span className="font-mono text-xs text-text-mid">{fmtDuration(r.call.durationSec)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {tab === 'permissions' && (
                  <div className="space-y-3">
                    {PERMISSIONS.map((p) => (
                      <div key={p.key} className="flex items-center justify-between rounded-[10px] border border-line bg-ink-800 px-3 py-2.5">
                        <span className="text-sm text-text-hi">{p.label}</span>
                        <ConsoleSwitch
                          checked={perms[p.key]}
                          onChange={(v) => setPerms((s) => ({ ...s, [p.key]: v }))}
                        />
                      </div>
                    ))}
                    <div className="flex justify-end pt-1">
                      <PrimaryButton onClick={savePermissions} disabled={saving} className="px-3 py-1.5 text-xs">
                        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        Save permissions
                      </PrimaryButton>
                    </div>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        )
      )}
    </Drawer>
  );
}

/* ------------------------------------------------------------------------- */

function AgentForm(props: {
  mode: DrawerMode;
  fName: string;
  setFName: (v: string) => void;
  fEmail: string;
  setFEmail: (v: string) => void;
  fRole: 'user' | 'admin';
  setFRole: (v: 'user' | 'admin') => void;
  fDepartment: string;
  setFDepartment: (v: string) => void;
  fTitle: string;
  setFTitle: (v: string) => void;
  fPresence: Presence;
  setFPresence: (v: Presence) => void;
  fExtensionId: number | null;
  setFExtensionId: (v: number | null) => void;
  extensionOptions: Array<{ value: string; label: string }>;
}) {
  const {
    mode, fName, setFName, fEmail, setFEmail, fRole, setFRole,
    fDepartment, setFDepartment, fTitle, setFTitle,
    fPresence, setFPresence, fExtensionId, setFExtensionId, extensionOptions,
  } = props;

  const fields = [
    { label: 'Full name', node: <ConsoleInput value={fName} onChange={setFName} placeholder="Dana Kim" /> },
    { label: 'Email', node: <ConsoleInput value={fEmail} onChange={setFEmail} placeholder="dana@company.com" mono /> },
    {
      label: 'Role',
      node: (
        <ConsoleSelect
          value={fRole}
          onChange={(v) => setFRole(v as 'user' | 'admin')}
          options={[
            { value: 'user', label: 'Agent' },
            { value: 'admin', label: 'Admin' },
          ]}
        />
      ),
    },
    {
      label: 'Extension',
      node: (
        <ConsoleSelect
          value={fExtensionId != null ? String(fExtensionId) : 'none'}
          onChange={(v) => setFExtensionId(v === 'none' ? null : Number(v))}
          options={extensionOptions}
        />
      ),
    },
    { label: 'Title', node: <ConsoleInput value={fTitle} onChange={setFTitle} placeholder="Support Specialist" /> },
    { label: 'Department', node: <ConsoleInput value={fDepartment} onChange={setFDepartment} placeholder="Support" /> },
  ];

  return (
    <div className="space-y-4">
      {mode === 'create' && (
        <div className="rounded-[10px] border border-amber/30 bg-amber/5 px-3 py-2.5 text-xs leading-4 text-amber">
          Invites are simulated — the seat appears instantly in this console.
        </div>
      )}
      {fields.map((f) => (
        <div key={f.label}>
          <div className="label-caps mb-1.5">{f.label}</div>
          {f.node}
        </div>
      ))}
      {mode === 'edit' && (
        <div>
          <div className="label-caps mb-1.5">Presence</div>
          <ConsoleSelect
            value={fPresence}
            onChange={(v) => setFPresence(v as Presence)}
            options={[
              { value: 'available', label: 'Available' },
              { value: 'busy', label: 'In call' },
              { value: 'away', label: 'Away' },
              { value: 'offline', label: 'Offline' },
            ]}
          />
        </div>
      )}
    </div>
  );
}
