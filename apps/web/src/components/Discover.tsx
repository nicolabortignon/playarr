import type { Album, AlbumRef, Availability, DiscoverAlbum, DiscoverTrack } from '@playarr/shared';
import { Binoculars, Check, Clock, LoaderCircle, Play, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { cn } from '../lib/cn';
import { formatTime, releaseKind } from '../lib/format';
import { albumHref, artistHref, titleKey } from '../lib/links';
import { useRequestAlbum, useRequests, useRequestsEnabled } from '../lib/queries';
import { useDelayedFlag } from '../lib/useDelayedFlag';
import { rowActionWords, RowAction } from './ActionRow';
import { Button } from './Button';
import { Cover } from './Cover';
import { InlineLink } from './InlineLink';
import { ListRow } from './SongRow';

/**
 * One control for every state of an album that may not be in the library yet: Request → Requesting… → Searching →
 * 42% → Importing → In library. What can be pressed is a button; what only says how it's going is a badge. Small in
 * cards and rows; large as a partial album's own action in its action row.
 */
export function RequestButton({
  album,
  availability,
  size = 'small',
  className,
}: {
  album: AlbumRef;
  availability: Availability;
  size?: 'small' | 'large';
  className?: string;
}) {
  const request = useRequestAlbum();
  const navigate = useNavigate();
  const requestsOn = useRequestsEnabled();
  // Finding an album can wait on MusicBrainz (about one request per second): say so after a moment.
  const slow = useDelayedFlag(request.isPending, 2000);
  const large = size === 'large';
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

  const lookingUp = 'Finding this album on MusicBrainz, which answers about one request per second';
  // Asking (again): a small button in a card (Request is the card's main action, Try again isn't), the page's own
  // action in a partial album's row (named by its words).
  const offer = (label: string, icon: ReactNode, title?: string) =>
    large ? (
      <RowAction
        icon={icon}
        onClick={ask}
        title={request.isPending ? (slow ? lookingUp : undefined) : title}
        pending={request.isPending}
        pendingLabel={slow ? 'Looking up…' : 'Requesting…'}
        className={className}
      >
        {label}
      </RowAction>
    ) : (
      <Button size="small" variant={label === 'Request' ? 'primary' : 'secondary'} icon={icon} onClick={ask} title={title} className={className}>
        {label}
      </Button>
    );

  if (request.isPending) {
    if (large) return offer('Request the rest', <Binoculars />);
    return (
      <StatusBadge
        icon={<LoaderCircle className="animate-spin" />}
        title={slow ? lookingUp : undefined}
        className={cn('border-line text-paper-dim', className)}
      >
        {slow ? 'Looking up…' : 'Requesting…'}
      </StatusBadge>
    );
  }
  // Some of its songs are already here: say how many (opening the album), and offer the rest.
  if (state === 'partial' && !large) {
    const have = availability.have ?? 0;
    // How long the album is may be unknown (folder files without a track total): then just how many are here.
    const total = availability.total;
    const summary = total ? `${have} of ${total} songs in your library` : `${have} ${have === 1 ? 'song' : 'songs'} in your library`;
    return (
      <span className={cn('inline-flex shrink-0 items-center gap-1.5', className)}>
        <Button
          size="small"
          title={summary}
          aria-label={`${summary}: open the album`}
          onClick={stop(() => albumId && navigate(`/albums/${albumId}`))}
          labelClassName="tabular"
        >
          {total ? `${have}/${total}` : `${have} here`}
        </Button>
        {requestsOn && (
          <Button size="small" variant="primary" icon={<Binoculars />} title="Request the whole album" onClick={ask}>
            Request
          </Button>
        )}
      </span>
    );
  }
  // The badges' words go with the page's action when the action row narrows; the spinner stays.
  const words = large ? rowActionWords : undefined;
  switch (state) {
    case 'available':
      if (large) return null;
      return (
        <Button size="small" icon={<Check className="text-success" />} onClick={stop(() => albumId && navigate(`/albums/${albumId}`))} className={className}>
          In library
        </Button>
      );
    case 'searching':
      return (
        <StatusBadge icon={<LoaderCircle className="animate-spin" />} title={message ?? 'Searching'} wordsClassName={words} className={className}>
          Searching
        </StatusBadge>
      );
    case 'downloading': {
      const pct = Math.round((progress ?? 0) * 100);
      return (
        // Under way like Searching and Importing (Download is the glyph for this device's downloads).
        <StatusBadge icon={<LoaderCircle className="animate-spin" />} title={message} className={className} fill={pct}>
          <span className="tabular">{pct}%</span>
        </StatusBadge>
      );
    }
    case 'importing':
      return (
        <StatusBadge icon={<LoaderCircle className="animate-spin" />} title={message ?? 'Importing'} wordsClassName={words} className={className}>
          Importing
        </StatusBadge>
      );
    case 'waiting':
      return offer('Try again', <Clock />, message);
    case 'failed':
      return offer('Try again', <TriangleAlert className="text-danger" />, message);
    default:
      return large ? offer('Request the rest', <Binoculars />) : offer('Request', <Binoculars />);
  }
}

/**
 * How a request is going (Requesting…, Searching, 42%, Importing): nothing happens when it's tapped, so it's a badge,
 * not a button. As tall as a small button, so a card doesn't move as it turns from one into the other.
 */
function StatusBadge({
  icon,
  title,
  fill,
  wordsClassName,
  className,
  children,
}: {
  icon: ReactNode;
  title?: string;
  /** How far along it is, in percent, filled in behind it. */
  fill?: number;
  wordsClassName?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        'relative inline-flex h-8 shrink-0 items-center gap-1.5 overflow-hidden rounded-full border border-accent/40 px-3 type-badge text-accent',
        className,
      )}
      style={fill === undefined ? undefined : ({ '--pct': `${fill}%` } as CSSProperties)}
    >
      {fill !== undefined && <span className="absolute inset-y-0 left-0 w-(--pct) bg-accent/15 transition-[width] duration-700" />}
      <span aria-hidden className="relative grid shrink-0 place-items-center *:size-3">
        {icon}
      </span>
      <span className={cn('relative', wordsClassName)}>{children}</span>
    </span>
  );
}

