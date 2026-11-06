import { useSimilarArtists } from '../lib/queries';
import { DiscoverArtistCard } from './Cards';
import { SectionHeader, SHELF_CARD, Shelf, Skeleton } from './Section';

const stagger = (i: number) => ({ animationDelay: `${Math.min(i, 8) * 40}ms` });

/**
 * Artists like this one, from who real listeners play alongside them (ListenBrainz): those already in the
 * library (opening their page), then the others (opening their discography, to request albums).
 */
export function SimilarArtists({ mbid }: { mbid: string }) {
  const { data, error, isPending } = useSimilarArtists(mbid);

  if (isPending) {
    return (
      <section className="mb-14" aria-busy="true">
        <SectionHeader kicker="From ListenBrainz" title="Similar artists" />
        <Shelf>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className={`aspect-square rounded-full ${SHELF_CARD}`} />
          ))}
        </Shelf>
      </section>
    );
  }
  if (error) {
    return (
      <section className="mb-14">
        <SectionHeader kicker="From ListenBrainz" title="Similar artists" />
        <p className="text-sm text-muted">Couldn’t reach ListenBrainz for similar artists right now.</p>
      </section>
    );
  }
  const mine = data.filter((a) => a.artistId !== undefined);
  const others = data.filter((a) => a.artistId === undefined);
  return (
    <>
      {[
        { title: 'Similar artists in your library', items: mine },
        { title: mine.length ? 'More similar artists' : 'Similar artists', items: others },
      ]
        .filter((g) => g.items.length)
        .map((g) => (
          <section key={g.title} className="mb-14">
            <SectionHeader kicker="From ListenBrainz" title={g.title} />
            <Shelf>
              {g.items.map((a, i) => (
                <DiscoverArtistCard key={a.mbid} artist={a} className={SHELF_CARD} style={stagger(i)} />
              ))}
            </Shelf>
          </section>
        ))}
    </>
  );
}
