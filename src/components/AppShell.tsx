import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { motion } from 'framer-motion';
import {
  Phone,
  Users,
  History,
  LayoutDashboard,
  ListOrdered,
  Settings,
  Bell,
  Search,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
  Activity,
  ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PresenceStatus } from '@/lib/telephony';
import { useAuth } from '@/hooks/useAuth';
import { LOGIN_PATH } from '@/const';

// ---------------------------------------------------------------------------
// Nav configurations (page agents import these to stay in sync)
// ---------------------------------------------------------------------------

export interface ShellNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** renders the animated live dot next to the label */
  liveDot?: boolean;
  end?: boolean;
}

export const AGENT_NAV: ShellNavItem[] = [
  { to: '/app', label: 'Softphone', icon: Phone, end: true },
  { to: '/app/contacts', label: 'Contacts', icon: Users },
  { to: '/app/history', label: 'Call History', icon: History },
];

export const ADMIN_NAV: ShellNavItem[] = [
  { to: '/admin', label: 'Overview', icon: LayoutDashboard, liveDot: true, end: true },
  { to: '/admin/verification', label: 'Verification', icon: ShieldCheck },
  { to: '/admin/agents', label: 'Agents & Extensions', icon: Users },
  { to: '/admin/logs', label: 'Call Logs', icon: ListOrdered },
  { to: '/admin/settings', label: 'Settings', icon: Settings },
];

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

export const PRESENCE_OPTIONS: Array<{ value: PresenceStatus; label: string; dot: string }> = [
  { value: 'available', label: 'Available', dot: 'bg-signal' },
  { value: 'away', label: 'Away', dot: 'bg-amber' },
  { value: 'dnd', label: 'Do Not Disturb', dot: 'bg-danger' },
  { value: 'offline', label: 'Offline', dot: 'bg-text-low' },
];

export function presenceDotClass(p: PresenceStatus): string {
  return PRESENCE_OPTIONS.find((o) => o.value === p)?.dot ?? 'bg-text-low';
}

export function presenceLabel(p: PresenceStatus): string {
  return PRESENCE_OPTIONS.find((o) => o.value === p)?.label ?? 'Offline';
}

// ---------------------------------------------------------------------------
// AppShell
// ---------------------------------------------------------------------------

export interface AppShellProps {
  variant: 'agent' | 'admin';
  /** page title shown in the top bar */
  title: string;
  children: ReactNode;
  /** controlled presence (agent shell); falls back to internal state */
  presence?: PresenceStatus;
  onPresenceChange?: (p: PresenceStatus) => void;
}

