import { useId, type ReactNode } from 'react';
import { cn } from '../lib/cn';

/** One block of a Settings panel: a small mono heading, an optional explanation, then its controls. */
export function SettingsSection({
  title,
  description,
  className,
  children,
}: {
  title: string;
  description?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn('mt-12 max-w-prose first:mt-0', className)}>
      <h2 id={id} className="mb-2 font-mono text-[11px] tracking-[0.2em] text-muted uppercase">
        {title}
      </h2>
      {description && <p className="mb-4 text-sm text-muted">{description}</p>}
      {children}
    </section>
  );
}

/** Shown in place of settings only an admin can see and change. */
export function AwayNotice({ children }: { children?: ReactNode }) {
  return (
    <p className="mb-6 rounded-lg border border-line px-4 py-3 text-sm text-paper-dim">
      {children ?? 'Only an admin can change these settings.'}
    </p>
  );
}

/** An on/off setting: the label and a one-line explanation, with the switch on the right. */
export function Switch({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="min-w-0">
        <div id={`${id}-label`} className="text-[15px] text-paper">
          {label}
        </div>
        {description && (
          <p id={`${id}-description`} className="mt-0.5 text-[13px] text-muted">
            {description}
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-description` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
          checked ? 'bg-accent' : 'bg-paper/15 hover:bg-paper/20',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'inline-block size-5 rounded-full shadow transition-transform',
            checked ? 'translate-x-[22px] bg-accent-ink' : 'translate-x-0.5 bg-paper',
          )}
        />
      </button>
    </div>
  );
}
