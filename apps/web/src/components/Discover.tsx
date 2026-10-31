import type { AlbumRef, Availability, DiscoverAlbum, DiscoverArtist, DiscoverTrack } from '@playarr/shared';
import { Check, Clock, Download, Loader2, Play, RotateCw, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, type CSSProperties, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { cn } from '../lib/cn';
import { formatTime } from '../lib/format';
import { albumHref, artistHref } from '../lib/links';
import { useRequestAlbum, useRequestsEnabled } from '../lib/queries';
import { useDelayedFlag } from '../lib/useDelayedFlag';
import { Cover } from './Cover';
import { InlineLink } from './InlineLink';

/**
 * One control for every state of an album that may not be in the library yet:
 * Request → Searching → 42% → Importing → In library.
 */
export function RequestButton({
  album,
  availability,
  size = 'md',
  className,
}: {
  album: AlbumRef;
  availability: Availability;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const request = useRequestAlbum();
  const navigate = useNavigate();
  const requestsOn = useRequestsEnabled();
  // Finding an album can wait on MusicBrainz (about one request per second): say so after a moment.
  const slow = useDelayedFlag(request.isPending, 2000);
  const pill = cn(
    'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full font-mono uppercase tracking-wider transition',
    size === 'sm' ? 'h-7 px-2.5 text-[10px]' : 'h-8 px-3.5 text-[11px]',
  );
  const base = cn(pill, className);
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
  const ask = stop(() => request.mutate(album));
  const { state, progress, message, albumId } = availability;
  // Without Lidarr, or with requests off in Settings, nothing can be asked for: hide every button that would.
  // Progress on earlier requests still shows, and "In library" still links to the album.
  if (!requestsOn && !request.isPending && (state === 'none' || state === 'waiting' || state === 'failed')) return null;

  if (request.isPending) {
    return (
      <span
        title={slow ? 'Finding this album on MusicBrainz, which answers about one request per second' : undefined}
        className={cn(base, 'border border-line text-paper-dim')}
      >
        <Loader2 className="size-3 animate-spin" /> {slow ? 'Looking up' : 'Requesting'}
      </span>
    );
  }
  // Some of its songs are already here: say how many (opening the album), and offer the rest.
  if (state === 'partial') {
    const have = availability.have ?? 0;
    const total = availability.total ?? 0;
    return (
      <span className={cn('inline-flex shrink-0 items-center gap-1.5', className)}>
        <button
          type="button"
          title={`${have} of ${total} songs in your library`}
          aria-label={`${have} of ${total} songs in your library: open the album`}
          onClick={stop(() => albumId && navigate(`/albums/${albumId}`))}
          className={cn(pill, 'border border-emerald-400/30 text-emerald-300 tabular hover:bg-emerald-400/10')}
        >
          {have}/{total}
        </button>
        {requestsOn && (
          <button
            type="button"
            title="Request the whole album"
            onClick={ask}
            className={cn(pill, 'bg-accent text-accent-ink hover:brightness-110 active:scale-95')}
          >
            <Download className="size-3" /> Request
          </button>
        )}
      </span>
    );
  }
  switch (state) {
    case 'available':
      return (
        <button
          type="button"
          onClick={stop(() => albumId && navigate(`/albums/${albumId}`))}
          className={cn(base, 'border border-emerald-400/30 text-emerald-300 hover:bg-emerald-400/10')}
        >
          <Check className="size-3" /> In library
        </button>
      );
    case 'searching':
      return (
        <span title={message} className={cn(base, 'border border-accent/40 text-accent')}>
          <Loader2 className="size-3 animate-spin" /> Searching
        </span>
      );
    case 'downloading': {
      const pct = Math.round((progress ?? 0) * 100);
      return (
        <span
          title={message}
          className={cn(base, 'relative overflow-hidden border border-accent/40 text-accent')}
          style={{ '--pct': `${pct}%` } as CSSProperties}
        >
          <span className="absolute inset-y-0 left-0 w-(--pct) bg-accent/15 transition-[width] duration-700" />
          <Download className="relative size-3" />
          <span className="relative tabular">{pct}%</span>
        </span>
      );
    }
    case 'importing':
      return (
        <span title={message} className={cn(base, 'border border-accent/40 text-accent')}>
          <Loader2 className="size-3 animate-spin" /> Importing
        </span>
      );
    case 'waiting':
      return (
        <button type="button" title={message} onClick={ask} className={cn(base, 'border border-line text-paper-dim hover:border-paper/30 hover:text-paper')}>
          <Clock className="size-3" /> Search again
        </button>
      );
    case 'failed':
      return (
        <button type="button" title={message} onClick={ask} className={cn(base, 'border border-red-400/40 text-red-300 hover:bg-red-400/10')}>
          <TriangleAlert className="size-3" /> Retry
        </button>
      );
    default:
      return (
        <button type="button" onClick={ask} className={cn(base, 'bg-accent text-accent-ink hover:brightness-110 active:scale-95')}>
          <Download className="size-3" /> Request
        </button>
      );
  }
}

export function DiscoverAlbumCard({
  album,
  style,
  className,
  highlighted,
}: {
  album: DiscoverAlbum;
  style?: CSSProperties;
  className?: string;
  /** Arrived here from a song on this album: bring it into view and mark it. */
  highlighted?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [highlighted]);
  const { state: availabilityState, albumId: libraryAlbumId, have, total } = album.availability;
  const available = availabilityState === 'available';
  // Partly in the library: the album page plays what's there.
  const partial = availabilityState === 'partial' || (have !== undefined && libraryAlbumId !== undefined);
  const to = (available || partial) && libraryAlbumId ? `/albums/${libraryAlbumId}` : `/discover/artists/${album.artistMbid}`;
  const kind = partial && have !== undefined && total ? `${have} of ${total}` : (album.secondaryTypes[0] ?? album.type);
  return (
    <div ref={ref} className={cn('group animate-rise', className)} style={style} data-highlighted={highlighted || undefined}>
      <Link to={to} className="block">
        <div className="relative">
          <Cover
            src={album.coverUrl}
            size={200}
            alt={album.title}
            className={cn(
              'rounded-[4px] ring-1 ring-paper/5 transition duration-500 ease-out-expo group-hover:-translate-y-1',
              !available && 'saturate-[0.85]',
              highlighted && 'ring-2 ring-accent ring-offset-4 ring-offset-ink-900 saturate-100',
            )}
          />
          {!available && (
            <span className="absolute top-2 left-2 rounded-[3px] bg-ink-950/75 px-1.5 py-0.5 font-mono text-[9px] tracking-[0.15em] text-paper-dim uppercase backdrop-blur">
              {kind}
            </span>
          )}
        </div>
        <div className="mt-3 min-w-0">
          <div className="truncate text-[15px] leading-snug text-paper">{album.title}</div>
          <div className="truncate text-[13px] text-muted">
            {album.artistName}
            {album.year && <span className="font-mono text-[12px]"> · {album.year}</span>}
          </div>
        </div>
      </Link>
      <RequestButton
        album={{ mbid: album.mbid, artistName: album.artistName, albumTitle: album.title }}
        availability={album.availability}
        size="sm"
        className="mt-2.5"
      />
    </div>
  );
}

export function DiscoverTrackRow({ track }: { track: DiscoverTrack }) {
  const navigate = useNavigate();
  const available = track.availability.state === 'available';
  // A song whose album is only partly here still opens that album.
  const opens = track.availability.albumId !== undefined && (available || track.availability.have !== undefined);
  return (
    <li
      className={cn(
        'group grid grid-cols-[2.75rem_1fr_auto] items-center gap-3 rounded-md px-3 py-2 transition hover:bg-paper/[0.045] md:grid-cols-[2.75rem_1fr_auto_auto] md:gap-4',
        opens && 'cursor-pointer',
      )}
      onClick={() => opens && navigate(`/albums/${track.availability.albumId}`)}
    >
      <div className="relative">
        <Cover src={track.coverUrl} size={44} alt="" label={track.albumTitle} className="size-11 rounded-[3px]" />
        {available && (
          <div className="absolute inset-0 grid place-items-center rounded-[3px] bg-black/50 opacity-0 transition group-hover:opacity-100">
            <Play className="size-4 fill-paper" />
          </div>
        )}
      </div>
      <div className="min-w-0">
        <div className="truncate text-[15px] text-paper">{track.title}</div>
        <div className="truncate text-[13px] text-muted">
          <InlineLink to={artistHref(track)}>{track.artistName}</InlineLink> <span className="text-ink-600">·</span>{' '}
          <InlineLink
            to={albumHref({ ...track, albumId: available ? track.availability.albumId : undefined })}
            title={available ? undefined : `Find it in ${track.artistName}’s discography`}
          >
            {track.albumTitle}
          </InlineLink>
        </div>
      </div>
      <span className="hidden font-mono text-[13px] text-muted tabular md:block">
        {track.duration ? formatTime(track.duration) : ''}
      </span>
      <RequestButton album={track.album} availability={track.availability} size="sm" />
    </li>
  );
}

export function DiscoverArtistCard({ artist, style, className }: { artist: DiscoverArtist; style?: CSSProperties; className?: string }) {
  const to = artist.artistId ? `/artists/${artist.artistId}` : `/discover/artists/${artist.mbid}`;
  return (
    <Link to={to} style={style} className={cn('group block animate-rise text-center', className)}>
      <Cover
        src={artist.imageUrl}
        size={176}
        alt={artist.name}
        className="mx-auto rounded-full ring-1 ring-paper/10 transition duration-500 ease-out-expo group-hover:scale-[1.03]"
      />
      <div className="mt-3 truncate text-[15px] text-paper">{artist.name}</div>
      <div className="truncate font-mono text-[10px] tracking-[0.15em] text-muted uppercase">
        {artist.artistId ? 'In your library' : (artist.disambiguation ?? artist.genres[0] ?? 'Artist')}
      </div>
    </Link>
  );
}

export function RequestsPill({ count }: { count: number }) {
  if (!count) return null;
  return (
    <Link
      to="/requests"
      className="inline-flex items-center gap-2 rounded-full border border-accent/40 px-3 py-1.5 font-mono text-[11px] tracking-wider text-accent uppercase transition hover:bg-accent/10"
    >
      <RotateCw className="size-3 animate-spin [animation-duration:2.5s]" />
      {count} {count === 1 ? 'request' : 'requests'} in progress
    </Link>
  );
}
