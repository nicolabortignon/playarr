import { focusSound } from './generators.ts';
import { tooShort } from './mood.ts';
import type { Song } from './taste.ts';

/** How often a song's lyrics are looked up ahead: one every five minutes, under 300 a day, so LRCLIB isn't leaned on. */
export const LYRICS_AHEAD_EVERY_MS = 5 * 60_000;
/** Singing guessed between these, from a song's tags and style, could go either way: its lyrics settle it. */
const UNDECIDED = { above: 0.25, below: 0.8 };

/**
 * Songs whose lyrics, looked up ahead, would settle whether they belong in Deep focus (plan 8): measured songs it would
 * take by their sound (`focusSound`) whose singing is only guessed from their tags and style, not looked up yet. Bonobo
 * is the case in point: tagged downtempo, electronic and trip hop, guessed 0.44, just too likely sung for Deep focus,
 * though most of Black Sands has no words. The most undecided first; at most `limit`.
 */
export function lyricsAheadCandidates(songs: Song[], lookedUp: ReadonlySet<string>, limit: number): Song[] {
  return songs
    .filter(
      (s) =>
        s.measured &&
        s.vocals > UNDECIDED.above &&
        s.vocals < UNDECIDED.below &&
        !s.traits.sketch &&
        !tooShort(s.track.duration, s.sound) &&
        !lookedUp.has(s.track.recordingId) &&
        focusSound(s),
    )
    .sort((a, b) => Math.abs(a.vocals - 0.5) - Math.abs(b.vocals - 0.5))
    .slice(0, limit);
}
