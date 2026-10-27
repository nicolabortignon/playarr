import { AnimatePresence, motion } from 'motion/react';
import { cn } from '../lib/cn';
import { useToasts } from '../lib/toast';

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-[max(env(safe-area-inset-top),0.75rem)] z-[160] flex flex-col items-center gap-2 px-4 md:top-auto md:bottom-[104px]"
    >
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.button
            key={t.id}
            type="button"
            layout
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            onClick={() => dismiss(t.id)}
            className={cn(
              'pointer-events-auto max-w-md rounded-lg border px-4 py-2.5 text-left text-sm shadow-2xl shadow-black/50 backdrop-blur-xl',
              t.tone === 'error' ? 'border-red-400/30 bg-red-950/80 text-red-100' : 'border-line bg-ink-700/90 text-paper',
            )}
          >
            {t.message}
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}
