import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { format } from 'date-fns';
import { Loader2, Mail, Phone, PhoneIncoming, PhoneOutgoing, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import Drawer from '@/components/Drawer';
import CallAvatar from '@/components/CallAvatar';
import StatusPill from '@/components/StatusPill';
import { trpc } from '@/providers/trpc';
import { cn } from '@/lib/utils';
import { formatCallDuration } from '@/lib/telephony';
import { peerNumber } from './shared';
import type { CallRow, Contact } from './shared';

const TAG_OPTIONS = [
  { value: 'customer', label: 'Customer' },
  { value: 'vip', label: 'VIP' },
  { value: 'lead', label: 'Lead' },
  { value: 'supplier', label: 'Supplier' },
] as const;

export interface ContactDrawerProps {
  open: boolean;
  /** null (while open) = create form */
  contact: Contact | null;
  history: CallRow[];
  onClose: () => void;
  onDial: (contact: Contact) => void;
  onOpenCall: (callId: number) => void;
}

export default function ContactDrawer({
  open,
  contact,
  history,
  onClose,
  onDial,
  onOpenCall,
}: ContactDrawerProps) {
  const utils = trpc.useUtils();
  const createMut = trpc.telephony.contacts.create.useMutation({
    onSuccess: async () => {
      toast.success('Contact added');
      await utils.telephony.contacts.list.invalidate();
      onClose();
    },
    onError: (e) => toast.error('Could not save contact', { description: e.message }),
  });
  const removeMut = trpc.telephony.contacts.remove.useMutation({
    onSuccess: async () => {
      toast('Contact deleted');
      await utils.telephony.contacts.list.invalidate();
      onClose();
    },
    onError: (e) => toast.error('Could not delete contact', { description: e.message }),
  });

  /* create-form state */
  const [fName, setFName] = useState('');
  const [fPhone, setFPhone] = useState('');
  const [fCompany, setFCompany] = useState('');
  const [fEmail, setFEmail] = useState('');
  const [fTag, setFTag] = useState<(typeof TAG_OPTIONS)[number]['value']>('customer');

  useEffect(() => {
    if (open && !contact) {
      setFName('');
      setFPhone('');
      setFCompany('');
      setFEmail('');
      setFTag('customer');
    }
  }, [open, contact]);

  const saving = createMut.isPending;
  const creating = open && contact == null;

  const handleCreate = () => {
    if (!fName.trim() || !fPhone.trim()) {
      toast.error('Name and phone number are required');
      return;
    }
    createMut.mutate({
      name: fName.trim(),
      phone: fPhone.trim(),
      company: fCompany.trim() || undefined,
      email: fEmail.trim() || undefined,
      tag: fTag,
    });
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={creating ? 'Add contact' : (contact?.name ?? 'Contact')}
      footer={
        creating ? (
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="rounded-[10px] border border-line px-4 py-2 text-sm text-text-mid transition-colors hover:text-text-hi"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={saving}
              className="flex items-center gap-2 rounded-[10px] bg-signal px-4 py-2 text-sm font-semibold text-ink-950 transition-transform hover:scale-[1.02] active:scale-[0.97] disabled:opacity-60"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save contact
            </button>
          </div>
        ) : (
          contact && (
            <div className="flex items-center justify-between gap-2">
              <button
                onClick={() => removeMut.mutate({ id: contact.id })}
                disabled={removeMut.isPending}
                className="flex items-center gap-1.5 rounded-[10px] border border-danger/30 px-3 py-2 text-xs text-danger transition-colors hover:bg-danger/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
              <button
                onClick={() => onDial(contact)}
                className="flex items-center gap-2 rounded-[10px] bg-signal px-4 py-2 text-sm font-semibold text-ink-950 transition-transform hover:scale-[1.02] active:scale-[0.97]"
              >
                <Phone className="h-4 w-4" />
                Call {contact.name.split(' ')[0]}
              </button>
            </div>
          )
        )
      }
    >
      {creating ? (
        <div className="space-y-4">
          <Field label="Full name">
            <input
              value={fName}
              onChange={(e) => setFName(e.target.value)}
              placeholder="Dana Kim"
              className={inputCls}
            />
          </Field>
          <Field label="Phone">
            <input
              value={fPhone}
              onChange={(e) => setFPhone(e.target.value)}
              placeholder="+61 412 345 678"
              className={cn(inputCls, 'font-mono')}
            />
          </Field>
          <Field label="Company">
            <input
              value={fCompany}
              onChange={(e) => setFCompany(e.target.value)}
              placeholder="Acme Pty Ltd"
              className={inputCls}
            />
          </Field>
          <Field label="Email">
            <input
              value={fEmail}
              onChange={(e) => setFEmail(e.target.value)}
              placeholder="dana@acme.com"
              className={cn(inputCls, 'font-mono')}
            />
          </Field>
          <Field label="Tag">
            <select
              value={fTag}
              onChange={(e) => setFTag(e.target.value as typeof fTag)}
              className={inputCls}
            >
              {TAG_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : (
        contact && (
          <div className="space-y-5">
            {/* identity header */}
            <div className="flex items-center gap-4">
              <CallAvatar name={contact.name} size={64} />
              <div className="min-w-0">
                <div className="truncate font-display text-lg font-semibold text-text-hi">
                  {contact.name}
                </div>
                {contact.company && (
                  <div className="truncate text-sm text-text-mid">{contact.company}</div>
                )}
                <div className="mt-1.5">
                  <StatusPill
                    variant={contact.favorite ? 'ringing' : 'offline'}
                    label={contact.favorite ? 'Favorite' : contact.tag}
                  />
                </div>
              </div>
            </div>

            {/* detail rows */}
            <div className="space-y-1">
              <div className="flex items-center justify-between border-b border-line/50 py-2.5">
                <span className="text-xs uppercase tracking-[0.08em] text-text-low">Phone</span>
                <span className="font-mono text-[13px] text-text-hi">{contact.phone}</span>
              </div>
              {contact.email && (
                <div className="flex items-center justify-between gap-3 border-b border-line/50 py-2.5">
                  <span className="text-xs uppercase tracking-[0.08em] text-text-low">Email</span>
                  <span className="flex min-w-0 items-center gap-1.5 font-mono text-[13px] text-text-hi">
                    <Mail className="h-3.5 w-3.5 shrink-0 text-text-low" />
                    <span className="truncate">{contact.email}</span>
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between py-2.5">
                <span className="text-xs uppercase tracking-[0.08em] text-text-low">Added</span>
                <span className="font-mono text-[13px] text-text-hi">
                  {format(new Date(contact.createdAt), 'MMM d, yyyy')}
                </span>
              </div>
            </div>

            {/* call history with this contact */}
            <div>
              <div className="label-caps mb-2">Recent calls</div>
              {history.length === 0 ? (
                <div className="py-4 text-center text-xs text-text-low">
                  No calls with {contact.name.split(' ')[0]} yet.
                </div>
              ) : (
                <div className="space-y-1">
                  {history.slice(0, 20).map((call) => (
                    <button
                      key={call.id}
                      onClick={() => onOpenCall(call.id)}
                      className="flex w-full items-center gap-3 rounded-[10px] px-2 py-2 text-left transition-colors hover:bg-ink-700"
                    >
                      {call.direction === 'inbound' ? (
                        <PhoneIncoming className="h-4 w-4 shrink-0 text-sky" />
                      ) : (
                        <PhoneOutgoing className="h-4 w-4 shrink-0 text-signal" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-text-hi">{peerNumber(call)}</div>
                        <div className="font-mono text-[11px] text-text-low">
                          {format(new Date(call.startedAt), 'MMM d, HH:mm')}
                        </div>
                      </div>
                      <span
                        className={cn(
                          'text-xs',
                          call.status === 'missed'
                            ? 'text-danger'
                            : call.status === 'completed'
                              ? 'text-text-mid'
                              : 'text-amber'
                        )}
                      >
                        {call.status}
                      </span>
                      <span className="w-12 text-right font-mono text-xs text-text-mid">
                        {call.durationSec > 0 ? formatCallDuration(call.durationSec) : '—'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )
      )}
    </Drawer>
  );
}

const inputCls =
  'w-full rounded-[10px] border border-line bg-ink-800 px-3 py-2 text-sm text-text-hi outline-none transition-colors placeholder:text-text-low focus:border-signal/50';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="label-caps mb-1.5">{label}</div>
      {children}
    </div>
  );
}
