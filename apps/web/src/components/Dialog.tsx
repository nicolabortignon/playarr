import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';

/** Modal dialog: a bottom sheet on phones, a centered card on larger screens. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** A larger card on desktop, for grids. */
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // Callers often pass a new onClose on every render (polling parents re-render every few seconds).
  // Keep the latest in a ref so the effect below runs only when the dialog opens or closes: re-running
  // it would move focus back to the first field and scroll the dialog to the top.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    window.addEventListener('keydown', onKey);
    // Focus the first field or button inside, and restore focus when closing.
    requestAnimationFrame(() =>
      panel.current?.querySelector<HTMLElement>('input, button:not([aria-label="Close"])')?.focus({ preventScroll: true }),
    );
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.({ preventScroll: true });
    };
  }, [open]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[140] flex items-end justify-center sm:items-center sm:p-6">
          <motion.div
            className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal
            aria-label={title}
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            transition={{ type: 'spring', damping: 32, stiffness: 380 }}
            className={cn(
              'relative flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-ink-850 pb-[env(safe-area-inset-bottom)] shadow-2xl shadow-black/60 sm:rounded-2xl sm:pb-0',
              wide ? 'sm:max-w-3xl' : 'sm:max-w-md',
            )}
          >
            <header className="flex items-center justify-between border-b border-line px-5 py-4">
              <h2 className="font-display text-2xl leading-none text-paper">{title}</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-paper/8 hover:text-paper"
              >
                <X className="size-5" />
              </button>
            </header>
            <div data-dialog-body className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
