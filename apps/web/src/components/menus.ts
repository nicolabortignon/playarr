import type { Track } from '@playarr/shared';
import { ArrowDown, ArrowUp, Disc3, Info, ListEnd, ListPlus, ListStart, MicVocal, Play, Radio, Shuffle, X } from 'lucide-react';
import { useNavigate } from 'react-router';
import { toast } from '../lib/toast';
import { useUI } from '../lib/ui';
import {
  albumTracks,
  moveUpcoming,
  playAlbum,
  playlistTracks,
  playPlaylist,
  playUpcomingNext,
  queueLater,
  queueTracks,
  removeUpcoming,
} from '../player/actions';
import { startRadio } from '../player/radio';
import { DIVIDER, type MenuEntry, type MenuItem } from './Menu';
import { useMixPointsItem } from './MixPointsDialog';

export interface SongMenuOptions {
  /** The list is the song's own album: no Go to album. */
  inAlbum?: boolean;
  /** It's the song playing (Now Playing): no Play next or Add to queue. */
  playing?: boolean;
  /** What Play next does when it means something else here (Up next moves the song up); null leaves it out. */
  playNext?: (() => void) | null;
  /** How Go to album and Go to artist get there (Now Playing closes first). */
  go?: (to: string) => void;
  /** The place's own actions, after a line: Move up, Move down, Remove from playlist or queue. */
  own?: MenuEntry[];
}

/**
 * The one song menu (docs/design.md, Rows): the same song shows the same menu in every list, in this order. Play next ·
 * Add to queue · Add to playlist… · Start radio · Go to album · Go to artist · Show metadata · Edit mix points (with DJ
 * mix on); then, after a line, the place's own actions. A song no longer in the library has only those.
 */
export function useSongMenu(track: Track | undefined, { inAlbum, playing, playNext, go, own = [] }: SongMenuOptions = {}): MenuEntry[] {
  const navigate = useNavigate();
  const openPicker = useUI((s) => s.openPlaylistPicker);
  const showMetadata = useUI((s) => s.showMetadata);
  const mixPoints = useMixPointsItem(track);
  if (!track) return own;
  const to = go ?? ((path: string) => void navigate(path));
  const items: MenuItem[] = [];
  if (!playing) {
    if (playNext !== null) items.push({ label: 'Play next', icon: ListStart, onSelect: playNext ?? (() => queueTracks([track], 'next')) });
    items.push({ label: 'Add to queue', icon: ListEnd, onSelect: () => queueTracks([track], 'end') });
  }
  items.push(
    // ListPlus, as Save as playlist (the queue's, a mix's): ListMusic is a playlist's own glyph (docs/design.md, Icons).
    { label: 'Add to playlist…', icon: ListPlus, onSelect: () => openPicker([track]) },
    { label: 'Start radio', icon: Radio, onSelect: () => void startRadio(track) },
  );
  if (!inAlbum) items.push({ label: 'Go to album', icon: Disc3, onSelect: () => to(`/albums/${track.albumId}`) });
  items.push({ label: 'Go to artist', icon: MicVocal, onSelect: () => to(`/artists/${track.artistId}`) });
  items.push({ label: 'Show metadata', icon: Info, onSelect: () => showMetadata(track.id) }, ...mixPoints);
  return [...items, DIVIDER, ...own];
}

/** Move up and Move down, in a list that reorders (a playlist, the queue): what dragging does, for the menu and the keyboard. */
export function moveItems(index: number, count: number, move: (from: number, to: number) => void): MenuItem[] {
  return [
    ...(index > 0 ? [{ label: 'Move up', icon: ArrowUp, onSelect: () => move(index, index - 1) }] : []),
    ...(index < count - 1 ? [{ label: 'Move down', icon: ArrowDown, onSelect: () => move(index, index + 1) }] : []),
  ];
}

/**
 * A song of Up next (the queue, Now Playing), `position` places after the one playing, of `count`. Play next moves it up
 * rather than queueing it again (it's already next at the top); its own actions are Move up, Move down and Remove.
 */
export function upNextMenu(position: number, count: number): SongMenuOptions {
  return {
    playNext: position > 0 ? () => playUpcomingNext(position) : null,
    own: [...moveItems(position, count, moveUpcoming), { label: 'Remove from queue', icon: X, onSelect: () => removeUpcoming(position) }],
  };
}

/** Songs at hand, or to fetch once chosen (an album or a playlist from its card). */
type Songs = Track[] | (() => Promise<Track[]>);

/** What everything you can play offers first, in one order: Play next · Add to queue · Add to playlist…. */
export function queueItems(songs: Songs, openPicker: (tracks: Track[]) => void): MenuItem[] {
  const queue = (mode: 'next' | 'end') => (Array.isArray(songs) ? queueTracks(songs, mode) : void queueLater(songs, mode));
  const pick = () => (Array.isArray(songs) ? openPicker(songs) : void songs().then(openPicker, (err: Error) => toast(err.message, 'error')));
  return [
    { label: 'Play next', icon: ListStart, onSelect: () => queue('next') },
    { label: 'Add to queue', icon: ListEnd, onSelect: () => queue('end') },
    { label: 'Add to playlist…', icon: ListPlus, onSelect: pick },
  ];
}

/** Play and Shuffle, first in a card's menu: the page has them as buttons, a card on a touch screen has neither. */
const playItems = (play: (opts?: { shuffle?: boolean }) => Promise<void>): MenuItem[] => [
  { label: 'Play', icon: Play, onSelect: () => void play().catch((err: Error) => toast(err.message, 'error')) },
  { label: 'Shuffle', icon: Shuffle, onSelect: () => void play({ shuffle: true }).catch((err: Error) => toast(err.message, 'error')) },
];

/**
 * An album's menu, the same on its page's ⋯ and on its card's right-click or long press: Play next · Add to queue · Add
 * to playlist… · Go to artist. A card puts Play and Shuffle first.
 */
export function useAlbumMenu(album: { id: number; artistId: number }, { tracks, card }: { tracks?: Track[]; card?: boolean } = {}): MenuEntry[] {
  const navigate = useNavigate();
  const openPicker = useUI((s) => s.openPlaylistPicker);
  return [
    ...(card ? playItems((opts) => playAlbum(album.id, opts)) : []),
    ...queueItems(tracks ?? (() => albumTracks(album.id)), openPicker),
    { label: 'Go to artist', icon: MicVocal, onSelect: () => void navigate(`/artists/${album.artistId}`) },
  ];
}

/**
 * A playlist's menu, the same on its page's ⋯ and on its card: Play next · Add to queue · Add to playlist…; then, after a
 * line, its owner's actions on its page (Rename, New cover…, Share, Delete). A card puts Play and Shuffle first.
 */
export function usePlaylistMenu(playlist: { id: number }, { tracks, card, own = [] }: { tracks?: Track[]; card?: boolean; own?: MenuEntry[] } = {}): MenuEntry[] {
  const openPicker = useUI((s) => s.openPlaylistPicker);
  return [
    ...(card ? playItems((opts) => playPlaylist(playlist.id, opts)) : []),
    ...queueItems(tracks ?? (() => playlistTracks(playlist.id)), openPicker),
    DIVIDER,
    ...own,
  ];
}
