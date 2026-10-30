import { AnimatePresence, motion } from 'motion/react';
import { cn } from '../lib/cn';
import { useToasts, type Toast } from '../lib/toast';

const BOX = 'pointer-events-auto max-w-md rounded-lg border px-4 py-2.5 text-left text-sm shadow-2xl shadow-black/50 backdrop-blur-xl';
const TONES: Record<Toast['tone'], string> = {
  info: 'border-line bg-ink-700/90 text-paper',
  error: 'border-red-400/30 bg-red-950/80 text-red-100',
};
const motionProps = {
  layout: true,
  initial: { opacity: 0, y: 12, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, scale: 0.96 },
} as const;

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-[max(env(safe-area-inset-top),0.75rem)] z-[160] flex flex-col items-center gap-2 px-4 md:top-auto md:bottom-[104px]"
    >
      <AnimatePresence>
        {toasts.map((t) =>
          t.action ? (
            <ActionToast key={t.id} toast={t} action={t.action} dismiss={() => dismiss(t.id)} />
          ) : (
            <motion.button
              key={t.id}
              type="button"
              {...motionProps}
              onClick={() => dismiss(t.id)}
              className={cn(BOX, TONES[t.tone])}
            >
              {t.message}
            </motion.button>
          ),
        )}
      </AnimatePresence>
    </div>
  );
}

/** A toast with a button (Reload…): it stays until the button is used or it's dismissed. */
function ActionToast({
  toast,
  action,
  dismiss,
}: {
  toast: Toast;
  action: NonNullable<Toast['action']>;
  dismiss: () => void;
}) {
  return (
    <motion.div
      {...motionProps}
      role="status"
      className={cn(BOX, 'flex items-center gap-4', TONES[toast.tone])}
    >
      <span>{toast.message}</span>
      <span className="ml-auto flex shrink-0 gap-1">
        <button
          type="button"
          onClick={() => {
            dismiss();
            action.run();
          }}
          className="rounded-full px-3 py-1 font-mono text-[11px] tracking-wider text-accent uppercase transition hover:bg-accent/10"
        >
          {action.label}
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="rounded-full px-3 py-1 font-mono text-[11px] tracking-wider text-muted uppercase transition hover:text-paper"
        >
          Later
        </button>
      </span>
    </motion.div>
  );
}
