/**
 * CallVerify port — admin verification console (/admin/verification).
 *
 * Drives the Twilio verification state machine (ported from piecebyte's
 * CallVerify / SessionService.java): initiate sessions, watch them advance
 * through the 7-step flow in near real time (3s polling), inspect per-leg
 * call SIDs + the event timeline, and act (terminate / confirm voicemail).
 * Violet accent marks verification/analysis surfaces, matching the Live
 * Analysis dock language.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  ShieldCheck,
  Radar,
  ChevronDown,
  PhoneOutgoing,
  PhoneForwarded,
  PhoneIncoming,
  PhoneCall,
  Check,
  X,
  Voicemail,
  OctagonX,
  Loader2,
} from 'lucide-react';
import AppShell from '@/components/AppShell';
import Drawer from '@/components/Drawer';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { formatPhoneDisplay, formatCallDuration, normalizePhoneNumber } from '@/lib/telephony';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// State vocabulary (mirrors api/verification.ts)
// ---------------------------------------------------------------------------

const FLOW_STEPS = [
  { key: 'INITIATED', label: 'Initiated' },
  { key: 'CALLER_HOLDING', label: 'Caller holding' },
  { key: 'LEG_A_DIALING', label: 'Leg A dialing' },
  { key: 'CALL_ACCEPTED', label: 'Call accepted' },
  { key: 'CALLEE_READY', label: 'Callee ready' },
  { key: 'LEG_B_DIALING', label: 'Leg B dialing' },
  { key: 'LEG_B_ANSWERED', label: 'Leg B answered' },
] as const;

const TERMINAL_LABEL: Record<string, string> = {
  COMPLETED: 'Completed',
  MERGE_DETECTED: 'Merge detected',
  VOIP_DETECTED: 'VoIP / multi-line',
  CALL_WAITING_OFF: 'Call waiting off',
  FAILED: 'Failed',
};

type Tone = 'amber' | 'signal' | 'violet' | 'sky' | 'danger';

function stateTone(state: string): Tone {
  switch (state) {
    case 'COMPLETED':
      return 'signal';
    case 'MERGE_DETECTED':
    case 'VOIP_DETECTED':
      return 'violet';
    case 'CALL_WAITING_OFF':
      return 'sky';
    case 'FAILED':
      return 'danger';
    default:
      return 'amber';
  }
}

const TONE_CLASSES: Record<Tone, { dot: string; text: string; bg: string }> = {
  amber: { dot: 'bg-amber', text: 'text-amber', bg: 'bg-amber/10 border-amber/30' },
  signal: { dot: 'bg-signal', text: 'text-signal', bg: 'bg-signal/10 border-signal/30' },
  violet: { dot: 'bg-violet', text: 'text-violet', bg: 'bg-violet/10 border-violet/30' },
  sky: { dot: 'bg-sky', text: 'text-sky', bg: 'bg-sky/10 border-sky/30' },
  danger: { dot: 'bg-danger', text: 'text-danger', bg: 'bg-danger/10 border-danger/30' },
};

function StatePill({ state, className }: { state: string; className?: string }) {
  const tone = stateTone(state);
  const s = TONE_CLASSES[tone];
  const terminal = state in TERMINAL_LABEL;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-medium tracking-[0.04em]',
        s.bg,
        s.text,
        className
      )}
    >
      <span className={cn('h-2 w-2 rounded-full', s.dot, !terminal && 'animate-pulse')} />
      {TERMINAL_LABEL[state] ?? state.replace(/_/g, ' ')}
    </span>
  );
}

function stateLabel(state: string): string {
  return TERMINAL_LABEL[state] ?? FLOW_STEPS.find((s) => s.key === state)?.label ?? state;
}

/** Ticking clock for live durations. */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

// ---------------------------------------------------------------------------
// Initiate card
// ---------------------------------------------------------------------------

