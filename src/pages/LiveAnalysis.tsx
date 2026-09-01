import { useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Activity, ArrowLeft, Loader2, Radar, ShieldCheck } from 'lucide-react';
import AppShell from '@/components/AppShell';
import { cn } from '@/lib/utils';
import { formatPhoneDisplay } from '@/lib/telephony';
import { trpc } from '@/providers/trpc';

const POLL_MS = 2000;

type VerificationEventRow = {
  id: number;
  eventType: string;
  details: string | null;
  timestamp: Date | string;
};

type VerificationSessionRow = {
  sessionId: string;
  calleeNumber: string;
  callerNumber: string | null;
  state: string;
  guarded: boolean | null;
  createdAt: Date | string;
  completedAt: Date | string | null;
  failureReason: string | null;
};

const STATE_BADGE: Record<string, string> = {
  INITIATED: 'border-amber/40 bg-amber/10 text-amber',
  CALLER_HOLDING: 'border-amber/40 bg-amber/10 text-amber',
  LEG_A_DIALING: 'border-amber/40 bg-amber/10 text-amber',
  CALL_ACCEPTED: 'border-violet/40 bg-violet/10 text-violet',
  CALLEE_READY: 'border-violet/40 bg-violet/10 text-violet',
  LEG_B_DIALING: 'border-violet/40 bg-violet/10 text-violet',
  LEG_B_ANSWERED: 'border-violet/40 bg-violet/10 text-violet',
  BRIDGED: 'border-signal/40 bg-signal/10 text-signal',
  COMPLETED: 'border-sky/40 bg-sky/10 text-sky',
  FAILED: 'border-danger/40 bg-danger/10 text-danger',
  MERGE_DETECTED: 'border-danger/40 bg-danger/10 text-danger',
  VOIP_DETECTED: 'border-danger/40 bg-danger/10 text-danger',
  CALL_WAITING_OFF: 'border-amber/40 bg-amber/10 text-amber',
};

function StateBadge({ state }: { state: string | null }) {
  if (!state) return null;
  return (
    <span
      className={cn(
        'rounded-full border px-2.5 py-1 font-mono text-[10px] font-medium tracking-[0.08em]',
        STATE_BADGE[state] ?? 'border-violet/40 bg-violet/10 text-violet'
      )}
    >
      {state.replace(/_/g, ' ')}
    </span>
  );
}

function latestSpeakerphone(events: VerificationEventRow[]) {
  const rows = events.filter((e) => e.eventType === 'SPEAKERPHONE_SUSPECTED');
  const latest = rows[rows.length - 1];
  return {
    count: rows.length,
    score: latest?.details?.match(/score=([\d.]+)/)?.[1] ?? null,
    verdict:
      latest?.details?.match(/verdict=([A-Z][A-Z_ ]*?)(?:\s+relayState|\s+weighted|$)/)?.[1] ?? null,
  };
}

function mergeGuardStatus(events: VerificationEventRow[], state: string | null) {
  const types = new Set(events.map((e) => e.eventType));
  if (state === 'MERGE_DETECTED' || types.has('MERGE_STREAM_DETECTED')) {
    return { value: 'merge detected', hint: 'in-band tone leaked into the second call; call ended', tone: 'text-danger' };
  }
  if (state === 'BRIDGED' || state === 'COMPLETED' || types.has('GUARDED_BRIDGED')) {
    return { value: 'passed', hint: 'no merge-tone leak during the watch window', tone: 'text-signal' };
  }
  if (types.has('GUARDED_MERGE_WATCH_ARMED') || state === 'LEG_B_ANSWERED') {
    return { value: 'watching', hint: 'second call answered; listening for merge tone', tone: 'text-amber' };
  }
  return { value: 'pending', hint: 'starts after voice-ID and second-call answer', tone: 'text-text-hi' };
}

function MetricCard({
  label,
  value,
  hint,
  tone = 'text-text-hi',
}: {
  label: string;
  value: string;
  hint: string;
  tone?: string;
}) {
  return (
    <div className="rounded-[14px] border border-line bg-ink-900 p-4">
      <div className="label-caps mb-2">{label}</div>
      <div className={cn('font-mono text-xl font-semibold', tone)}>{value}</div>
      <div className="mt-1 text-xs text-text-low">{hint}</div>
    </div>
  );
}

