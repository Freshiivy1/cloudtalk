import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

export type CallAvatarState = 'idle' | 'ringing' | 'active' | 'held' | 'offline';

export interface CallAvatarProps {
  name: string;
  /** 40 | 56 | 88 */
  size?: number;
  state?: CallAvatarState;
  /** ring tint while ringing: amber = outbound, sky = inbound */
  ringTint?: 'amber' | 'sky';
  className?: string;
}

/* Deterministic muted hue from a name → initials avatar background. */
const AVATAR_HUES = [160, 199, 262, 32, 350, 210, 280, 145];

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function CallAvatar({
  name,
  size = 56,
  state = 'idle',
  ringTint = 'amber',
  className,
}: CallAvatarProps) {
  const hue = AVATAR_HUES[hashName(name) % AVATAR_HUES.length];
  const tintClass = ringTint === 'sky' ? 'border-sky' : 'border-amber';
  const tintBg = ringTint === 'sky' ? 'bg-sky' : 'bg-amber';

  return (
    <div className={cn('relative inline-flex items-center justify-center', className)} style={{ width: size, height: size }}>
      {/* Ringing pulse rings — 3 concentric, scale 1→1.6, 1.6s loop, staggered */}
      {state === 'ringing' &&
        [0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className={cn('pointer-events-none absolute inset-0 rounded-full border-2', tintClass)}
            animate={{ scale: [1, 1.6], opacity: [0.6, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, delay: i * 0.33, ease: 'easeOut' }}
          />
        ))}

      <div
        className={cn(
          'flex items-center justify-center rounded-full font-display font-semibold',
          state === 'active' && 'ring-2 ring-signal shadow-glow-signal',
          state === 'held' && 'border-2 border-dashed border-amber',
          state === 'offline' && 'opacity-50 grayscale',
          state === 'ringing' && cn('ring-2', ringTint === 'sky' ? 'ring-sky' : 'ring-amber')
        )}
        style={{
          width: size,
          height: size,
          fontSize: size * 0.36,
          color: `hsl(${hue} 45% 72%)`,
          background: `linear-gradient(160deg, hsl(${hue} 35% 22%), hsl(${hue} 40% 12%))`,
        }}
      >
        {initials(name)}
      </div>

      {/* held: steady amber badge dot */}
      {state === 'held' && (
        <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-ink-900 bg-amber" />
      )}
      {/* ringing: tint dot */}
      {state === 'ringing' && (
        <span className={cn('absolute -bottom-0.5 -right-0.5 h-3 w-3 animate-pulse rounded-full border-2 border-ink-900', tintBg)} />
      )}
    </div>
  );
}
