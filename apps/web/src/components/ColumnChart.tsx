import { useId, useState } from 'react';
import { cn } from '../lib/cn';

/**
 * One measure across ordered categories (hours, weekdays, months) as columns: one color, the busiest
 * labelled, the rest on hover, and every value in a table for screen readers and whoever wants numbers.
 */
export function ColumnChart({
  title,
  values,
  labels,
  ticks,
  format,
  height = 140,
  className,
}: {
  title: string;
  values: number[];
  /** A full label per column (tooltip and table). */
  labels: string[];
  /** Which columns get an axis label underneath. */
  ticks?: (i: number) => boolean;
  format: (v: number) => string;
  height?: number;
  className?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const max = Math.max(...values, 1);
  const peak = values.indexOf(Math.max(...values));
  const shown = hover ?? peak;
  return (
    <figure className={cn('min-w-0', className)} aria-labelledby={id}>
      <figcaption id={id} className="mb-3 flex items-baseline justify-between gap-3">
        <span className="type-kicker text-muted">{title}</span>
        {values[shown]! > 0 && (
          <span className="type-small text-paper-dim tabular" aria-live="polite">
            {hover === null ? 'Most: ' : ''}
            <span className="text-paper">{labels[shown]}</span> · {format(values[shown]!)}
          </span>
        )}
      </figcaption>
      <div className="relative" style={{ height }} onPointerLeave={() => setHover(null)} aria-hidden>
        <div className="absolute inset-x-0 bottom-0 h-px bg-line" />
        <div className="absolute inset-0 flex items-end gap-[2px]">
          {values.map((v, i) => (
            // The whole slot is the hover target, however short the column.
            <div key={i} className="flex h-full min-w-0 flex-1 items-end justify-center" onPointerEnter={() => setHover(i)}>
              <div
                className={cn(
                  'w-full max-w-6 rounded-t-[4px] bg-accent transition-opacity duration-150',
                  hover !== null && hover !== i && 'opacity-45',
                )}
                style={{ height: v > 0 ? `max(${(v / max) * 100}%, 2px)` : 0 }}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="mt-1.5 flex gap-[2px]" aria-hidden>
        {labels.map((l, i) => (
          <span key={i} className="min-w-0 flex-1 text-center type-badge text-muted">
            {(ticks ? ticks(i) : true) ? l : ''}
          </span>
        ))}
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer type-kicker text-muted hover:text-paper">Numbers</summary>
        <table className="mt-2 w-full type-small">
          <tbody>
            {values.map((v, i) => (
              <tr key={i} className="border-b border-line/60">
                <th scope="row" className="py-1 text-left font-normal text-paper-dim">
                  {labels[i]}
                </th>
                <td className="py-1 text-right text-paper tabular">{format(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
