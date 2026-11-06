import type { Track } from '@playarr/shared';
import { GripVertical, Play } from 'lucide-react';
import { Reorder, type DragControls } from 'motion/react';
import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '../lib/cn';
import { useContextMenu } from '../lib/contextMenu';
import { formatTime } from '../lib/format';
import { currentTrack, usePlayer } from '../player/store';
import { Cover } from './Cover';
import { Equalizer } from './Equalizer';
import { FavoriteButton } from './FavoriteButton';
import { InlineLink } from './InlineLink';
import { DIVIDER, Menu, type MenuEntry, type MenuHandle } from './Menu';
import { useSongMenu, type SongMenuOptions } from './menus';
import { NameAndNumbers } from './NameAndNumbers';
import { OfflineMark } from './OfflineMark';
import { Tempo } from './Tempo';

/** A row's controls show on hover and focus with a mouse, and always on touch screens (plan 6 §1). */
const REVEAL = 'pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100';

/**
 * The row's own button or link: the title, stretched over the whole row by its ::after, so the row presses as one while
 * its controls (handle, links, ♥, ⋯) sit above it as buttons of their own. The focus ring goes round the row.
 */
const MAIN =
  'min-w-0 cursor-pointer truncate text-left outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent';

export interface RowReorder {
  /** What the list's Reorder.Group holds for this row. */
  value: unknown;
  controls: DragControls;
  /** The handle's name: "Drag to reorder Teardrop". */
  label: string;
  onDragEnd: () => void;
  /** One place up or down: the arrow keys on the handle (the menu's Move up and Move down do the same). */
  onMove: (by: -1 | 1) => void;
}

export interface ListRowProps {
  /** The thumbnail, or the number column. */
  lead?: ReactNode;
  title: ReactNode;
  /** The title's color: the accent for the song playing. */
  titleClassName?: string;
  /** On the title's line, after it: the "on this device" mark. */
  badge?: ReactNode;
  subtitle?: ReactNode;
  /** After the text, in this order on every list: the time, then the controls (♥), each a button of its own. */
  trailing?: ReactNode;
  /** What pressing the row does, named for screen readers: play (a button) or open (a link). None for a song not in the library. */
  main?: { label: string; onClick: () => void; to?: undefined } | { label: string; to: string; onClick?: undefined };
  /** ⋯, and the same menu on a right-click, a long press or the menu key. */
  menu?: { label: string; items: MenuEntry[] };
  /** Drag to reorder by a handle (a playlist, the queue). */
  reorder?: RowReorder;
  /** The song playing: a faint highlight. */
  current?: boolean;
  /** Not in the library: greyed out, nothing to press. */
  missing?: boolean;
  /** Its tooltip ("Not in your library"). */
  hint?: string;
  /** Up next in Now Playing: a smaller thumbnail and less padding, the same type. */
  compact?: boolean;
  /** Drawn over the row (a download's progress along its bottom). */
  overlay?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/**
 * One row of a list (docs/design.md, Rows): [handle] lead · title and subtitle · trailing · ⋯. Every row of a list is
 * the same height, a missing song's included: 60 with a thumbnail; 52 with a number, 60 on touch screens, where the
 * controls are 44.
 */
export function ListRow({
  lead,
  title,
  titleClassName,
  badge,
  subtitle,
  trailing,
  main,
  menu,
  reorder,
  current,
  missing,
  hint,
  compact,
  overlay,
  className,
  style,
}: ListRowProps) {
  const menuRef = useRef<MenuHandle>(null);
  const handle = useRef<HTMLButtonElement>(null);
  const [dragging, setDragging] = useState(false);
  const hasMenu = !!menu?.items.some((e) => e !== DIVIDER);
  const context = useContextMenu((at, keyboard) => menuRef.current?.open(at, keyboard));

  const moveByKey = (e: KeyboardEvent) => {
    const by = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!by || !reorder) return;
    // The volume keys elsewhere on the page: here they move the song.
    e.preventDefault();
    reorder.onMove(by);
    // The row moves in the list; the focus stays on its handle.
    requestAnimationFrame(() => handle.current?.focus());
  };