export default function AppShell({ variant, title, children, presence, onPresenceChange }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { user, isLoading, logout } = useAuth();
  const [internalPresence, setInternalPresence] = useState<PresenceStatus>('available');
  const [presenceOpen, setPresenceOpen] = useState(false);
  const location = useLocation();

  const nav = variant === 'admin' ? ADMIN_NAV : AGENT_NAV;
  const currentPresence = presence ?? internalPresence;

  const handlePresence = (p: PresenceStatus) => {
    setPresenceOpen(false);
    if (onPresenceChange) onPresenceChange(p);
    else setInternalPresence(p);
  };

  return (
    <div className="flex min-h-[100dvh] bg-ink-950 text-text-hi">
      {/* ---------------- Sidebar ---------------- */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex flex-col border-r border-line bg-ink-900 transition-[width] duration-300',
          collapsed ? 'w-16' : 'w-[232px]'
        )}
      >
        {/* Wordmark */}
        <div className={cn('flex h-14 items-center border-b border-line', collapsed ? 'justify-center px-2' : 'justify-between px-4')}>
          <Link to={variant === 'admin' ? '/admin' : '/app'} className="flex items-center gap-2 overflow-hidden">
            {collapsed ? (
              <img src="/logo.svg" alt="CloudTalk" className="h-8 w-8 object-cover object-left" />
            ) : (
              <img src="/logo.svg" alt="CloudTalk" className="h-8 w-auto" />
            )}
          </Link>
          {variant === 'admin' && !collapsed && (
            <span className="rounded-full border border-violet/40 bg-violet/10 px-2 py-0.5 font-mono text-[10px] font-medium tracking-[0.08em] text-violet">
              ADMIN
            </span>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) =>
                cn(
                  'group relative flex items-center gap-3 rounded-[10px] px-3 py-2 text-sm font-medium transition-colors duration-150',
                  collapsed && 'justify-center px-0',
                  isActive
                    ? 'bg-signal-dim/40 text-text-hi'
                    : 'text-text-mid hover:bg-ink-700 hover:text-text-hi'
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={cn(
                      'absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-signal transition-opacity',
                      isActive ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <item.icon className={cn('h-[18px] w-[18px] shrink-0', isActive ? 'text-signal' : 'text-text-low group-hover:text-text-mid')} />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                  {!collapsed && item.liveDot && (
                    <span className="ml-auto h-2 w-2 rounded-full bg-signal animate-live-dot" />
                  )}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Presence card (agent) / System status (admin) */}
        {!collapsed && (
          <div className="mx-3 mb-3">
            {variant === 'agent' ? (
              <div className="rounded-[14px] border border-line bg-ink-800 p-3">
                <div className="label-caps mb-2">Presence</div>
                <button
                  onClick={() => setPresenceOpen((v) => !v)}
                  className="flex w-full items-center gap-2 rounded-[10px] border border-line bg-ink-700 px-3 py-2 text-sm text-text-hi transition-colors hover:border-signal/50"
                >
                  <span className={cn('h-2 w-2 rounded-full', presenceDotClass(currentPresence))} />
                  <span className="flex-1 text-left">{presenceLabel(currentPresence)}</span>
                  <ChevronDown className={cn('h-3.5 w-3.5 text-text-low transition-transform', presenceOpen && 'rotate-180')} />
                </button>
                {presenceOpen && (
                  <div className="mt-1 overflow-hidden rounded-[10px] border border-line bg-ink-700">
                    {PRESENCE_OPTIONS.map((o) => (
                      <button
                        key={o.value}
                        onClick={() => handlePresence(o.value)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text-mid transition-colors hover:bg-ink-800 hover:text-text-hi"
                      >
                        <span className={cn('h-2 w-2 rounded-full', o.dot)} />
                        {o.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-[14px] border border-line bg-ink-800 p-3">
                <div className="label-caps mb-2">System Status</div>
                <div className="flex items-center gap-2 text-sm text-text-hi">
                  <Activity className="h-4 w-4 text-signal" />
                  <span>All trunks operational</span>
                </div>
                <div className="mt-1 font-mono text-[11px] text-text-low">sip-gw-02 · 23ms</div>
              </div>
            )}
          </div>
        )}

        {/* User block — wired to useAuth() */}
        <div className={cn('flex items-center gap-3 border-t border-line p-3', collapsed && 'justify-center')}>
          {isLoading ? (
            <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-ink-700" />
          ) : !user ? (
            <Link
              to={LOGIN_PATH}
              className="flex w-full items-center justify-center gap-2 rounded-[10px] border border-line bg-ink-700 px-3 py-2 text-sm text-text-hi transition-colors hover:border-signal/50"
            >
              Sign in
            </Link>
          ) : (
            <>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-signal-dim font-display text-xs font-semibold text-signal">
                {(user.name ?? 'U')
                  .split(' ')
                  .map((p) => p[0])
                  .slice(0, 2)
                  .join('')
                  .toUpperCase()}
              </div>
              {!collapsed && (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-text-hi">{user.name ?? 'User'}</div>
                    <div
                      className={cn(
                        'mt-0.5 inline-flex rounded-full px-1.5 py-px font-mono text-[10px] tracking-[0.06em]',
                        user.role === 'admin' ? 'bg-violet/10 text-violet' : 'bg-signal/10 text-signal'
                      )}
                    >
                      {user.role === 'admin' ? 'admin' : 'agent'}
                    </div>
                  </div>
                  <button
                    onClick={() => logout()}
                    title="Sign out"
                    className="rounded-[10px] p-2 text-text-low transition-colors hover:bg-ink-700 hover:text-danger"
                  >
                    <LogOut className="h-4 w-4" />
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </aside>

      {/* ---------------- Main column ---------------- */}
      <div
        className={cn(
          'flex min-h-[100dvh] flex-1 flex-col transition-[padding] duration-300',
          collapsed ? 'pl-16' : 'pl-[232px]'
        )}
      >
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-line bg-ink-900/80 px-6 backdrop-blur-md">
          <h1 className="font-display text-lg font-semibold tracking-tight text-text-hi">{title}</h1>

          <div className="ml-4 hidden max-w-sm flex-1 md:block">
            <div className="flex items-center gap-2 rounded-[10px] border border-line bg-ink-800 px-3 py-1.5 text-sm text-text-low transition-colors focus-within:border-signal/50">
              <Search className="h-4 w-4" />
              <input
                placeholder="Search contacts, calls, agents…"
                className="w-full bg-transparent text-text-hi outline-none placeholder:text-text-low"
              />
              <kbd className="rounded border border-line bg-ink-700 px-1.5 py-0.5 font-mono text-[10px] text-text-low">⌘K</kbd>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {variant === 'admin' && (
              import.meta.env.VITE_TWILIO_ENABLED === 'true' ? (
                <span className="flex items-center gap-1.5 rounded-full border border-signal/40 bg-signal/10 px-2.5 py-1 font-mono text-[10px] font-medium tracking-[0.08em] text-signal">
                  <span className="h-1.5 w-1.5 animate-live-dot rounded-full bg-signal" />
                  LIVE · TWILIO
                </span>
              ) : (
                <span className="rounded-full border border-amber/40 bg-amber/10 px-2.5 py-1 font-mono text-[10px] font-medium tracking-[0.08em] text-amber">
                  SIMULATION
                </span>
              )
            )}
            {variant === 'agent' && (
              <span className="hidden items-center gap-2 rounded-full border border-line bg-ink-800 px-3 py-1.5 text-xs text-text-mid sm:flex">
                <span className={cn('h-2 w-2 rounded-full', presenceDotClass(currentPresence))} />
                {presenceLabel(currentPresence)}
              </span>
            )}
            <button className="relative rounded-[10px] p-2 text-text-mid transition-colors hover:bg-ink-700 hover:text-text-hi" title="Notifications">
              <Bell className="h-[18px] w-[18px]" />
              <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-danger font-mono text-[9px] font-bold text-white">
                2
              </span>
            </button>
            <button
              onClick={() => setCollapsed((v) => !v)}
              className="rounded-[10px] p-2 text-text-mid transition-colors hover:bg-ink-700 hover:text-text-hi"
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? <PanelLeftOpen className="h-[18px] w-[18px]" /> : <PanelLeftClose className="h-[18px] w-[18px]" />}
            </button>
          </div>
        </header>

        {/* Content slot — cross-fades/slides 8px between routes */}
        <motion.main
          key={location.pathname}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          className="flex min-h-0 flex-1 flex-col"
        >
          {children}
        </motion.main>
      </div>
    </div>
  );
}
