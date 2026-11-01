import { integrate, type TransitionPlan, valueAt } from '@playarr/mix';

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
