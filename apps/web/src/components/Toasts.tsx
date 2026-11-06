import { AnimatePresence, motion } from 'motion/react';
import { cn } from '../lib/cn';
import { useToasts, type Toast } from '../lib/toast';
import { Button } from './Button';

const BOX = 'pointer-events-auto max-w-md rounded-lg border px-4 py-2.5 text-left text-sm shadow-2xl shadow-black/50 backdrop-blur-xl';
const TONES: Record<Toast['tone'], string> = {
  info: 'border-line bg-ink-700/90 text-paper',
  error: 'border-danger/40 bg-ink-700/90 text-danger',
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

/**
 * A toast with a button. Reload stays until it's used or put off (Later); an Undo goes by itself after a while, but
 * not while it's pointed at or has the focus, so the button can still be reached.
 */
function ActionToast({
  toast,
  action,
  dismiss,
}: {
  toast: Toast;
  action: NonNullable<Toast['action']>;
  dismiss: () => void;
}) {
  const hold = useToasts((s) => s.hold);
  const timed = !!toast.timeout;
  return (
    <motion.div
      {...motionProps}
      role="status"
      onPointerEnter={timed ? () => hold(toast.id, true) : undefined}
      onPointerLeave={timed ? () => hold(toast.id, false) : undefined}
      onFocus={timed ? () => hold(toast.id, true) : undefined}
      onBlur={timed ? () => hold(toast.id, false) : undefined}
      className={cn(BOX, 'flex items-center gap-4', TONES[toast.tone])}
    >
      <span>{toast.message}</span>
      <span className="ml-auto flex shrink-0 gap-1">
        <Button
          variant="primary"
          size="small"
          onClick={() => {
            dismiss();
            action.run();
          }}
        >
          {action.label}
        </Button>
        {!timed && (
          <Button variant="ghost" size="small" onClick={dismiss}>
            Later
          </Button>
        )}
      </span>
    </motion.div>
  );
}
