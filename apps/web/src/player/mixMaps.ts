import type { CuePoints, MixMap } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { api } from '../lib/api';

/** Asked again after this long: a song without a map may have been analysed since, and cue points edited. */
const FRESH_MS = 60_000;

type SongMap = MixMap & { cues?: CuePoints };

/** What's known of each song's mix map (null: none yet), and when it was asked for. */
const known = new Map<string, { map: SongMap | null; at: number }>();
const asking = new Set<string>();

/** A song's mix map, if it has come: the engine never waits for one. */
export function mixMapOf(recordingId: string): SongMap | undefined {
  return known.get(recordingId)?.map ?? undefined;
}

/** Forget a song's mix map (its cue points were just edited): it's asked for afresh next time. */
export function forgetMixMap(recordingId: string) {
  known.delete(recordingId);
}

/** Learn the mix maps of these songs (for cuts on the beat), unless known lately or on their way. */
export async function loadMixMaps(tracks: (Track | undefined)[]): Promise<void> {
  const now = Date.now();
  const ids = [...new Set(tracks.flatMap((t) => (t?.recordingId ? [t.recordingId] : [])))].filter(
    (id) => !asking.has(id) && now - (known.get(id)?.at ?? -Infinity) > FRESH_MS,
  );
  if (!ids.length) return;
  for (const id of ids) asking.add(id);
  try {
    const found = await api.mixMaps(ids);
    for (const id of ids) known.set(id, { map: found[id] ?? known.get(id)?.map ?? null, at: now });
  } catch {
    // Offline or the server busy: asked again next time; meanwhile the songs follow each other the usual way.
  } finally {
    for (const id of ids) asking.delete(id);
  }
}
