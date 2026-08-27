import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, Plus, Search, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import AppShell from '@/components/AppShell';
import { trpc } from '@/providers/trpc';
import { cn } from '@/lib/utils';
import type { PresenceStatus } from '@/lib/telephony';
import ContactCard from '@/components/contacts/ContactCard';
import ContactDrawer from '@/components/contacts/ContactDrawer';
import { sameNumber, peerNumber } from '@/components/contacts/shared';
import type { CallRow, Contact } from '@/components/contacts/shared';

const EASE = [0.22, 1, 0.36, 1] as [number, number, number, number];

type TabKey = 'all' | 'favorites' | 'vip' | 'lead' | 'customer';
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'favorites', label: 'Favorites' },
  { key: 'vip', label: 'VIP' },
  { key: 'lead', label: 'Leads' },
  { key: 'customer', label: 'Customers' },
];

type SortKey = 'recent' | 'name' | 'favorites';
const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'recent', label: 'Recently called' },
  { key: 'name', label: 'Name A–Z' },
  { key: 'favorites', label: 'Favorites first' },
];

/** Wire the shell presence selector to the telephony backend (dnd ↔ busy). */
function useShellPresence() {
  const utils = trpc.useUtils();
  const mine = trpc.telephony.presence.mine.useQuery();
  const setMut = trpc.telephony.presence.set.useMutation({
    onSuccess: () => utils.telephony.presence.mine.invalidate(),
  });
  const backend = mine.data?.presence;
  const presence: PresenceStatus =
    backend === 'busy' ? 'dnd' : backend === 'available' || backend === 'away' || backend === 'offline' ? backend : 'available';
  const onPresenceChange = (p: PresenceStatus) => setMut.mutate({ presence: p === 'dnd' ? 'busy' : p });
  return { presence, onPresenceChange };
}

