import type { Track } from '@playarr/shared';
import { api } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { toast } from '../lib/toast';
import { plural } from '../lib/format';
import { usePlayer } from './store';

const fetchAlbum = (id: number) => queryClient.fetchQuery({ queryKey: ['album', id], queryFn: () => api.album(id) });
const albumTracks = async (id: number) => (await fetchAlbum(id)).tracks;

const artistTracks = (id: number) =>
  queryClient.fetchQuery({ queryKey: ['artist-tracks', id], queryFn: () => api.artistTracks(id) });

/** Play means in order wherever it's pressed; only Shuffle shuffles (not whatever shuffle was left on). */
export async function playAlbum(id: number, opts?: { shuffle?: boolean }) {
  const album = await fetchAlbum(id);
  usePlayer.getState().playTracks(album.tracks, 0, { shuffle: false, ...opts, source: { label: album.title, href: `/albums/${id}` } });
}

export async function playArtist(id: number, opts?: { shuffle?: boolean }) {
  const tracks = await artistTracks(id);
  const source = tracks[0] ? { label: tracks[0].artistName, href: `/artists/${id}` } : undefined;
  usePlayer.getState().playTracks(tracks, 0, { shuffle: false, ...opts, source });
}

export async function shuffleLibrary() {
  const tracks = await api.randomTracks(300);
  usePlayer.getState().playTracks(tracks, 0, { shuffle: true, source: { label: 'Your whole library', href: '/albums' } });
}

export function queueTracks(tracks: Track[], mode: 'next' | 'end') {
  const p = usePlayer.getState();
  if (mode === 'next') p.playNext(tracks);
  else p.addToQueue(tracks);
  toast(mode === 'next' ? `Playing ${plural(tracks.length, 'track')} next` : `Added ${plural(tracks.length, 'track')} to queue`);
}

export async function queueAlbum(id: number, mode: 'next' | 'end') {
  queueTracks(await albumTracks(id), mode);
}
