// The last step of a transition: turn a plan and the two songs' audio around it into the mixed
// PCM the player puts between A and B. A plays as it is (at its own tempo, with the high-pass
// sweep and bass cut on it); B is time-stretched to A's tempo and eased back to its own, with its
// own bass cut; each is faded by its gain curve. Two loud masters playing together can sum to
// twice full scale (+6 dB), so the sum goes through a look-ahead limiter that turns the level
// down smoothly ahead of each peak. It never touches a song playing on its own, however loud:
// the transition must join each song's normal playback sample for sample.

import { integrate, valueAt } from '../automation.ts';
import type { Automation, TransitionPlan } from '../types.ts';
import { applyHighPass, applyLowShelf, HIGH_PASS_OFF_HZ } from './filters.ts';
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

/** How far bResume may be from where B's rate takes it: rounding, not a different place. */
const MAX_RESUME_MISMATCH = 0.001;

/** The limiter's ceiling where the songs alone are quieter: −1 dBFS. */
export const LIMIT_CEILING = 10 ** (-1 / 20);
/**
 * How far ahead the limiter sees a peak coming, which is also how long it takes to turn down for
 * it: short enough to catch a kick's attack as it comes, long enough that the gain moves as a
 * ramp, not a jump (a jump would click, and reshaping single wave peaks is what a clipper does).
 */
const LOOK_AHEAD_SECONDS = 0.005;
/** How quickly the limiter lets go after a peak (time constant): slow enough not to pump audibly. */
const RELEASE_SECONDS = 0.1;

/**
 * The song times the caller must decode for `renderTransition`: A from where the transition
 * starts until it has faded out, B from where it comes in until where normal playback resumes,
 * each with EXCERPT_MARGIN on both sides. Clamped at 0; the caller clamps to the song's length.
 * Undefined for a straight cut (no transition audio, so nothing to decode).
 */
export function excerptRanges(plan: TransitionPlan): { a: [from: number, to: number]; b: [from: number, to: number] } | undefined {
  checkFinite(plan);
  if (plan.length === 0) return undefined;
  return {
    a: [Math.max(0, plan.aStart - EXCERPT_MARGIN), plan.aStart + audibleUntil(plan.aGain, plan.length) + EXCERPT_MARGIN],
    b: [Math.max(0, plan.bStart - EXCERPT_MARGIN), plan.bResume + EXCERPT_MARGIN],
  };
}

/**
 * Renders the transition: `plan.length` seconds of stereo audio at `rate`, to be played after A
 * up to `plan.aStart` and before B from `plan.bResume`.
 *
 * The plan must be consistent (finite times; bResume where bRate takes B from bStart), and the
 * excerpts must reach back to the plan's start in each song: it throws otherwise, as that's a
 * planning or decoding mistake and the joins would land off the beat. The excerpts may stop
 * short at the other end, since a song can end before the transition does: missing audio plays
 * as silence. The first sample follows A's sample at round(aStart × rate), the last runs into
 * B's at round(bResume × rate).
 */
