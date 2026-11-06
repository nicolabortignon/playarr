import type { Track } from '@playarr/shared';
import { api } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { toast, toastWithUndo } from '../lib/toast';
import { plural } from '../lib/format';
import { usePlayer } from './store';

const fetchAlbum = (id: number) => queryClient.fetchQuery({ queryKey: ['album', id], queryFn: () => api.album(id) });
export const albumTracks = async (id: number) => (await fetchAlbum(id)).tracks;

export const artistTracks = (id: number) =>
  queryClient.fetchQuery({ queryKey: ['artist-tracks', id], queryFn: () => api.artistTracks(id) });

const fetchPlaylist = (id: number) => queryClient.fetchQuery({ queryKey: ['playlist', id], queryFn: () => api.playlist(id) });
/** A playlist's songs that are in the library, as it plays them. */
export const playlistTracks = async (id: number) => (await fetchPlaylist(id)).items.flatMap((i) => (i.track ? [i.track] : []));

/** Play means in order wherever it's pressed; only Shuffle shuffles (not whatever shuffle was left on). */
export async function playAlbum(id: number, opts?: { shuffle?: boolean }) {
  const album = await fetchAlbum(id);
  usePlayer.getState().playTracks(album.tracks, 0, { shuffle: false, ...opts, source: { label: album.title, href: `/albums/${id}` } });
}

export async function playPlaylist(id: number, opts?: { shuffle?: boolean }) {
  const p = await fetchPlaylist(id);
  const tracks = p.items.flatMap((i) => (i.track ? [i.track] : []));
  usePlayer.getState().playTracks(tracks, 0, { shuffle: false, ...opts, source: { label: p.name, href: `/playlists/${id}` } });
}

export async function playArtist(id: number, opts?: { shuffle?: boolean }) {
  const tracks = await artistTracks(id);
  const source = tracks[0] ? { label: tracks[0].artistName, href: `/artists/${id}` } : undefined;
  usePlayer.getState().playTracks(tracks, 0, { shuffle: false, ...opts, source });
}

/** Feeling lucky: 15 songs put together on the server, starting from one that suits the hour; new at every press. */
export async function feelingLucky() {
  const { tracks, subtitle } = await api.lucky();
  if (!tracks.length) return toast('Nothing to play yet: add some music to the library first.');
  usePlayer.getState().playTracks(tracks, 0, { source: { label: `Feeling lucky · ${subtitle}`, href: '/' } });
}

/** A song by its title in quotes, or how many: "“Teardrop”", "3 songs". */
const songsLabel = (tracks: Track[]) => (tracks.length === 1 ? `“${tracks[0]!.title}”` : plural(tracks.length, 'song'));

/**
 * Play next and Add to queue, from any menu. A toast names what was queued ("“Teardrop” plays next"), with Undo that
 * takes it back out of what's coming. With nothing queued, the songs just play.
 */
export function queueTracks(tracks: Track[], mode: 'next' | 'end') {
  if (!tracks.length) return;
  const p = usePlayer.getState();
  const idle = p.pos < 0;
  const base = p.queue.length;
  if (mode === 'next') p.playNext(tracks);
  else p.addToQueue(tracks);
  if (idle) return toast(`Playing ${songsLabel(tracks)}`);
  const what = songsLabel(tracks);
  toastWithUndo(mode === 'next' ? `${what} ${tracks.length === 1 ? 'plays' : 'play'} next` : `Added ${what} to the queue`, () => unqueue(tracks, base));
}

/** Undo for Play next and Add to queue: those entries leave what's coming (not the song playing), if it's the same queue. */
function unqueue(tracks: Track[], base: number) {
  const s = usePlayer.getState();
  // Something else has been played since (a new queue reuses the places): leave it alone.
  if (!tracks.every((t, i) => s.queue[base + i] === t)) return;
  const added = new Set(tracks.map((_, i) => base + i));
  s.setUpcoming(s.order.slice(s.pos + 1).filter((q) => !added.has(q)));
}

/** Queue songs that are still to be fetched (an album or a playlist from its card); a failure says so. */
export async function queueLater(songs: () => Promise<Track[]>, mode: 'next' | 'end') {
  try {
    queueTracks(await songs(), mode);
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

export const queueAlbum = (id: number, mode: 'next' | 'end') => queueLater(() => albumTracks(id), mode);
export const queueArtist = (id: number, mode: 'next' | 'end') => queueLater(() => artistTracks(id), mode);

// Up next: the songs after the one playing, by their place among them (0 plays next).

/** Up next, as places in the player's queue. */
const upcoming = () => {
  const s = usePlayer.getState();
  return s.order.slice(s.pos + 1);
};

/** Move a song of Up next from one place to another: dragging, or Move up and Move down in its menu. */
export function moveUpcoming(from: number, to: number) {
  const next = upcoming();
  if (from === to || from < 0 || from >= next.length || to < 0 || to >= next.length) return;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  usePlayer.getState().setUpcoming(next);
}

/** Up next's Play next: the song moves up to play next (rather than being queued again), with Undo. */
export function playUpcomingNext(position: number) {
  const s = usePlayer.getState();
  const queueIndex = upcoming()[position];
  if (queueIndex === undefined || position === 0) return;
  const track = s.queue[queueIndex]!;
  moveUpcoming(position, 0);
  toastWithUndo(`“${track.title}” plays next`, () => {
    const now = upcoming();
    const at = now.indexOf(queueIndex);
    if (at >= 0 && usePlayer.getState().queue[queueIndex] === track) moveUpcoming(at, Math.min(position, now.length - 1));
  });
}

export function playUpcoming(position: number) {
  const s = usePlayer.getState();
  s.jumpTo(s.pos + 1 + position);
}

/**
 * Remove from queue: the song leaves Up next at once, with Undo, which puts it back before the song that came after it
 * (while it's still the same queue).
 */
export function removeUpcoming(position: number) {
  const s = usePlayer.getState();
  const next = upcoming();
  const queueIndex = next[position];
  if (queueIndex === undefined) return;
  const track = s.queue[queueIndex]!;
  const followedBy = next[position + 1];
  s.removeAt(s.pos + 1 + position);
  toastWithUndo(`Removed “${track.title}” from the queue`, () => {
    const now = usePlayer.getState();
    const coming = upcoming();
    // A new queue reuses the places; and the song may be back already.
    if (now.queue[queueIndex] !== track || coming.includes(queueIndex)) return;
    const at = followedBy === undefined ? -1 : coming.indexOf(followedBy);
    coming.splice(at < 0 ? coming.length : at, 0, queueIndex);
    now.setUpcoming(coming);
  });
}
