import {
  type CuePoints,
  integrate,
  MIN_DOWNBEAT_CONFIDENCE,
  type MixMap,
  type MixMode,
  STEADY_BEAT_CONFIDENCE,
  type TransitionPlan,
  valueAt,
} from '@playarr/mix';

// A DJ transition plays as a file of its own between the two songs, but the listener (the lock screen,
// the seek bar, the history) only ever sees the two songs. These map the transition's time to theirs.

/** Joining the transition this late still sounds right (it starts as A itself); later, the moment has passed (a seek). */
const MAX_LATE_S = 2;
/** Starting it this early would cut A short: something moved meanwhile (a seek back), so A plays on. */
const MAX_EARLY_S = 1;

/** Where B is, in its own seconds, this far into the transition: B plays time-stretched, its clock running at bRate. */
export function bTimeAt(plan: TransitionPlan, transitionTime: number): number {
  return plan.bStart + integrate(plan.bRate, 0, transitionTime);
}

/** The song to show this far into the transition, and where in it: A until the switch, then B. */
export function songTimeDuring(plan: TransitionPlan, transitionTime: number): { song: 'a' | 'b'; time: number } {
  if (transitionTime < plan.switchAt) return { song: 'a', time: plan.aStart + transitionTime };
  return { song: 'b', time: bTimeAt(plan, transitionTime) };
}

/**
 * The point of the transition that shows B at `bTime`, for a seek within it; null outside the part that
 * shows B (before the switch the transition shows A; from its end on, B's own file plays).
 */
export function transitionTimeFor(plan: TransitionPlan, bTime: number): number | null {
  let low = plan.switchAt;
  let high = plan.length;
  if (!(bTime >= bTimeAt(plan, low) && bTime < bTimeAt(plan, high))) return null;
  // B's time only grows with the transition's, so halving the interval homes in on it.
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (bTimeAt(plan, mid) <= bTime) low = mid;
    else high = mid;
  }
  return low;
}

/**
 * Where to start the transition file with A at `aTime`, or null to let A play on (followed by B the usual
 * way). With the sleep timer stopping at the end of the song, A plays out: there's nothing to blend into.
 */
export function bridgeEntry(plan: TransitionPlan, aTime: number, stopsAtSongEnd: boolean): number | null {
  const late = aTime - plan.aStart;
  if (stopsAtSongEnd || late > MAX_LATE_S || late < -MAX_EARLY_S) return null;
  // A timer that came late joins where A is by now: the transition starts as A itself, so it stays in step.
  return Math.max(0, late);
}

/**
 * How loud to play the transition file for even volume, given each song's level gain. The file holds both
 * songs at their own levels, so it takes each one's gain as much as that song is heard: A's at the start
 * (as A's own file had), B's at the end (as B's own file will), blended in decibels between.
 */
export function bridgeGain(plan: TransitionPlan, transitionTime: number, gainA: number, gainB: number): number {
  const a = valueAt(plan.aGain, transitionTime) ** 2;
  const b = valueAt(plan.bGain, transitionTime) ** 2;
  const share = a + b > 0 ? b / (a + b) : transitionTime < plan.switchAt ? 0 : 1;
  return gainA ** (1 - share) * gainB ** share;
}

// With no transition ready (not rendered in time, failed, or none possible), DJ mix still joins the songs
// on the beat: A stops on its last downbeat and B comes in on its first, as a plain gapless start.

/** A cut never leaves A more than this before its real end (a long silent tail plays out instead). */
const LONGEST_CUT_S = 20;
/** B's intro longer than this many bars is mostly skipped at a cut: it was made for a blend, not to start on. */
const LONG_INTRO_BARS = 8;

type Song = MixMap & { cues?: CuePoints };

/** Where A stops and B starts at a cut. */
export interface BeatCut {
  aEnd: number;
  bStart: number;
}

const beatLength = (song: Song) => 60 / song.bpm;
const steadyBeat = (song: Song) =>
  Number.isFinite(song.bpm) &&
  song.bpm > 0 &&
  song.beatConfidence >= STEADY_BEAT_CONFIDENCE &&
  Number.isFinite(song.firstBeat) &&
  Number.isFinite(song.downbeatOffset);
const firstDownbeat = (song: Song) => song.firstBeat + song.downbeatOffset * beatLength(song);
/** The grid a cut lands on: bars, or beats where the bar starts are unsure (missing confidence counts as sure). */
const lineLength = (song: Song) =>
  (song.downbeatConfidence === undefined || song.downbeatConfidence >= MIN_DOWNBEAT_CONFIDENCE ? 4 : 1) * beatLength(song);
const finiteOr = (value: number | undefined, fallback: number) => (value !== undefined && Number.isFinite(value) ? value : fallback);

/**
 * The cut from A into B on the beat, or null to play them the usual way: mixing off, songs of one album
 * in order (heard as one), no steady beat in either, or no downbeat late enough in A.
 */
export function beatCut(
  a: Song,
  b: Song,
  { aDuration, mode, sameAlbumInOrder }: { aDuration: number; mode: MixMode; sameAlbumInOrder: boolean },
): BeatCut | null {
  if (mode === 'off' || sameAlbumInOrder || !steadyBeat(a) || !steadyBeat(b)) return null;
  // A: the last grid line at or before its sound ends, but not so early that much of A would go unheard.
  const aOrigin = firstDownbeat(a);
  const aLine = lineLength(a);
  const soundEnd = Math.min(finiteOr(a.soundEnd, aDuration), aDuration);
  const aEnd = aOrigin + Math.floor((soundEnd - aOrigin) / aLine + 1e-9) * aLine;
  const earliest = Math.max(aDuration - LONGEST_CUT_S, finiteOr(a.cues?.mixOut ?? a.outroStart, 0));
  if (!(aEnd >= earliest && aEnd > 0)) return null;
  // B: its first downbeat; with a long intro, a bar before the intro ends (on a grid line, not before it).
  const bOrigin = Math.max(0, firstDownbeat(b));
  const bLine = lineLength(b);
  const bar = 4 * beatLength(b);
  const intoIntro = finiteOr(b.cues?.mixIn ?? b.introEnd, 0) - bar;
  let bStart = bOrigin;
  if (intoIntro - bOrigin > LONG_INTRO_BARS * bar) bStart = bOrigin + Math.ceil((intoIntro - bOrigin) / bLine - 1e-9) * bLine;
  // Never into B's own outro (where the next mix begins), nor past its end.
  if (bStart >= finiteOr(b.cues?.mixOut ?? b.outroStart, b.duration)) bStart = bOrigin;
  return bStart < b.duration ? { aEnd, bStart } : null;
}