export function renderTransition(plan: TransitionPlan, a: Excerpt, b: Excerpt, rate = RENDER_RATE): StereoAudio {
  checkFinite(plan);
  const samples = Math.round(plan.length * rate);
  const out: StereoAudio = { left: new Float32Array(samples), right: new Float32Array(samples) };
  if (samples === 0) return out;
  checkResume(plan);
  checkReachesBack(a, plan.aStart, 'A', rate);
  checkReachesBack(b, plan.bStart, 'B', rate);

  // A at its own tempo. Only the part where it's still audible is worth filtering and mixing.
  const aSamples = Math.min(samples, Math.ceil(audibleUntil(plan.aGain, plan.length) * rate) + 1);
  const aFrom = Math.round((plan.aStart - a.start) * rate);
  const highPassOn = plan.aHighPassHz.some((point) => point.value > HIGH_PASS_OFF_HZ);
  const aGain = sampleCurve(plan.aGain, aSamples, rate);
  // The level each moment may reach: −1 dBFS, or what the louder song reaches there on its own.
  const allowed = new Float32Array(samples).fill(LIMIT_CEILING);
  for (const side of ['left', 'right'] as const) {
    const channel = copyPadded(a[side], aFrom, aSamples);
    if (highPassOn) applyHighPass(channel, (t) => valueAt(plan.aHighPassHz, t), rate);
    applyLowShelf(channel, (t) => valueAt(plan.aLowDb, t), rate);
    mixWithGain(out[side], channel, aGain, allowed);
  }

  // B stretched to A's tempo, then eased back to its own. Placed by where it must end rather than
  // where it starts, so that the transition's last sample runs exactly into B's sample at bResume
  // (which is where the player picks B up); B's start moves by under a sample for it.
  const bEnd = Math.round((plan.bResume - b.start) * rate);
  const bFrom = bEnd - rate * integrate(plan.bRate, 0, samples / rate);
  const stretched = stretchStereo(b.left, b.right, (t) => valueAt(plan.bRate, t), samples, rate, bFrom);
  const bGain = sampleCurve(plan.bGain, samples, rate);
  for (const side of ['left', 'right'] as const) {
    applyLowShelf(stretched[side], (t) => valueAt(plan.bLowDb, t), rate);
    mixWithGain(out[side], stretched[side], bGain, allowed);
  }

  limitLoudness(out, rate, allowed);
  return out;
}

/**
 * Turns `audio` down in place wherever it goes over the allowed level, smoothly, like a mastering
 * limiter rather than a clipper: the waveform keeps its shape and only its level moves.
 *
 * `allowed` is the level allowed at each sample, at least −1 dBFS (the default throughout). The
 * renderer raises it to what the louder song reaches on its own at that moment, so a song playing
 * alone is never touched, and two songs together are never louder than the louder one alone.
 *
 * The gain needed at each sample (the allowed level over the louder channel's level, so both
 * channels move together and the stereo image holds) is spread backwards over the look-ahead
 * window by a running minimum, let back up towards 1 with the release, then averaged over the same
 * window. Each value in that average is a minimum over a window containing the sample itself, so
 * the gain is never more than the sample needs, and the average turns each step down into a ramp
 * over LOOK_AHEAD_SECONDS. Audio already within the allowed level comes out bit for bit unchanged.
 *
 * Finally, samples beyond ±1 (only possible if a song alone goes there) are clamped, which is what
 * playing that song on its own does too.
 */
export function limitLoudness(audio: StereoAudio, rate: number, allowed?: Float32Array): void {
  const { left, right } = audio;
  const length = Math.min(left.length, right.length);
  const window = Math.max(1, Math.round(LOOK_AHEAD_SECONDS * rate));

  const needed = new Float32Array(length);
  let anyOver = false;
  for (let i = 0; i < length; i++) {
    const level = Math.max(Math.abs(left[i]!), Math.abs(right[i]!));
    const limit = allowed ? allowed[i]! : LIMIT_CEILING;
    if (level > limit) {
      needed[i] = limit / level;
      anyOver = true;
    } else {
      needed[i] = 1;
    }
  }
  if (anyOver) {
    const held = runningMinimumAhead(needed, window);
    // Release: the gain may rise back towards 1 only so fast, and never above what's held.
    const release = 1 - Math.exp(-1 / (RELEASE_SECONDS * rate));
    let gain = 1;
    for (let i = 0; i < length; i++) {
      gain = Math.min(held[i]!, gain + (1 - gain) * release);
      held[i] = gain;
    }
    // Average over the window behind each sample, as a sum of the reductions (1 − gain), so
    // stretches with nothing to reduce stay at exactly 1. Before the start counts as the first
    // value: minimums taken there would have been at least as large, so this only errs low.
    const before = 1 - held[0]!;
    let reduction = before * (window - 1);
    // How many samples in the window have a reduction: when none do, the sum is reset to exactly 0.
    let reducing = before !== 0 ? window - 1 : 0;
    for (let i = 0; i < length; i++) {
      const entering = 1 - held[i]!;
      reduction += entering;
      if (entering !== 0) reducing++;
      if (i > 0) {
        const leaving = i >= window ? 1 - held[i - window]! : before;
        reduction -= leaving;
        if (leaving !== 0) reducing--;
      }
      if (reducing === 0) reduction = 0;
      const gainHere = 1 - reduction / window;
      left[i]! *= gainHere;
      right[i]! *= gainHere;
    }
  }
  for (let i = 0; i < length; i++) {
    left[i] = Math.max(-1, Math.min(1, left[i]!));
    right[i] = Math.max(-1, Math.min(1, right[i]!));
  }
}

