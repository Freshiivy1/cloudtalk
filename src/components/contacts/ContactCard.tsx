import { motion } from 'framer-motion';
import { formatDistanceToNow } from 'date-fns';
import { Building2, Phone, Star } from 'lucide-react';
import CallAvatar from '@/components/CallAvatar';
import { cn } from '@/lib/utils';
import type { Contact } from './shared';

const TAG_STYLES: Record<Contact['tag'], string> = {
  vip: 'border-amber/40 bg-amber/10 text-amber',
  lead: 'border-sky/40 bg-sky/10 text-sky',
  customer: 'border-signal/30 bg-signal/10 text-signal',
  supplier: 'border-violet/40 bg-violet/10 text-violet',
};

const TAG_LABELS: Record<Contact['tag'], string> = {
  vip: 'VIP',
  lead: 'Lead',
  customer: 'Customer',
  supplier: 'Supplier',
};

export interface ContactCardProps {
  contact: Contact;
  /** epoch ms of the most recent call with this contact, if any */
  lastCallAt: number | null;
  selected?: boolean;
  onOpen: (contact: Contact) => void;
  onDial: (contact: Contact) => void;
  onToggleFavorite: (contact: Contact) => void;
}

export default function ContactCard({
  contact,
  lastCallAt,
  selected = false,
  onOpen,
  onDial,
  onToggleFavorite,
}: ContactCardProps) {
  return (
    <div
      onClick={() => onOpen(contact)}
      className={cn(
        'group relative cursor-pointer rounded-[14px] border bg-ink-900 p-4 transition-colors',
        selected ? 'border-signal/60' : 'border-line hover:border-signal/30'
      )}
    >
      <div className="flex items-start gap-3">
        <CallAvatar name={contact.name} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-text-hi">{contact.name}</span>
            <span
              className={cn(
                'shrink-0 rounded-full border px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.08em]',
                TAG_STYLES[contact.tag]
              )}
            >
              {TAG_LABELS[contact.tag]}
            </span>
          </div>
          {contact.company && (
            <div className="mt-0.5 flex items-center gap-1 truncate text-xs text-text-low">
              <Building2 className="h-3 w-3 shrink-0" />
              <span className="truncate">{contact.company}</span>
            </div>
          )}
          <div className="mt-1 truncate font-mono text-xs text-text-mid">{contact.phone}</div>
          <div className="mt-1 text-[11px] text-text-low">
            {lastCallAt
              ? `Last call ${formatDistanceToNow(new Date(lastCallAt), { addSuffix: true })}`
              : 'Never called'}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-center gap-1">
          <motion.button
            whileTap={{ scale: 0.85 }}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(contact);
            }}
            title={contact.favorite ? 'Remove from favorites' : 'Add to favorites'}
            className={cn(
              'rounded-lg p-1.5 transition-colors',
              contact.favorite ? 'text-amber' : 'text-text-low opacity-0 hover:text-amber group-hover:opacity-100'
            )}
          >
            <Star className={cn('h-4 w-4', contact.favorite && 'fill-amber')} />
          </motion.button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDial(contact);
            }}
            title={`Call ${contact.name}`}
            className="rounded-lg p-1.5 text-text-low opacity-0 transition-colors hover:bg-signal/10 hover:text-signal group-hover:opacity-100"
          >
            <Phone className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
