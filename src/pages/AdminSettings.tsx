import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useLocation } from 'react-router';
import {
  Activity,
  AlertTriangle,
  ArrowRightLeft,
  Check,
  Copy,
  Disc,
  GitBranch,
  Globe,
  Loader2,
  Lock,
  Phone,
  Plug,
  Radio,
  RotateCcw,
  ShieldCheck,
  Timer,
  Users2,
  Voicemail,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import AppShell from '@/components/AppShell';
import { trpc } from '@/providers/trpc';
import { cn } from '@/lib/utils';
import {
  AdminCard,
  ConsoleInput,
  ConsoleSelect,
  ConsoleSwitch,
  EASE,
  FieldRow,
  GhostButton,
  PrimaryButton,
  Stepper,
  fmtDuration,
} from '@/components/admin/controls';
import EventTicker from '@/components/admin/EventTickerLive';

/* ------------------------------------------------------------------------- */

type TabKey = 'telephony' | 'routing' | 'recordings' | 'security' | 'integrations';

const TABS: Array<{ key: TabKey; label: string; icon: typeof Phone; violet?: boolean }> = [
  { key: 'telephony', label: 'Telephony', icon: Phone },
  { key: 'routing', label: 'Routing', icon: GitBranch },
  { key: 'recordings', label: 'Recordings', icon: Disc },
  { key: 'security', label: 'Security', icon: ShieldCheck },
  { key: 'integrations', label: 'Integrations', icon: Plug, violet: true },
];

/** defaults for every settings key the console manages */
const DEFAULTS: Record<string, string> = {
  'telephony.provider': 'simulated',
  'telephony.region': 'us-west',
  'telephony.codec': 'opus',
  'telephony.maxConcurrent': '25',
  'telephony.callerId': '+14155550134',
  'telephony.cnam': 'true',
  'telephony.hours': JSON.stringify({
    days: {
      mon: { on: true, from: '09:00', to: '17:00' },
      tue: { on: true, from: '09:00', to: '17:00' },
      wed: { on: true, from: '09:00', to: '17:00' },
      thu: { on: true, from: '09:00', to: '17:00' },
      fri: { on: true, from: '09:00', to: '17:00' },
      sat: { on: false, from: '10:00', to: '14:00' },
      sun: { on: false, from: '10:00', to: '14:00' },
    },
    afterHours: 'voicemail',
    forwardNumber: '',
  }),
  'routing.strategy': 'round-robin',
  'routing.maxQueue': '10',
  'routing.maxRingSec': '240',
  'routing.holdMusic': 'true',
  'routing.callback': 'true',
  'routing.fallback': 'voicemail',
  'routing.fallbackNumber': '',
  'recording.enabled': 'true',
  'recording.policy': 'all',
  'recording.inbound': 'true',
  'recording.outbound': 'true',
  'recording.announce': 'true',
  'recording.retention': '30',
  'recording.autoDelete': 'true',
  'recording.agentsAccess': 'true',
  'security.sessionTimeout': '8h',
  'security.requireMfa': 'true',
  'security.ipAllowlist': '',
  'security.srtp': 'true',
  'integrations.analysisEnabled': 'false',
  'integrations.analysisEndpoint': '',
  'integrations.mod.sentiment': '',
  'integrations.mod.transcription': '',
  'integrations.mod.alerts': '',
  'integrations.alertRules': '[]',
  'integrations.webhookEnabled': 'false',
  'integrations.webhookUrl': '',
  'integrations.webhookSecret': '',
};

const E164 = /^\+[1-9]\d{6,14}$/;

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export default function AdminSettings() {
  const location = useLocation();
  const utils = trpc.useUtils();
  const settingsQuery = trpc.admin.settings.getAll.useQuery();
  const setMutation = trpc.admin.settings.set.useMutation();

  const [tab, setTab] = useState<TabKey>(
    location.hash === '#integrations' ? 'integrations' : 'telephony'
  );
  const [pendingTab, setPendingTab] = useState<TabKey | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settingsQuery.data && !loaded) {
      const merged = { ...DEFAULTS, ...(settingsQuery.data as Record<string, string>) };
      setForm(merged);
      setSaved(merged);
      setLoaded(true);
    }
  }, [settingsQuery.data, loaded]);

  const dirtyKeys = useMemo(
    () => Object.keys(form).filter((k) => form[k] !== saved[k]),
    [form, saved]
  );

  const callerIdValid = E164.test(form['telephony.callerId'] ?? '');

  const set = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function save() {
    if (!callerIdValid) {
      toast.error('Invalid caller ID format');
      setTab('telephony');
      return;
    }
    setSaving(true);
    const started = Date.now();
    try {
      for (const key of dirtyKeys) {
        await setMutation.mutateAsync({ key, value: form[key] ?? '' });
      }
      // keep the save feeling deliberate — 500ms simulated latency floor
      const elapsed = Date.now() - started;
      if (elapsed < 500) await new Promise((r) => setTimeout(r, 500 - elapsed));
      await utils.admin.settings.getAll.invalidate();
      setSaved({ ...form });
      toast.success('Settings saved');
    } catch {
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setForm({ ...saved });
    setPendingTab(null);
  }

  function requestTab(next: TabKey) {
    if (dirtyKeys.length > 0 && next !== tab) setPendingTab(next);
    else setTab(next);
  }

  /* Ctrl+S saves the dirty tab */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirtyKeys.length > 0 && !saving) void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const get = (key: string) => form[key] ?? DEFAULTS[key] ?? '';
  const bool = (key: string) => get(key) === 'true';

  return (
    <AppShell variant="admin" title="Settings">
      <div className="mx-auto w-full max-w-[960px] flex-1 p-6">
        {/* header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
        >
          <h1 className="font-display text-[28px] font-semibold leading-[34px] tracking-tight text-text-hi">
            Settings
          </h1>
          <p className="mt-1 text-sm text-text-low">Changes apply instantly to the simulated provider.</p>
        </motion.div>

        <div className="mt-6 flex items-start gap-6">
          {/* tab rail */}
          <nav className="sticky top-20 shrink-0 space-y-1" style={{ width: 200 }}>
            {TABS.map((t, i) => (
              <motion.button
                key={t.key}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.4, ease: EASE, delay: i * 0.05 }}
                onClick={() => requestTab(t.key)}
                className={cn(
                  'relative flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-sm font-medium transition-colors duration-150',
                  tab === t.key
                    ? t.violet
                      ? 'bg-violet/10 text-text-hi'
                      : 'bg-signal-dim/40 text-text-hi'
                    : 'text-text-mid hover:bg-ink-700 hover:text-text-hi'
                )}
              >
                <span
                  className={cn(
                    'absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full transition-opacity',
                    t.violet ? 'bg-violet' : 'bg-signal',
                    tab === t.key ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <t.icon
                  className={cn(
                    'h-[18px] w-[18px]',
                    tab === t.key ? (t.violet ? 'text-violet' : 'text-signal') : 'text-text-low'
                  )}
                />
                {t.label}
              </motion.button>
            ))}
          </nav>

          {/* content column */}
          <div className="relative min-w-0 flex-1 pb-20">
            <AnimatePresence mode="wait">
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.24, ease: EASE }}
                className="space-y-4"
              >
                {!loaded ? (
                  <div className="flex h-48 items-center justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-signal" />
                  </div>
                ) : tab === 'telephony' ? (
                  <TelephonyTab get={get} set={set} bool={bool} callerIdValid={callerIdValid} />
                ) : tab === 'routing' ? (
                  <RoutingTab get={get} set={set} bool={bool} />
                ) : tab === 'recordings' ? (
                  <RecordingsTab get={get} set={set} bool={bool} />
                ) : tab === 'security' ? (
                  <SecurityTab get={get} set={set} bool={bool} />
                ) : (
                  <IntegrationsTab get={get} set={set} bool={bool} />
                )}
              </motion.div>
            </AnimatePresence>

            {/* dirty save bar */}
            <AnimatePresence>
              {dirtyKeys.length > 0 && (
                <motion.div
                  initial={{ y: '100%', opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: '100%', opacity: 0 }}
                  transition={{ duration: 0.25, ease: EASE }}
                  className="sticky bottom-4 z-20 flex items-center justify-between gap-3 rounded-[14px] border border-signal/30 bg-ink-800/95 px-4 py-3 shadow-glow-signal backdrop-blur-md"
                >
                  <span className="flex items-center gap-2 text-sm text-text-hi">
                    <span className="h-2 w-2 rounded-full bg-amber" />
                    You have unsaved changes
                    <span className="font-mono text-[11px] text-text-low">({dirtyKeys.length})</span>
                  </span>
                  <div className="flex gap-2">
                    <GhostButton onClick={discard} disabled={saving} className="px-3 py-1.5 text-xs">
                      Discard
                    </GhostButton>
                    <PrimaryButton onClick={() => void save()} disabled={saving} className="px-3 py-1.5 text-xs">
                      {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      Save
                    </PrimaryButton>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* discard-confirm dialog */}
      <AnimatePresence>
        {pendingTab && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center">
            <div className="absolute inset-0 bg-ink-950/60 backdrop-blur-[2px]" onClick={() => setPendingTab(null)} />
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.18, ease: EASE }}
              className="relative w-80 rounded-[14px] border border-line bg-ink-800 p-5 shadow-xl"
            >
              <div className="text-sm font-medium text-text-hi">Discard unsaved changes?</div>
              <p className="mt-1 text-xs leading-4 text-text-low">
                Your edits on this tab haven't been saved yet.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <GhostButton onClick={() => setPendingTab(null)} className="px-3 py-1.5 text-xs">
                  Keep editing
                </GhostButton>
                <PrimaryButton
                  tint="danger"
                  className="px-3 py-1.5 text-xs"
                  onClick={() => {
                    discard();
                    setTab(pendingTab);
                  }}
                >
                  Discard
                </PrimaryButton>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </AppShell>
  );
}

