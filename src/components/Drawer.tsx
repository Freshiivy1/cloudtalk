import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Header content — string or arbitrary node. */
  title?: ReactNode;
  /** Sticky footer row (actions). */
  footer?: ReactNode;
  /** Panel width in px (default 400). */
  width?: number;
  children?: ReactNode;
  className?: string;
}

/**
 * Right-edge slide-over panel shared by the admin console and the agent
 * workspace. Framer-motion spring in/out, backdrop click + Escape to close.
 */
export default function Drawer({
  open,
  onClose,
  title,
  footer,
  width = 400,
  children,
  className,
}: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="drawer-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-ink-950/60 backdrop-blur-[2px]"
          />
          <motion.aside
            key="drawer-panel"
            role="dialog"
            aria-modal="true"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 34 }}
            style={{ width, maxWidth: '100vw' }}
            className={cn(
              'fixed inset-y-0 right-0 z-50 flex flex-col border-l border-line bg-ink-900 shadow-2xl',
              className
            )}
          >
            <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0 truncate font-display text-base font-semibold text-text-hi">
                {title}
              </div>
              <button
                onClick={onClose}
                title="Close"
                className="shrink-0 rounded-lg p-1.5 text-text-low transition-colors hover:bg-ink-700 hover:text-text-hi"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="relative min-h-0 flex-1 overflow-y-auto px-5 py-5">
              {children}
            </div>

            {footer && (
              <div className="border-t border-line bg-ink-950/60 px-5 py-3.5">
                {footer}
              </div>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
