import type { Album, Artist, DiscoverArtist } from '@playarr/shared';
import { Pause, Play } from 'lucide-react';
import { useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import { Link } from 'react-router';
import { cn } from '../lib/cn';
import { useContextMenu, type Point } from '../lib/contextMenu';
import { plural } from '../lib/format';
import { useNearScreen } from '../lib/viewport';
import { playAlbum } from '../player/actions';
import { currentTrack, usePlayer } from '../player/store';
import { Cover } from './Cover';
import { canRequestRest, RequestRest } from './Discover';
import { ContextMenu } from './Menu';
import { useAlbumMenu } from './menus';

/** Where a card's menu opens, and whether from the keyboard. */
export type CardMenuAt = { at: Point; keyboard: boolean } | null;

/**
 * A card's menu on a right-click, a long press or the menu key, as on a row (lib/contextMenu.ts). The card mounts the
 * menu only then. From the keyboard it opens under the cover (a square as wide as the card).
 */
export function useCardMenu(card: { current: HTMLElement | null }) {
  const [menuAt, setMenuAt] = useState<CardMenuAt>(null);
  const events = useContextMenu(
    (at, keyboard) => {
      const r = card.current?.getBoundingClientRect();
      const point = at ?? (r ? { x: r.left, y: r.top + r.width } : undefined);
      if (point) setMenuAt({ at: point, keyboard });
    },
    { links: 'ours' },
  );
  return { menuAt, close: () => setMenuAt(null), events };
}

export function AlbumCard({ album, size = 220, style, className }: { album: Album; size?: number; style?: CSSProperties; className?: string }) {
  // Booleans about this album only: a new track or play/pause re-renders the cards it concerns, not all of them.
  const isCurrent = usePlayer((s) => currentTrack(s)?.albumId === album.id);
  const playingHere = usePlayer((s) => s.playing && currentTrack(s)?.albumId === album.id);
  const toggle = usePlayer((s) => s.toggle);
  // Far off screen in a long grid, the card keeps only its size: no image, no buttons, nothing to update.
  const ref = useRef<HTMLDivElement>(null);
  const { near, height } = useNearScreen(ref);
  const menu = useCardMenu(ref);

  return (
    <div ref={ref} className={cn('group relative animate-rise long-press', className)} style={near ? style : { ...style, height }} {...menu.events}>
      {near && (
        <>
          <Link to={`/albums/${album.id}`} className="block rounded-md outline-offset-4">
            <div className="relative">
              <Cover
                src={album.coverUrl}
                size={size}
                alt={album.title}
                className="rounded-cover shadow-cover ring-1 ring-paper/5"
              />
            </div>
            <div className="mt-3 min-w-0">
              <div className={cn('truncate type-body leading-snug', isCurrent ? 'text-accent' : 'text-paper')}>{album.title}</div>
              <div className="truncate type-small text-muted">
                {album.artistName}
                {album.year && <span className="type-meta"> · {album.year}</span>}
                {album.trackCount < album.totalTrackCount && (
                  <span className="type-meta">
                    {' '}
                    · {album.trackCount} of {album.totalTrackCount}
                  </span>
                )}
              </div>
            </div>
          </Link>
          {/* Only some of it is here: the rest can be asked for without opening the album. */}
          {canRequestRest(album) && <RequestRest album={album} className="mt-2" />}
          {/* The play button sits on the cover (a square as wide as the card), whatever is shown below it. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 aspect-square">
            <button
              type="button"
              aria-label={playingHere ? `Pause ${album.title}` : `Play ${album.title}`}
              onClick={() => (isCurrent ? toggle() : void playAlbum(album.id))}
              className={cn(
                'pointer-events-auto absolute right-2.5 bottom-2.5 grid size-11 place-items-center rounded-full bg-accent text-accent-ink shadow-xl shadow-black/40 transition duration-300 ease-out-expo hover:scale-105 active:scale-95',
                playingHere
                  ? 'translate-y-0 opacity-100'
                  : 'translate-y-2 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100 pointer-coarse:hidden',
              )}
            >
              {playingHere ? <Pause className="size-5 fill-current" /> : <Play className="ml-0.5 size-5 fill-current" />}
            </button>
          </div>
        </>
      )}
      {menu.menuAt && <AlbumCardMenu album={album} at={menu.menuAt} onClose={menu.close} />}
    </div>
  );
}

/** The album's one menu (components/menus.ts), with Play and Shuffle first: a card on a touch screen has no Play button. */
function AlbumCardMenu({ album, at, onClose }: { album: Album; at: NonNullable<CardMenuAt>; onClose: () => void }) {
  const items = useAlbumMenu(album, { card: true });
  return <ContextMenu items={items} label={`More for ${album.title}`} at={at.at} keyboard={at.keyboard} onClose={onClose} />;
}

/**
 * An artist's picture: their photo, else their best album cover (the server's pick when there's no photo), in a circle;
 * a vinyl monogram of their initials when there's neither. Alt-less: their name is always beside it.
 */
export function ArtistAvatar({ name, src, size, eager, className }: { name: string; src?: string; size: number; eager?: boolean; className?: string }) {
  return <Cover src={src} size={size} alt="" label={name} eager={eager} className={cn('rounded-full ring-1 ring-paper/10', className)} />;
}

/** An artist on a shelf or in a grid, in or out of the library: the picture in a circle, the name below it as on album cards. */
export function ArtistTile({
  to,
  name,
  imageUrl,
  meta,
  style,
  className,
  tileRef,
  empty,
}: {
  to: string;
  name: string;
  imageUrl?: string;
  /** Under the name: "4 albums · 41 songs", "In your library". */
  meta?: ReactNode;
  style?: CSSProperties;
  className?: string;
  tileRef?: Ref<HTMLAnchorElement>;
  /** Far off screen in a long grid: just its size. */
  empty?: boolean;
}) {
  return (
    <Link ref={tileRef} to={to} style={style} className={cn('group block animate-rise text-center', className)}>
      {!empty && (
        <>
          <ArtistAvatar name={name} src={imageUrl} size={220} className="w-full shadow-cover transition duration-500 ease-out-expo group-hover:scale-[1.03]" />
          <div className="mt-3 truncate type-body leading-snug text-paper">{name}</div>
          {meta && <div className="truncate type-small text-muted">{meta}</div>}
        </>
      )}
    </Link>
  );
}

export function ArtistCard({ artist, style, className }: { artist: Artist; style?: CSSProperties; className?: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const { near, height } = useNearScreen(ref);
  return (
    <ArtistTile
      tileRef={ref}
      to={`/artists/${artist.id}`}
      name={artist.name}
      imageUrl={artist.imageUrl}
      meta={`${plural(artist.albumCount, 'album')} · ${plural(artist.trackCount, 'song')}`}
      empty={!near}
      style={near ? style : { ...style, height }}
      className={className}
    />
  );
}

/** An artist from ListenBrainz or a search beyond the library: their page here when they're in it, else their discography. */
export function DiscoverArtistCard({ artist, style, className }: { artist: DiscoverArtist; style?: CSSProperties; className?: string }) {
  return (
    <ArtistTile
      to={artist.artistId ? `/artists/${artist.artistId}` : `/discover/artists/${artist.mbid}`}
      name={artist.name}
      imageUrl={artist.imageUrl}
      meta={artist.artistId ? 'In your library' : (artist.disambiguation ?? artist.genres[0] ?? 'Artist')}
      style={style}
      className={className}
    />
  );
}