type TabProps = {
  get: (key: string) => string;
  set: (key: string, value: string) => void;
  bool: (key: string) => boolean;
};

/* ------------------------------------------------------------------------- */
/* Telephony                                                                  */
/* ------------------------------------------------------------------------- */

function TelephonyTab({ get, set, bool, callerIdValid }: TabProps & { callerIdValid: boolean }) {
  const hours = parseJson(get('telephony.hours'), {
    days: {} as Record<string, { on: boolean; from: string; to: string }>,
    afterHours: 'voicemail',
    forwardNumber: '',
  });
  const setHours = (next: typeof hours) => set('telephony.hours', JSON.stringify(next));

  const dayLabels: Array<[string, string]> = [
    ['mon', 'Monday'],
    ['tue', 'Tuesday'],
    ['wed', 'Wednesday'],
    ['thu', 'Thursday'],
    ['fri', 'Friday'],
    ['sat', 'Saturday'],
    ['sun', 'Sunday'],
  ];

  return (
    <>
      <TabHeader title="Telephony" caption="Connection profile, caller identity, and business hours." />

      <AdminCard title="Connection profile" caption="How CloudTalk reaches the telephone network.">
        <FieldRow label="Provider">
          <div className="flex items-center gap-2">
            <ConsoleSelect
              value={get('telephony.provider')}
              onChange={(v) => set('telephony.provider', v)}
              options={[
                { value: 'simulated', label: 'Simulated provider (built-in)' },
                { value: 'sip', label: 'SIP trunk — coming with integration', disabled: true },
              ]}
              width={260}
            />
            <span className="rounded-full border border-amber/40 bg-amber/10 px-2 py-0.5 font-mono text-[10px] font-medium tracking-[0.08em] text-amber">
              SIMULATED
            </span>
          </div>
        </FieldRow>
        <FieldRow label="Region">
          <ConsoleSelect
            value={get('telephony.region')}
            onChange={(v) => set('telephony.region', v)}
            options={[
              { value: 'us-west', label: 'US West' },
              { value: 'us-east', label: 'US East' },
              { value: 'eu', label: 'EU' },
            ]}
            width={160}
          />
        </FieldRow>
        <FieldRow label="Codec preference">
          <ConsoleSelect
            value={get('telephony.codec')}
            onChange={(v) => set('telephony.codec', v)}
            options={[
              { value: 'opus', label: 'Opus' },
              { value: 'g711', label: 'G.711' },
            ]}
            width={160}
          />
        </FieldRow>
        <FieldRow label="Max concurrent calls">
          <Stepper
            value={parseInt(get('telephony.maxConcurrent'), 10) || 25}
            onChange={(v) => set('telephony.maxConcurrent', String(v))}
            min={1}
            max={50}
          />
        </FieldRow>
      </AdminCard>

      <AdminCard title="Caller ID" caption="What callees see when your agents dial out.">
        <div>
          <div className="label-caps mb-1.5">Outbound caller ID</div>
          <motion.div
            key={callerIdValid ? 'valid' : 'invalid'}
            animate={callerIdValid ? { x: 0 } : { x: [0, -6, 6, -6, 6, 0] }}
            transition={{ duration: 0.3 }}
          >
            <ConsoleInput
              mono
              value={get('telephony.callerId')}
              onChange={(v) => set('telephony.callerId', v)}
              placeholder="+14155550134"
              invalid={!callerIdValid}
              className="max-w-xs"
            />
          </motion.div>
          {!callerIdValid && (
            <div className="mt-1.5 text-xs text-danger">Use format +1… (E.164)</div>
          )}
        </div>
        <FieldRow label="Show company name (CNAM)">
          <ConsoleSwitch checked={bool('telephony.cnam')} onChange={(v) => set('telephony.cnam', String(v))} />
        </FieldRow>
      </AdminCard>

      <AdminCard title="Business hours" caption="When agents are expected to answer.">
        <div className="space-y-2">
          {dayLabels.map(([key, label]) => {
            const d = hours.days[key] ?? { on: false, from: '09:00', to: '17:00' };
            return (
              <div key={key} className="flex items-center gap-3">
                <span className="w-20 text-sm text-text-mid">{label}</span>
                <ConsoleSwitch
                  checked={d.on}
                  onChange={(v) => setHours({ ...hours, days: { ...hours.days, [key]: { ...d, on: v } } })}
                />
                <input
                  type="time"
                  value={d.from}
                  disabled={!d.on}
                  onChange={(e) => setHours({ ...hours, days: { ...hours.days, [key]: { ...d, from: e.target.value } } })}
                  className="rounded-[8px] border border-line bg-ink-700 px-2 py-1 font-mono text-[12px] text-text-hi outline-none disabled:opacity-40"
                />
                <span className="text-text-low">–</span>
                <input
                  type="time"
                  value={d.to}
                  disabled={!d.on}
                  onChange={(e) => setHours({ ...hours, days: { ...hours.days, [key]: { ...d, to: e.target.value } } })}
                  className="rounded-[8px] border border-line bg-ink-700 px-2 py-1 font-mono text-[12px] text-text-hi outline-none disabled:opacity-40"
                />
              </div>
            );
          })}
        </div>
        <div>
          <div className="label-caps mb-2">After-hours behavior</div>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['voicemail', 'Voicemail', Voicemail],
                ['message', 'Play message', Radio],
                ['forward', 'Forward to number', ArrowRightLeft],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                onClick={() => setHours({ ...hours, afterHours: value })}
                className={cn(
                  'flex items-center gap-2 rounded-[10px] border px-3 py-2 text-xs font-medium transition-colors',
                  hours.afterHours === value
                    ? 'border-signal/60 bg-signal/10 text-signal'
                    : 'border-line bg-ink-700 text-text-mid hover:text-text-hi'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
          <AnimatePresence>
            {hours.afterHours === 'forward' && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.25, ease: EASE }}
                className="overflow-hidden"
              >
                <div className="pt-3">
                  <ConsoleInput
                    mono
                    value={hours.forwardNumber}
                    onChange={(v) => setHours({ ...hours, forwardNumber: v })}
                    placeholder="+14155550199"
                    className="max-w-xs"
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </AdminCard>
    </>
  );
}

/* ------------------------------------------------------------------------- */
/* Routing                                                                    */
/* ------------------------------------------------------------------------- */

function RoutingTab({ get, set, bool }: TabProps) {
  const strategies = [
    { value: 'round-robin', title: 'Round-robin', caption: 'Rotate through available agents', icon: RotateCcw },
    { value: 'simultaneous', title: 'Simultaneous', caption: 'Ring everyone, first to answer wins', icon: Users2 },
    { value: 'longest-idle', title: 'Longest-idle', caption: 'Agent idle longest gets it', icon: Timer },
  ] as const;

  const maxWait = parseInt(get('routing.maxRingSec'), 10) || 240;

  return (
    <>
      <TabHeader title="Routing" caption="How inbound calls find an agent." />

      <AdminCard title="Incoming call routing" caption="Pick the distribution strategy.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {strategies.map((s, i) => {
            const selected = get('routing.strategy') === s.value;
            return (
              <motion.button
                key={s.value}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: EASE, delay: i * 0.06 }}
                whileHover={{ y: -4 }}
                onClick={() => set('routing.strategy', s.value)}
                className={cn(
                  'rounded-[12px] border p-4 text-left transition-colors duration-200',
                  selected
                    ? 'border-signal bg-signal/5 shadow-glow-signal'
                    : 'border-line bg-ink-700/50 hover:border-signal/30'
                )}
              >
                <s.icon className={cn('h-5 w-5', selected ? 'text-signal' : 'text-text-low')} />
                <div className="mt-2.5 text-sm font-medium text-text-hi">{s.title}</div>
                <div className="mt-0.5 text-xs leading-4 text-text-low">{s.caption}</div>
              </motion.button>
            );
          })}
        </div>
      </AdminCard>

      <AdminCard title="Queue" caption="What happens when every agent is busy.">
        <FieldRow label="Max queue size">
          <Stepper
            value={parseInt(get('routing.maxQueue'), 10) || 10}
            onChange={(v) => set('routing.maxQueue', String(v))}
            min={1}
            max={100}
          />
        </FieldRow>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-text-hi">Max wait</span>
            <span className="rounded-md border border-line bg-ink-700 px-2 py-0.5 font-mono text-[12px] text-signal">
              {fmtDuration(maxWait)}
            </span>
          </div>
          <input
            type="range"
            min={30}
            max={600}
            step={30}
            value={maxWait}
            onChange={(e) => set('routing.maxRingSec', e.target.value)}
            className="w-full accent-[#2EE6A8]"
          />
          <div className="mt-1 flex justify-between font-mono text-[10px] text-text-low">
            <span>0:30</span>
            <span>10:00</span>
          </div>
        </div>
        <FieldRow label="Play hold music">
          <ConsoleSwitch checked={bool('routing.holdMusic')} onChange={(v) => set('routing.holdMusic', String(v))} />
        </FieldRow>
        <FieldRow label="Callback offers" hint="Let callers keep their place without waiting">
          <ConsoleSwitch checked={bool('routing.callback')} onChange={(v) => set('routing.callback', String(v))} />
        </FieldRow>
      </AdminCard>

      <AdminCard title="Fallback" caption="Overflow destination when the queue gives up.">
        <FieldRow label="Overflow destination">
          <ConsoleSelect
            value={get('routing.fallback')}
            onChange={(v) => set('routing.fallback', v)}
            options={[
              { value: 'voicemail', label: 'Voicemail' },
              { value: 'external', label: 'External number' },
            ]}
            width={200}
          />
        </FieldRow>
        <AnimatePresence>
          {get('routing.fallback') === 'external' && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: EASE }}
              className="overflow-hidden"
            >
              <ConsoleInput
                mono
                value={get('routing.fallbackNumber')}
                onChange={(v) => set('routing.fallbackNumber', v)}
                placeholder="+14155550100"
                className="max-w-xs"
              />
            </motion.div>
          )}
        </AnimatePresence>
      </AdminCard>
    </>
  );
}

