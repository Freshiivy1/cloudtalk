import { memo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowDownLeft, ArrowUpRight, Ear, Info } from 'lucide-react';
import CallAvatar from '@/components/CallAvatar';
import type { CallAvatarState } from '@/components/CallAvatar';
import StatusPill from '@/components/StatusPill';
import type { StatusPillVariant } from '@/components/StatusPill';
import WaveformRibbon from '@/components/WaveformRibbon';
import { formatCallDuration } from '@/lib/telephony';
import { cn } from '@/lib/utils';
import type { ActiveCallRow } from './adminTypes';
import { EASE } from './adminTypes';

export interface LiveCallCardProps {
  row: ActiveCallRow;
  /** snapshot clock — frozen while the stream is paused */
  now: number;
  paused: boolean;
  onDetails: (row: ActiveCallRow) => void;
}

const PILL: Record<string, { variant: StatusPillVariant; label: string }> = {
  dialing: { variant: 'ringing', label: 'Dialing' },
  ringing: { variant: 'ringing', label: 'Ringing' },
  active: { variant: 'active', label: 'Active' },
  held: { variant: 'held', label: 'Held' },
};

const AVATAR_STATE: Record<string, CallAvatarState> = {
  dialing: 'ringing',
  ringing: 'ringing',
  active: 'active',
  held: 'held',
};

/** Animated dotted "audio path" connector between the two parties (SVG SMIL dash march). */
function AudioPath({ tone, running }: { tone: string; running: boolean }) {
  return (
    <svg className="h-[3px] min-w-6 flex-1" preserveAspectRatio="none" viewBox="0 0 100 3" aria-hidden>
      <line
        x1="2"
        y1="1.5"
        x2="98"
        y2="1.5"
        stroke={tone}
        strokeWidth="2"
        strokeDasharray="3 5"
        strokeLinecap="round"
        opacity="0.7"
      >
        {running && (
          <animate attributeName="stroke-dashoffset" from="8" to="0" dur="1s" repeatCount="indefinite" />
        )}
      </line>
    </svg>
  );
}

/**
 * One live instrument card in the Active Calls monitor.
 * Arrives with a green flash + scale-in; departs desaturating and collapsing.
 */
function LiveCallCardInner({ row, now, paused, onDetails }: LiveCallCardProps) {
  const [hovered, setHovered] = useState(false);
  const { call } = row;
  const status = PILL[call.status] ?? PILL.ringing!;
  const avatarState = AVATAR_STATE[call.status] ?? 'ringing';
  const isActive = call.status === 'active';
  const isHeld = call.status === 'held';
  const inbound = call.direction === 'inbound';

  const callerName = call.contactName ?? call.fromNumber;
  const callerNumber = call.contactName ? call.fromNumber : null;
  const agentName = row.agentName ?? 'Unassigned';
  const ext = row.extensionNumber ? `Ext ${row.extensionNumber}` : 'No ext';

  const anchor = call.answeredAt ?? call.startedAt;
  const durSec = Math.max(0, Math.floor((now - new Date(anchor).getTime()) / 1000));
  const timerTone = durSec < 300 ? 'text-signal' : durSec > 600 ? 'text-amber' : 'text-text-hi';

  const borderTone = isActive
    ? 'border-signal/40'
    : isHeld
      ? 'border-amber/40'
      : 'border-amber/30';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.9, boxShadow: '0 0 32px rgba(46,230,168,0.5)' }}
      animate={{
        opacity: 1,
        scale: 1,
        boxShadow:
          isActive && !paused
            ? [
                '0 0 10px rgba(46,230,168,0.18)',
                '0 0 24px rgba(46,230,168,0.35)',
                '0 0 10px rgba(46,230,168,0.18)',
              ]
            : '0 0 0px rgba(46,230,168,0)',
      }}
      exit={{
        opacity: 0,
        scale: 0.92,
        height: 0,
        filter: 'saturate(0.15)',
        transition: { duration: 0.5, ease: EASE },
      }}
      transition={{
        duration: 0.4,
        ease: EASE,
        boxShadow: { duration: 3, repeat: Infinity, ease: 'easeInOut' },
        layout: { duration: 0.35, ease: EASE },
      }}
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => setHovered(false)}
      onClick={() => onDetails(row)}
      className={cn(
        'group cursor-pointer overflow-hidden rounded-[14px] border bg-ink-800 p-3 transition-colors duration-150',
        borderTone,
        'hover:border-signal/60'
      )}
    >
      {/* Top row — caller → agent audio path */}
      <div className="flex items-center gap-2">
        <CallAvatar
          name={callerName}
          size={40}
          state={avatarState}
          ringTint={inbound ? 'sky' : 'amber'}
        />
        <AudioPath
          tone={isHeld || paused ? '#FFB224' : '#2EE6A8'}
          running={!paused}
        />
        <CallAvatar
          name={agentName}
          size={40}
          state={avatarState}
          ringTint={inbound ? 'sky' : 'amber'}
        />
        <span className="ml-1 flex items-center gap-1 whitespace-nowrap font-mono text-[11px] text-text-low">
          {inbound ? (
            <ArrowDownLeft className="h-3 w-3 text-sky" />
          ) : (
            <ArrowUpRight className="h-3 w-3 text-amber" />
          )}
          {inbound ? 'Inbound' : 'Outbound'} → {ext}
        </span>
      </div>

      {/* Middle — parties + status */}
      <div className="mt-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text-hi">{callerName}</div>
          <div className="truncate font-mono text-xs text-text-low">
            {callerNumber ?? agentName}
          </div>
        </div>
        <StatusPill variant={status.variant} label={status.label} />
      </div>

      {/* Live waveform strip — frozen amber when held / snapshot-frozen when paused */}
      <div className="mt-2">
        <WaveformRibbon
          height={36}
          active={isActive && !paused}
          held={isHeld || paused}
          muted={call.muted}
          tint={paused && !isHeld ? 'signal' : undefined}
          amplitude={hovered ? 1.1 : 1}
        />
      </div>

      {/* Bottom row — ticking timer + hover actions */}
      <div className="mt-2 flex items-center justify-between">
        <span className={cn('font-mono text-[15px] font-medium tabular-nums', timerTone)}>
          {formatCallDuration(durSec)}
        </span>
        <div className="flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <button
            disabled
            title="Live monitoring — coming with telephony provider"
            onClick={(e) => e.stopPropagation()}
            className="cursor-not-allowed rounded-[10px] p-1.5 text-violet/50"
          >
            <Ear className="h-4 w-4" />
          </button>
          <button
            title="Call details"
            onClick={(e) => {
              e.stopPropagation();
              onDetails(row);
            }}
            className="rounded-[10px] p-1.5 text-text-mid transition-colors hover:bg-ink-700 hover:text-text-hi"
          >
            <Info className="h-4 w-4" />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

const LiveCallCard = memo(LiveCallCardInner);
export default LiveCallCard;
