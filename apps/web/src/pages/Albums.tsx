import type { Album, AlbumFilters, AlbumPage, AlbumSort, Fidelity } from '@playarr/shared';
import { ChevronDown, Disc3, FolderPlus, ListFilter, type LucideIcon } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { useEffect, useMemo, type CSSProperties } from 'react';
import { AlbumCard } from '../components/Cards';
import { Choice } from '../components/Choice';
import { PageHeader } from '../components/PageHeader';
import { CardSkeletons, EmptyState, ErrorState } from '../components/States';
import { cn } from '../lib/cn';
import { useAlbumFilters, useAlbumPages, useIsMember } from '../lib/queries';
import { useLoadMore } from '../lib/useIncremental';

const SORTS: { value: AlbumSort; label: string }[] = [
  { value: 'artist', label: 'Artist' },
  { value: 'title', label: 'Title' },
  { value: 'year', label: 'Year' },
  { value: 'added', label: 'Recently added' },
];

const FIDELITY_LABELS: Record<Fidelity, string> = { 'hi-res': 'Hi-Res', lossless: 'Lossless', lossy: 'Lossy' };

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
  const genre = params.get('genre') || undefined;
  const fidelity = (Object.keys(FIDELITY_LABELS) as Fidelity[]).find((f) => f === params.get('fidelity'));
  const filtered = !!genre || !!fidelity;
  /** The address with these changed: the defaults left out, so a plain /albums is the whole list by artist. */
  const show = (next: { sort?: AlbumSort; genre?: string; fidelity?: Fidelity }) => {
    const all = { sort, genre, fidelity, ...next };
    setParams(
      {
        ...(all.sort !== 'artist' ? { sort: all.sort } : {}),
        ...(all.genre ? { genre: all.genre } : {}),
        ...(all.fidelity ? { fidelity: all.fidelity } : {}),
      },
      { replace: true },
    );
  };
  // A page at a time from the server, the next as the end of the grid comes near: a library of 10,000 albums
  // opens with its first 120, not all of them.
  const { data, error, isPending, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useAlbumPages(sort, { genre, fidelity });
  const filters = useAlbumFilters().data;
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
        className={filters && (filtered || worthFiltering(filters)) ? 'mb-5 md:mb-6' : undefined}
        actions={
          <Choice
            label="Sort albums"
            options={SORTS}
            value={sort}
            onChange={(v) => show({ sort: v })}
            // On a phone the row scrolls from one edge of the screen to the other.
            className="-mx-5 px-5 md:-mx-1.5 md:px-1.5"
          />
        }
      />
      {filters && (filtered || worthFiltering(filters)) && (
        <AlbumFilterRow
          filters={filters}
          genre={genre}
          fidelity={fidelity}
          onGenre={(g) => show({ genre: g })}
          onFidelity={(f) => show({ fidelity: f })}
        />
      )}
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data && !total && filtered ? (
        <EmptyState
          icon={ListFilter}
          title={`No ${fidelity ? `${FIDELITY_LABELS[fidelity]} ` : ''}albums${genre ? ` in ${genre}` : ''} yet.`}
          action={{ label: 'Show all albums', onClick: () => show({ genre: undefined, fidelity: undefined }) }}
        />
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

/** Filters are offered once there's a choice to make: a genre, or albums of more than one fidelity. */
function worthFiltering(filters: AlbumFilters): boolean {
  return filters.genres.length > 0 || filters.fidelities.length > 1;
}

/**
 * The Albums page's filters, under its header: a genre (a menu, as a library may have hundreds) and a fidelity (the
 * pills). Each says how many albums it finds; a genre or fidelity no album has any more stays offered while it's chosen.
 */
function AlbumFilterRow({
  filters,
  genre,
  fidelity,
  onGenre,
  onFidelity,
}: {
  filters: AlbumFilters;
  genre: string | undefined;
  fidelity: Fidelity | undefined;
  onGenre: (genre: string | undefined) => void;
  onFidelity: (fidelity: Fidelity | undefined) => void;
}) {
  const chosen = genre && filters.genres.find((g) => g.name.toLowerCase() === genre.toLowerCase());
  const fidelities = filters.fidelities.some((f) => f.value === fidelity) || !fidelity ? filters.fidelities : [...filters.fidelities, { value: fidelity, count: 0 }];
  return (
    <div className="mb-8 flex flex-wrap items-center gap-x-3 gap-y-3 md:mb-10">
      {(filters.genres.length > 0 || genre) && (
        <span className="relative inline-flex">
          <select
            aria-label="Genre"
            value={chosen ? chosen.name : (genre ?? '')}
            onChange={(e) => onGenre(e.target.value || undefined)}
            className={cn(
              'h-8 max-w-64 appearance-none truncate rounded-full border pr-8 pl-3.5 type-kicker transition tap-target',
              genre ? 'border-paper bg-paper text-ink-900' : 'border-line bg-transparent text-muted hover:border-paper/25 hover:text-paper',
            )}
          >
            <option value="">All genres</option>
            {genre && !chosen && <option value={genre}>{genre}</option>}
            {filters.genres.map((g) => (
              <option key={g.name} value={g.name}>{`${g.name} · ${g.count}`}</option>
            ))}
          </select>
          <ChevronDown aria-hidden className={cn('pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2', genre ? 'text-ink-900' : 'text-muted')} />
        </span>
      )}
      {fidelities.length > 1 || fidelity ? (
        <Choice
          label="Quality"
          options={[{ value: 'any', label: 'Any quality' }, ...fidelities.map((f) => ({ value: f.value, label: FIDELITY_LABELS[f.value], title: `${f.count} ${f.count === 1 ? 'album' : 'albums'}` }))]}
          value={fidelity ?? 'any'}
          onChange={(v) => onFidelity(v === 'any' ? undefined : (v as Fidelity))}
          className="-mx-5 px-5 md:-mx-1.5 md:px-1.5"
        />
      ) : null}
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