function TabHeader({ title, caption, violet }: { title: string; caption: string; violet?: boolean }) {
  return (
    <div>
      <h2 className={cn('font-display text-xl font-semibold text-text-hi')}>{title}</h2>
      <p className="mt-1 text-sm text-text-low">{caption}</p>
      {violet && (
        <motion.div
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 0.5, ease: EASE }}
          className="mt-3 h-px origin-left bg-violet/50"
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Recordings                                                                 */
/* ------------------------------------------------------------------------- */

function RecordingsTab({ get, set, bool }: TabProps) {
  const enabled = bool('recording.enabled');
  const retention = parseInt(get('recording.retention'), 10) || 30;
  const storageMb = Math.round(retention * 13.7);

  return (
    <>
      <TabHeader title="Recordings" caption="Capture policy, retention, and access." />

      <AdminCard title="Policy" caption="Which calls get recorded." accent="violet">
        <FieldRow label="Record all calls" hint="Master switch for the whole org">
          <ConsoleSwitch
            tint="violet"
            checked={enabled}
            onChange={(v) => set('recording.enabled', String(v))}
          />
        </FieldRow>
        <AnimatePresence>
          {enabled && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="overflow-hidden"
            >
              <div className="space-y-4 border-t border-line/60 pt-4">
                <div className="flex items-center gap-6">
                  <span className="text-sm font-medium text-text-hi">Directions</span>
                  {(['inbound', 'outbound'] as const).map((d) => (
                    <label key={d} className="flex cursor-pointer items-center gap-2 text-sm text-text-mid">
                      <input
                        type="checkbox"
                        checked={bool(`recording.${d}`)}
                        onChange={(e) => set(`recording.${d}`, String(e.target.checked))}
                        className="h-4 w-4 accent-[#9B8CFF]"
                      />
                      {d === 'inbound' ? 'Inbound' : 'Outbound'}
                    </label>
                  ))}
                </div>
                <FieldRow
                  label="Announce recording to caller"
                  hint="Plays 'This call may be recorded' on connect"
                >
                  <ConsoleSwitch
                    tint="violet"
                    checked={bool('recording.announce')}
                    onChange={(v) => set('recording.announce', String(v))}
                  />
                </FieldRow>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </AdminCard>

      <AdminCard title="Retention" caption={`≈ ${storageMb} MB estimated storage at this period.`}>
        <FieldRow label="Retention period">
          <ConsoleSelect
            value={get('recording.retention')}
            onChange={(v) => set('recording.retention', v)}
            options={[
              { value: '7', label: '7 days' },
              { value: '30', label: '30 days' },
              { value: '90', label: '90 days' },
            ]}
            width={160}
          />
        </FieldRow>
        <div>
          <div className="mb-1.5 flex justify-between text-xs">
            <span className="text-text-mid">Storage used</span>
            <span className="font-mono text-amber">61%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-ink-700">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: '61%' }}
              transition={{ duration: 0.8, ease: EASE, delay: 0.2 }}
              className="h-full rounded-full bg-amber"
            />
          </div>
        </div>
        <FieldRow label="Auto-delete oldest when full">
          <ConsoleSwitch
            checked={bool('recording.autoDelete')}
            onChange={(v) => set('recording.autoDelete', String(v))}
          />
        </FieldRow>
      </AdminCard>

      <AdminCard title="Access" caption="Who can play back recordings.">
        <FieldRow label="Admins" hint="Always on">
          <ConsoleSwitch checked disabled />
        </FieldRow>
        <FieldRow label="Agents — own calls only">
          <ConsoleSwitch
            checked={bool('recording.agentsAccess')}
            onChange={(v) => set('recording.agentsAccess', String(v))}
          />
        </FieldRow>
      </AdminCard>
    </>
  );
}

/* ------------------------------------------------------------------------- */
/* Security                                                                   */
/* ------------------------------------------------------------------------- */

function SecurityTab({ get, set, bool }: TabProps) {
  const [ipTouched, setIpTouched] = useState(false);
  const ipLines = get('security.ipAllowlist').split('\n').filter((l) => l.trim() !== '');
  const cidrRe = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;

  const auditRows = [
    { actor: 'Dana Kim', action: 'changed routing strategy', at: '2h ago' },
    { actor: 'Dana Kim', action: 'assigned extension 107', at: '5h ago' },
    { actor: 'Maya Chen', action: 'enabled recording announcements', at: '1d ago' },
    { actor: 'Dana Kim', action: 'updated caller ID', at: '2d ago' },
    { actor: 'System', action: 'rotated SIP credentials', at: '3d ago' },
  ];

  return (
    <>
      <TabHeader title="Security" caption="Authentication, network, and audit." />

      <AdminCard title="Authentication">
        <FieldRow label="Require SSO" hint="Configured by your identity provider">
          <ConsoleSwitch checked={false} disabled title="Configured by your identity provider" />
        </FieldRow>
        <FieldRow label="Session timeout">
          <ConsoleSelect
            value={get('security.sessionTimeout')}
            onChange={(v) => set('security.sessionTimeout', v)}
            options={[
              { value: '1h', label: '1 hour' },
              { value: '8h', label: '8 hours' },
              { value: '24h', label: '24 hours' },
            ]}
            width={160}
          />
        </FieldRow>
        <FieldRow label="Enforce 2FA for admins">
          <ConsoleSwitch
            checked={bool('security.requireMfa')}
            onChange={(v) => set('security.requireMfa', String(v))}
          />
        </FieldRow>
      </AdminCard>

      <AdminCard title="Network">
        <div>
          <div className="label-caps mb-1.5">IP allowlist — one CIDR per line</div>
          <textarea
            value={get('security.ipAllowlist')}
            onChange={(e) => set('security.ipAllowlist', e.target.value)}
            onBlur={() => setIpTouched(true)}
            rows={4}
            placeholder={'203.0.113.0/24\n198.51.100.14'}
            className="w-full rounded-[10px] border border-line bg-ink-700 px-3 py-2 font-mono text-[13px] text-text-hi outline-none transition-colors placeholder:text-text-low focus:border-signal/60"
          />
          {ipTouched && ipLines.length > 0 && (
            <div className="mt-1.5 space-y-1">
              {ipLines.map((line, i) => {
                const ok = cidrRe.test(line.trim());
                return (
                  <motion.div
                    key={`${line}-${i}`}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.15 }}
                    className="flex items-center gap-1.5 font-mono text-[11px]"
                  >
                    {ok ? (
                      <Check className="h-3 w-3 text-signal" />
                    ) : (
                      <X className="h-3 w-3 text-danger" />
                    )}
                    <span className={ok ? 'text-text-low' : 'text-danger'}>{line}</span>
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>
        <FieldRow label="Encrypt media (SRTP)">
          <div className="flex items-center gap-2">
            <AnimatePresence>
              {bool('security.srtp') && (
                <motion.span
                  initial={{ opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 8 }}
                  transition={{ duration: 0.2 }}
                  className="flex items-center gap-1 rounded-full border border-signal/40 bg-signal/10 px-2 py-0.5 text-[10px] font-medium text-signal"
                >
                  <Lock className="h-3 w-3" />
                  Encrypted
                </motion.span>
              )}
            </AnimatePresence>
            <ConsoleSwitch
              checked={bool('security.srtp')}
              onChange={(v) => set('security.srtp', String(v))}
            />
          </div>
        </FieldRow>
      </AdminCard>

      <AdminCard title="Audit" caption="Recent administrative actions.">
        <div className="space-y-1">
          {auditRows.map((r, i) => (
            <div key={i} className="flex items-center justify-between border-b border-line/50 py-2 last:border-0">
              <span className="text-sm text-text-mid">
                <span className="text-text-hi">{r.actor}</span> {r.action}
              </span>
              <span className="font-mono text-[11px] text-text-low">{r.at}</span>
            </div>
          ))}
        </div>
        <button
          className="text-xs font-medium text-sky underline-offset-2 hover:underline"
          title="Coming soon"
          onClick={() => toast.info('Full audit log — coming soon')}
        >
          View full audit log
        </button>
      </AdminCard>
    </>
  );
}

/* ------------------------------------------------------------------------- */
/* Integrations — the future live-analysis module registry                    */
/* ------------------------------------------------------------------------- */

type ModuleConfig = { endpoint: string; apiKey: string; scope: string[] };

type AlertRule = { keyword: string; severity: 'low' | 'medium' | 'high' };

const MODULES = [
  {
    id: 'sentiment',
    title: 'Live sentiment',
    description: 'Stream call events to a sentiment model and surface per-call mood on the Overview dock.',
    icon: Activity,
  },
  {
    id: 'transcription',
    title: 'Live transcription',
    description: 'Real-time speech-to-text over active calls; transcript chunks attach to the call timeline.',
    icon: Globe,
  },
  {
    id: 'alerts',
    title: 'Keyword & compliance alerts',
    description: 'Trigger alerts when configured keywords appear in live transcripts.',
    icon: AlertTriangle,
  },
] as const;

const EVENT_SCHEMA_SAMPLE = `{
  "type": "call_active",          // call_ringing | call_active | call_held |
                                  // call_resumed | call_ended | presence_changed
  "callId": 1042,
  "direction": "inbound",
  "from": "+1 415 555 0134",
  "to": "+1 628 555 0110",
  "agent": { "id": 7, "extension": "104" },
  "at": "2025-03-12T14:32:08.211Z",
  "payload": { "audio_frame": "…pcm16 16kHz…" }  // when audio frames are in scope
}`;

function IntegrationsTab({ get, set, bool }: TabProps) {
  const [connecting, setConnecting] = useState<(typeof MODULES)[number]['id'] | null>(null);
  const [copied, setCopied] = useState(false);
  const [newRule, setNewRule] = useState<AlertRule | null>(null);

  const rules = parseJson<AlertRule[]>(get('integrations.alertRules'), []);
  const setRules = (next: AlertRule[]) => set('integrations.alertRules', JSON.stringify(next));

  const moduleConfig = (id: string) =>
    parseJson<ModuleConfig | null>(get(`integrations.mod.${id}`), null);

  async function copySchema() {
    try {
      await navigator.clipboard.writeText(EVENT_SCHEMA_SAMPLE);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error('Clipboard unavailable');
    }
  }

  return (
    <>
      <TabHeader
        violet
        title="Integrations"
        caption="The module registry — where live call-analysis tools get wired in."
      />
      <div className="label-caps -mb-2 text-violet">Modules</div>

      {/* intro card */}
      <div className="rounded-[14px] border border-violet/30 bg-violet/5 p-5">
        <div className="flex items-start gap-3">
          <div className="rounded-[10px] border border-violet/40 bg-violet/10 p-2">
            <Plug className="h-5 w-5 text-violet" />
          </div>
          <div>
            <h3 className="font-display text-lg font-semibold text-text-hi">Connect live call analysis</h3>
            <p className="mt-1 max-w-xl text-sm leading-6 text-text-mid">
              CloudTalk streams every call event in real time. Connect an analysis module below to run live
              sentiment, transcription, and alerting on active calls. Your module receives the same event
              stream the Overview dashboard uses.
            </p>
          </div>
        </div>
      </div>

      {/* module registry */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {MODULES.map((m, i) => {
          const cfg = moduleConfig(m.id);
          const configured = cfg != null && cfg.endpoint !== '';
          return (
            <motion.div
              key={m.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: EASE, delay: i * 0.07 }}
              className="flex flex-col rounded-[14px] border border-dashed border-violet/40 bg-ink-800 p-4"
            >
              <div className="flex items-center justify-between">
                <m.icon className="h-4 w-4 text-violet" />
                <motion.span
                  key={configured ? 'configured' : 'none'}
                  initial={{ scale: 1.1 }}
                  animate={{ scale: 1 }}
                  transition={{ duration: 0.2 }}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[10px] font-medium',
                    configured
                      ? 'border-violet/50 bg-violet/10 text-violet'
                      : 'border-line bg-ink-700 text-text-low'
                  )}
                >
                  {configured ? 'Configured · awaiting module' : 'Not connected'}
                </motion.span>
              </div>
              <div className="mt-2.5 text-sm font-semibold text-text-hi">{m.title}</div>
              <p className="mt-1 flex-1 text-xs leading-5 text-text-low">{m.description}</p>

              {m.id === 'alerts' && (
                <div className="mt-3 border-t border-line/60 pt-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-mono text-[11px] text-text-low">{rules.length} rules</span>
                    <button
                      onClick={() => setNewRule({ keyword: '', severity: 'medium' })}
                      className="rounded-md border border-line px-2 py-1 text-[11px] text-text-mid transition-colors hover:border-violet/50 hover:text-violet"
                    >
                      + Add rule
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    {rules.map((r, idx) => (
                      <div
                        key={idx}
                        className="group flex items-center gap-2 rounded-[8px] border border-line bg-ink-700/60 px-2.5 py-1.5"
                      >
                        <span className="flex-1 truncate font-mono text-[11px] text-text-hi">{r.keyword}</span>
                        <span
                          className={cn(
                            'rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase',
                            r.severity === 'high'
                              ? 'bg-danger/15 text-danger'
                              : r.severity === 'medium'
                                ? 'bg-amber/15 text-amber'
                                : 'bg-ink-700 text-text-low'
                          )}
                        >
                          {r.severity}
                        </span>
                        <button
                          onClick={() => setRules(rules.filter((_, j) => j !== idx))}
                          className="rounded p-0.5 text-text-low opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                          title="Delete rule"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                    {newRule && (
                      <div className="flex items-center gap-1.5">
                        <input
                          autoFocus
                          value={newRule.keyword}
                          onChange={(e) => setNewRule({ ...newRule, keyword: e.target.value })}
                          placeholder="keyword"
                          className="w-full min-w-0 rounded-[8px] border border-line bg-ink-700 px-2 py-1 font-mono text-[11px] text-text-hi outline-none focus:border-violet/60"
                        />
                        <select
                          value={newRule.severity}
                          onChange={(e) => setNewRule({ ...newRule, severity: e.target.value as AlertRule['severity'] })}
                          className="rounded-[8px] border border-line bg-ink-700 px-1.5 py-1 text-[11px] text-text-hi outline-none"
                        >
                          <option value="low" className="bg-ink-800">low</option>
                          <option value="medium" className="bg-ink-800">medium</option>
                          <option value="high" className="bg-ink-800">high</option>
                        </select>
                        <button
                          onClick={() => {
                            if (!newRule.keyword.trim()) return;
                            setRules([...rules, newRule]);
                            setNewRule(null);
                            toast.success('Rule added');
                          }}
                          className="rounded-[8px] border border-violet/50 bg-violet/10 px-2 py-1 text-[11px] font-medium text-violet hover:bg-violet/20"
                        >
                          Save
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <PrimaryButton
                tint="violet"
                className="mt-3 w-full px-3 py-1.5 text-xs"
                onClick={() => setConnecting(m.id)}
              >
                {configured ? 'Reconfigure' : 'Connect'}
              </PrimaryButton>
            </motion.div>
          );
        })}
      </div>

      {/* event stream developer surface */}
      <AdminCard
        accent="violet"
        title="Event stream"
        caption="WebSocket endpoint: wss://your-domain/ws/analysis — provisioned when telephony goes live."
      >
        <div className="relative overflow-hidden rounded-[10px] border border-line bg-ink-950/70">
          <button
            onClick={() => void copySchema()}
            className="absolute right-2 top-2 rounded-lg border border-line bg-ink-800 p-1.5 text-text-low transition-colors hover:text-violet"
            title="Copy schema"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-signal" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          <pre className="overflow-x-auto p-4 font-mono text-[11px] leading-5 text-text-mid">
            <code>{EVENT_SCHEMA_SAMPLE}</code>
          </pre>
        </div>
        <EventTicker limit={12} maxRows={8} />
      </AdminCard>

      {/* webhook row */}
      <AdminCard accent="violet" title="Webhook" caption="Also forward events to a webhook.">
        <FieldRow label="Forward events">
          <ConsoleSwitch
            tint="violet"
            checked={bool('integrations.webhookEnabled')}
            onChange={(v) => set('integrations.webhookEnabled', String(v))}
          />
        </FieldRow>
        <AnimatePresence>
          {bool('integrations.webhookEnabled') && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: EASE }}
              className="space-y-3 overflow-hidden"
            >
              <ConsoleInput
                mono
                value={get('integrations.webhookUrl')}
                onChange={(v) => set('integrations.webhookUrl', v)}
                placeholder="https://your-service.example/hooks/cloudtalk"
              />
              <ConsoleInput
                mono
                type="password"
                value={get('integrations.webhookSecret')}
                onChange={(v) => set('integrations.webhookSecret', v)}
                placeholder="Signing secret"
              />
            </motion.div>
          )}
        </AnimatePresence>
      </AdminCard>

      {/* connect modal */}
      <ConnectModal
        moduleId={connecting}
        initial={connecting ? moduleConfig(connecting) : null}
        onClose={() => setConnecting(null)}
        onSave={(cfg) => {
          if (!connecting) return;
          set(`integrations.mod.${connecting}`, JSON.stringify(cfg));
          // the headline analysis endpoint mirrors the first configured module
          if (!get('integrations.analysisEndpoint')) {
            set('integrations.analysisEndpoint', cfg.endpoint);
          }
          set('integrations.analysisEnabled', 'true');
          setConnecting(null);
          toast.success('Module configuration saved');
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------------- */

const SCOPES = ['call lifecycle', 'audio frames', 'metadata'] as const;

function ConnectModal({
  moduleId,
  initial,
  onClose,
  onSave,
}: {
  moduleId: string | null;
  initial: ModuleConfig | null;
  onClose: () => void;
  onSave: (cfg: ModuleConfig) => void;
}) {
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [scope, setScope] = useState<string[]>(['call lifecycle', 'metadata']);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);

  useEffect(() => {
    if (moduleId) {
      setEndpoint(initial?.endpoint ?? '');
      setApiKey(initial?.apiKey ?? '');
      setScope(initial?.scope ?? ['call lifecycle', 'metadata']);
      setTested(false);
      setTesting(false);
    }
  }, [moduleId, initial]);

  const module = MODULES.find((m) => m.id === moduleId);

  return (
    <AnimatePresence>
      {moduleId && module && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-ink-950/60 backdrop-blur-[4px]"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="relative w-[420px] rounded-[14px] border border-violet/30 bg-ink-800 p-5 shadow-glow-violet"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <module.icon className="h-4 w-4 text-violet" />
                <span className="font-display text-[15px] font-semibold text-text-hi">
                  Connect {module.title}
                </span>
              </div>
              <button onClick={onClose} className="rounded-lg p-1.5 text-text-mid hover:bg-ink-700 hover:text-text-hi">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <div>
                <div className="label-caps mb-1.5">Endpoint URL</div>
                <ConsoleInput
                  mono
                  value={endpoint}
                  onChange={setEndpoint}
                  placeholder="wss://your-analysis-service.example/stream"
                />
              </div>
              <div>
                <div className="label-caps mb-1.5">API key</div>
                <ConsoleInput
                  mono
                  type="password"
                  value={apiKey}
                  onChange={setApiKey}
                  placeholder="••••••••••••"
                />
              </div>
              <div>
                <div className="label-caps mb-1.5">Event scope</div>
                <div className="flex flex-wrap gap-3">
                  {SCOPES.map((s) => (
                    <label key={s} className="flex cursor-pointer items-center gap-2 text-xs text-text-mid">
                      <input
                        type="checkbox"
                        checked={scope.includes(s)}
                        onChange={(e) =>
                          setScope(e.target.checked ? [...scope, s] : scope.filter((x) => x !== s))
                        }
                        className="h-3.5 w-3.5 accent-[#9B8CFF]"
                      />
                      {s}
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <GhostButton
                  className="px-3 py-1.5 text-xs"
                  disabled={testing}
                  onClick={() => {
                    setTesting(true);
                    setTested(false);
                    setTimeout(() => {
                      setTesting(false);
                      setTested(true);
                    }, 600);
                  }}
                >
                  {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Test connection
                </GhostButton>
              </div>
              <AnimatePresence>
                {tested && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="rounded-[10px] border border-amber/30 bg-amber/5 px-3 py-2 text-[11px] leading-4 text-amber"
                  >
                    No module responding — this is expected until your analysis service is live.
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <GhostButton onClick={onClose} className="px-3 py-1.5 text-xs">
                Cancel
              </GhostButton>
              <PrimaryButton
                tint="violet"
                className="px-3 py-1.5 text-xs"
                disabled={!endpoint.trim()}
                onClick={() => onSave({ endpoint: endpoint.trim(), apiKey, scope })}
              >
                Save configuration
              </PrimaryButton>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
