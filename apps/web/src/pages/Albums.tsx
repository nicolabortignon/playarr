import type { AlbumSort } from '@playarr/shared';
import { Disc3, FolderPlus, type LucideIcon } from 'lucide-react';
import { useSearchParams } from 'react-router';
import type { CSSProperties } from 'react';
import { AlbumCard } from '../components/Cards';
import { Choice } from '../components/Choice';
import { PageHeader } from '../components/PageHeader';
import { CardSkeletons, EmptyState, ErrorState } from '../components/States';
import { useAlbums, useIsMember } from '../lib/queries';
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

export function AlbumsPage() {
  const [params, setParams] = useSearchParams();
  const sort = (SORTS.find((s) => s.value === params.get('sort'))?.value ?? 'artist') as AlbumSort;
  const { data, error, isPending, refetch } = useAlbums(sort);
  const { visible, more, sentinel } = useIncremental(data, { resetKey: sort });

  return (
    <div className="px-5 pt-8 md:px-10 md:pt-14">
      <PageHeader
        title="Albums"
        count={data?.length || undefined}
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
      ) : data && !data.length ? (
        <EmptyLibrary icon={Disc3} title="Your crates are empty." />
      ) : (
        <>
          <div className={GRID}>
            {isPending ? <CardSkeletons /> : visible.map((a, i) => <AlbumCard key={a.id} album={a} {...gridItem(i, { lift: true })} />)}
          </div>
          {more && <div ref={sentinel} aria-hidden className="h-px" />}
        </>
      )}
    </div>
  );
}

/**
 * Albums or Artists with nothing in the library yet: where music comes from. An admin is offered Settings → Sources;
 * anyone else, that an admin adds it.
 */
export function EmptyLibrary({ icon, title }: { icon: LucideIcon; title: string }) {
  const member = useIsMember();
  return member ? (
    <EmptyState icon={icon} title={title} hint="Music shows up here once an admin adds some to the library." />
  ) : (
    <EmptyState
      icon={icon}
      title={title}
      hint="Add Lidarr or a folder of music, and it shows up here."
      action={{ label: 'Add music', icon: <FolderPlus />, to: '/settings/sources' }}
    />
  );
}
