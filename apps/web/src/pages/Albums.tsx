import type { Album, AlbumPage, AlbumSort } from '@playarr/shared';
import { Disc3, FolderPlus, type LucideIcon } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { useEffect, useMemo, type CSSProperties } from 'react';
import { AlbumCard } from '../components/Cards';
import { Choice } from '../components/Choice';
import { PageHeader } from '../components/PageHeader';
import { CardSkeletons, EmptyState, ErrorState } from '../components/States';
import { useAlbumPages, useIsMember } from '../lib/queries';
import { useLoadMore } from '../lib/useIncremental';

const SORTS: { value: AlbumSort; label: string }[] = [
  { value: 'artist', label: 'Artist' },
  { value: 'title', label: 'Title' },
  { value: 'year', label: 'Year' },
  { value: 'added', label: 'Recently added' },
];

export const GRID = 'grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 md:gap-x-6 page-lg:grid-cols-4 page-xl:grid-cols-5 page-2xl:grid-cols-6';

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

export function AlbumsPage() {
  const [params, setParams] = useSearchParams();
  const sort = (SORTS.find((s) => s.value === params.get('sort'))?.value ?? 'artist') as AlbumSort;
  // A page at a time from the server, the next as the end of the grid comes near: a library of 10,000 albums
  // opens with its first 120, not all of them.
  const { data, error, isPending, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useAlbumPages(sort);
  const albums = useMemo(() => uniqueAlbums(data?.pages ?? []), [data]);
  const total = data?.pages[0]?.total;
  // A page read after the library changed: those before it may have moved, so they're all read again.
  const moved = !!data && data.pages.some((page) => page.version !== data.pages[0]!.version);
  useEffect(() => {
    if (moved) void refetch();
  }, [moved, refetch]);
  const sentinel = useLoadMore({
    count: albums.length,
    more: !!hasNextPage && !isFetchingNextPage && !moved,
    load: () => void fetchNextPage(),
  });

  return (
    <div className="px-5 pt-8 md:px-10 md:pt-14">
      <PageHeader
        title="Albums"
        count={total || undefined}
        actions={
          <Choice
            label="Sort albums"
            options={SORTS}
            value={sort}
            onChange={(v) => setParams(v === 'artist' ? {} : { sort: v }, { replace: true })}
            // On a phone the row scrolls from one edge of the screen to the other.
            className="-mx-5 px-5 md:-mx-1.5 md:px-1.5"
          />
        }
      />
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data && !total ? (
        <EmptyLibrary icon={Disc3} title="Your crates are empty." />
      ) : (
        <>
          <div className={GRID}>
            {isPending ? <CardSkeletons /> : albums.map((a, i) => <AlbumCard key={a.id} album={a} {...gridItem(i, { lift: true })} />)}
          </div>
          {hasNextPage && <div ref={sentinel} aria-hidden className="h-px" />}
        </>
      )}
    </div>
  );
}

/** The pages' albums in order, each once: while pages read across a change are read again, one may be on two. */
export function uniqueAlbums(pages: AlbumPage[]): Album[] {
  const seen = new Set<number>();
  return pages.flatMap((page) => page.albums.filter((album) => !seen.has(album.id) && !!seen.add(album.id)));
}

/**
 * Albums or Artists with nothing in the library yet: where music comes from. An admin is offered Settings → Sources;
 * anyone else, that an admin adds it.
 */
export function EmptyLibrary({ icon, title }: { icon: LucideIcon; title: string }) {
  const member = useIsMember();
  return member ? (
    <EmptyState icon={icon} title={title} hint="Music shows up here once an admin adds some." />
  ) : (
    <EmptyState
      icon={icon}
      title={title}
      hint="Add Lidarr or a folder of music, and it shows up here."
      action={{ label: 'Add music', icon: <FolderPlus />, to: '/settings/sources' }}
    />
  );
}