export function DiscoverAlbumCard({
  album,
  style,
  className,
  highlighted,
  onArtistPage,
}: {
  album: DiscoverAlbum;
  style?: CSSProperties;
  className?: string;
  /** Arrived here from a song on this album: bring it into view and mark it. */
  highlighted?: boolean;
  /** On the artist's own page, where their name says nothing: what it is and when ("EP · 2019") instead, and no badge. */
  onArtistPage?: boolean;
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
              'rounded-cover ring-1 ring-paper/5',
              !available && 'saturate-[0.85]',
              highlighted && 'ring-2 ring-accent ring-offset-4 ring-offset-ink-900 saturate-100',
            )}
          />
          {!available && !onArtistPage && (
            <span className="absolute top-2 left-2 rounded-cover bg-ink-950/75 px-1.5 py-0.5 type-badge text-paper-dim backdrop-blur">
              {kind}
            </span>
          )}
        </div>
        <div className="mt-3 min-w-0">
          <div className="truncate type-body leading-snug text-paper">{album.title}</div>
          {onArtistPage ? (
            <div className="truncate type-small text-muted">{[releaseKind(album.type, album.secondaryTypes), album.year].filter(Boolean).join(' · ')}</div>
          ) : (
            <div className="truncate type-small text-muted">
              {album.artistName}
              {album.year && <span className="type-meta"> · {album.year}</span>}
            </div>
          )}
        </div>
      </Link>
      <RequestButton
        album={{ mbid: album.mbid, artistName: album.artistName, albumTitle: album.title }}
        availability={album.availability}
        className="mt-2.5"
      />
    </div>
  );
}

/**
 * A song beyond the library (search), in the one row: its cover, title, artist and album (linked), length and Request.
 * Pressing it opens its album when some of that is here; otherwise only its links and Request do something.
 */