function SessionLiveView({ sessionId }: { sessionId: string }) {
  const sessionQ = trpc.verification.get.useQuery(
    { sessionId },
    { refetchInterval: POLL_MS, retry: 1 }
  );
  const eventsQ = trpc.verification.events.useQuery(
    { sessionId },
    { refetchInterval: POLL_MS, retry: 1 }
  );

  const session = (sessionQ.data ?? null) as VerificationSessionRow | null;
  const events = useMemo(() => ((eventsQ.data ?? []) as VerificationEventRow[]), [eventsQ.data]);
  const sp = latestSpeakerphone(events);
  const voiceprintCaptured = events.some((e) => e.eventType === 'VOICEPRINT_CAPTURED');
  const voiceprintMissed = events.some((e) => e.eventType === 'VOICEPRINT_MISSED');
  const voiceMismatches = events.filter((e) => e.eventType === 'VOICE_MISMATCH').length;
  const mergeGuard = mergeGuardStatus(events, session?.state ?? null);

  const timelineRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <div className="space-y-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            to="/app"
            className="flex items-center gap-2 rounded-[10px] border border-line bg-ink-800 px-3 py-2 text-sm text-text-mid transition-colors hover:bg-ink-700 hover:text-text-hi"
          >
            <ArrowLeft className="h-4 w-4" />
            Softphone
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-display text-[24px] font-semibold tracking-tight text-text-hi">
                Live call analysis
              </h1>
              <StateBadge state={session?.state ?? null} />
            </div>
            <p className="mt-1 font-mono text-xs text-text-low">session {sessionId}</p>
          </div>
        </div>
        <Link
          to="/admin/verification"
          className="flex items-center gap-2 rounded-[10px] border border-violet/40 bg-violet/10 px-3 py-2 text-sm text-violet transition-colors hover:bg-violet/20"
        >
          <ShieldCheck className="h-4 w-4" />
          Admin verification
        </Link>
      </div>

      <div className="rounded-[14px] border border-signal/30 bg-signal/10 px-4 py-3 text-sm text-text-mid">
        Guarded inmate call: the callee hears the inmate-call warning and presses{' '}
        <span className="text-text-hi">1</span>, says{' '}
        <span className="text-text-hi">“my voice identifies me”</span>, then keeps the current call
        alive and accepts the second verification call. If the calls are merged, the in-band tone
        leaks into the second call and the session ends; if no merge is detected, the caller and
        callee bridge and live speakerphone/voice-match forensics continue.
      </div>

      {sessionQ.isLoading ? (
        <div className="flex items-center gap-2 rounded-[14px] border border-line bg-ink-900 p-6 text-sm text-text-low">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading session…
        </div>
      ) : sessionQ.isError ? (
        <div className="rounded-[14px] border border-danger/30 bg-danger/10 p-6 text-sm text-danger">
          Could not load this verification session. If auth is enabled, make sure you are signed in.
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <MetricCard
              label="Callee"
              value={session ? formatPhoneDisplay(session.calleeNumber) : '—'}
              hint={session?.callerNumber ? `caller ${formatPhoneDisplay(session.callerNumber)}` : 'browser softphone caller'}
            />
            <MetricCard
              label="Speakerphone"
              value={sp.score ? `score ${sp.score}` : 'no suspicion'}
              hint={sp.verdict ?? (sp.count > 0 ? 'suspected window logged' : 'detector runs every ~2s while bridged')}
              tone={sp.score ? 'text-amber' : 'text-text-hi'}
            />
            <MetricCard
              label="Challenge noise"
              value={`${sp.count}`}
              hint="callee-only injections; call never hangs up"
              tone={sp.count > 0 ? 'text-amber' : 'text-text-hi'}
            />
            <MetricCard
              label="Merge guard"
              value={mergeGuard.value}
              hint={mergeGuard.hint}
              tone={mergeGuard.tone}
            />
            <MetricCard
              label="Voiceprint"
              value={voiceprintCaptured ? 'captured' : voiceprintMissed ? 'missed' : 'awaiting phrase…'}
              hint={voiceMismatches > 0 ? `${voiceMismatches} voice-match alert${voiceMismatches === 1 ? '' : 's'}` : 'captured from the required voice-ID recording'}
              tone={voiceprintCaptured ? 'text-signal' : voiceprintMissed ? 'text-amber' : 'text-text-hi'}
            />
          </div>

          <section className="rounded-[14px] border border-line bg-ink-900">
            <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-violet" />
                <h2 className="font-display text-[15px] font-semibold text-text-hi">Event timeline</h2>
              </div>
              <span className="font-mono text-[11px] text-text-low">
                {eventsQ.isFetching ? 'refreshing…' : `${events.length} event${events.length === 1 ? '' : 's'}`}
              </span>
            </div>
            <div
              ref={timelineRef}
              className="max-h-[54vh] overflow-y-auto p-4 font-mono text-[11px] leading-[1.75]"
            >
              {events.length === 0 ? (
                <div className="rounded-[10px] border border-dashed border-line px-3 py-8 text-center text-text-low">
                  Waiting for engine events… this fills in live while the call runs.
                </div>
              ) : (
                events.map((e) => (
                  <div key={e.id} className="flex gap-2 border-b border-line/40 py-1 last:border-0">
                    <span className="shrink-0 text-text-low">
                      {new Date(e.timestamp).toLocaleTimeString('en-AU', { hour12: false })}
                    </span>
                    <span className="shrink-0 text-violet">{e.eventType}</span>
                    <span className="min-w-0 break-words text-text-mid">{e.details}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function RecentGuardedSessions() {
  const navigate = useNavigate();
  const listQ = trpc.verification.list.useQuery(undefined, { refetchInterval: 4000, retry: 1 });
  const sessions = useMemo(() => ((listQ.data ?? []) as VerificationSessionRow[]), [listQ.data]);
  const guarded = sessions.filter((s) => s.guarded);

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[24px] font-semibold tracking-tight text-text-hi">Live call analysis</h1>
          <p className="mt-1 text-sm text-text-low">Open a guarded session to watch its live analysis.</p>
        </div>
        <Link
          to="/app"
          className="flex items-center gap-2 rounded-[10px] border border-line bg-ink-800 px-3 py-2 text-sm text-text-mid transition-colors hover:bg-ink-700 hover:text-text-hi"
        >
          <ArrowLeft className="h-4 w-4" />
          Softphone
        </Link>
      </div>

      <section className="rounded-[14px] border border-line bg-ink-900">
        <div className="flex items-center gap-2 border-b border-line px-5 py-3.5">
          <Radar className="h-4 w-4 text-violet" />
          <h2 className="font-display text-[15px] font-semibold text-text-hi">Recent guarded sessions</h2>
        </div>
        {listQ.isLoading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-text-low">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading sessions…
          </div>
        ) : guarded.length === 0 ? (
          <div className="p-6 text-sm text-text-low">
            No guarded sessions yet. Start one from the softphone with “Guarded inmate call” enabled.
          </div>
        ) : (
          <ul className="divide-y divide-line/60">
            {guarded.map((s) => (
              <li key={s.sessionId}>
                <button
                  onClick={() => navigate(`/app/live-analysis/${s.sessionId}`)}
                  className="flex w-full items-center gap-4 px-5 py-3 text-left transition-colors hover:bg-ink-700"
                >
                  <StateBadge state={s.state} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-text-hi">
                      {formatPhoneDisplay(s.calleeNumber)}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-text-low">
                      {s.sessionId.slice(0, 8)} · {new Date(s.createdAt).toLocaleString('en-AU')}
                      {s.failureReason ? ` — ${s.failureReason}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function LiveAnalysis() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  return (
    <AppShell variant="agent" title="Live Analysis">
      {sessionId ? <SessionLiveView sessionId={sessionId} /> : <RecentGuardedSessions />}
    </AppShell>
  );
}