function InitiateCard({ onStarted }: { onStarted: (sessionId: string) => void }) {
  const [callee, setCallee] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [caller, setCaller] = useState('');
  const [legB, setLegB] = useState('');
  const [ringTest, setRingTest] = useState('');
  const utils = trpc.useUtils();

  const initiate = trpc.verification.initiate.useMutation({
    onSuccess: (s) => {
      toast.success(`Verification started for ${formatPhoneDisplay(s.calleeNumber)}`);
      void utils.verification.list.invalidate();
      onStarted(s.sessionId);
    },
    onError: (err) => toast.error(err.message),
  });

  const calleeNorm = normalizePhoneNumber(callee);
  const calleeValid = calleeNorm != null;

  const submit = () => {
    initiate.mutate({
      calleeNumber: callee.trim(),
      callerNumber: caller.trim() || undefined,
      legBNumber: legB.trim() || undefined,
      ringTestNumber: ringTest.trim() || undefined,
    });
  };

  const inputCls =
    'w-full rounded-[10px] border border-line bg-ink-800 px-3 py-2 font-mono text-sm text-text-hi outline-none transition-colors placeholder:text-text-low focus:border-violet/60';

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="rounded-[14px] border border-line bg-ink-900 p-5"
    >
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-violet" />
        <h2 className="font-display text-[15px] font-semibold text-text-hi">Start a verification</h2>
      </div>
      <p className="mt-1 text-xs text-text-low">
        Verifies a number is a single cellular line: Leg A IVR → Leg B + ring test → merge /
        VoIP / call-waiting detection.
      </p>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <div className="label-caps mb-1.5">Number to verify (E.164)</div>
          <input
            value={callee}
            onChange={(e) => setCallee(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && calleeValid && !initiate.isPending && submit()}
            placeholder="+61 4XX XXX XXX"
            className={inputCls}
          />
          {callee.trim() && (
            <div className={cn('mt-1.5 font-mono text-[11px]', calleeValid ? 'text-violet' : 'text-danger')}>
              {calleeValid ? `→ ${formatPhoneDisplay(callee)}` : 'Not a valid E.164 number'}
            </div>
          )}
        </div>
        <button
          onClick={submit}
          disabled={!calleeValid || initiate.isPending}
          className="flex h-[38px] shrink-0 items-center justify-center gap-2 rounded-[10px] bg-violet px-5 text-sm font-semibold text-ink-950 transition-all hover:brightness-110 disabled:opacity-40"
        >
          {initiate.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Radar className="h-4 w-4" />
          )}
          Start verification
        </button>
      </div>

      <button
        onClick={() => setAdvanced((v) => !v)}
        className="mt-3 flex items-center gap-1.5 text-xs font-medium text-text-low transition-colors hover:text-text-mid"
      >
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', advanced && 'rotate-180')} />
        Advanced: caller + leg overrides
      </button>
      <AnimatePresence initial={false}>
        {advanced && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-3 grid gap-3 border-t border-line/60 pt-3 sm:grid-cols-3">
              <div>
                <div className="label-caps mb-1.5">Caller number (optional)</div>
                <input value={caller} onChange={(e) => setCaller(e.target.value)} placeholder="+61…" className={inputCls} />
                <div className="mt-1 text-[11px] text-text-low">
                  Parked on hold with music; the verdict is announced to them at the
                  end and shown live here. Empty = dashboard-only.
                </div>
              </div>
              <div>
                <div className="label-caps mb-1.5">Leg B number override</div>
                <input value={legB} onChange={(e) => setLegB(e.target.value)} placeholder="= callee" className={inputCls} />
              </div>
              <div>
                <div className="label-caps mb-1.5">Ring-test number override</div>
                <input value={ringTest} onChange={(e) => setRingTest(e.target.value)} placeholder="= callee" className={inputCls} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

// ---------------------------------------------------------------------------
// Session monitor (list)
// ---------------------------------------------------------------------------

type SessionRow = {
  id: number;
  sessionId: string;
  callerNumber: string | null;
  calleeNumber: string;
  state: string;
  callerCallSid: string | null;
  legACallSid: string | null;
  legBCallSid: string | null;
  ringTestCallSid: string | null;
  legBOriginatedAt: Date | null;
  toneDetected: boolean;
  toneDetectedAt: Date | null;
  smsSent: boolean;
  createdAt: Date;
  completedAt: Date | null;
  failureReason: string | null;
  legBNumber: string | null;
  ringTestNumber: string | null;
};

const LEG_META: Array<{ key: keyof SessionRow & string; label: string; icon: typeof PhoneCall }> = [
  { key: 'callerCallSid', label: 'Caller', icon: PhoneIncoming },
  { key: 'legACallSid', label: 'Leg A (IVR)', icon: PhoneOutgoing },
  { key: 'legBCallSid', label: 'Leg B (verify)', icon: PhoneCall },
  { key: 'ringTestCallSid', label: 'Ring test', icon: PhoneForwarded },
];

function SessionMonitor({ onSelect }: { onSelect: (sessionId: string) => void }) {
  const now = useNow();
  const listQ = trpc.verification.list.useQuery(undefined, { refetchInterval: 3000 });
  const sessions = useMemo(() => listQ.data ?? [], [listQ.data]);

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.08 }}
      className="rounded-[14px] border border-line bg-ink-900"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Radar className="h-4 w-4 text-violet" />
          <h2 className="font-display text-[15px] font-semibold text-text-hi">Live sessions</h2>
        </div>
        <span className="font-mono text-[11px] text-text-low">
          {listQ.isFetching ? 'refreshing…' : `${sessions.length} session${sessions.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {sessions.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
          <div className="rounded-[14px] border border-dashed border-line p-4">
            <ShieldCheck className="h-8 w-8 text-text-low" />
          </div>
          <div className="text-sm font-medium text-text-hi">No verification sessions yet</div>
          <div className="max-w-xs text-xs text-text-low">
            Start one above — sessions advance live through Leg A, Leg B and the ring test.
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-line/60">
          {sessions.map((s) => {
            const terminal = s.state in TERMINAL_LABEL;
            const elapsed = Math.max(
              0,
              Math.floor(((s.completedAt ? new Date(s.completedAt).getTime() : now) - new Date(s.createdAt).getTime()) / 1000)
            );
            return (
              <li key={s.sessionId}>
                <button
                  onClick={() => onSelect(s.sessionId)}
                  className="group flex w-full items-center gap-4 px-5 py-3 text-left transition-colors hover:bg-ink-700"
                >
                  <span className="relative flex items-center">
                    <span className="absolute -left-5 h-5 w-[2px] rounded-full bg-violet opacity-0 transition-opacity group-hover:opacity-100" />
                    <StatePill state={s.state} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-text-hi">
                      {formatPhoneDisplay(s.calleeNumber)}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-text-low">
                      {s.callerNumber ? `caller ${formatPhoneDisplay(s.callerNumber)} · ` : ''}
                      {s.sessionId.slice(0, 8)} · {stateLabel(s.state)}
                      {s.failureReason ? ` — ${s.failureReason}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-xs text-text-mid">
                    {formatCallDuration(elapsed)}
                    {!terminal && <span className="ml-1.5 inline-block h-1.5 w-1.5 animate-live-dot rounded-full bg-amber align-middle" />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </motion.section>
  );
}

// ---------------------------------------------------------------------------
// Session detail drawer
// ---------------------------------------------------------------------------

function FlowStepper({ session, eventStates }: { session: SessionRow; eventStates: string[] }) {
  // Furthest non-terminal state reached (from the event timeline, falling back
  // to the current state) so terminal sessions still show their full path.
  let furthest = FLOW_STEPS.findIndex((f) => f.key === session.state);
  for (const st of eventStates) {
    const idx = FLOW_STEPS.findIndex((f) => f.key === st);
    if (idx > furthest) furthest = idx;
  }
  const terminal = session.state in TERMINAL_LABEL ? session.state : null;
  if (terminal) furthest = Math.max(furthest, 0);

  return (
    <div>
      <div className="label-caps mb-2">State flow</div>
      <ol className="space-y-0">
        {FLOW_STEPS.map((step, i) => {
          const reached = i <= furthest;
          const current = !terminal && i === furthest;
          return (
            <li key={step.key} className="flex items-stretch gap-3">
              <span className="flex flex-col items-center">
                <span
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded-full border',
                    reached
                      ? 'border-violet/50 bg-violet/15 text-violet'
                      : 'border-line bg-ink-800 text-text-low',
                    current && 'border-amber/60 bg-amber/15 text-amber'
                  )}
                >
                  {reached ? <Check className="h-3 w-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-text-low" />}
                </span>
                {i < FLOW_STEPS.length - 1 && (
                  <span className={cn('w-px flex-1', i < furthest ? 'bg-violet/40' : 'bg-line')} />
                )}
              </span>
              <span
                className={cn(
                  'pb-3.5 text-[13px] leading-5',
                  reached ? 'text-text-hi' : 'text-text-low',
                  current && 'font-medium text-amber'
                )}
              >
                {step.label}
              </span>
            </li>
          );
        })}
        {terminal && (
          <li className="flex items-center gap-3">
            <span
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-full border',
                TONE_CLASSES[stateTone(terminal)].bg,
                TONE_CLASSES[stateTone(terminal)].text
              )}
            >
              {terminal === 'COMPLETED' ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            </span>
            <span className={cn('text-[13px] font-medium', TONE_CLASSES[stateTone(terminal)].text)}>
              {TERMINAL_LABEL[terminal]}
            </span>
          </li>
        )}
      </ol>
    </div>
  );
}

