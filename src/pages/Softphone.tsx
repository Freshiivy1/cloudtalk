import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  Phone,
  PhoneOff,
  PhoneMissed,
  Mic,
  MicOff,
  Grid3X3,
  Volume2,
  Pause,
  UserPlus,
  ArrowRightLeft,
  Delete,
  X,
  Contact,
  ChevronDown,
  ArrowUpRight,
  ArrowDownLeft,
  RotateCcw,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import AppShell, { PRESENCE_OPTIONS, presenceDotClass, presenceLabel } from '@/components/AppShell';
import DialPad from '@/components/DialPad';
import CallAvatar from '@/components/CallAvatar';
import WaveformRibbon from '@/components/WaveformRibbon';
import StatCard from '@/components/StatCard';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { useTelephonyReporter } from '@/hooks/useTelephonyReporter';
import {
  useTelephony,
  formatCallDuration,
  formatRelativeTime,
  playDTMFTone,
  normalizePhoneNumber,
} from '@/lib/telephony';
import type { PresenceStatus, CallInfo, CallContact } from '@/lib/telephony';
import { trpc } from '@/providers/trpc';

const EASE = [0.22, 1, 0.36, 1] as [number, number, number, number];
const AGENT_EXT = '104';
/** sessionStorage key — "Guarded inmate call" toggle persists for the session. */
const GUARDED_KEY = 'cloudtalk.guardedInmateCall';

/** Ticking seconds, re-render every 1s. */
function useNow(activeMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), activeMs);
    return () => clearInterval(t);
  }, [activeMs]);
  return now;
}

// ---------------------------------------------------------------------------
// Presence selector pill (panel header)
// ---------------------------------------------------------------------------