export function DiscoverTrackRow({ track }: { track: DiscoverTrack }) {
  const available = track.availability.state === 'available';
  // A song whose album is only partly here still opens that album.
  const opens = track.availability.albumId !== undefined && (available || track.availability.have !== undefined);
  return (
    <ListRow
      lead={
        <span className="relative size-11 shrink-0">
          <Cover src={track.coverUrl} size={44} alt="" label={track.albumTitle} className="size-11 rounded-cover" />
          {available && (
            <span className="absolute inset-0 grid place-items-center rounded-cover bg-ink-950/55 opacity-0 transition pointer-fine:group-hover:opacity-100">
              <Play aria-hidden className="size-4 fill-paper text-paper" />
            </span>
          )}
        </span>
      }
      title={track.title}
      main={opens ? { label: `Open ${track.albumTitle}`, to: `/albums/${track.availability.albumId}` } : undefined}
      subtitle={
        <>
          <InlineLink to={artistHref(track)}>{track.artistName}</InlineLink> <span className="text-ink-600">·</span>{' '}
          <InlineLink
            to={albumHref({ ...track, albumId: available ? track.availability.albumId : undefined })}
            title={available ? undefined : `Find it in ${track.artistName}’s discography`}
          >
            {track.albumTitle}
          </InlineLink>
        </>
      }
      trailing={
        <>
          {track.duration ? <span className="hidden shrink-0 type-meta text-muted md:block">{formatTime(track.duration)}</span> : null}
          <span className="relative z-10 shrink-0">
            <RequestButton album={track.album} availability={track.availability} />
          </span>
        </>
      }
    />
  );
}

export function RequestsPill({ count }: { count: number }) {
  if (!count) return null;
  return (
    <Link
      to="/requests"
      className="inline-flex items-center gap-2 rounded-full border border-accent/40 px-3 py-1.5 type-badge text-accent transition hover:bg-accent/10"
    >
      <LoaderCircle className="size-3 animate-spin [animation-duration:2.5s]" />
      {count} {count === 1 ? 'request' : 'requests'} in progress
    </Link>
  );
}

/** A library album missing songs, which can be asked for (not the "Loose songs" bucket of an artist). */
export function canRequestRest(album: Album): boolean {
  return album.albumType !== 'Loose' && (album.trackCount < album.totalTrackCount || !!album.mayBeIncomplete);
}

/**
 * Asking for the rest of a partial library album: the request to show (its progress, or the offer), or null when
 * there's nothing to show (the album is whole, what was asked for has arrived, or nothing can be asked for).
 */
export function useRestRequest(album: Album | undefined): { album: AlbumRef; availability: Availability } | null {
  const { data: requests } = useRequests();
  const requestsOn = useRequestsEnabled();
  if (!album || !canRequestRest(album)) return null;
  // Albums known only from their tags have no MusicBrainz id: the server finds them by artist and title,
  // and their request is recognized the same way.
  const request = requests?.find(
    (r) =>
      (album.mbid && r.mbid === album.mbid) ||
      (titleKey(r.artistName) === titleKey(album.artistName) && titleKey(r.title) === titleKey(album.title)),
  );
  const availability = request?.availability ?? { state: 'none' as const };
  if (availability.state === 'available') return null;
  // Without Lidarr, or with requests off: nothing to offer, though an earlier request still shows how it's going.
  if (!requestsOn && (availability.state === 'none' || availability.state === 'waiting' || availability.state === 'failed')) return null;
  return { album: { ...(album.mbid ? { mbid: album.mbid } : {}), artistName: album.artistName, albumTitle: album.title }, availability };
}

/** Only some of a library album is here: ask Lidarr for the whole of it, then show how that's going (in a card). */
export function RequestRest({ album, className }: { album: Album; className?: string }) {
  const rest = useRestRequest(album);
  return rest && <RequestButton album={rest.album} availability={rest.availability} className={className} />;
}