  const content = (
    <>
      {reorder && (
        <button
          ref={handle}
          type="button"
          data-drag-handle
          aria-label={reorder.label}
          aria-keyshortcuts="ArrowUp ArrowDown"
          title="Drag, or press ↑ or ↓, to move"
          onPointerDown={(e) => reorder.controls.start(e)}
          onKeyDown={moveByKey}
          className={cn('relative z-10 -mr-1 grid h-11 w-6 shrink-0 cursor-grab touch-none place-items-center rounded-md text-muted active:cursor-grabbing', REVEAL)}
        >
          <GripVertical className="size-4" />
        </button>
      )}
      {lead}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {main?.to !== undefined ? (
            <Link to={main.to} aria-label={main.label} className={cn(MAIN, 'type-body', compact && 'leading-snug', titleClassName ?? 'text-paper')}>
              {title}
            </Link>
          ) : main ? (
            <button type="button" onClick={main.onClick} aria-label={main.label} className={cn(MAIN, 'type-body', compact && 'leading-snug', titleClassName ?? 'text-paper')}>
              {title}
            </button>
          ) : (
            <span className={cn('min-w-0 truncate type-body', compact && 'leading-snug', titleClassName ?? 'text-paper')}>{title}</span>
          )}
          {badge}
        </div>
        {subtitle && <div className={cn('min-w-0 truncate type-small text-muted', compact && 'leading-snug')}>{subtitle}</div>}
      </div>
      {trailing}
      {hasMenu && (
        <div className={cn('relative z-10 shrink-0 transition', REVEAL, 'pointer-fine:has-[[aria-expanded=true]]:opacity-100')}>
          <Menu ref={menuRef} label={menu!.label} items={menu!.items} />
        </div>
      )}
      {overlay}
    </>
  );

  const classes = cn(
    'group relative isolate flex items-center rounded-md transition-colors',
    compact ? 'min-h-12 gap-3 px-2 py-1 pointer-coarse:min-h-13' : 'min-h-13 gap-3 px-3 py-2 md:gap-4 pointer-coarse:min-h-15',
    main && (compact ? 'hover:bg-paper/[0.06]' : 'hover:bg-paper/[0.045]'),
    current && 'bg-paper/[0.035]',
    missing && 'opacity-40',
    hasMenu && 'long-press',
    // Lifted while dragged: opaque, over the rows it passes.
    dragging && 'bg-ink-800 shadow-cover',
    className,
  );
  const events = hasMenu ? context : {};

  if (reorder) {
    return (
      <Reorder.Item
        value={reorder.value}
        dragListener={false}
        dragControls={reorder.controls}
        onDragStart={() => setDragging(true)}
        onDragEnd={() => {
          setDragging(false);
          reorder.onDragEnd();
        }}
        whileDrag={{ scale: 1.02 }}
        title={hint}
        style={style}
        className={classes}
        {...events}
      >
        {content}
      </Reorder.Item>
    );
  }
  return (
    <li title={hint} style={style} className={classes} {...events}>
      {content}
    </li>
  );
}

/** As wide as a row's ♥ or ⋯: keeps a missing song's length in line with the others'. */
export const ControlGap = () => <span aria-hidden className="size-11 shrink-0 pointer-fine:size-9" />;

/** A song's length in a row, with its tempo when it's measured. */
export function SongTime({ seconds, bpm, className }: { seconds: number; bpm?: number; className?: string }) {
  return (
    <span className={cn('shrink-0 type-meta text-muted', className)}>
      <Tempo bpm={bpm} />
      {formatTime(seconds)}
    </span>
  );
}

/** "Massive Attack · Mezzanine", each a link of its own. */
export function ArtistAndAlbum({ track: t }: { track: Pick<Track, 'artistId' | 'artistName' | 'albumId' | 'albumTitle'> }) {
  return (
    <>
      <InlineLink to={`/artists/${t.artistId}`}>{t.artistName}</InlineLink> <span className="text-ink-600">·</span>{' '}
      <InlineLink to={`/albums/${t.albumId}`}>{t.albumTitle}</InlineLink>
    </>
  );
}