export default function Contacts() {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const { presence, onPresenceChange } = useShellPresence();

  /* ------------------------------ state ------------------------------ */
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [tab, setTab] = useState<TabKey>('all');
  const [sort, setSort] = useState<SortKey>('recent');
  const [sortOpen, setSortOpen] = useState(false);
  const [drawer, setDrawer] = useState<{ mode: 'view'; contact: Contact } | { mode: 'create' } | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 150);
    return () => window.clearTimeout(t);
  }, [search]);

  /* ------------------------------ data ------------------------------- */
  const listInput = {
    search: debouncedSearch || undefined,
    tag: tab === 'vip' || tab === 'lead' || tab === 'customer' ? tab : undefined,
    favoritesOnly: tab === 'favorites' || undefined,
  };
  const contactsQuery = trpc.telephony.contacts.list.useQuery(listInput);
  const allQuery = trpc.telephony.contacts.list.useQuery({});
  const callsQuery = trpc.telephony.calls.listMine.useQuery({ page: 1, pageSize: 200 });

  const favMut = trpc.telephony.contacts.toggleFavorite.useMutation({
    onSuccess: () => utils.telephony.contacts.list.invalidate(),
  });

  const allContacts = useMemo(() => allQuery.data ?? [], [allQuery.data]);
  const favCount = useMemo(() => allContacts.filter((c) => c.favorite).length, [allContacts]);
  const calls = useMemo(() => callsQuery.data?.rows ?? [], [callsQuery.data]);

  /** phone digits → most recent call epoch ms, for "Last call: …" captions */
  const lastCallByPhone = useMemo(() => {
    const map = new Map<string, number>();
    for (const call of calls) {
      const key = peerNumber(call).replace(/\D/g, '');
      const at = new Date(call.startedAt).getTime();
      const prev = map.get(key);
      if (key && (prev == null || at > prev)) map.set(key, at);
    }
    return map;
  }, [calls]);

  const lastCallFor = (c: Contact): number | null => {
    const digits = c.phone.replace(/\D/g, '');
    for (const [k, v] of lastCallByPhone) {
      if (sameNumber(k, digits)) return v;
    }
    return null;
  };

  const visible = useMemo(() => {
    const rows = [...(contactsQuery.data ?? [])];
    if (sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'favorites') rows.sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
    else rows.sort((a, b) => (lastCallFor(b) ?? 0) - (lastCallFor(a) ?? 0) || Number(b.favorite) - Number(a.favorite));
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactsQuery.data, sort, lastCallByPhone]);

  const historyFor = (c: Contact | null): CallRow[] =>
    c ? calls.filter((call) => sameNumber(peerNumber(call), c.phone)) : [];

  /* --------------------------- interactions --------------------------- */
  const dial = (c: Contact) => {
    toast(`Dialing ${c.name}…`, { description: c.phone });
    navigate('/app', { state: { dial: { number: c.phone, name: c.name } } });
  };

  const openCallInHistory = (callId: number) => {
    setDrawer(null);
    navigate(`/app/history?call=${callId}`);
  };

  /* --------------------------- keyboard ------------------------------ */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      if (e.key === 'Escape' && drawer) {
        setDrawer(null);
        return;
      }
      if (typing) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (drawer) return;
      const idx = visible.findIndex((c) => c.id === selectedId);
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        const next = visible[Math.min(visible.length - 1, idx + 1)] ?? visible[0];
        if (next) setSelectedId(next.id);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const prev = visible[Math.max(0, idx - 1)] ?? visible[0];
        if (prev) setSelectedId(prev.id);
      } else if (e.key === 'Enter' && idx >= 0) {
        setDrawer({ mode: 'view', contact: visible[idx] });
      } else if ((e.key === 'c' || e.key === 'C') && idx >= 0) {
        dial(visible[idx]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const drawerContact = drawer?.mode === 'view' ? drawer.contact : null;

  return (
    <AppShell variant="agent" title="Contacts" presence={presence} onPresenceChange={onPresenceChange}>
      <div className="flex min-h-0 flex-1 flex-col p-6">
        {/* ------------------------- header ------------------------- */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: EASE }}
          className="mb-5"
        >
          <h2 className="font-display text-[28px] font-semibold leading-[34px] tracking-tight text-text-hi">
            Contacts
          </h2>
          <p className="mt-1 text-sm text-text-mid">
            {allContacts.length} contacts · {favCount} favorites
          </p>
        </motion.div>

        {/* -------------------- controls (sticky) -------------------- */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.06, ease: EASE }}
          className="sticky top-14 z-20 -mx-6 mb-5 flex flex-wrap items-center gap-3 border-b border-line bg-ink-950/80 px-6 pb-4 pt-1 backdrop-blur-md"
        >
          {/* search */}
          <div className="flex w-[360px] max-w-full items-center gap-2 rounded-[10px] border border-line bg-ink-800 px-3 py-2 text-sm transition-colors focus-within:border-signal/50">
            <Search className="h-4 w-4 shrink-0 text-text-low" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, company, or number…"
              className="w-full bg-transparent text-text-hi outline-none placeholder:text-text-low"
            />
            {debouncedSearch && (
              <span className="shrink-0 font-mono text-[11px] text-text-low">{visible.length} results</span>
            )}
            <AnimatePresence>
              {search && (
                <motion.button
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ duration: 0.15 }}
                  onClick={() => setSearch('')}
                  className="shrink-0 rounded p-0.5 text-text-low hover:text-text-hi"
                  title="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </motion.button>
              )}
            </AnimatePresence>
          </div>

          {/* filter tabs */}
          <div className="flex items-center gap-1 rounded-full border border-line bg-ink-900 p-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  'relative rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors',
                  tab === t.key ? 'text-signal' : 'text-text-mid hover:text-text-hi'
                )}
              >
                {tab === t.key && (
                  <motion.span
                    layoutId="contacts-tab-pill"
                    className="absolute inset-0 rounded-full bg-signal-dim/50"
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  />
                )}
                <span className="relative">{t.label}</span>
              </button>
            ))}
          </div>

          {/* sort dropdown */}
          <div className="relative">
            <button
              onClick={() => setSortOpen((v) => !v)}
              className="flex items-center gap-2 rounded-[10px] border border-line bg-ink-800 px-3 py-2 text-[13px] text-text-mid transition-colors hover:border-signal/40 hover:text-text-hi"
            >
              {SORTS.find((s) => s.key === sort)?.label}
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', sortOpen && 'rotate-180')} />
            </button>
            {sortOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setSortOpen(false)} />
                <div className="absolute left-0 z-20 mt-1 w-44 overflow-hidden rounded-[10px] border border-line bg-ink-800 shadow-lg">
                  {SORTS.map((s) => (
                    <button
                      key={s.key}
                      onClick={() => {
                        setSort(s.key);
                        setSortOpen(false);
                      }}
                      className="flex w-full items-center justify-between px-3 py-2 text-[13px] text-text-mid transition-colors hover:bg-ink-700 hover:text-text-hi"
                    >
                      {s.label}
                      {sort === s.key && <Check className="h-3.5 w-3.5 text-signal" />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* add contact */}
          <button
            onClick={() => setDrawer({ mode: 'create' })}
            className="ml-auto flex items-center gap-2 rounded-[10px] bg-signal px-4 py-2 text-sm font-semibold text-ink-950 transition-transform hover:scale-[1.02] active:scale-[0.97]"
          >
            <Plus className="h-4 w-4" />
            Add contact
          </button>
        </motion.div>

        {/* --------------------------- grid --------------------------- */}
        {contactsQuery.isLoading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-[132px] animate-pulse rounded-[14px] border border-line bg-ink-800" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center"
          >
            <div className="rounded-[14px] border border-dashed border-line p-4">
              <img src="/empty-contacts.svg" alt="" className="h-28 w-auto opacity-80" />
            </div>
            {tab === 'favorites' && !debouncedSearch ? (
              <>
                <div className="text-sm font-medium text-text-hi">No favorites yet</div>
                <div className="max-w-xs text-xs text-text-low">Star the people you call most.</div>
              </>
            ) : (
              <>
                <div className="text-sm font-medium text-text-hi">No one by that name</div>
                <div className="max-w-xs text-xs text-text-low">
                  Try a different spelling, or add them as a new contact
                </div>
                <button
                  onClick={() => setDrawer({ mode: 'create' })}
                  className="mt-1 flex items-center gap-2 rounded-[10px] bg-signal px-4 py-2 text-sm font-semibold text-ink-950 transition-transform hover:scale-[1.02] active:scale-[0.97]"
                >
                  <UserPlus className="h-4 w-4" />
                  Add contact
                </button>
              </>
            )}
          </motion.div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
            {visible.map((c, i) => (
              <motion.div
                key={`${tab}-${debouncedSearch}-${c.id}`}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.45, delay: Math.min(i, 16) * 0.03, ease: EASE }}
              >
                <ContactCard
                  contact={c}
                  lastCallAt={lastCallFor(c)}
                  selected={selectedId === c.id}
                  onOpen={(contact) => setDrawer({ mode: 'view', contact })}
                  onDial={dial}
                  onToggleFavorite={(contact) => favMut.mutate({ id: contact.id })}
                />
              </motion.div>
            ))}
          </div>
        )}
      </div>

      <ContactDrawer
        open={drawer != null}
        contact={drawerContact}
        history={historyFor(drawerContact)}
        onClose={() => setDrawer(null)}
        onDial={dial}
        onOpenCall={openCallInHistory}
      />
    </AppShell>
  );
}
