// Whether a song's beat holds steady where a mix would be, from its phrase-by-phrase drift. A song
// whose beat wanders in a breakdown can still be blended in its outro: what matters is the beats the
// two songs play together.

import type { MixMap } from './types.ts';

/** A phrase's beat this far (ms) from where the song's beats sit: a blend's kicks start to flam. */
export const DRIFT_LIMIT_MS = 25;

const PHRASE_BEATS = 16;
/** A hair, so a span ending exactly on a phrase line doesn't reach into the next phrase. */
const EPSILON = 1e-6;

type Grid = Pick<MixMap, 'bpm' | 'firstBeat' | 'downbeatOffset' | 'gridStable' | 'phraseDrift'>;

/**
 * The beat holds from `from` to `to` (seconds into the song): every phrase overlapping that span has
 * its beat within DRIFT_LIMIT_MS of the song's, or no beat to judge. Maps without phraseDrift (from
 * before version 6, or without the beat model) can only say it for the whole song: their gridStable.
 */
export function beatHolds(song: Grid, from: number, to: number): boolean {
  const drift = song.phraseDrift;
  if (!drift) return song.gridStable;
  if (!(song.bpm > 0) || !(to > from)) return true;
  const phrase = (PHRASE_BEATS * 60) / song.bpm;
  const firstLine = song.firstBeat + (song.downbeatOffset * 60) / song.bpm;
  const first = Math.max(0, Math.floor((from - firstLine) / phrase + EPSILON));
  const last = Math.min(drift.length - 1, Math.ceil((to - firstLine) / phrase - EPSILON) - 1);
  for (let k = first; k <= last; k++) {
    const d = drift[k];
    if (d !== null && d !== undefined && Math.abs(d) > DRIFT_LIMIT_MS) return false;
  }
  return true;
}
