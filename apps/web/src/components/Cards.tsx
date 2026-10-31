import type { Album, Artist } from '@playarr/shared';
import { Pause, Play } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { cn } from '../lib/cn';
import { plural } from '../lib/format';
import { playAlbum } from '../player/actions';
import { useCurrentTrack, usePlayer } from '../player/store';
import { Cover } from './Cover';
import { canRequestRest, RequestRest } from './Discover';

export function AlbumCard({ album, size = 220, style, className }: { album: Album; size?: number; style?: CSSProperties; className?: string }) {
  const current = useCurrentTrack();
  const playing = usePlayer((s) => s.playing);
  const toggle = usePlayer((s) => s.toggle);
  const isCurrent = current?.albumId === album.id;

  return (
    <div className={cn('group relative animate-rise', className)} style={style}>
      <Link to={`/albums/${album.id}`} className="block rounded-md outline-offset-4">
        <div className="relative">
          <Cover
            src={album.coverUrl}
            size={size}
            alt={album.title}
            className="rounded-[4px] shadow-[0_12px_32px_-12px_rgb(0_0_0/0.8)] ring-1 ring-paper/5 transition duration-500 ease-out-expo group-hover:-translate-y-1"
          />
        </div>
        <div className="mt-3 min-w-0">
          <div className={cn('truncate text-[15px] leading-snug', isCurrent ? 'text-accent' : 'text-paper')}>{album.title}</div>
          <div className="truncate text-[13px] text-muted">
            {album.artistName}
            {album.year && <span className="font-mono text-[12px]"> · {album.year}</span>}
            {album.trackCount < album.totalTrackCount && (
              <span className="font-mono text-[12px]">
                {' '}
                · {album.trackCount} of {album.totalTrackCount}
              </span>
            )}
          </div>
        </div>
      </Link>
      {/* Only some of it is here: the rest can be asked for without opening the album. */}
      {canRequestRest(album) && <RequestRest album={album} size="sm" className="mt-2" />}
      {/* The play button sits on the cover (a square as wide as the card), whatever is shown below it. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 aspect-square">
        <button
          type="button"
          aria-label={isCurrent && playing ? `Pause ${album.title}` : `Play ${album.title}`}
          onClick={() => (isCurrent ? toggle() : void playAlbum(album.id))}
          className={cn(
            'pointer-events-auto absolute right-2.5 bottom-2.5 grid size-11 place-items-center rounded-full bg-accent text-accent-ink shadow-xl shadow-black/40 transition duration-300 ease-out-expo hover:scale-105 active:scale-95',
            isCurrent && playing
              ? 'translate-y-0 opacity-100'
              : 'translate-y-2 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100 max-md:hidden',
          )}
        >
          {isCurrent && playing ? <Pause className="size-5 fill-current" /> : <Play className="ml-0.5 size-5 fill-current" />}
        </button>
      </div>
    </div>
  );
}

export function ArtistCard({ artist, style, className }: { artist: Artist; style?: CSSProperties; className?: string }) {
  return (
    <Link
      to={`/artists/${artist.id}`}
      style={style}
      className={cn('group relative block animate-rise overflow-hidden rounded-[4px] bg-ink-800 ring-1 ring-paper/5', className)}
    >
      <Cover
        src={artist.imageUrl}
        size={260}
        alt={artist.name}
        className="aspect-[4/5] transition duration-700 ease-out-expo group-hover:scale-[1.04]"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-ink-950/95 via-ink-950/20 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 p-3.5">
        <div className="font-display text-xl leading-tight text-paper md:text-2xl">{artist.name}</div>
        <div className="mt-1 font-mono text-[11px] tracking-wider text-paper-dim/80 uppercase">
          {plural(artist.albumCount, 'album')} · {plural(artist.trackCount, 'track')}
        </div>
      </div>
    </Link>
  );
}
