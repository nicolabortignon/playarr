import type { Album } from '@playarr/shared';
import { ListEnd, ListPlus } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { ActionRow, usePlayState } from '../components/ActionRow';
import { Button } from '../components/Button';
import { AlbumCard } from '../components/Cards';
import { DiscoverAlbumCard } from '../components/Discover';
import { BackButton, ErrorState, SectionHeader, Skeleton } from '../components/Section';
import { SimilarArtists } from '../components/SimilarArtists';
import { SlowLookup } from '../components/SlowLookup';
import { artistHero } from '../lib/api';
import { cn } from '../lib/cn';
import { plural } from '../lib/format';
import { useArtist, useDiscoverArtist } from '../lib/queries';
import { playArtist, queueArtist } from '../player/actions';
import { usePlayer } from '../player/store';
import { gridItem, GRID } from './Albums';

function groupAlbums(albums: Album[]) {
  const groups: { title: string; albums: Album[] }[] = [
    { title: 'Albums', albums: [] },
    { title: 'Soundtracks', albums: [] },
    { title: 'EPs & Singles', albums: [] },
    { title: 'Live & Compilations', albums: [] },
    { title: 'Loose songs', albums: [] },
  ];
  for (const a of albums) {
    const secondary = a.secondaryTypes.map((t) => t.toLowerCase());
    if (a.albumType === 'Loose') groups[4]!.albums.push(a);
    else if (secondary.includes('soundtrack')) groups[1]!.albums.push(a);
    else if (secondary.some((t) => ['live', 'compilation', 'remix', 'dj-mix', 'mixtape/street'].includes(t))) groups[3]!.albums.push(a);
    else if (a.albumType === 'EP' || a.albumType === 'Single') groups[2]!.albums.push(a);
    else groups[0]!.albums.push(a);
  }
  return groups.filter((g) => g.albums.length);
}

/**
 * The artist's albums and EPs that aren't in the library at all, from their MusicBrainz discography, each
 * with Request. (Albums partly here are in the sections above, with their own Request.)
 */
