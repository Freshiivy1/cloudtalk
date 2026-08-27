import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { format } from 'date-fns';
import { ArrowRight, AudioWaveform } from 'lucide-react';
import Drawer from '@/components/Drawer';
import CallAvatar from '@/components/CallAvatar';
import type { CallAvatarState } from '@/components/CallAvatar';
import WaveformRibbon from '@/components/WaveformRibbon';
import { formatCallDuration } from '@/lib/telephony';
import { cn } from '@/lib/utils';
import type { ActiveCallRow, FeedEvent } from './adminTypes';
import { EASE } from './adminTypes';

export interface CallDetailDrawerProps {
  /** snapshot of the inspected call (kept after it leaves the live list) */
  row: ActiveCallRow | null;
  open: boolean;
  /** full live event stream — timeline filters to this call */
  events: FeedEvent[];
  now: number;
  paused: boolean;
  onClose: () => void;
}

const EVENT_META: Record<string, { label: string; dot: string }> = {
  incoming_call: { label: 'Incoming call', dot: 'bg-sky' },
  call_ringing: { label: 'Ringing', dot: 'bg-amber' },
  call_active: { label: 'Answered', dot: 'bg-signal' },
  call_held: { label: 'Held', dot: 'bg-amber' },
  call_resumed: { label: 'Resumed', dot: 'bg-signal' },
  call_ended: { label: 'Ended', dot: 'bg-danger' },
};

const AVATAR_STATE: Record<string, CallAvatarState> = {
  dialing: 'ringing',
  ringing: 'ringing',
  active: 'active',
  held: 'held',
};

/** Per-call sheet: parties, live timer, full waveform, live event timeline, metadata, analysis slot. */
export default function CallDetailDrawer({ row, open, events, now, paused, onClose }: CallDetailDrawerProps) {
  // ESC closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const call = row?.call ?? null;
  const timeline = call ? events.filter((e) => e.callId === call.id) : [];

  const anchor = call ? (call.answeredAt ?? call.startedAt) : null;
  const durSec = anchor ? Math.max(0, Math.floor((now - new Date(anchor).getTime()) / 1000)) : 0;

  const isActive = call?.status === 'active';
  const isHeld = call?.status === 'held';
  const timerTone = durSec < 300 ? 'text-signal' : durSec > 600 ? 'text-amber' : 'text-text-hi';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={call ? `Call · ${call.contactName ?? call.fromNumber}` : 'Call details'}
    >
      {row && call && (
        <div className="space-y-5">
          {/* Parties */}
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <CallAvatar
                name={call.contactName ?? call.fromNumber}
                size={40}
                state={AVATAR_STATE[call.status] ?? 'idle'}
                ringTint={call.direction === 'inbound' ? 'sky' : 'amber'}
              />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-text-hi">
                  {call.contactName ?? call.fromNumber}
                </div>
                <div className="truncate font-mono text-[11px] text-text-low">
                  {call.direction === 'inbound' ? call.fromNumber : call.toNumber}
                </div>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-text-low" />
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <CallAvatar
                name={row.agentName ?? 'Unassigned'}
                size={40}
                state={AVATAR_STATE[call.status] ?? 'idle'}
              />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-text-hi">
                  {row.agentName ?? 'Unassigned'}
                </div>
                <div className="truncate font-mono text-[11px] text-text-low">
                  {row.extensionNumber ? `Ext ${row.extensionNumber}` : 'No extension'}
                </div>
              </div>
            </div>
          </div>

          {/* Live timer + full waveform */}
          <div className="rounded-[14px] border border-line bg-ink-800 p-4">
            <div className={cn('text-center font-mono text-[32px] font-medium leading-10 tabular-nums', timerTone)}>
              {formatCallDuration(durSec)}
            </div>
            <div className="mt-2">
              <WaveformRibbon
                height={64}
                active={isActive && !paused}
                held={isHeld || paused}
                muted={call.muted}
                tint={paused && !isHeld ? 'signal' : undefined}
              />
            </div>
          </div>

          {/* Live timeline of call events so far */}
          <div>
            <div className="label-caps mb-2">Timeline</div>
            <div className="space-y-1.5">
              {timeline.length === 0 ? (
                <div className="font-mono text-[11px] text-text-low">— no events yet</div>
              ) : (
                <AnimatePresence initial={false}>
                  {timeline.map((e) => {
                    const meta = EVENT_META[e.type] ?? { label: e.type, dot: 'bg-text-low' };
                    return (
                      <motion.div
                        key={e.id}
                        layout="position"
                        initial={{ opacity: 0, x: 8 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.25, ease: EASE }}
                        className="flex items-center gap-2.5"
                      >
                        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', meta.dot)} />
                        <span className="flex-1 text-xs text-text-mid">{meta.label}</span>
                        <span className="font-mono text-[11px] text-text-low">
                          {format(new Date(e.createdAt), 'HH:mm:ss')}
                        </span>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              )}
            </div>
          </div>

          {/* Metadata grid */}
          <div>
            <div className="label-caps mb-2">Metadata</div>
            <div className="grid grid-cols-2 gap-2">
              {[
                ['Call ID', `c-${call.id}`],
                ['Codec', 'Opus · simulated'],
                ['MOS score', '4.3'],
                ['Trunk', 'sip-gw-02'],
              ].map(([k, v]) => (
                <div key={k} className="rounded-[10px] border border-line bg-ink-800 px-3 py-2">
                  <div className="text-[11px] text-text-low">{k}</div>
                  <div className="mt-0.5 truncate font-mono text-xs text-text-hi">{v}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Per-call analysis module slot (mirrors the dock) */}
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
                <AudioWaveform className="h-3.5 w-3.5 text-violet" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-hi">Analysis</div>
                <div className="font-mono text-[10px] text-text-low">slot: analysis.perCall</div>
              </div>
            </div>
            <p className="mt-2 text-xs text-text-mid">
              Per-call analysis module will render here.
            </p>
          </motion.div>
        </div>
      )}
    </Drawer>
  );
}
