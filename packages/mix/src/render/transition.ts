// The last step of a transition: turn a plan and the two songs' audio around it into the mixed
// PCM the player puts between A and B. A plays as it is (at its own tempo, with the high-pass
// sweep and bass cut on it); B is time-stretched to A's tempo and eased back to its own, with its
// own bass cut; each is faded by its gain curve. Two loud masters playing together can sum to
// twice full scale (+6 dB), so the sum goes through a look-ahead limiter that turns the level
// down smoothly ahead of each peak and holds it there through the overlap. It doesn't limit a
// song playing on its own, however loud, so where only one song plays, at least 5 ms before the
// other comes in and a second and a half after the last loud moment of the overlap, the
// transition is that song sample for sample, and joins its normal playback exactly.

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

/**
 * How far bResume may be from where B's rate takes it, in samples. B is placed by where it ends,
 * so any mismatch moves all of B's beats against A's: allow only rounding.
 */
const MAX_RESUME_MISMATCH_SAMPLES = 0.5;

/** The limiter's ceiling where the songs alone are quieter: −1 dBFS. */
export const LIMIT_CEILING = 10 ** (-1 / 20);
/**
 * How far ahead the limiter sees a peak coming, which is also how long it takes to turn down for
 * it: short enough to catch a kick's attack as it comes, long enough that the gain moves as a
 * ramp, not a jump (a jump would click, and reshaping single wave peaks is what a clipper does).
 */
const LOOK_AHEAD_SECONDS = 0.005;
/**
 * How long the limiter holds its gain after a peak before letting go. Two beat-matched loud songs
 * peak together on every kick; a limiter that recovers between kicks pumps (measured on two hot
 * masters at 124 BPM: 5.4 dB of swing per beat with a plain 100 ms release, 4.4 dB at 400 ms, 2.1 dB
 * at 1.5 s, which then held the gain down for 3 s after the overlap). Holding for a second, two beats
 * at 120 BPM, keeps the level steady through the overlap (0.3 dB per beat) and lets go about a
 * second after it.
 */
const HOLD_SECONDS = 1;
/** How quickly the limiter lets go once the hold is over (time constant): a smooth return, not a jump. */
const RELEASE_SECONDS = 0.15;

/**
 * The song times the caller must decode for `renderTransition`: A from where the transition
 * starts until it has faded out, B from where it comes in until where normal playback resumes,
 * each with EXCERPT_MARGIN on both sides. Clamped at 0; the caller clamps to the song's length.
 * Undefined for a straight cut (no transition audio, so nothing to decode).
 */
export function excerptRanges(plan: TransitionPlan, tail = 0): { a: [from: number, to: number]; b: [from: number, to: number] } | undefined {
  checkFinite(plan);
  if (plan.length === 0) return undefined;
  return {
    a: [Math.max(0, plan.aStart - EXCERPT_MARGIN), plan.aStart + audibleUntil(plan.aGain, plan.length) + EXCERPT_MARGIN],
    b: [Math.max(0, plan.bStart - EXCERPT_MARGIN), plan.bResume + Math.max(0, tail) + EXCERPT_MARGIN],
  };
}

/**
 * Renders the transition: `plan.length` seconds of stereo audio at `rate`, to be played after A
 * up to `plan.aStart` and before B from `plan.bResume`; then `tail` seconds of B on its own from
 * bResume, as B's own playback goes on (B's excerpt must reach that far: see excerptRanges). With a
 * tail, a player can start B's own file at any moment during it, in step, rather than exactly at
 * the transition's end.
 *
 * The plan must be consistent (finite times; bResume where bRate takes B from bStart), and the
 * excerpts must reach back to the plan's start in each song: it throws otherwise, as that's a
 * planning or decoding mistake and the joins would land off the beat. The excerpts may stop
 * short at the other end, since a song can end before the transition does: missing audio plays
 * as silence. The first sample follows A's excerpt sample round((aStart − a.start) × rate); the
 * last runs into B's excerpt sample round((bResume − b.start) × rate).
 *
 * The start join also relies on the plan starting with A alone, as the planner's do: aGain 1 and
 * bGain 0 at time 0, A's filters neutral. (The end join likewise wants A silent and B's filter
 * neutral by the end.) Nothing else would make the first sample continue A's normal playback.
 */
export function renderTransition(plan: TransitionPlan, a: Excerpt, b: Excerpt, rate = RENDER_RATE, tail = 0): StereoAudio {
  checkFinite(plan);
  const samples = Math.round(plan.length * rate);
  const out: StereoAudio = { left: new Float32Array(samples), right: new Float32Array(samples) };
  if (samples === 0) return out;
  checkCurves(plan);
  checkResume(plan, rate);
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
  return withTail(out, b, bEnd, Math.max(0, Math.round(tail * rate)));
}

