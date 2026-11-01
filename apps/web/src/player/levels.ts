import type { Track, TrackLevel } from '@playarr/shared';
import { create } from 'zustand';
import { api } from '../lib/api';

/** Songs not measured yet are asked about again after this long (they're being measured meanwhile). */
const RETRY_MS = 10 * 60_000;

interface Levels {
  levels: Record<string, TrackLevel>;
}

/** How loud each song is, as far as the server has measured: for even volume. */
export const useLevels = create<Levels>()(() => ({ levels: {} }));

const asked = new Map<string, number>();

/** Learn the levels of these songs, unless known or asked lately. */
export async function loadLevels(tracks: (Track | undefined)[]): Promise<void> {
  const now = Date.now();
  const known = useLevels.getState().levels;
  const ids = [...new Set(tracks.flatMap((t) => (t ? [t.recordingId] : [])))].filter(
    (id) => !known[id] && now - (asked.get(id) ?? 0) > RETRY_MS,
  );
  if (!ids.length) return;
  for (const id of ids) asked.set(id, now);
  try {
    const found = await api.levels(ids);
    if (Object.keys(found).length) useLevels.setState((s) => ({ levels: { ...s.levels, ...found } }));
  } catch {
    for (const id of ids) asked.delete(id);
  }
}
