import type { AlbumSort } from '@playarr/shared';
import { useSearchParams } from 'react-router';
import type { CSSProperties, ReactNode } from 'react';
import { AlbumCard } from '../components/Cards';
import { ErrorState, Skeleton } from '../components/Section';
import { cn } from '../lib/cn';
import { useAlbums } from '../lib/queries';
import { useIncremental } from '../lib/useIncremental';

const SORTS: { value: AlbumSort; label: string }[] = [
  { value: 'artist', label: 'Artist' },
  { value: 'title', label: 'Title' },
  { value: 'year', label: 'Year' },
  { value: 'added', label: 'Recently added' },
];

export const GRID = 'grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 md:gap-x-6 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6';

/** How many grid cards rise in when a page opens: the first screenful. The rest just appear. */
const ANIMATED = 18;

/**
 * Props for the i-th card of a long grid: a short staggered entrance for the first screenful only (a delay
 * per card across hundreds of them left cards blank for seconds), and off-screen cards skipped by the browser.
 */
export function gridItem(i: number, { lift = false } = {}): { className: string; style?: CSSProperties } {
  const base = lift ? 'offscreen-skip offscreen-skip-lift' : 'offscreen-skip';
  return i < ANIMATED ? { className: base, style: { animationDelay: `${i * 25}ms` } } : { className: `${base} animate-none` };
}

export function PageTitle({ title, count, children }: { title: string; count?: number; children?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-4 md:mb-10">
      <h1 className="flex items-baseline gap-3 font-display text-5xl leading-none text-paper md:text-7xl">
        {title}
        {count !== undefined && <span className="font-mono text-sm tracking-normal text-muted">{count}</span>}
      </h1>
      {children}
    </header>
  );
}

export function AlbumsPage() {
  const [params, setParams] = useSearchParams();
  const sort = (SORTS.find((s) => s.value === params.get('sort'))?.value ?? 'artist') as AlbumSort;
  const { data, error, isPending } = useAlbums(sort);
  const { visible, more, sentinel } = useIncremental(data, { resetKey: sort });

  return (
    <div className="px-5 pt-8 md:px-10 md:pt-14">
      <PageTitle title="Albums" count={data?.length}>
        <div role="radiogroup" aria-label="Sort albums" className="scrollbar-none -mx-5 flex gap-1.5 overflow-x-auto px-5 md:mx-0 md:px-0">
          {SORTS.map((s) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={sort === s.value}
              onClick={() => setParams(s.value === 'artist' ? {} : { sort: s.value }, { replace: true })}
              className={cn(
                'h-8 shrink-0 rounded-full border px-3.5 font-mono text-[11px] tracking-wider uppercase transition',
                sort === s.value ? 'border-accent bg-accent text-accent-ink' : 'border-line text-paper-dim hover:border-paper/25',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </PageTitle>
      {error ? (
        <ErrorState error={error} />
      ) : (
        <>
          <div className={GRID}>
            {isPending
              ? Array.from({ length: 12 }, (_, i) => <Skeleton key={i} className="aspect-square" />)
              : visible.map((a, i) => <AlbumCard key={a.id} album={a} {...gridItem(i, { lift: true })} />)}
          </div>
          {more && <div ref={sentinel} aria-hidden className="h-px" />}
        </>
      )}
    </div>
  );
}
