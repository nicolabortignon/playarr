import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * A name and the numbers about it ("Massive Attack" and "10 h 10 min · 105 plays") on one line when both fit, else the
 * numbers go under the name. The name is cut short only once the numbers have a line of their own: a name never loses
 * to numbers. After the name, a dot sets the numbers apart; it's clipped away when they start a line. With `end`, they
 * sit at the line's far end instead (a ranking). With `together`, they never leave the name's line, which is cut short
 * first: under a title of its own, where a third line can't be had (the queue's column beside the page).
 */
export function NameAndNumbers({
  name,
  numbers,
  end,
  together,
  className,
  nameClassName,
  numbersClassName,
}: {
  /** None (a download without a subtitle): just the numbers. */
  name?: ReactNode;
  numbers: ReactNode;
  end?: boolean;
  together?: boolean;
  className?: string;
  nameClassName?: string;
  numbersClassName?: string;
}) {
  const named = name !== undefined && name !== null && name !== '';
  return (
    <span
      className={cn(
        'flex min-w-0 items-baseline gap-x-3',
        together ? 'flex-nowrap' : 'flex-wrap',
        end ? 'justify-between' : 'overflow-hidden',
        className,
      )}
    >
      {named && <span className={cn('max-w-full min-w-0 truncate', nameClassName)}>{name}</span>}
      <span
        className={cn(
          'relative',
          together ? 'shrink-0' : 'min-w-0',
          named && !end && 'before:absolute before:right-full before:mr-1 before:content-["·"]',
          numbersClassName,
        )}
      >
        {numbers}
      </span>
    </span>
  );
}
