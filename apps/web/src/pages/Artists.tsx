import { Mic2 } from 'lucide-react';
import { ArtistCard } from '../components/Cards';
import { PageHeader } from '../components/PageHeader';
import { CardSkeletons, ErrorState } from '../components/States';
import { useArtists } from '../lib/queries';
import { useIncremental } from '../lib/useIncremental';
import { EmptyLibrary, GRID, gridItem } from './Albums';

export function ArtistsPage() {
  const { data, error, isPending, refetch } = useArtists();
  const { visible, more, sentinel } = useIncremental(data);
  return (
    <div className="px-5 pt-8 md:px-10 md:pt-14">
      <PageHeader title="Artists" count={data?.length || undefined} />
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data && !data.length ? (
        <EmptyLibrary icon={Mic2} title="Nobody on the roster yet." />
      ) : (
        <>
          <div className={GRID}>
            {isPending ? <CardSkeletons round /> : visible.map((a, i) => <ArtistCard key={a.id} artist={a} {...gridItem(i)} />)}
          </div>
          {more && <div ref={sentinel} aria-hidden className="h-px" />}
        </>
      )}
    </div>
  );
}