/** `audio` followed by `samples` of B's excerpt from its sample `from` on, as it is (silence past its end). */
function withTail(audio: StereoAudio, b: Excerpt, from: number, samples: number): StereoAudio {
  if (samples === 0) return audio;
  const length = audio.left.length;
  const out: StereoAudio = { left: new Float32Array(length + samples), right: new Float32Array(length + samples) };
  for (const side of ['left', 'right'] as const) {
    out[side].set(audio[side]);
    out[side].set(copyPadded(b[side], from, samples), length);
  }
  return out;
}

/**
 * Turns `audio` down in place wherever it goes over the allowed level, smoothly, like a mastering
 * limiter rather than a clipper: the waveform keeps its shape and only its level moves.
 *
 * `allowed` is the level allowed at each sample, at least −1 dBFS (the default throughout). The
 * renderer raises it to what the louder song reaches on its own at that moment, so a song playing
 * alone never needs limiting, and two songs together are never louder than the louder one alone.
 * The gain does move a little either side of where limiting is needed, though: from 5 ms before
 * (the look-ahead) to HOLD_SECONDS and the release after.
 *
 * The gain needed at each sample (the allowed level over the louder channel's level, so both
 * channels move together and the stereo image holds) is spread over the look-ahead before it and
 * the hold after it by a running minimum, let back up towards 1 with the release, then averaged
 * over the look-ahead window. Each value in that average is a minimum over a window containing the
 * sample itself, so the gain is never more than the sample needs, and the average turns each step
 * down into a ramp over LOOK_AHEAD_SECONDS. Audio with nothing over the allowed level comes out bit
 * for bit unchanged.
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
    const held = runningMinimum(needed, Math.round(HOLD_SECONDS * rate), window - 1);
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

/** For each sample, the smallest of `values` from `behind` samples before it to `ahead` after. */
function runningMinimum(values: Float32Array, behind: number, ahead: number): Float32Array {
  const length = values.length;
  const out = new Float32Array(length);
  // Indices of candidates for the minimum, in a ring, their values increasing from front to back.
  const ring = new Int32Array(behind + ahead + 2);
  let front = 0;
  let count = 0;
  let next = 0; // the next index to take into the window
  for (let i = 0; i < length; i++) {
    for (const last = Math.min(length - 1, i + ahead); next <= last; next++) {
      const value = values[next]!;
      // Anything not smaller than the new value can never be the minimum again.
      while (count > 0 && values[ring[(front + count - 1) % ring.length]!]! >= value) count--;
      ring[(front + count) % ring.length] = next;
      count++;
    }
    // Drop candidates that have slid out of the window behind.
    while (ring[front]! < i - behind) {
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

/**
 * Every automation curve must be one the renderer can read: at least one point, all numbers (JSON
 * turns NaN into null, which would render as NaN samples), in time order; and B's rate positive.
 */
function checkCurves(plan: TransitionPlan): void {
  const curves = ['bRate', 'aGain', 'bGain', 'aLowDb', 'bLowDb', 'aHighPassHz'] as const;
  for (const name of curves) {
    const curve: unknown = plan[name];
    if (!Array.isArray(curve) || curve.length === 0) throw new RangeError(`The transition plan's ${name} has no points`);
    let previous = -Infinity;
    for (const point of curve as unknown[]) {
      const { at, value } = (point ?? {}) as { at?: unknown; value?: unknown };
      if (typeof at !== 'number' || typeof value !== 'number' || !Number.isFinite(at) || !Number.isFinite(value)) {
        throw new RangeError(`The transition plan's ${name} has a point that isn't numbers: ${JSON.stringify(point)}`);
      }
      if (at < previous) throw new RangeError(`The transition plan's ${name} isn't in time order (${at} s after ${previous} s)`);
      if (name === 'bRate' && !(value > 0)) throw new RangeError(`The transition plan's bRate must be positive, not ${value}`);
      previous = at;
    }
  }
}

/** B must end where the plan resumes it: bResume = bStart + ∫ bRate (else B's beats miss A's). */
function checkResume(plan: TransitionPlan, rate: number): void {
  const reached = plan.bStart + integrate(plan.bRate, 0, plan.length);
  if (Math.abs(reached - plan.bResume) * rate > MAX_RESUME_MISMATCH_SAMPLES) {
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
