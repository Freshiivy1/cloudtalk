import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------------- */
/* Shared building blocks for the admin management pages (agents / logs /    */
/* settings). Colors come straight from the CloudTalk console palette.        */
/* ------------------------------------------------------------------------- */

export const EASE = [0.22, 1, 0.36, 1] as [number, number, number, number];

/** Frosted instrument card used to group form sections. */
export function AdminCard({
  title,
  caption,
  children,
  className,
  accent = 'signal',
}: {
  title: string;
  caption?: string;
  children: ReactNode;
  className?: string;
  accent?: 'signal' | 'violet';
}) {
  return (
    <div
      className={cn(
        'rounded-[14px] border bg-ink-800 p-5',
        accent === 'violet' ? 'border-violet/30' : 'border-line',
        className
      )}
    >
      <div className="mb-4">
        <h3 className="font-display text-[15px] font-semibold leading-5 text-text-hi">{title}</h3>
        {caption && <p className="mt-1 text-xs leading-4 text-text-low">{caption}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

/** Label + control row used inside cards. */
export function FieldRow({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      <div className="min-w-0">
        <div className="text-sm font-medium text-text-hi">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-4 text-text-low">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Console-styled toggle switch (120ms knob snap). */
export function ConsoleSwitch({
  checked,
  onChange,
  disabled,
  tint = 'signal',
  title,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  tint?: 'signal' | 'violet' | 'amber';
  title?: string;
}) {
  const onBg =
    tint === 'violet' ? 'bg-violet/25 border-violet/60' : tint === 'amber' ? 'bg-amber/25 border-amber/60' : 'bg-signal-dim border-signal/60';
  const knob = tint === 'violet' ? 'bg-violet' : tint === 'amber' ? 'bg-amber' : 'bg-signal';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={() => onChange?.(!checked)}
      className={cn(
        'relative h-6 w-11 rounded-full border transition-colors duration-150',
        checked ? onBg : 'border-line bg-ink-700',
        disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'
      )}
    >
      <motion.span
        animate={{ x: checked ? 20 : 0 }}
        transition={{ type: 'spring', stiffness: 700, damping: 32 }}
        className={cn('absolute left-0.5 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full', checked ? knob : 'bg-text-low')}
      />
    </button>
  );
}

/** Console-styled native select. */
export function ConsoleSelect({
  value,
  onChange,
  options,
  disabled,
  className,
  width,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  disabled?: boolean;
  className?: string;
  width?: number;
}) {
  return (
    <div className={cn('relative', className)} style={width ? { width } : undefined}>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'w-full appearance-none rounded-[10px] border border-line bg-ink-700 py-2 pl-3 pr-8 text-sm text-text-hi outline-none transition-colors',
          disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer hover:border-signal/40 focus:border-signal/60'
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled} className="bg-ink-800">
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-low" />
    </div>
  );
}

/** Console-styled text input. */
export function ConsoleInput({
  value,
  onChange,
  placeholder,
  mono,
  invalid,
  type = 'text',
  className,
  disabled,
  onBlur,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  invalid?: boolean;
  type?: string;
  className?: string;
  disabled?: boolean;
  onBlur?: () => void;
}) {
  return (
    <input
      type={type}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onBlur={onBlur}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'w-full rounded-[10px] border bg-ink-700 px-3 py-2 text-sm text-text-hi outline-none transition-colors placeholder:text-text-low',
        mono && 'font-mono text-[13px]',
        invalid ? 'border-danger/70' : 'border-line focus:border-signal/60',
        disabled && 'cursor-not-allowed opacity-45',
        className
      )}
    />
  );
}

/** Number stepper (1–50 style ranges), mono value. */
export function Stepper({
  value,
  onChange,
  min = 0,
  max = 99,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div className="flex items-center gap-1 rounded-[10px] border border-line bg-ink-700 p-1">
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        className="rounded-md p-1 text-text-mid transition-colors hover:bg-ink-800 hover:text-text-hi"
        title="Decrease"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="w-10 text-center font-mono text-[13px] text-text-hi">{value}</span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        className="rounded-md p-1 text-text-mid transition-colors hover:bg-ink-800 hover:text-text-hi"
        title="Increase"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** Primary green button. */
export function PrimaryButton({
  children,
  onClick,
  disabled,
  className,
  tint = 'signal',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  tint?: 'signal' | 'violet' | 'danger';
  title?: string;
}) {
  const styles =
    tint === 'violet'
      ? 'bg-violet/15 text-violet border-violet/50 hover:bg-violet/25'
      : tint === 'danger'
        ? 'bg-danger/15 text-danger border-danger/50 hover:bg-danger/25'
        : 'bg-signal/15 text-signal border-signal/50 hover:bg-signal/25';
  return (
    <motion.button
      whileHover={{ scale: disabled ? 1 : 1.02 }}
      whileTap={{ scale: disabled ? 1 : 0.97 }}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-[10px] border px-3.5 py-2 text-sm font-medium transition-colors duration-150',
        styles,
        disabled && 'cursor-not-allowed opacity-50',
        className
      )}
    >
      {children}
    </motion.button>
  );
}

/** Secondary / ghost button. */
export function GhostButton({
  children,
  onClick,
  disabled,
  className,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <motion.button
      whileHover={{ scale: disabled ? 1 : 1.02 }}
      whileTap={{ scale: disabled ? 1 : 0.97 }}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-[10px] border border-line bg-ink-700 px-3.5 py-2 text-sm font-medium text-text-mid transition-colors duration-150 hover:border-signal/40 hover:text-text-hi',
        disabled && 'cursor-not-allowed opacity-50',
        className
      )}
    >
      {children}
    </motion.button>
  );
}

/** Section eyebrow label. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('label-caps', className)}>{children}</div>;
}

/** Format seconds → m:ss mono-safe. */
export function fmtDuration(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
