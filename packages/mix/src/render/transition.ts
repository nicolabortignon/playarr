// The last step of a transition: turn a plan and the two songs' audio around it into the mixed
// PCM the player puts between A and B. A plays as it is (at its own tempo, with the high-pass
// sweep and bass cut on it); B is time-stretched to A's tempo and eased back to its own, with its
// own bass cut; each is faded by its gain curve, and the sum goes through a soft limiter in case
// two loud songs together clip.

import { valueAt } from '../automation.ts';
import type { Automation, TransitionPlan } from '../types.ts';
import { applyHighPass, applyLowShelf, HIGH_PASS_OFF_HZ } from './biquad.ts';
import { RENDER_RATE, stretchStereo } from './stretch.ts';

/** A stretch of one song's decoded audio. */
export interface Excerpt {
  left: Float32Array;
  right: Float32Array;
  /** Song time (seconds) of sample 0. */
  start: number;
}

export interface StereoAudio {
  left: Float32Array;
  right: Float32Array;
}

/**
 * Extra seconds decoded on each side of what the plan plays. The time-stretch looks up to ~35 ms
 * either side of where it reads (to find matching waveforms), and decoders don't always land on
 * the exact sample asked for: a quarter of a second covers both with room to spare.
 */
export const EXCERPT_MARGIN = 0.25;

/** Samples under −1 dBFS pass the limiter untouched; louder ones are bent towards 1. */
const LIMIT_THRESHOLD = 10 ** (-1 / 20);
const LIMIT_HEADROOM = 1 - LIMIT_THRESHOLD;

/**
 * The song times the caller must decode for `renderTransition`: A from where the transition
 * starts until it has faded out, B from where it comes in until where normal playback resumes,
 * each with EXCERPT_MARGIN on both sides. Clamped at 0; the caller clamps to the song's length.
 */
export function excerptRanges(plan: TransitionPlan): { a: [from: number, to: number]; b: [from: number, to: number] } {
  return {
    a: [Math.max(0, plan.aStart - EXCERPT_MARGIN), plan.aStart + audibleUntil(plan.aGain, plan.length) + EXCERPT_MARGIN],
    b: [Math.max(0, plan.bStart - EXCERPT_MARGIN), plan.bResume + EXCERPT_MARGIN],
  };
}

/**
 * Renders the transition: `plan.length` seconds of stereo audio at `rate`, to be played after A
 * up to `plan.aStart` and before B from `plan.bResume`.
 *
 * The excerpts must reach back to the plan's start in each song (throws otherwise: that's a
 * decoding mistake, and the join would land off the beat). They may stop short at the other
 * end, since a song can end before the transition does: missing audio plays as silence.
 */
export function renderTransition(plan: TransitionPlan, a: Excerpt, b: Excerpt, rate = RENDER_RATE): StereoAudio {
  const samples = Math.round(plan.length * rate);
  const out: StereoAudio = { left: new Float32Array(samples), right: new Float32Array(samples) };
  if (samples === 0) return out;
  checkReachesBack(a, plan.aStart, 'A', rate);
  checkReachesBack(b, plan.bStart, 'B', rate);

  // A at its own tempo. Only the part where it's still audible is worth filtering and mixing.
  const aSamples = Math.min(samples, Math.ceil(audibleUntil(plan.aGain, plan.length) * rate) + 1);
  const aFrom = Math.round((plan.aStart - a.start) * rate);
  const highPassOn = plan.aHighPassHz.some((point) => point.value > HIGH_PASS_OFF_HZ);
  for (const side of ['left', 'right'] as const) {
    const channel = copyPadded(a[side], aFrom, aSamples);
    if (highPassOn) applyHighPass(channel, (t) => valueAt(plan.aHighPassHz, t), rate);
    applyLowShelf(channel, (t) => valueAt(plan.aLowDb, t), rate);
    mixWithGain(out[side], channel, plan.aGain, rate);
  }

  // B stretched to A's tempo, then eased back to its own.
  const bFrom = Math.round((plan.bStart - b.start) * rate);
  const stretched = stretchStereo(b.left, b.right, (t) => valueAt(plan.bRate, t), samples, rate, bFrom);
  for (const side of ['left', 'right'] as const) {
    applyLowShelf(stretched[side], (t) => valueAt(plan.bLowDb, t), rate);
    mixWithGain(out[side], stretched[side], plan.bGain, rate);
  }

  for (const side of ['left', 'right'] as const) {
    const channel = out[side];
    for (let i = 0; i < channel.length; i++) channel[i] = softLimit(channel[i]!);
  }
  return out;
}

/**
 * The soft limiter's curve: the identity up to −1 dBFS, then a tanh knee that meets it with the
 * same slope (so no corner, no audible click) and approaches 1 without reaching it. Monotonic, so
 * it never folds a peak back down; odd, so it treats both halves of the waveform alike.
 */
export function softLimit(x: number): number {
  const level = Math.abs(x);
  if (level <= LIMIT_THRESHOLD) return x;
  const bent = LIMIT_THRESHOLD + LIMIT_HEADROOM * Math.tanh((level - LIMIT_THRESHOLD) / LIMIT_HEADROOM);
  return x < 0 ? -bent : bent;
}

/**
 * Seconds into the transition after which `gain` stays at 0: the end of the last stretch where
 * it's above 0, or the whole `length` when it never fades out. 0 when it's silent throughout.
 */
function audibleUntil(gain: Automation, length: number): number {
  let lastAudible = -1;
  gain.forEach((point, index) => {
    if (point.value > 0) lastAudible = index;
  });
  if (lastAudible === -1) return 0;
  const fadedAt = gain[lastAudible + 1]?.at ?? length;
  return Math.max(0, Math.min(length, fadedAt));
}

function checkReachesBack(excerpt: Excerpt, planStart: number, song: 'A' | 'B', rate: number): void {
  // Half a sample of slack: an excerpt starting on the sample nearest the plan's start is fine.
  if (excerpt.start > planStart + 0.5 / rate) {
    throw new RangeError(
      `The ${song} excerpt starts at ${excerpt.start.toFixed(3)} s, after the transition starts in ${song} ` +
        `(${planStart.toFixed(3)} s): decode the ranges excerptRanges(plan) gives`,
    );
  }
}

/** `length` samples of `source` from `from`, with silence wherever the source doesn't reach. */
function copyPadded(source: Float32Array, from: number, length: number): Float32Array {
  const channel = new Float32Array(length);
  const first = Math.max(0, from);
  const last = Math.min(source.length, from + length);
  if (last > first) channel.set(source.subarray(first, last), first - from);
  return channel;
}

/**
 * Adds `channel` into `out`, scaled by the gain curve read at every sample, so fades are as
 * smooth as the curve itself. `channel` may be shorter than `out` (A after it has faded out).
 */
function mixWithGain(out: Float32Array, channel: Float32Array, gain: Automation, rate: number): void {
  const length = Math.min(out.length, channel.length);
  for (let i = 0; i < length; i++) out[i]! += channel[i]! * valueAt(gain, i / rate);
}
