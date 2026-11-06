import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cn } from '../lib/cn';

/** The field itself (docs/design.md, Controls): 44 tall, radius 12, the accent ring when focused. Also for a `<select>`. */
export const fieldClass =
  'h-11 w-full min-w-0 rounded-panel border border-line bg-ink-850 px-3 type-body text-paper outline-none transition placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-40';

type TextFieldProps = Omit<ComponentPropsWithRef<'input'>, 'children'> & {
  /** Above the field; a field always has one, even when it's only for screen readers (`hideLabel`). */
  label: ReactNode;
  hideLabel?: boolean;
  /** A line under the field: what to type, or where to find it. Read out after the label, not as part of it. */
  hint?: ReactNode;
  /** In DM Mono, for keys and paths. */
  mono?: boolean;
  /** In place of the text input, another control under the same label: a `<select>`, say. */
  children?: ReactNode;
};

/** A labeled text field. `className` is for the whole of it (label, field and hint), e.g. its width in a row. */
export function TextField({ label, hideLabel, hint, mono, className, children, ...input }: TextFieldProps) {
  const hintId = useId();
  return (
    <div className={className}>
      <label className="block">
        <span className={cn('mb-1.5 block type-small text-muted', hideLabel && 'sr-only')}>{label}</span>
        {children ?? <input aria-describedby={hint ? hintId : undefined} {...input} className={cn(fieldClass, mono && 'font-mono')} />}
      </label>
      {hint && (
        <p id={hintId} className="mt-1.5 type-small text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}
