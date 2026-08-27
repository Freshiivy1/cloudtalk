import { cn } from '@/lib/utils';

export type StatusPillVariant =
  | 'active'
  | 'ringing'
  | 'held'
  | 'missed'
  | 'completed'
  | 'available'
  | 'busy'
  | 'away'
  | 'offline'
  | 'live';

const VARIANT_STYLES: Record<StatusPillVariant, { dot: string; text: string; bg: string; pulse?: boolean }> = {
  active: { dot: 'bg-signal', text: 'text-signal', bg: 'bg-signal/10 border-signal/30' },
  ringing: { dot: 'bg-amber', text: 'text-amber', bg: 'bg-amber/10 border-amber/30', pulse: true },
  held: { dot: 'bg-amber', text: 'text-amber', bg: 'bg-amber/10 border-amber/30' },
  missed: { dot: 'bg-danger', text: 'text-danger', bg: 'bg-danger/10 border-danger/30' },
  completed: { dot: 'bg-text-low', text: 'text-text-mid', bg: 'bg-ink-700 border-line' },
  available: { dot: 'bg-signal', text: 'text-signal', bg: 'bg-signal/10 border-signal/30' },
  busy: { dot: 'bg-danger', text: 'text-danger', bg: 'bg-danger/10 border-danger/30' },
  away: { dot: 'bg-amber', text: 'text-amber', bg: 'bg-amber/10 border-amber/30' },
  offline: { dot: 'bg-text-low', text: 'text-text-mid', bg: 'bg-ink-700 border-line' },
  live: { dot: 'bg-violet', text: 'text-violet', bg: 'bg-violet/10 border-violet/30', pulse: true },
};

export interface StatusPillProps {
  variant: StatusPillVariant;
  label?: string;
  className?: string;
}

/** Pill with a 10px dot + label. `ringing` and `live` dots pulse. */
export default function StatusPill({ variant, label, className }: StatusPillProps) {
  const s = VARIANT_STYLES[variant];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        s.bg,
        s.text,
        className
      )}
    >
      <span className={cn('h-2.5 w-2.5 rounded-full', s.dot, s.pulse && 'animate-pulse')} />
      {label ?? variant}
    </span>
  );
}
