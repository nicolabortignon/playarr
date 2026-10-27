import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { DiscoverAlbumCard } from '../components/Discover';
import { ErrorState, SectionHeader, Skeleton } from '../components/Section';
import { sized } from '../lib/api';
import { cn } from '../lib/cn';
import { plural } from '../lib/format';
import { useDiscoverArtist } from '../lib/queries';
import { GRID } from './Albums';

/** An artist's discography from MusicBrainz, with what's in the library and what can be requested. */
export function DiscoverArtistPage() {
  const mbid = useParams().mbid ?? '';
  const { data: artist, error, isPending } = useDiscoverArtist(mbid);
  const [bioOpen, setBioOpen] = useState(false);

  if (error) return <ErrorState error={error} />;
  if (isPending || !artist) {
    return (
      <div className="px-5 pt-10 md:px-10 md:pt-16">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-4 h-16 w-80" />
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

  return (
    <div>
      <section className="relative isolate overflow-hidden px-5 pt-10 pb-10 md:px-10 md:pt-16">
        {artist.imageUrl && (
          <img
            src={sized(artist.imageUrl, 480)}
            alt=""
            className="absolute inset-0 -z-10 h-full w-full scale-125 animate-fade object-cover opacity-40 blur-3xl saturate-150"
          />
        )}
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-transparent via-ink-900/60 to-ink-900" />
        <div className="font-mono text-[11px] tracking-[0.25em] text-paper-dim/80 uppercase">
          {artist.genres.join(' · ') || artist.disambiguation || 'Artist'}
        </div>
        <h1 className="mt-3 animate-rise font-display text-5xl leading-[0.95] tracking-tight text-paper md:text-7xl">
          {artist.name}
        </h1>
        <div className="mt-5 flex flex-wrap items-center gap-4 font-mono text-[12px] text-paper-dim/80">
          <span>
            {plural(artist.albums.length, 'release')} · {owned} in your library
          </span>
          {artist.artistId && (
            <Link to={`/artists/${artist.artistId}`} className="inline-flex items-center gap-1.5 text-accent hover:underline">
              Open in your library <ArrowRight className="size-3.5" />
            </Link>
          )}
        </div>
        {artist.overview && (
          <div className="mt-6 max-w-2xl">
            <p className={cn('text-[15px] leading-relaxed text-paper-dim/90', !bioOpen && 'line-clamp-3')}>{artist.overview}</p>
            <button
              type="button"
              onClick={() => setBioOpen((o) => !o)}
              className="mt-2 font-mono text-[11px] tracking-[0.15em] text-accent uppercase hover:underline"
            >
              {bioOpen ? 'Less' : 'Read more'}
            </button>
          </div>
        )}
      </section>

      <div className="px-5 md:px-10">
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
                  <DiscoverAlbumCard key={a.mbid} album={a} style={{ animationDelay: `${Math.min(i, 20) * 30}ms` }} />
                ))}
              </div>
            </section>
          ))}
        {!artist.albums.length && <p className="text-muted">MusicBrainz lists no albums or EPs for this artist.</p>}
      </div>
    </div>
  );
}
