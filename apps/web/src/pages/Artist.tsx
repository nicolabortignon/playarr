import type { Album, ArtistDetail } from '@playarr/shared';
import { Disc3 } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { ActionRow, usePlayState } from '../components/ActionRow';
import { Button } from '../components/Button';
import { AlbumCard } from '../components/Cards';
import { Cover } from '../components/Cover';
import { DetailHeader, joinMeta } from '../components/DetailHeader';
import { DiscoverAlbumCard } from '../components/Discover';
import { queueItems } from '../components/menus';
import { BackButton, SectionHeader } from '../components/Section';
import { CardSkeleton, EmptyState, ErrorState, InlineError, Skeleton } from '../components/States';
import { SimilarArtists } from '../components/SimilarArtists';
import { SlowLookup } from '../components/SlowLookup';
import { artistHero } from '../lib/api';
import { cn } from '../lib/cn';
import { plural } from '../lib/format';
import { useArtist, useDiscoverArtist } from '../lib/queries';
import { useUI } from '../lib/ui';
import { artistTracks, playArtist } from '../player/actions';
import { usePlayer } from '../player/store';
import { gridItem, GRID } from './Albums';

function groupAlbums(albums: Album[]) {
  const groups: { title: string; albums: Album[] }[] = [
    { title: 'Albums', albums: [] },
    { title: 'Soundtracks', albums: [] },
    { title: 'EPs & singles', albums: [] },
    { title: 'Live & compilations', albums: [] },
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
 * The artist's own photo, if there is one. The server falls back to their newest album's cover for an artist without
 * one, which isn't a photo of them: then undefined.
 */
export function artistPhoto(artist: Pick<ArtistDetail, 'imageUrl' | 'albums'>): string | undefined {
  const url = artist.imageUrl;
  return url && !artist.albums.some((a) => a.coverUrl === url) ? url : undefined;
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
            <CardSkeleton key={i} />
          ))}
        </div>
        <SlowLookup active what="the rest of this artist’s albums" className="mt-4" />
      </section>
    );
  }
  if (error || data?.discographyError) {
    return (
      <section className="mb-14">
        <SectionHeader title="Not in your library" />
        <InlineError error={data?.discographyError ?? error} onRetry={() => void refetch()} retrying={isFetching}>
          Couldn’t load the rest of this artist’s albums from MusicBrainz
        </InlineError>
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
              <DiscoverAlbumCard key={a.mbid} album={a} onArtistPage style={{ animationDelay: `${Math.min(i, 20) * 30}ms` }} />
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
  const openPicker = useUI((s) => s.openPlaylistPicker);

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

  const photo = artist.fanartUrl ?? artistPhoto(artist);
  const showLogo = artist.logoUrl && !logoFailed;
  const title = showLogo ? (
    <>
      <span className="sr-only">{artist.name}</span>
      <img
        src={artist.logoUrl}
        alt=""
        onError={() => setLogoFailed(true)}
        className="max-h-24 max-w-[80%] animate-rise object-contain object-left drop-shadow-[0_4px_24px_color-mix(in_oklab,var(--color-ink-950)_60%,transparent)] md:max-h-36 md:max-w-[560px]"
      />
    </>
  ) : (
    artist.name
  );
  const header = (
    <DetailHeader
      // Without a photo: their best album cover (the server's pick) as a round picture beside the name.
      cover={
        photo ? undefined : (
          <Cover
            src={artist.imageUrl ?? artist.albums.find((a) => a.coverUrl)?.coverUrl}
            size={192}
            alt=""
            label={artist.name}
            eager
            className="w-full rounded-full shadow-cover-hero ring-1 ring-paper/10"
          />
        )
      }
      round
      kicker="Artist"
      title={title}
      meta={joinMeta(plural(artist.albumCount, 'album'), plural(artist.trackCount, 'song'))}
      overArt={!!photo}
    >
      <ActionRow
        title={artist.name}
        state={playState}
        onPlay={() => (playState !== 'idle' ? toggle() : void playArtist(artist.id))}
        onShuffle={() => void playArtist(artist.id, { shuffle: true })}
        // What everything you can play offers (components/menus.ts), all of their songs fetched once chosen.
        menu={{ label: `More for ${artist.name}`, items: queueItems(() => artistTracks(artist.id), openPicker) }}
      />
    </DetailHeader>
  );

  return (
    <div>
      {photo ? (
        <section className="relative isolate flex h-[52vh] min-h-[360px] items-end overflow-hidden md:h-[60vh]">
          <BackButton fallback="/artists" className="absolute top-3 left-3 z-20" />
          <img
            src={artistHero(artist)}
            alt=""
            className={cn(
              'absolute inset-0 -z-10 h-full w-full animate-fade object-cover object-[center_30%]',
              // No wide photo: use the square one as a soft, blurred backdrop instead of a blown-up crop.
              !artist.fanartUrl && 'scale-125 opacity-60 blur-2xl saturate-150',
            )}
          />
          <div className="absolute inset-0 -z-10 bg-gradient-to-t from-ink-900 via-ink-900/45 to-ink-900/10" />
          <div className="absolute inset-0 -z-10 bg-gradient-to-r from-ink-900/70 via-transparent to-transparent" />
          {/* Room under the row for Play's glow, which the band would otherwise cut off. */}
          <div className="w-full px-5 pb-10 md:px-10 md:pb-12">{header}</div>
        </section>
      ) : (
        // No photo: a compact header rather than a band of blur before the name.
        <div className="relative px-5 pt-6 md:px-10 md:pt-14">
          <BackButton fallback="/artists" className="absolute top-3 left-3 z-20" />
          {header}
        </div>
      )}

      <div className={cn('px-5 md:px-10', photo ? 'pt-6 md:pt-10' : 'pt-10 md:pt-14')}>
        {!artist.albums.length && <EmptyState icon={Disc3} title={`Nothing by ${artist.name} here yet.`} className="pt-0 md:pt-0" />}
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
            <SectionHeader title="About" kicker={artist.genres.slice(0, 3).join(' · ') || undefined} />
            <p className={cn('type-body leading-relaxed whitespace-pre-line text-paper-dim', !bioOpen && 'line-clamp-5')}>
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