function EventTimeline({ events }: { events: Array<{ id: number; eventType: string; details: string | null; timestamp: Date }> }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <div>
      <div className="label-caps mb-2">Event timeline</div>
      {events.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-line px-3 py-4 text-center text-xs text-text-low">
          No events yet — the timeline fills in as Twilio reports call progress.
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="max-h-72 overflow-y-auto rounded-[10px] border border-line bg-ink-950 p-3 font-mono text-[11px] leading-[1.7]"
        >
          {events.map((e) => (
            <div key={e.id} className="flex gap-2">
              <span className="shrink-0 text-text-low">
                {new Date(e.timestamp).toLocaleTimeString('en-AU', { hour12: false })}
              </span>
              <span className={cn('shrink-0', e.eventType in TERMINAL_LABEL ? TONE_CLASSES[stateTone(e.eventType)].text : 'text-violet')}>
                {e.eventType}
              </span>
              <span className="min-w-0 break-words text-text-mid">{e.details}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SessionDrawer({ sessionId, onClose }: { sessionId: string | null; onClose: () => void }) {
  const enabled = sessionId != null;
  const utils = trpc.useUtils();
  const sessionQ = trpc.verification.get.useQuery(
    { sessionId: sessionId ?? '' },
    { enabled, refetchInterval: 3000 }
  );
  const eventsQ = trpc.verification.events.useQuery(
    { sessionId: sessionId ?? '' },
    { enabled, refetchInterval: 3000 }
  );

  const terminate = trpc.verification.terminate.useMutation({
    onSuccess: () => {
      toast('Session terminated');
      void utils.verification.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });
  const confirmVoicemail = trpc.verification.confirmVoicemail.useMutation({
    onSuccess: () => {
      toast.success('Voicemail confirmed — call waiting OFF');
      void utils.verification.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const s = (sessionQ.data ?? null) as SessionRow | null;
  const events = useMemo(() => eventsQ.data ?? [], [eventsQ.data]);
  const eventStates = useMemo(() => events.map((e) => e.eventType), [events]);
  const terminal = s ? s.state in TERMINAL_LABEL : false;

  return (
    <Drawer
      open={enabled}
      onClose={onClose}
      width={460}
      title={
        <span className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-violet" />
          Verification session
          {s && <StatePill state={s.state} />}
        </span>
      }
      footer={
        s && (
          <div className="flex gap-2">
            {s.state === 'LEG_B_ANSWERED' && (
              <button
                onClick={() => confirmVoicemail.mutate({ sessionId: s.sessionId })}
                disabled={confirmVoicemail.isPending}
                className="flex flex-1 items-center justify-center gap-2 rounded-[10px] border border-sky/40 bg-sky/10 px-3 py-2 text-sm font-medium text-sky transition-colors hover:bg-sky/20 disabled:opacity-40"
              >
                <Voicemail className="h-4 w-4" />
                Confirm voicemail (call waiting off)
              </button>
            )}
            {!terminal && (
              <button
                onClick={() => {
                  if (window.confirm('Terminate this verification session? All legs will be hung up.')) {
                    terminate.mutate({ sessionId: s.sessionId });
                  }
                }}
                disabled={terminate.isPending}
                className="flex flex-1 items-center justify-center gap-2 rounded-[10px] border border-danger/40 bg-danger/10 px-3 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger/20 disabled:opacity-40"
              >
                <OctagonX className="h-4 w-4" />
                Terminate
              </button>
            )}
            {terminal && (
              <div className="w-full rounded-[10px] border border-line bg-ink-800 px-3 py-2 text-center text-xs text-text-low">
                Session finished — {TERMINAL_LABEL[s.state]}
                {s.failureReason ? `: ${s.failureReason}` : ''}
              </div>
            )}
          </div>
        )
      }
    >
      {!s ? (
        <div className="flex items-center gap-2 text-sm text-text-low">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading session…
        </div>
      ) : (
        <div className="space-y-6">
          {/* Numbers */}
          <div className="rounded-[12px] border border-line bg-ink-800 p-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="label-caps mb-1">Callee</div>
                <div className="font-mono text-[13px] text-text-hi">{formatPhoneDisplay(s.calleeNumber)}</div>
              </div>
              <div>
                <div className="label-caps mb-1">Caller</div>
                <div className="font-mono text-[13px] text-text-hi">
                  {s.callerNumber ? formatPhoneDisplay(s.callerNumber) : '— (dashboard only)'}
                </div>
              </div>
              <div>
                <div className="label-caps mb-1">SMS</div>
                <div className={cn('font-mono text-[13px]', s.smsSent ? 'text-signal' : 'text-text-low')}>
                  {s.smsSent ? 'sent' : 'not sent'}
                </div>
              </div>
              <div>
                <div className="label-caps mb-1">Merge tone</div>
                <div className={cn('font-mono text-[13px]', s.toneDetected ? 'text-violet' : 'text-text-low')}>
                  {s.toneDetected ? 'detected' : 'not detected'}
                </div>
              </div>
            </div>
            {s.failureReason && (
              <div className="mt-3 rounded-[8px] border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                {s.failureReason}
              </div>
            )}
          </div>

          <FlowStepper session={s} eventStates={eventStates} />

          {/* Legs */}
          <div>
            <div className="label-caps mb-2">Call legs</div>
            <div className="space-y-1.5">
              {LEG_META.map(({ key, label, icon: Icon }) => {
                const sid = s[key] as string | null;
                return (
                  <div key={key} className="flex items-center gap-2.5 rounded-[10px] border border-line bg-ink-800 px-3 py-2">
                    <Icon className={cn('h-3.5 w-3.5 shrink-0', sid ? 'text-violet' : 'text-text-low')} />
                    <span className="w-24 shrink-0 text-xs text-text-mid">{label}</span>
                    <span className="min-w-0 truncate font-mono text-[11px] text-text-low">
                      {sid ?? 'not originated'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <EventTimeline events={events} />
        </div>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminVerification() {
  const { user, isAuthenticated } = useAuth();
  const enabled = isAuthenticated && user?.role === 'admin';
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <AppShell variant="admin" title="Call Verification">
      <div className="space-y-6 p-6">
        {enabled ? (
          <>
            <InitiateCard onStarted={setSelected} />
            <SessionMonitor onSelect={setSelected} />
          </>
        ) : (
          <div className="rounded-[14px] border border-line bg-ink-900 p-8 text-center text-sm text-text-low">
            Admin access required.
          </div>
        )}
      </div>
      <SessionDrawer sessionId={selected} onClose={() => setSelected(null)} />
    </AppShell>
  );
}
