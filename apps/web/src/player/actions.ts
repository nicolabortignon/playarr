import type { Track } from '@playarr/shared';
import { api } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { toast } from '../lib/toast';
import { plural } from '../lib/format';
import { usePlayer } from './store';

const albumTracks = async (id: number) =>
  (await queryClient.fetchQuery({ queryKey: ['album', id], queryFn: () => api.album(id) })).tracks;

const artistTracks = (id: number) =>
  queryClient.fetchQuery({ queryKey: ['artist-tracks', id], queryFn: () => api.artistTracks(id) });

export async function playAlbum(id: number, opts?: { shuffle?: boolean }) {
  usePlayer.getState().playTracks(await albumTracks(id), 0, opts);
}

export async function playArtist(id: number, opts?: { shuffle?: boolean }) {
  usePlayer.getState().playTracks(await artistTracks(id), 0, opts);
}

export async function shuffleLibrary() {
  const tracks = await api.randomTracks(300);
  usePlayer.getState().playTracks(tracks, 0, { shuffle: true });
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