function NotInLibrary({ artistMbid, owned }: { artistMbid: string; owned: Album[] }) {
  const { data, error, isPending, isFetching, refetch } = useDiscoverArtist(artistMbid);
  const ownedMbids = new Set(owned.map((a) => a.mbid).filter(Boolean));
  const missing = (data?.albums ?? []).filter(
    (a) => !ownedMbids.has(a.mbid) && a.availability.state !== 'available' && a.availability.state !== 'partial',
  );
  const groups = [
    { title: 'Albums not in your library', items: missing.filter((a) => a.type === 'Album') },
    { title: 'EPs & soundtracks not in your library', items: missing.filter((a) => a.type !== 'Album') },
  ].filter((g) => g.items.length);

  if (isPending) {
    return (
      <section className="mb-14" aria-busy="true">
        <SectionHeader title="Not in your library" />
        <div className={GRID}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="aspect-square" />
          ))}
        </div>
        <SlowLookup active what="the rest of this artist’s albums" className="mt-4" />
      </section>
    );
  }
  if (error || data?.discographyError) {
    return (
      <section className="mb-14 max-w-md">
        <SectionHeader title="Not in your library" />
        <p className="text-sm text-paper-dim">Couldn’t load the rest of this artist’s albums from MusicBrainz right now.</p>
        <Button size="small" className="mt-4" onClick={() => void refetch()} pending={isFetching} pendingLabel="Trying again…">
          Try again
        </Button>
      </section>
    );
  }
  return (
    <>
      {groups.map((g) => (
        <section key={g.title} className="mb-14">
          <SectionHeader title={g.title} kicker={plural(g.items.length, 'release')} />
          <div className={GRID}>
            {g.items.map((a, i) => (
              <DiscoverAlbumCard key={a.mbid} album={a} style={{ animationDelay: `${Math.min(i, 20) * 30}ms` }} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

export function ArtistPage() {
  const id = Number(useParams().id);
  const { data: artist, error, isPending, refetch } = useArtist(id);
  const [logoFailed, setLogoFailed] = useState(false);
  const [bioOpen, setBioOpen] = useState(false);
  const toggle = usePlayer((s) => s.toggle);
  const playState = usePlayState(`/artists/${id}`);

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isPending || !artist) {
    return (
      <div>
        <Skeleton className="h-[46vh] rounded-none" />
        <div className="space-y-4 px-5 pt-8 md:px-10">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-12 w-72" />
        </div>
      </div>
    );
  }

  const hero = artist.fanartUrl ?? artist.imageUrl;
  const showLogo = artist.logoUrl && !logoFailed;

  return (
    <div>
      <section className="relative isolate flex h-[52vh] min-h-[360px] items-end overflow-hidden md:h-[60vh]">
        <BackButton fallback="/artists" className="absolute top-3 left-3 z-20" />
        {hero && (
          <img
            src={artistHero(artist)}
            alt=""
            className={cn(
              'absolute inset-0 -z-10 h-full w-full animate-fade object-cover object-[center_30%]',
              // No wide photo: use the square image as a soft, blurred backdrop instead of a blown-up crop.
              !artist.fanartUrl && 'scale-125 opacity-60 blur-2xl saturate-150',
            )}
          />
        )}
        <div className="absolute inset-0 -z-10 bg-gradient-to-t from-ink-900 via-ink-900/45 to-ink-900/10" />
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-ink-900/70 via-transparent to-transparent" />

        <div className="w-full px-5 pb-8 md:px-10 md:pb-12">
          <div className="mb-3 font-mono text-[11px] tracking-[0.25em] text-paper-dim/80 uppercase">
            {artist.genres.slice(0, 3).join(' · ') || 'Artist'}
          </div>
          {showLogo ? (
            <h1>
              <span className="sr-only">{artist.name}</span>
              <img
                src={artist.logoUrl}
                alt=""
                onError={() => setLogoFailed(true)}
                className="max-h-24 max-w-[80%] animate-rise object-contain object-left drop-shadow-[0_4px_24px_rgb(0_0_0/0.6)] md:max-h-36 md:max-w-[560px]"
              />
            </h1>
          ) : (
            <h1 className="animate-rise font-display text-6xl leading-[0.9] tracking-tight text-paper drop-shadow-2xl md:text-8xl">
              {artist.name}
            </h1>
          )}
          <p className="mt-3 type-meta text-paper-dim">
            {plural(artist.albumCount, 'album')} · {plural(artist.trackCount, 'track')}
          </p>
          <ActionRow
            className="mt-6"
            title={artist.name}
            state={playState}
            onPlay={() => (playState !== 'idle' ? toggle() : void playArtist(artist.id))}
            onShuffle={() => void playArtist(artist.id, { shuffle: true })}
            menu={{
              items: [
                { label: 'Play next', icon: ListPlus, onSelect: () => void queueArtist(artist.id, 'next') },
                { label: 'Add to queue', icon: ListEnd, onSelect: () => void queueArtist(artist.id, 'end') },
              ],
            }}
          />
        </div>
      </section>

      <div className="px-5 pt-6 md:px-10 md:pt-10">
        {groupAlbums(artist.albums).map((g) => (
          <section key={g.title} className="mb-14">
            <SectionHeader title={g.title} kicker={plural(g.albums.length, 'release')} />
            <div className={GRID}>
              {g.albums.map((a, i) => (
                <AlbumCard key={a.id} album={a} {...gridItem(i, { lift: true })} />
              ))}
            </div>
          </section>
        ))}

        {artist.mbid && <NotInLibrary artistMbid={artist.mbid} owned={artist.albums} />}

        {artist.mbid && <SimilarArtists mbid={artist.mbid} />}

        {artist.overview && (
          <section className="max-w-3xl">
            <SectionHeader title="About" />
            <p className={cn('text-[15px] leading-relaxed whitespace-pre-line text-paper-dim/90', !bioOpen && 'line-clamp-5')}>
              {artist.overview}
            </p>
            <Button variant="ghost" size="small" onClick={() => setBioOpen((o) => !o)} aria-expanded={bioOpen} className="mt-3 -ml-3.5">
              {bioOpen ? 'Less' : 'Read more'}
            </Button>
          </section>
        )}
      </div>
    </div>
  );
}