export interface SongRowProps {
  track: Track;
  /** What leads the row: the song's number on its album's page, else its cover. */
  lead?: 'number' | 'cover';
  /** Its place in a ranking (Your listening's top songs), before the cover. */
  rank?: number;
  /** Under the title: by default the artist and the album, linked, beside a cover; nothing beside a number. */
  subtitle?: ReactNode;
  /** Play from this song. Pressing the song playing pauses or resumes it instead. */
  onPlay: () => void;
  /** Mark the song when it's the one playing: off in Up next, where it never is. */
  markCurrent?: boolean;
  bpm?: number;
  /** In place of the length, the number that matters in this list: a ranking's plays ("12 plays"). */
  numbers?: ReactNode;
  /** The song menu's options here: its own actions, Go to album left out on the album's page… */
  menu?: SongMenuOptions;
  reorder?: RowReorder;
  compact?: boolean;
  /**
   * On phones (the queue, Your listening): no heart, and the length (or `numbers`) under the title rather than beside
   * it, so the title has the room.
   */
  stackOnPhones?: boolean;
  /** In a column as narrow as a phone at any width (the queue beside the page): laid out as `stackOnPhones` is on one. */
  narrow?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * A song in any list: album, playlist, queue, Now Playing's Up next, Favorites, mixes, search. Trailing in one order on
 * both apps: time · ♥ · ⋯. Pressing the row (a button: Enter and Space too) plays it; ⋯, a right-click or a long press
 * opens the one song menu.
 */
export function SongRow({
  track: t,
  lead = 'cover',
  rank,
  subtitle,
  onPlay,
  markCurrent = true,
  bpm,
  numbers,
  menu,
  reorder,
  compact,
  stackOnPhones,
  narrow,
  className,
  style,
}: SongRowProps) {
  // Booleans about this song only: a new song or play/pause re-renders the rows it concerns, not the whole list.
  const current = usePlayer((s) => markCurrent && currentTrack(s)?.fileId === t.fileId);
  const playingHere = usePlayer((s) => markCurrent && s.playing && currentTrack(s)?.fileId === t.fileId);
  const toggle = usePlayer((s) => s.toggle);
  const items = useSongMenu(t, menu);
  const under = subtitle === undefined ? lead === 'cover' && <ArtistAndAlbum track={t} /> : subtitle;
  // Stacked: the numbers under the title and no heart, on phones only, or everywhere in a narrow column.
  const stack = narrow ? 'always' : stackOnPhones ? 'phones' : undefined;
  const besideTitle = stack === 'always' ? 'hidden' : stack === 'phones' ? 'max-sm:hidden' : undefined;

  const leadEl =
    lead === 'number' ? (
      <span className="relative grid w-8 shrink-0 place-items-center">
        {current ? (
          <Equalizer playing={playingHere} />
        ) : (
          <>
            <span className="type-meta text-muted pointer-fine:group-hover:invisible">{t.trackNumber}</span>
            <Play aria-hidden className="invisible absolute size-3.5 fill-paper text-paper pointer-fine:group-hover:visible" />
          </>
        )}
      </span>
    ) : (
      <span className={cn('relative shrink-0', compact ? 'size-10' : 'size-11')}>
        <Cover src={t.coverUrl} size={compact ? 40 : 44} alt="" label={t.albumTitle} className="size-full rounded-cover" />
        <span
          className={cn(
            'absolute inset-0 grid place-items-center rounded-cover bg-ink-950/55 opacity-0 transition pointer-fine:group-hover:opacity-100',
            current && 'opacity-100',
          )}
        >
          {current ? <Equalizer playing={playingHere} /> : <Play aria-hidden className="size-4 fill-paper text-paper" />}
        </span>
      </span>
    );

  return (
    <ListRow
      lead={
        rank === undefined ? (
          leadEl
        ) : (
          <>
            <span className="w-6 shrink-0 text-right type-meta text-muted">{rank}</span>
            {leadEl}
          </>
        )
      }
      title={t.title}
      titleClassName={current ? 'text-accent' : 'text-paper'}
      badge={<OfflineMark fileId={t.fileId} />}
      subtitle={
        stack ? (
          <NameAndNumbers
            name={under || undefined}
            numbers={numbers ?? formatTime(t.duration)}
            numbersClassName={cn('tabular', stack === 'phones' && 'sm:hidden')}
          />
        ) : (
          under
        )
      }
      trailing={
        <>
          {numbers !== undefined ? (
            <span className={cn('shrink-0 type-meta text-muted', besideTitle)}>{numbers}</span>
          ) : (
            <SongTime seconds={t.duration} bpm={bpm} className={besideTitle} />
          )}
          <FavoriteButton track={t} reveal className={cn('relative z-10', besideTitle)} />
        </>
      }
      main={{ label: `${playingHere ? 'Pause' : 'Play'} ${t.title}`, onClick: () => (current ? toggle() : onPlay()) }}
      menu={{ label: `More for ${t.title}`, items }}
      reorder={reorder}
      current={current}
      compact={compact}
      className={className}
      style={style}
    />
  );
}
