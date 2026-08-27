import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { Check, Loader2, Phone, PhoneIncoming, PhoneOutgoing } from 'lucide-react';
import { toast } from 'sonner';
import Drawer from '@/components/Drawer';
import CallAvatar from '@/components/CallAvatar';
import StatusPill from '@/components/StatusPill';
import { trpc } from '@/providers/trpc';
import { formatCallDuration } from '@/lib/telephony';
import { cn } from '@/lib/utils';
import { estimatedCost, eventLabel, eventSuffix, peerNumber, statusPillOf } from './shared';

export interface CallDetailDrawerProps {
  callId: number | null;
  onClose: () => void;
  onRedial: (number: string, name: string | null) => void;
}

/**
 * Agent-facing call detail: parties, lifecycle event timeline, note editor,
 * recording metadata and the simulated cost estimate.
 */
export default function CallDetailDrawer({ callId, onClose, onRedial }: CallDetailDrawerProps) {
  const utils = trpc.useUtils();
  const detailQuery = trpc.telephony.calls.getById.useQuery(
    { id: callId ?? 0 },
    { enabled: callId != null }
  );
  const addNoteMut = trpc.telephony.calls.addNote.useMutation({
    onSuccess: async () => {
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1200);
      await utils.telephony.calls.getById.invalidate();
    },
    onError: (e) => toast.error('Could not save note', { description: e.message }),
  });

  const detail = detailQuery.data ?? null;
  const call = detail?.call ?? null;

  const [note, setNote] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  useEffect(() => {
    setNote(call?.note ?? '');
    setSavedFlash(false);
  }, [call?.id, call?.note]);

  const pill = call ? statusPillOf(call.status) : null;
  const peer = call ? peerNumber(call) : '';

  return (
    <Drawer
      open={callId != null}
      onClose={onClose}
      title={
        call ? (
          <span className="flex items-center gap-2">
            {call.direction === 'inbound' ? (
              <PhoneIncoming className="h-4 w-4 text-sky" />
            ) : (
              <PhoneOutgoing className="h-4 w-4 text-signal" />
            )}
            {call.contactName ?? peer}
          </span>
        ) : (
          'Call details'
        )
      }
      footer={
        call && (
          <div className="flex justify-end">
            <button
              onClick={() => {
                onClose();
                onRedial(peer, call.contactName);
              }}
              className="flex items-center gap-2 rounded-[10px] bg-signal px-4 py-2 text-sm font-semibold text-ink-950 transition-transform hover:scale-[1.02] active:scale-[0.97]"
            >
              <Phone className="h-4 w-4" />
              Redial
            </button>
          </div>
        )
      }
    >
      {callId != null && detailQuery.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-[10px] border border-line bg-ink-800" />
          ))}
        </div>
      ) : !call ? (
        <div className="py-10 text-center text-sm text-text-low">Call not found.</div>
      ) : (
        <div className="space-y-5">
          {/* parties */}
          <div className="flex items-center gap-3">
            <CallAvatar name={call.contactName ?? peer} size={56} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-display text-lg font-semibold text-text-hi">
                {call.contactName ?? 'Unknown'}
              </div>
              <div className="truncate font-mono text-xs text-text-mid">{peer}</div>
            </div>
            {pill && <StatusPill variant={pill.variant} label={pill.label} />}
          </div>

          {/* meta grid */}
          <div className="grid grid-cols-2 gap-2">
            {[
              ['Direction', call.direction === 'inbound' ? 'Inbound' : 'Outbound'],
              ['Duration', call.durationSec > 0 ? formatCallDuration(call.durationSec) : '—'],
              ['Started', format(new Date(call.startedAt), 'MMM d, HH:mm:ss')],
              ['Est. cost', estimatedCost(call.durationSec)],
            ].map(([k, v]) => (
              <div key={k} className="rounded-[10px] border border-line bg-ink-800 px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-[0.08em] text-text-low">{k}</div>
                <div className="mt-1 font-mono text-[13px] text-text-hi">{v}</div>
              </div>
            ))}
          </div>

          {/* recording */}
          {detail?.recording && (
            <div className="flex items-center justify-between rounded-[10px] border border-violet/30 bg-violet/5 px-3 py-2.5">
              <span className="text-sm text-text-hi">Recording</span>
              <span className="font-mono text-xs text-violet">
                {formatCallDuration(detail.recording.durationSec)}
              </span>
            </div>
          )}

          {/* note editor */}
          <div>
            <div className="label-caps mb-1.5">Note</div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Add a note for this call…"
              className="w-full resize-none rounded-[10px] border border-line bg-ink-800 px-3 py-2 text-sm text-text-hi outline-none transition-colors placeholder:text-text-low focus:border-signal/50"
            />
            <div className="mt-1.5 flex justify-end">
              <button
                onClick={() => addNoteMut.mutate({ callId: call.id, note })}
                disabled={addNoteMut.isPending || note === (call.note ?? '')}
                className={cn(
                  'flex items-center gap-1.5 rounded-[10px] border px-3 py-1.5 text-xs transition-colors',
                  savedFlash
                    ? 'border-signal/40 bg-signal/10 text-signal'
                    : 'border-line text-text-mid hover:text-text-hi disabled:opacity-50'
                )}
              >
                {addNoteMut.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : savedFlash ? (
                  <Check className="h-3.5 w-3.5" />
                ) : null}
                {savedFlash ? 'Saved' : 'Save note'}
              </button>
            </div>
          </div>

          {/* event timeline */}
          <div>
            <div className="label-caps mb-2">Timeline</div>
            {detail?.events.length ? (
              <ol className="relative space-y-0 border-l border-line pl-4">
                {detail.events.map((ev) => (
                  <li key={ev.id} className="relative pb-3 last:pb-0">
                    <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-signal" />
                    <div className="text-[13px] text-text-hi">
                      {eventLabel(ev.type)}
                      <span className="text-text-low">{eventSuffix(ev.payload)}</span>
                    </div>
                    <div className="font-mono text-[11px] text-text-low">
                      {format(new Date(ev.createdAt), 'HH:mm:ss')}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="py-3 text-xs text-text-low">No events recorded.</div>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}
