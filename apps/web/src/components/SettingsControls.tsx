import { useId, type KeyboardEvent, type ReactNode } from 'react';
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

/** Shown in place of settings that can only be seen and changed from the home network. */
export function AwayNotice({ children }: { children?: ReactNode }) {
  return (
    <p className="mb-6 rounded-lg border border-line px-4 py-3 text-sm text-paper-dim">
      {children ?? 'You’re using Playarr from outside your home network, so settings are read-only.'}
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

const STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Keyboard for a radiogroup of buttons: arrows move and choose, Home and End jump.
 * Only the chosen option is in the tab order (or the first, when none is).
 */
export function radioKeys<T>(values: readonly T[], current: T, onChange: (v: T) => void) {
  const index = values.indexOf(current);
  return {
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      const n = values.length;
      const next =
        e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : STEPS[e.key] ? (Math.max(index, 0) + STEPS[e.key]! + n) % n : -1;
      if (next < 0) return;
      e.preventDefault();
      onChange(values[next]!);
      e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
    },
    tabIndexFor: (i: number) => (i === (index < 0 ? 0 : index) ? 0 : -1),
  };
}

/** A few choices as pills, like Playback's "Keep up to". */
export function PillGroup<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const keys = radioKeys(
    options.map((o) => o.value),
    value,
    onChange,
  );
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={keys.onKeyDown} className="flex flex-wrap gap-1.5">
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={keys.tabIndexFor(i)}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-8 rounded-full border px-3.5 font-mono text-[11px] tracking-wider uppercase transition',
            value === o.value ? 'border-accent bg-accent text-accent-ink' : 'border-line text-paper-dim hover:border-paper/25',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-mono text-[11px] tracking-[0.2em] text-muted uppercase">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-muted">{hint}</span>}
    </label>
  );
}
