import type { Album } from '@playarr/shared';
import { Play, Shuffle } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { AlbumCard } from '../components/Cards';
import { ErrorState, SectionHeader, Skeleton } from '../components/Section';
import { artistHero } from '../lib/api';
import { cn } from '../lib/cn';
import { plural } from '../lib/format';
import { useArtist } from '../lib/queries';
import { playArtist } from '../player/actions';
import { GRID } from './Albums';

function groupAlbums(albums: Album[]) {
  const groups: { title: string; albums: Album[] }[] = [
    { title: 'Albums', albums: [] },
    { title: 'Soundtracks', albums: [] },
    { title: 'EPs & Singles', albums: [] },
    { title: 'Live & Compilations', albums: [] },
  ];
  for (const a of albums) {
    const secondary = a.secondaryTypes.map((t) => t.toLowerCase());
    if (secondary.includes('soundtrack')) groups[1]!.albums.push(a);
    else if (secondary.some((t) => ['live', 'compilation', 'remix', 'dj-mix', 'mixtape/street'].includes(t))) groups[3]!.albums.push(a);
    else if (a.albumType === 'EP' || a.albumType === 'Single') groups[2]!.albums.push(a);
    else groups[0]!.albums.push(a);
  }
  return groups.filter((g) => g.albums.length);
}

export function ArtistPage() {
  const id = Number(useParams().id);
  const { data: artist, error, isPending } = useArtist(id);
  const [logoFailed, setLogoFailed] = useState(false);
  const [bioOpen, setBioOpen] = useState(false);

  if (error) return <ErrorState error={error} />;
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
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void playArtist(artist.id)}
              className="inline-flex h-12 items-center gap-2 rounded-full bg-accent pr-6 pl-5 font-medium text-accent-ink shadow-[0_10px_40px_-12px_var(--accent)] transition hover:brightness-110 active:scale-[0.98]"
            >
              <Play className="size-5 fill-current" /> Play
            </button>
            <button
              type="button"
              onClick={() => void playArtist(artist.id, { shuffle: true })}
              className="inline-flex h-12 items-center gap-2 rounded-full border border-paper/20 bg-ink-900/30 px-5 text-paper backdrop-blur transition hover:border-paper/40"
            >
              <Shuffle className="size-[18px]" /> Shuffle
            </button>
            <span className="ml-1 font-mono text-[12px] text-paper-dim/80">
              {plural(artist.albumCount, 'album')} · {plural(artist.trackCount, 'track')}
            </span>
          </div>
        </div>
      </section>

      <div className="px-5 pt-6 md:px-10 md:pt-10">
        {groupAlbums(artist.albums).map((g) => (
          <section key={g.title} className="mb-14">
            <SectionHeader title={g.title} kicker={plural(g.albums.length, 'release')} />
            <div className={GRID}>
              {g.albums.map((a, i) => (
                <AlbumCard key={a.id} album={a} style={{ animationDelay: `${i * 35}ms` }} />
              ))}
            </div>
          </section>
        ))}

        {artist.overview && (
          <section className="max-w-3xl">
            <SectionHeader title="About" />
            <p className={cn('text-[15px] leading-relaxed whitespace-pre-line text-paper-dim/90', !bioOpen && 'line-clamp-5')}>
              {artist.overview}
            </p>
            <button
              type="button"
              onClick={() => setBioOpen((o) => !o)}
              className="mt-3 font-mono text-[11px] tracking-[0.15em] text-accent uppercase hover:underline"
            >
              {bioOpen ? 'Less' : 'Read more'}
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