function PresencePill({
  presence,
  onChange,
}: {
  presence: PresenceStatus;
  onChange: (p: PresenceStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <motion.button
        whileTap={{ y: 2 }}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-line bg-ink-800 px-4 py-2 text-sm font-medium text-text-hi transition-colors hover:border-signal/50"
      >
        <motion.span
          key={presence}
          initial={{ scale: 1.6 }}
          animate={{ scale: 1 }}
          className={cn('h-2.5 w-2.5 rounded-full', presenceDotClass(presence))}
        />
        {presenceLabel(presence)}
        <ChevronDown className={cn('h-3.5 w-3.5 text-text-low transition-transform', open && 'rotate-180')} />
      </motion.button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 z-20 mt-2 w-48 overflow-hidden rounded-[10px] border border-line bg-ink-800 shadow-xl"
          >
            {PRESENCE_OPTIONS.map((o) => (
              <button
                key={o.value}
                onClick={() => {
                  setOpen(false);
                  onChange(o.value);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text-mid transition-colors hover:bg-ink-700 hover:text-text-hi"
              >
                <span className={cn('h-2 w-2 rounded-full', o.dot)} />
                {o.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Animated ellipsis for status text
// ---------------------------------------------------------------------------

function Ellipsis() {
  return (
    <span className="inline-flex">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          animate={{ opacity: [0.2, 1, 0.2] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
        >
          .
        </motion.span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Softphone page
// ---------------------------------------------------------------------------

export default function Softphone() {
  const t = useTelephony();
  useTelephonyReporter(t);
  const { callState, call, muted, speakerOn, presence, queue, recent, dtmfLog, lastDuration } = t.snapshot;

  const [digits, setDigits] = useState('');
  const [dtmfOpen, setDtmfOpen] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [heroHover, setHeroHover] = useState(false);
  // Guarded inmate call mode — persists for the browser session.
  const [guarded, setGuardedState] = useState(() => {
    try {
      return sessionStorage.getItem(GUARDED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setGuarded = useCallback((v: boolean) => {
    setGuardedState(v);
    try {
      sessionStorage.setItem(GUARDED_KEY, v ? '1' : '0');
    } catch {
      /* storage unavailable — state still lives in-memory */
    }
  }, []);
  const [guardedStatus, setGuardedStatus] = useState<string | null>(null);
  const initiateGuarded = trpc.verification.initiateGuarded.useMutation({
    onSuccess: (data, vars) => {
      // Guarded inmate call: NO incoming call. Place the outbound SDK call
      // immediately, carrying the sessionId as the `guarded` custom param —
      // the TwiML App voice webhook parks this leg in the session conference
      // and starts the verification engine (Leg A dial).
      setGuardedStatus('Please wait while we connect your call…');
      t.dial(vars.calleeNumber, { guarded: data.sessionId });
    },
    onError: (err) => {
      setGuardedStatus(null);
      setPending(null);
      toast.error(`Guarded call failed: ${err.message}`);
    },
  });
  const now = useNow();
  const prevState = useRef(callState);

  // One-click dial from Contacts / Call History: they navigate to /app with
  // route state { dial: { number, name } } — consume it once and clear it.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const dial = (location.state as { dial?: { number: string; name?: string } } | null)?.dial;
    if (dial?.number && callState === 'idle') {
      setDigits(dial.number);
      t.dial(dial.number);
      navigate(location.pathname, { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, callState]);

  // clear pending spinner whenever state changes
  useEffect(() => {
    if (prevState.current !== callState) {
      prevState.current = callState;
      setPending(null);
      if (callState === 'idle') {
        setDigits('');
        setDtmfOpen(false);
        setNoteOpen(false);
        setNote('');
        setGuardedStatus(null);
      }
    }
  }, [callState]);

  // toasts from provider events
  useEffect(() => {
    const offEnded = t.on('call_ended', (payload) => {
      const p = payload as { durationSecs: number; missed: boolean; call: CallInfo | null };
      if (p.missed) {
        toast('Missed call', {
          description: `from ${p.call?.contact?.name ?? p.call?.number ?? 'unknown'}`,
        });
      } else {
        toast(`Call ended · ${formatCallDuration(p.durationSecs)}`);
      }
    });
    const offPresence = t.on('presence_changed', (payload) => {
      const p = payload as { presence: PresenceStatus };
      toast(`Presence set to ${presenceLabel(p.presence)}`);
    });
    return () => {
      offEnded();
      offPresence();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.provider]);

  const act = useCallback((key: string, fn: () => void) => {
    setPending(key);
    fn();
  }, []);

  const handleCall = useCallback(() => {
    const n = normalizePhoneNumber(digits);
    if (!n) {
      toast.error('Enter a valid phone number — e.g. +61 4XX XXX XXX');
      return;
    }
    if (guarded) {
      // Guarded inmate call: create the verification session, then place an
      // OUTBOUND softphone call (see the mutation's onSuccess) — the caller
      // is parked in the guarded conference while the callee is verified.
      setPending('call');
      setGuardedStatus(null);
      initiateGuarded.mutate({ calleeNumber: n });
      return;
    }
    act('call', () => t.dial(n));
  }, [digits, act, t, guarded, initiateGuarded]);

  // ---- keyboard support --------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      const state = t.snapshot.callState;
      if (e.key === '+' && state === 'idle') {
        setDigits((d) => (d.startsWith('+') ? d : ('+' + d.replace(/\+/g, '')).slice(0, 24)));
      } else if (/^[0-9*#]$/.test(e.key)) {
        if (state === 'idle') {
          playDTMFTone(e.key);
          setDigits((d) => (d + e.key).slice(0, 24));
        } else if (state === 'active' || state === 'held') {
          t.sendDTMF(e.key);
        }
      } else if (e.key === 'Backspace' && state === 'idle') {
        setDigits((d) => d.slice(0, -1));
      } else if (e.key === 'Enter' && state === 'idle') {
        handleCall();
      } else if (e.key === 'Escape') {
        if (state !== 'idle') act('hangup', () => t.hangup());
      } else if ((e.key === 'm' || e.key === 'M') && (state === 'active' || state === 'held')) {
        act('mute', () => t.toggleMute());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [t, act, handleCall]);

  // ---- real contacts (fed into the provider for inbound/queue sim) -------
  const contactsQuery = trpc.telephony.contacts.list.useQuery({});
  const realContacts: CallContact[] = (contactsQuery.data ?? []).map((c) => ({
    name: c.name,
    number: c.phone,
    company: c.company ?? undefined,
    tags: [c.tag.toUpperCase()],
  }));
  useEffect(() => {
    t.provider.setContacts(realContacts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactsQuery.data]);

  // ---- derived ------------------------------------------------------------
  const talkSecs =
    call?.connectedAt != null
      ? Math.max(0, Math.floor(((call.heldAt ?? now) - call.connectedAt) / 1000))
      : 0;
  const holdSecs = call?.heldAt != null ? Math.max(0, Math.floor((now - call.heldAt) / 1000)) : 0;
  const calleeName = call?.contact?.name ?? call?.number ?? '';
  const inCall = callState === 'active' || callState === 'held';
  const inRingBranch = callState === 'dialing' || callState === 'ringing' || callState === 'incoming';

  const speedDials = realContacts.slice(0, 3);

  return (
    <AppShell variant="agent" title="Softphone" presence={presence} onPresenceChange={t.setPresence}>
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
        {/* ---- Incoming call banner (slides down from content top) ---- */}
        <AnimatePresence>
          {callState === 'incoming' && (
            <motion.div
              initial={{ y: -64, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -64, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 260, damping: 22 }}
              className="flex items-center gap-4 rounded-[14px] border border-line border-l-4 border-l-amber bg-ink-800 px-5 py-3"
            >
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-amber" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-text-hi">{calleeName}</div>
                <div className="font-mono text-xs text-text-mid">
                  {call?.number} <span className="text-amber">· Incoming call</span>
                </div>
              </div>
              <button
                onClick={() => act('answer', t.answer)}
                className="flex items-center gap-2 rounded-full bg-signal px-4 py-2 text-sm font-semibold text-ink-950 transition-transform hover:scale-[1.02] active:scale-[0.97]"
              >
                {pending === 'answer' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}
                Answer
              </button>
              <button
                onClick={() => act('decline', t.hangup)}
                className="flex items-center gap-2 rounded-full bg-danger px-4 py-2 text-sm font-semibold text-white transition-transform hover:scale-[1.02] active:scale-[0.97]"
              >
                <PhoneOff className="h-4 w-4" />
                Decline
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 xl:grid-cols-[1fr_380px]">
          {/* ================= Left: dialer / call panel ================= */}
          <motion.section
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
            className={cn(
              'instrument-panel relative flex min-h-0 flex-col overflow-hidden transition-[filter,border-color] duration-300',
              callState === 'active' && 'border-signal',
              callState === 'held' && 'border-amber/60 saturate-[0.7]'
            )}
            style={
              callState === 'active'
                ? { boxShadow: '0 0 24px rgba(46,230,168,0.18), inset 0 1px 0 0 rgba(234,241,251,0.05)' }
                : undefined
            }
          >
            {callState === 'active' && (
              <span className="absolute left-5 top-4 z-10 rounded-full border border-signal/40 bg-signal/10 px-2.5 py-1 font-mono text-[10px] font-medium tracking-[0.08em] text-signal">
                IN CALL · ENCRYPTED
              </span>
            )}
            {callState === 'held' && (
              <span className="absolute left-5 top-4 z-10 rounded-full border border-amber/40 bg-amber/10 px-2.5 py-1 font-mono text-[10px] font-medium tracking-[0.08em] text-amber">
                ON HOLD
              </span>
            )}

            <AnimatePresence mode="wait">
              {/* ================= IDLE DIALER ================= */}
              {callState === 'idle' && (
                <motion.div
                  key="idle"
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ duration: 0.3, ease: EASE }}
                  className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-8 py-6"
                >
                  {/* status header */}
                  <motion.div
                    initial={{ y: -12, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ duration: 0.4, ease: EASE }}
                    className="flex w-full items-start justify-between gap-4"
                  >
                    <div>
                      <h2 className="font-display text-[28px] font-semibold leading-[34px] tracking-tight text-text-hi">
                        Ready when you are
                      </h2>
                      <p className="mt-1 text-sm text-text-mid">
                        You're {presenceLabel(presence)} · Ext <span className="font-mono">{AGENT_EXT}</span>
                      </p>
                    </div>
                    <PresencePill presence={presence} onChange={t.setPresence} />
                  </motion.div>

                  {/* waveform hero strip */}
                  <motion.div
                    initial={{ clipPath: 'inset(0 100% 0 0)' }}
                    animate={{ clipPath: 'inset(0 0% 0 0)' }}
                    transition={{ duration: 0.8, ease: EASE, delay: 0.15 }}
                    className="mt-4 w-full cursor-pointer"
                    onMouseEnter={() => setHeroHover(true)}
                    onMouseLeave={() => setHeroHover(false)}
                  >
                    <WaveformRibbon height={64} amplitude={0.2} boost={heroHover ? 1 : 0} />
                  </motion.div>

                  {/* number display */}
                  <div className="mt-2 flex h-14 w-full items-center justify-center gap-2">
                    <div className="relative flex h-full min-w-0 flex-1 items-center justify-center overflow-hidden">
                      {digits ? (
                        <div className="flex items-baseline font-mono text-[32px] font-medium leading-10 tracking-wide text-text-hi">
                          <AnimatePresence>
                            {digits.split('').map((d, i) => (
                              <motion.span
                                key={`${i}-${d}`}
                                initial={{ y: -8, opacity: 0, scale: 1.24 }}
                                animate={{ y: 0, opacity: 1, scale: 1 }}
                                transition={{ duration: 0.15 }}
                              >
                                {d}
                              </motion.span>
                            ))}
                          </AnimatePresence>
                          <span className="ml-1 inline-block h-7 w-[3px] animate-caret-blink rounded bg-signal" />
                        </div>
                      ) : (
                        <span className="font-mono text-[32px] leading-10 text-text-low">Enter a number</span>
                      )}
                      <span className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-ink-900 to-transparent" />
                    </div>
                    {digits && (
                      <button
                        onClick={() => setDigits((d) => d.slice(0, -1))}
                        className="rounded-[10px] p-2 text-text-low transition-colors hover:bg-ink-700 hover:text-text-hi"
                        title="Backspace"
                      >
                        <Delete className="h-5 w-5" />
                      </button>
                    )}
                  </div>

                  {/* dial pad */}
                  <div className="mt-4">
                    <DialPad
                      onPress={(d) => setDigits((prev) => (prev + d).slice(0, 24))}
                      onPlus={() => setDigits((prev) => (prev.startsWith('+') ? prev : ('+' + prev).slice(0, 24)))}
                    />
                  </div>

                  {/* guarded inmate call toggle */}
                  <div className="mt-4 flex w-full max-w-[280px] items-center justify-between rounded-[10px] border border-line bg-ink-800 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className={cn('h-4 w-4', guarded ? 'text-signal' : 'text-text-low')} />
                      <div>
                        <p className="text-xs font-medium text-text-hi">Guarded inmate call</p>
                        <p className="text-[10px] text-text-low">Verified line · challenge noise on speakerphone</p>
                      </div>
                    </div>
                    <Switch
                      checked={guarded}
                      onCheckedChange={setGuarded}
                      aria-label="Guarded inmate call"
                    />
                  </div>
                  {guardedStatus && (
                    <p className="mt-2 w-full max-w-[280px] text-center text-[11px] leading-snug text-signal">
                      {guardedStatus}
                    </p>
                  )}

                  {/* quick action row */}
                  <motion.div
                    initial={{ y: 16, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ duration: 0.4, ease: EASE, delay: 0.55 }}
                    className="mt-5 flex w-full max-w-[280px] items-center gap-3"
                  >
                    <div className="relative">
                      <button
                        onClick={() => setContactsOpen((v) => !v)}
                        className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-ink-800 text-text-mid transition-colors hover:border-signal/50 hover:text-text-hi"
                        title="Dial from contacts"
                      >
                        <Contact className="h-5 w-5" />
                      </button>
                      <AnimatePresence>
                        {contactsOpen && (
                          <motion.div
                            initial={{ opacity: 0, y: 6, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 6, scale: 0.98 }}
                            transition={{ duration: 0.15 }}
                            className="absolute bottom-12 left-0 z-20 w-64 overflow-hidden rounded-[10px] border border-line bg-ink-800 shadow-xl"
                          >
                            {realContacts.length === 0 ? (
                              <div className="px-3 py-4 text-center">
                                <p className="text-sm text-text-mid">No contacts yet</p>
                                <p className="mt-1 text-[11px] text-text-low">Add people from the Contacts page</p>
                              </div>
                            ) : (
                              realContacts.map((c) => (
                                <button
                                  key={c.number}
                                  onClick={() => {
                                    setContactsOpen(false);
                                    setDigits(c.number.replace(/[^\d+]/g, ''));
                                  }}
                                  className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-ink-700"
                                >
                                  <span className="flex-1 truncate text-sm text-text-hi">{c.name}</span>
                                  <span className="font-mono text-[11px] text-text-low">{c.number}</span>
                                </button>
                              ))
                            )}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    <motion.button
                      whileHover={{ scale: digits.length >= 3 ? 1.02 : 1 }}
                      whileTap={{ scale: digits.length >= 3 ? 0.97 : 1 }}
                      onClick={handleCall}
                      disabled={digits.length < 3 || pending === 'call'}
                      className={cn(
                        'flex h-16 flex-1 items-center justify-center gap-2 rounded-full bg-signal font-display text-base font-semibold text-ink-950 transition-shadow',
                        digits.length >= 3
                          ? 'shadow-glow-signal hover:shadow-[0_0_32px_rgba(46,230,168,0.55)]'
                          : 'opacity-40'
                      )}
                    >
                      {pending === 'call' ? (
                        <Loader2 className="h-5 w-5 animate-spin" />
                      ) : (
                        <Phone className="h-5 w-5" />
                      )}
                      Call
                    </motion.button>

                    <button
                      onClick={() => setDigits('')}
                      className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-ink-800 text-text-mid transition-colors hover:border-danger/50 hover:text-danger"
                      title="Clear all"
                    >
                      <X className="h-5 w-5" />
                    </button>
                  </motion.div>

                  {/* speed-dial chips */}
                  <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                    {speedDials.map((c) => (
                      <button
                        key={c.number}
                        onClick={() => {
                          const num = c.number.replace(/\D/g, '');
                          if (digits === num) act('call', () => t.dial(num));
                          else setDigits(num);
                        }}
                        className="rounded-full border border-line bg-ink-800 px-3 py-1.5 text-xs text-text-mid transition-all duration-150 hover:-translate-y-0.5 hover:border-signal/50 hover:text-text-hi"
                      >
                        {c.name.split(' ')[0]} {c.name.split(' ')[1]?.[0]}. ·{' '}
                        <span className="font-mono">Ext {102 + speedDials.indexOf(c)}</span>
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}

              {/* ============ DIALING / RINGING / INCOMING ============ */}
              {inRingBranch && call && (
                <motion.div
                  key={`ring-${call.id}`}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ duration: 0.3, ease: EASE }}
                  className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-y-auto px-8 py-8"
                >
                  <motion.div
                    initial={{ scale: 0.6, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: 'spring', stiffness: 260, damping: 20 }}
                  >
                    <CallAvatar
                      name={calleeName}
                      size={88}
                      state="ringing"
                      ringTint={call.direction === 'inbound' ? 'sky' : 'amber'}
                    />
                  </motion.div>

                  <div className="text-center">
                    {call.contact ? (
                      <>
                        <div className="font-display text-2xl font-semibold tracking-tight text-text-hi">
                          {call.contact.name}
                        </div>
                        <div className="mt-1 font-mono text-sm text-text-mid">
                          {call.number}
                          {call.contact.company && <span className="text-text-low"> · {call.contact.company}</span>}
                        </div>
                      </>
                    ) : (
                      <div className="font-mono text-[28px] leading-9 text-text-hi">{call.number}</div>
                    )}
                    <div
                      className={cn(
                        'mt-2 text-sm font-medium',
                        callState === 'incoming' ? 'text-sky' : 'text-amber'
                      )}
                    >
                      {callState === 'incoming'
                        ? 'Incoming call'
                        : callState === 'dialing'
                          ? <>Dialing<Ellipsis /></>
                          : <>Ringing<Ellipsis /></>}
                    </div>
                  </div>

                  <WaveformRibbon
                    height={40}
                    amplitude={callState === 'incoming' ? 0.4 : 0.1}
                    active={callState === 'incoming'}
                    tint={callState === 'incoming' ? 'signal' : 'amber'}
                    className="max-w-md opacity-80"
                  />

                  {/* caller context card (known inbound contact) */}
                  {callState === 'incoming' && call.contact && (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.15 }}
                      className="w-full max-w-sm rounded-[14px] border border-line bg-ink-800 p-4"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-text-hi">{call.contact.company}</span>
                        <span className="flex gap-1.5">
                          {call.contact.tags?.map((tag) => (
                            <span
                              key={tag}
                              className="rounded-full border border-sky/30 bg-sky/10 px-2 py-0.5 text-[10px] font-medium text-sky"
                            >
                              {tag}
                            </span>
                          ))}
                        </span>
                      </div>
                      {call.contact.lastCall && (
                        <div className="mt-1.5 font-mono text-[11px] text-text-low">{call.contact.lastCall}</div>
                      )}
                    </motion.div>
                  )}

                  {/* controls */}
                  {callState === 'incoming' ? (
                    <div className="flex items-center gap-8">
                      <motion.button
                        animate={{ y: [0, -2, 0] }}
                        transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
                        onClick={() => act('answer', t.answer)}
                        className="flex h-16 w-16 items-center justify-center rounded-full bg-signal text-ink-950 shadow-glow-signal transition-transform hover:scale-105 active:scale-95"
                        title="Answer"
                      >
                        {pending === 'answer' ? <Loader2 className="h-6 w-6 animate-spin" /> : <Phone className="h-6 w-6" />}
                      </motion.button>
                      <button
                        onClick={() => act('decline', t.hangup)}
                        className="flex h-16 w-16 items-center justify-center rounded-full bg-danger text-white shadow-glow-danger transition-transform hover:scale-105 active:scale-95"
                        title="Decline"
                      >
                        <PhoneOff className="h-6 w-6" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => act('cancel', t.hangup)}
                      className="flex h-16 w-16 items-center justify-center rounded-full bg-danger text-white shadow-glow-danger transition-transform hover:scale-105 active:scale-95"
                      title="Cancel call"
                    >
                      {pending === 'cancel' ? <Loader2 className="h-6 w-6 animate-spin" /> : <PhoneOff className="h-6 w-6" />}
                    </button>
                  )}
                </motion.div>
              )}

              {/* ==================== ACTIVE / HELD ==================== */}
              {inCall && call && (
                <motion.div
                  key={`active-${call.id}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3 }}
                  className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-6"
                >
                  {/* header */}
                  <div className="mt-6 flex items-center justify-center gap-4">
                    <CallAvatar name={calleeName} size={64} state={callState === 'held' ? 'held' : 'active'} />
                    <div>
                      <div className="font-display text-xl font-semibold tracking-tight text-text-hi">{calleeName}</div>
                      <div className="font-mono text-xs text-text-mid">{call.number}</div>
                      <div
                        className={cn(
                          'mt-1 font-mono text-[32px] font-medium leading-10 tabular-nums',
                          callState === 'held' ? 'text-amber' : 'text-signal'
                        )}
                      >
                        {callState === 'held'
                          ? `On hold ${formatCallDuration(holdSecs)}`
                          : formatCallDuration(talkSecs)}
                      </div>
                    </div>
                  </div>

                  {/* waveform */}
                  <div className="mx-auto mt-4 w-full max-w-lg">
                    <WaveformRibbon
                      height={72}
                      active={callState === 'active' && !muted}
                      held={callState === 'held'}
                      muted={muted}
                    />
                  </div>

                  {/* control grid 2×3 */}
                  <div className="mx-auto mt-5 grid w-full max-w-sm grid-cols-3 gap-3">
                    {[
                      {
                        key: 'mute',
                        label: muted ? 'Unmute · M' : 'Mute · M',
                        icon: muted ? MicOff : Mic,
                        onClick: () => act('mute', t.toggleMute),
                        activeCls: muted ? 'bg-danger/90 text-white shadow-glow-danger' : '',
                        enabled: true,
                      },
                      {
                        key: 'keypad',
                        label: 'Keypad',
                        icon: Grid3X3,
                        onClick: () => setDtmfOpen((v) => !v),
                        activeCls: dtmfOpen ? 'bg-signal-dim text-signal' : '',
                        enabled: true,
                      },
                      {
                        key: 'speaker',
                        label: 'Speaker',
                        icon: Volume2,
                        onClick: () => act('speaker', t.toggleSpeaker),
                        activeCls: speakerOn ? 'bg-sky/80 text-ink-950' : '',
                        enabled: true,
                      },
                      {
                        key: 'hold',
                        label: callState === 'held' ? 'Resume' : 'Hold',
                        icon: Pause,
                        onClick: () => act('hold', t.toggleHold),
                        activeCls: callState === 'held' ? 'bg-amber/90 text-ink-950' : '',
                        enabled: true,
                      },
                      {
                        key: 'add',
                        label: 'Add call',
                        icon: UserPlus,
                        onClick: () => {},
                        activeCls: '',
                        enabled: false,
                        tip: 'Coming with live telephony',
                      },
                      {
                        key: 'transfer',
                        label: 'Transfer',
                        icon: ArrowRightLeft,
                        onClick: () => {},
                        activeCls: '',
                        enabled: false,
                        tip: 'Coming with live telephony',
                      },
                    ].map((c, i) => (
                      <motion.button
                        key={c.key}
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.05, duration: 0.3, ease: EASE }}
                        onClick={c.onClick}
                        disabled={!c.enabled}
                        title={c.tip ?? c.label}
                        className={cn(
                          'flex flex-col items-center gap-1.5 rounded-[14px] border border-line bg-ink-700 py-3 text-text-mid transition-colors duration-150',
                          c.enabled ? 'hover:border-signal/40 hover:text-text-hi' : 'opacity-40',
                          c.activeCls
                        )}
                      >
                        {pending === c.key ? (
                          <Loader2 className="h-5 w-5 animate-spin" />
                        ) : (
                          <c.icon className="h-5 w-5" />
                        )}
                        <span className="text-[11px] font-medium">{c.label}</span>
                      </motion.button>
                    ))}
                  </div>

                  {/* hang up */}
                  <div className="mt-5 flex justify-center pb-2">
                    <button
                      onClick={() => act('hangup', t.hangup)}
                      className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-danger text-white shadow-glow-danger transition-transform hover:scale-105 active:scale-95"
                      title="Hang up · Esc"
                    >
                      {pending === 'hangup' ? <Loader2 className="h-7 w-7 animate-spin" /> : <PhoneOff className="h-7 w-7" />}
                    </button>
                  </div>

                  {/* DTMF overlay */}
                  <AnimatePresence>
                    {dtmfOpen && (
                      <motion.div
                        initial={{ y: '100%' }}
                        animate={{ y: 0 }}
                        exit={{ y: '100%' }}
                        transition={{ type: 'spring', stiffness: 320, damping: 30 }}
                        className="absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-3 rounded-t-[14px] border-t border-line bg-ink-900/95 px-6 pb-6 pt-3 backdrop-blur-md"
                      >
                        <button
                          onClick={() => setDtmfOpen(false)}
                          className="w-full rounded-lg py-1.5 text-center text-xs font-medium text-text-mid transition-colors hover:bg-ink-700 hover:text-text-hi"
                        >
                          Done
                        </button>
                        <div className="h-5 font-mono text-xs text-text-low">
                          {dtmfLog.length > 0 ? `tones sent: ${dtmfLog.join(' ')}` : 'tones sent: —'}
                        </div>
                        <DialPad size={56} noEntrance onPress={(d) => t.sendDTMF(d)} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              )}

              {/* ==================== ENDED / WRAP-UP ==================== */}
              {callState === 'ended' && (
                <motion.div
                  key="ended"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3 }}
                  className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-8 py-8"
                >
                  <div className="text-sm font-medium text-text-mid">Call ended</div>
                  <div className="font-mono text-[32px] font-medium leading-10 text-text-hi">
                    {formatCallDuration(lastDuration)}
                  </div>
                  <div className="text-sm text-text-mid">
                    with <span className="text-text-hi">{calleeName}</span>
                  </div>

                  {noteOpen ? (
                    <div className="w-full max-w-sm">
                      <div className="mb-2 text-xs text-text-low">How'd it go? Add a note.</div>
                      <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        rows={3}
                        autoFocus
                        placeholder="Call summary…"
                        className="w-full resize-none rounded-[10px] border border-line bg-ink-800 p-3 text-sm text-text-hi outline-none placeholder:text-text-low focus:border-signal/50"
                      />
                      <div className="mt-2 flex justify-end gap-2">
                        <button
                          onClick={() => setNoteOpen(false)}
                          className="rounded-full border border-line px-4 py-1.5 text-xs text-text-mid hover:bg-ink-700"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => {
                            toast('Note saved to call log');
                            setNoteOpen(false);
                            setNote('');
                          }}
                          className="rounded-full bg-signal px-4 py-1.5 text-xs font-semibold text-ink-950"
                        >
                          Save note
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => call && act('call', () => t.dial(call.number.replace(/\D/g, '')))}
                        className="flex items-center gap-2 rounded-full border border-signal/50 px-4 py-2 text-sm font-medium text-signal transition-colors hover:bg-signal/10"
                      >
                        <RotateCcw className="h-4 w-4" />
                        Call back
                      </button>
                      <button
                        onClick={() => setNoteOpen(true)}
                        className="rounded-full border border-line px-4 py-2 text-sm text-text-mid transition-colors hover:bg-ink-700 hover:text-text-hi"
                      >
                        Add note
                      </button>
                      {!call?.contact && call && (
                        <button
                          onClick={() => toast('Contact saved', { description: call.number })}
                          className="rounded-full border border-line px-4 py-2 text-sm text-text-mid transition-colors hover:bg-ink-700 hover:text-text-hi"
                        >
                          Save contact
                        </button>
                      )}
                    </div>
                  )}

                  {/* auto-dismiss progress bar along the panel's bottom edge */}
                  <motion.div
                    initial={{ scaleX: 1 }}
                    animate={{ scaleX: 0 }}
                    transition={{ duration: 4, ease: 'linear' }}
                    className="absolute bottom-0 left-0 h-[3px] w-full origin-left bg-signal"
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.section>

          {/* ================= Right rail (380px) ================= */}
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
            {/* Today's stats */}
            <motion.div
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, ease: EASE }}
              className="instrument-panel p-4"
            >
              <div className="label-caps mb-3">Today's Stats</div>
              <div className="grid grid-cols-2 gap-3">
                <StatCard compact label="Calls handled" value={14} />
                <StatCard compact label="Talk time" value={102} format={(n) => `${Math.floor(n / 60)}h ${Math.round(n % 60)}m`} />
                <StatCard compact label="Avg call" value={258} format={(n) => formatCallDuration(Math.round(n))} />
                <StatCard compact label="Missed" value={1} />
              </div>
            </motion.div>

            {/* Call queue */}
            <motion.div
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, ease: EASE, delay: 0.1 }}
              className="instrument-panel flex min-h-0 flex-col p-4"
            >
              <div className="label-caps mb-3">
                Waiting in queue <span className="font-mono text-text-mid">({queue.length})</span>
              </div>
              <div className="space-y-1">
                <AnimatePresence initial={false}>
                  {queue.map((q) => (
                    <motion.div
                      key={q.id}
                      layout="position"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.3, ease: EASE }}
                      className="group flex items-center gap-3 overflow-hidden rounded-[10px] px-2 py-2 transition-colors hover:bg-ink-700"
                    >
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-ink-700 font-mono text-[10px] text-text-mid group-hover:bg-ink-800">
                        #{q.position}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-text-hi">{q.name}</div>
                        <div className="truncate font-mono text-[11px] text-text-low">{q.number}</div>
                      </div>
                      <span
                        className={cn(
                          'font-mono text-xs tabular-nums',
                          q.waitedSecs > 120 ? 'text-amber' : 'text-text-mid'
                        )}
                      >
                        {formatCallDuration(q.waitedSecs)}
                      </span>
                      <button
                        onClick={() => callState === 'idle' && t.provider.pickUpFromQueue(q.id)}
                        className={cn(
                          'text-xs font-semibold text-signal opacity-0 transition-opacity group-hover:opacity-100',
                          callState !== 'idle' && 'pointer-events-none'
                        )}
                      >
                        Pick up
                      </button>
                    </motion.div>
                  ))}
                </AnimatePresence>
                {queue.length === 0 && (
                  <div className="py-4 text-center text-xs text-text-low">Queue is clear — nice.</div>
                )}
              </div>
            </motion.div>

            {/* Recent activity */}
            <motion.div
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, ease: EASE, delay: 0.2 }}
              className="instrument-panel flex min-h-0 flex-1 flex-col p-4"
            >
              <div className="label-caps mb-3">Recent Activity</div>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
                {recent.slice(0, 6).map((r) => (
                  <button
                    key={r.id}
                    onClick={() => {
                      if (callState === 'idle') setDigits(r.number.replace(/\D/g, ''));
                    }}
                    className="group flex w-full items-center gap-3 rounded-[10px] px-2 py-2 text-left transition-all duration-150 hover:-translate-y-0.5 hover:bg-ink-700"
                  >
                    {r.missed ? (
                      <PhoneMissed className="h-4 w-4 shrink-0 text-danger" />
                    ) : r.direction === 'outbound' ? (
                      <ArrowUpRight className="h-4 w-4 shrink-0 text-signal" />
                    ) : (
                      <ArrowDownLeft className="h-4 w-4 shrink-0 text-sky" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-text-hi">{r.name}</div>
                      <div className="truncate font-mono text-[11px] text-text-low">
                        {r.number}
                        {!r.missed && ` · ${formatCallDuration(r.durationSecs)}`}
                      </div>
                    </div>
                    <span className="text-[11px] text-text-low">{formatRelativeTime(r.at, now)}</span>
                    <Phone className="h-3.5 w-3.5 shrink-0 text-signal opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                ))}
              </div>
            </motion.div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
