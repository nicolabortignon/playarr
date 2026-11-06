import { ArtistCard } from '../components/Cards';
import { PageHeader } from '../components/PageHeader';
import { ErrorState, Skeleton } from '../components/Section';
import { useArtists } from '../lib/queries';
import { useIncremental } from '../lib/useIncremental';
import { GRID, gridItem } from './Albums';

export function ArtistsPage() {
  const { data, error, isPending, refetch } = useArtists();
  const { visible, more, sentinel } = useIncremental(data);
  return (
    <div className="px-5 pt-8 md:px-10 md:pt-14">
      <PageHeader title="Artists" count={data?.length} />
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <>
          <div className={GRID}>
            {isPending
              ? Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-square rounded-full" />)
              : visible.map((a, i) => <ArtistCard key={a.id} artist={a} {...gridItem(i)} />)}
          </div>
          {more && <div ref={sentinel} aria-hidden className="h-px" />}
        </>
      )}
    </div>
  );
}
