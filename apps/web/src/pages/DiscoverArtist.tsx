import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Button } from '../components/Button';
import { Cover } from '../components/Cover';
import { DetailHeader, DetailHeaderSkeleton, joinMeta } from '../components/DetailHeader';
import { DiscoverAlbumCard } from '../components/Discover';
import { BackButton, ErrorState, SectionHeader, Skeleton } from '../components/Section';
import { SimilarArtists } from '../components/SimilarArtists';
import { SlowLookup } from '../components/SlowLookup';
import { cn } from '../lib/cn';
import { plural } from '../lib/format';
import { titleKey } from '../lib/links';
import { useDiscoverArtist } from '../lib/queries';
import { GRID } from './Albums';

/** An artist's discography from MusicBrainz, with what's in the library and what can be requested. */
export function DiscoverArtistPage() {
  const mbid = useParams().mbid ?? '';
  const { data: artist, error, isPending, refetch, isFetching } = useDiscoverArtist(mbid);
  const [bioOpen, setBioOpen] = useState(false);
  const wantedAlbum = useSearchParams()[0].get('album');

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isPending || !artist) {
    return (
      <div className="px-5 pt-6 md:px-10 md:pt-14">
        <DetailHeaderSkeleton round />
        <SlowLookup active what="this artist’s albums" className="mt-6" />
        <div className={cn(GRID, 'mt-12')}>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="aspect-square" />
          ))}
        </div>
      </div>
    );
  }

  const owned = artist.albums.filter((a) => a.availability.state === 'available').length;
  const studio = artist.albums.filter((a) => a.type === 'Album');
  const eps = artist.albums.filter((a) => a.type !== 'Album');
  const highlight = wantedAlbum ? artist.albums.find((a) => titleKey(a.title) === titleKey(wantedAlbum))?.mbid : undefined;

  return (
    <div>
      <div className="relative px-5 pt-6 md:px-10 md:pt-14">
        <BackButton fallback="/search" className="absolute top-3 left-3 z-20" />
        <DetailHeader
          cover={<Cover src={artist.imageUrl} size={192} alt="" label={artist.name} eager className="w-full rounded-full shadow-cover-hero ring-1 ring-paper/10" />}
          round
          kicker="Artist"
          title={artist.name}
          meta={
            <>
              {joinMeta(artist.disambiguation, plural(artist.albums.length, 'release'), `${owned} in your library`)}
              {artist.artistId && (
                <Link to={`/artists/${artist.artistId}`} className="ml-1 inline-flex items-center gap-1.5 text-accent hover:underline">
                  Open in your library <ArrowRight className="size-3.5" />
                </Link>
              )}
            </>
          }
        />
      </div>

      <div className="px-5 pt-10 md:px-10 md:pt-14">
        {wantedAlbum && !highlight && artist.albums.length > 0 && (
          <p className="-mt-2 mb-8 max-w-xl text-sm text-muted">
            “{wantedAlbum}” isn’t among these albums and EPs; it’s probably a single or a compilation. You can still
            request it from the song.
          </p>
        )}
        {[
          { title: 'Albums', items: studio },
          { title: 'EPs & soundtracks', items: eps },
        ]
          .filter((g) => g.items.length)
          .map((g) => (
            <section key={g.title} className="mb-14">
              <SectionHeader title={g.title} kicker={plural(g.items.length, 'release')} />
              <div className={GRID}>
                {g.items.map((a, i) => (
                  <DiscoverAlbumCard
                    key={a.mbid}
                    album={a}
                    onArtistPage
                    highlighted={a.mbid === highlight}
                    style={{ animationDelay: `${Math.min(i, 20) * 30}ms` }}
                  />
                ))}
              </div>
            </section>
          ))}
        {artist.discographyError ? (
          <div className="max-w-md">
            <p className="text-sm text-paper-dim">Couldn’t load the discography from MusicBrainz right now.</p>
            <p className="mt-1 font-mono text-[11px] text-muted">{artist.discographyError}</p>
            <Button size="small" className="mt-4" onClick={() => void refetch()} pending={isFetching} pendingLabel="Trying again…">
              Try again
            </Button>
          </div>
        ) : (
          !artist.albums.length && <p className="text-muted">MusicBrainz lists no albums or EPs for this artist.</p>
        )}
        <div className="mt-14">
          <SimilarArtists mbid={artist.mbid} />
        </div>

        {artist.overview && (
          <section className="max-w-3xl">
            <SectionHeader title="About" kicker={artist.genres.slice(0, 3).join(' · ') || undefined} />
            <p className={cn('type-body leading-relaxed text-paper-dim', !bioOpen && 'line-clamp-5')}>{artist.overview}</p>
            <Button variant="ghost" size="small" onClick={() => setBioOpen((o) => !o)} aria-expanded={bioOpen} className="mt-3 -ml-3.5">
              {bioOpen ? 'Less' : 'Read more'}
            </Button>
          </section>
        )}
      </div>
    </div>
  );
}
