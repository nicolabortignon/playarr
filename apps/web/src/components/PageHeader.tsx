import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * The header of a tab or a library list (Albums, Artists, Playlists, Downloads, Queue, Library…): the page's name as a
 * large title, how many it holds beside it, and the page's own controls (sort, filter, a button) on the right, which
 * go under the title when they don't fit beside it. The same spacing on every page.
 */
export function PageHeader({
  title,
  count,
  kicker,
  actions,
  description,
  className,
}: {
  /** The page's name: its h1. */
  title: ReactNode;
  /** How many it holds, once known. Beside the title, not in it: the heading's name stays the page's. */
  count?: number;
  /** A line above the title. */
  kicker?: ReactNode;
  /** The page's own controls: Albums' sort, Made for you's "Tune your mixes". */
  actions?: ReactNode;
  /** A sentence under the title saying what the page is for. */
  description?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('mb-8 md:mb-10', className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          {kicker && <div className="mb-2 type-kicker text-muted">{kicker}</div>}
          <div className="flex items-baseline gap-3">
            <h1 className="min-w-0 type-page-title text-paper">{title}</h1>
            {count !== undefined && <span className="type-meta text-muted">{count}</span>}
          </div>
        </div>
        {actions}
      </div>
      {description && <p className="mt-3 max-w-xl type-body text-paper-dim">{description}</p>}
    </header>
  );
}