/** For each sample, the smallest of `values` from it to `window` − 1 samples later. */
function runningMinimumAhead(values: Float32Array, window: number): Float32Array {
  const out = new Float32Array(values.length);
  // Indices of candidates for the minimum, in a ring, their values increasing from front to back.
  const ring = new Int32Array(window + 1);
  let front = 0;
  let count = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i]!;
    // Anything not smaller than the new value can never be the minimum again.
    while (count > 0 && values[ring[(front + count - 1) % ring.length]!]! >= value) count--;
    ring[(front + count) % ring.length] = i;
    count++;
    // Drop the front once it has slid out of the window.
    if (ring[front]! > i + window - 1) {
      front = (front + 1) % ring.length;
      count--;
    }
    out[i] = values[ring[front]!]!;
  }
  return out;
}

/**
 * Seconds into the transition after which `gain` stays at 0: the end of the last stretch where
 * it's above 0, or the whole `length` when it never fades out. 0 when it's silent throughout.
 */
function audibleUntil(gain: Automation, length: number): number {
  let lastAudible = gain.length - 1;
  while (lastAudible >= 0 && !(gain[lastAudible]!.value > 0)) lastAudible--;
  if (lastAudible === -1) return 0;
  const fadedAt = gain[lastAudible + 1]?.at ?? length;
  return Math.max(0, Math.min(length, fadedAt));
}

/** A plan whose times aren't numbers would render garbage or loop forever: refuse it up front. */
function checkFinite(plan: TransitionPlan): void {
  for (const field of ['aStart', 'bStart', 'length', 'bResume'] as const) {
    if (!Number.isFinite(plan[field])) throw new RangeError(`The transition plan's ${field} is ${plan[field]}`);
  }
  if (plan.length < 0) throw new RangeError(`The transition plan's length is negative (${plan.length} s)`);
}

/** B must end where the plan resumes it: bResume = bStart + ∫ bRate (else B's beats miss A's). */
function checkResume(plan: TransitionPlan): void {
  const reached = plan.bStart + integrate(plan.bRate, 0, plan.length);
  if (Math.abs(reached - plan.bResume) > MAX_RESUME_MISMATCH) {
    throw new RangeError(
      `The transition plan resumes B at ${plan.bResume.toFixed(3)} s, but its rate takes B from ` +
        `${plan.bStart.toFixed(3)} s to ${reached.toFixed(3)} s`,
    );
  }
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

/** An automation curve read at every sample, so fades are as smooth as the curve itself. */
function sampleCurve(automation: Automation, samples: number, rate: number): Float32Array {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) curve[i] = valueAt(automation, i / rate);
  return curve;
}

/**
 * Adds `channel` × `gain` into `out`, raising `allowed` to the level it reaches on its own.
 * `channel` may be shorter than `out` (A after it has faded out).
 */
function mixWithGain(out: Float32Array, channel: Float32Array, gain: Float32Array, allowed: Float32Array): void {
  const length = Math.min(out.length, channel.length, gain.length);
  for (let i = 0; i < length; i++) {
    const sample = channel[i]! * gain[i]!;
    out[i]! += sample;
    const level = Math.abs(sample);
    if (level > allowed[i]!) allowed[i] = level;
  }
}
