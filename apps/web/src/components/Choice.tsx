import type { KeyboardEvent } from 'react';
import { cn } from '../lib/cn';

const STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Keyboard for a radiogroup of buttons: arrows move and choose, Home and End jump.
 * Only the chosen option is in the tab order (or the first, when none is).
 * Options this device can't use (`enabled` false) are stepped over.
 */
export function radioKeys<T>(values: readonly T[], current: T, onChange: (v: T) => void, enabled: (v: T) => boolean = () => true) {
  const index = values.indexOf(current);
  return {
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      const n = values.length;
      const step = e.key === 'Home' || e.key === 'End' ? 0 : STEPS[e.key];
      if (step === undefined) return;
      // Home and End look from either end inwards; arrows from the current option onwards.
      const from = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (Math.max(index, 0) + step + n) % n;
      const direction = e.key === 'Home' ? 1 : e.key === 'End' ? -1 : step;
      let next = -1;
      for (let i = 0, at = from; i < n; i++, at = (at + direction + n) % n) {
        if (enabled(values[at]!)) {
          next = at;
          break;
        }
      }
      if (next < 0) return;
      e.preventDefault();
      onChange(values[next]!);
      e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
    },
    tabIndexFor: (i: number) => (i === (index < 0 ? 0 : index) ? 0 : -1),
  };
}

/**
 * One of a few choices, as the mono capitals pills (docs/design.md, Controls): Albums' sort, Stats' ranges, Transitions.
 * The chosen one is filled with paper. On a phone the row never wraps: it scrolls sideways.
 */
export function Choice<T extends string | number>({
  label,
  options,
  value,
  onChange,
  disabled,
  className,
}: {
  /** The group's name, for screen readers ("Sort albums"). */
  label: string;
  /** An option `disabled` stays visible but can't be chosen, e.g. something this device can't do (its `title` says why). */
  options: readonly { value: T; label: string; disabled?: boolean; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  /** E.g. to run the row to the screen's edges on a phone. */
  className?: string;
}) {
  const keys = radioKeys(
    options.map((o) => o.value),
    value,
    onChange,
    (v) => !options.find((o) => o.value === v)?.disabled,
  );
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={disabled ? undefined : keys.onKeyDown}
      // The padding keeps focus rings and the 44 px tap targets clear of the edges the row scrolls within.
      className={cn('scrollbar-none -m-1.5 flex gap-1.5 overflow-x-auto p-1.5 md:flex-wrap', disabled && 'opacity-40', className)}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={keys.tabIndexFor(i)}
          disabled={disabled || o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'relative h-8 shrink-0 rounded-full border px-3.5 type-kicker whitespace-nowrap transition tap-target',
            // The whole group dims itself when disabled; a single option dims on its own.
            o.disabled && !disabled && 'opacity-40',
            value === o.value ? 'border-paper bg-paper text-ink-900' : 'border-line text-muted enabled:hover:border-paper/25 enabled:hover:text-paper',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
