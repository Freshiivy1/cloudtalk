import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router';
import { AudioWaveform, BellRing, Mic, Plug, Settings2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import StatusPill from '@/components/StatusPill';
import type { FeedEvent } from './adminTypes';
import { EASE } from './adminTypes';
import EventTicker from './EventTicker';

/**
 * Live Analysis dock — the registered plug-in surface for the user's future
 * live call-analysis modules. Each slot is a registered component keyed
 * `analysis.sentiment | .transcription | .alerts`; swapping in a real module
 * replaces a slot's placeholder without touching layout, routing, or the
 * telephony provider. The tickers are fed by the REAL call-event stream —
 * the exact stream real analysis will consume.
 */
interface AnalysisModuleSlot {
  key: 'analysis.sentiment' | 'analysis.transcription' | 'analysis.alerts';
  title: string;
  icon: LucideIcon;
  placeholder: string;
}

const ANALYSIS_MODULES: AnalysisModuleSlot[] = [
  {
    key: 'analysis.sentiment',
    title: 'Sentiment stream',
    icon: AudioWaveform,
    placeholder: 'Live sentiment module — awaiting integration',
  },
  {
    key: 'analysis.transcription',
    title: 'Transcription',
    icon: Mic,
    placeholder: 'Live transcription module — awaiting integration',
  },
  {
    key: 'analysis.alerts',
    title: 'Keyword & compliance alerts',
    icon: BellRing,
    placeholder: 'Alert rules module — awaiting integration',
  },
];

export interface AnalysisDockProps {
  /** the real admin.dashboard.eventFeed stream */
  events: FeedEvent[];
  /** call currently inspected in the detail drawer (scopes transcription) */
  focusCallId: number | null;
}

/** Dashed violet slot card with the slow ambient shimmer (4s, 20% opacity swing). */
function ModuleSlot({ slot, children }: { slot: AnalysisModuleSlot; children?: ReactNode }) {
  const Icon = slot.icon;
  return (
    <motion.div
      animate={{
        borderColor: [
          'rgba(155,140,255,0.18)',
          'rgba(155,140,255,0.38)',
          'rgba(155,140,255,0.18)',
        ],
      }}
      transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
      style={{ borderWidth: 1, borderStyle: 'dashed' }}
      className="rounded-[14px] bg-ink-900 p-3"
    >
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] border border-violet/30 bg-violet/10">
          <Icon className="h-3.5 w-3.5 text-violet" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-hi">{slot.title}</div>
          <div className="truncate font-mono text-[10px] text-text-low">{slot.key}</div>
        </div>
      </div>
      <p className="mt-2 text-xs text-text-mid">{slot.placeholder}</p>
      {children}
    </motion.div>
  );
}

export default function AnalysisDock({ events, focusCallId }: AnalysisDockProps) {
  const [sentiment, transcription, alerts] = ANALYSIS_MODULES;

  // Transcription ticker is scoped to the inspected call (else the busiest one in the feed).
  const scopedId = focusCallId ?? events[0]?.callId ?? null;
  const scopedEvents = scopedId == null ? [] : events.filter((e) => e.callId === scopedId);

  return (
    <motion.section
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.5, delay: 0.3, ease: EASE }}
      className="rounded-[14px] border border-violet/30 bg-ink-900/80 p-4 backdrop-blur-md"
      style={{ boxShadow: 'inset 0 1px 0 0 rgba(234,241,251,0.05)' }}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="label-caps !text-violet">Analysis</div>
          <h2 className="mt-0.5 font-display text-lg font-semibold leading-6 tracking-tight text-text-hi">
            Live Analysis
          </h2>
        </div>
        <StatusPill variant="live" label="live" />
        <Link
          to="/admin/settings"
          title="Settings → Integrations"
          className="rounded-[10px] p-1.5 text-text-mid transition-colors hover:bg-ink-700 hover:text-violet"
        >
          <Settings2 className="h-4 w-4" />
        </Link>
      </div>

      {/* Module slots */}
      <div className="mt-3 space-y-3">
        <ModuleSlot slot={sentiment!}>
          <EventTicker events={events} className="mt-2" />
        </ModuleSlot>

        <ModuleSlot slot={transcription!}>
          <EventTicker events={scopedEvents} rows={6} className="mt-2" />
          <div className="mt-1.5 truncate font-mono text-[10px] text-text-low">
            {scopedId == null
              ? 'no call in stream to scope'
              : focusCallId != null
                ? `scoped to c-${scopedId} (inspected call)`
                : `scoped to c-${scopedId} (latest in stream)`}
          </div>
        </ModuleSlot>

        <ModuleSlot slot={alerts!}>
          <div className="mt-2 flex items-center justify-between rounded-[10px] bg-ink-950/60 px-2 py-1.5">
            <span className="font-mono text-[11px] text-text-low">0 rules configured</span>
            <span className="font-mono text-[10px] text-violet/70">analysis.alerts</span>
          </div>
        </ModuleSlot>
      </div>

      {/* Footer CTA → integration surface */}
      <Link
        to="/admin/settings"
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-[10px] border border-violet/40 px-3 py-2 text-sm font-medium text-violet transition-colors duration-150 hover:bg-violet/10"
      >
        <Plug className="h-4 w-4" />
        Connect analysis module
      </Link>
    </motion.section>
  );
}
