import { ArtistCard } from '../components/Cards';
import { ErrorState, Skeleton } from '../components/Section';
import { useArtists } from '../lib/queries';
import { useIncremental } from '../lib/useIncremental';
import { gridItem, PageTitle } from './Albums';

export function ArtistsPage() {
  const { data, error, isPending } = useArtists();
  const { visible, more, sentinel } = useIncremental(data);
  return (
    <div className="px-5 pt-8 md:px-10 md:pt-14">
      <PageTitle title="Artists" count={data?.length} />
      {error ? (
        <ErrorState error={error} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:gap-6 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {isPending
              ? Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-[4/5]" />)
              : visible.map((a, i) => <ArtistCard key={a.id} artist={a} {...gridItem(i)} />)}
          </div>
          {more && <div ref={sentinel} aria-hidden className="h-px" />}
        </>
      )}
    </div>
  );
}
