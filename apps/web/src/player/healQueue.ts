import { api } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { usePlayer } from './store';

/**
 * A queue saved by an older version of Playarr can hold tracks missing newer fields
 * (e.g. recordingId, needed for favorites). Re-fetch those tracks' albums and swap in
 * fresh copies, keeping the queue order and the current position.
 */
export async function healQueue() {
  const stale = usePlayer.getState().queue.filter((t) => !t.recordingId);
  if (!stale.length) return;
  const albumIds = [...new Set(stale.map((t) => t.albumId))];
  const albums = await Promise.all(
    albumIds.map((id) =>
      queryClient.fetchQuery({ queryKey: ['album', id], queryFn: () => api.album(id) }).catch(() => null),
    ),
  );
  const fresh = new Map(albums.flatMap((a) => a?.tracks ?? []).map((t) => [t.id, t]));
  usePlayer.setState((s) => ({ queue: s.queue.map((t) => fresh.get(t.id) ?? t) }));
}
