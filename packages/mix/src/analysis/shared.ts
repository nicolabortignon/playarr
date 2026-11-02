// Small pieces downbeats.ts and sections.ts both need: bar and phrase lengths, where a frame sits in
// time, where the sound ends, and a few array helpers. Internal to the analysis; not exported from
// the package.

import { ONSET_FRAME, ONSET_HOP, type Onsets } from './onset.ts';

export const BEATS_PER_BAR = 4;
export const BEATS_PER_PHRASE = 16;
/** A last, partial phrase counts if it has at least this many beats of music: half a phrase. */
export const MIN_LAST_PHRASE_BEATS = 8;
/**
 * A beat is part of the music only if at least this much of it (s) sounds: a grid beat that starts a
 * few milliseconds before the sound ends is a sliver of the last one's tail, not a beat.
 */
export const MIN_BEAT_SOUND = 0.05;
/** A frame's window covers this many hops (frame i covers samples [i·HOP, i·HOP + FRAME)). */
export const FRAME_HOPS = ONSET_FRAME / ONSET_HOP;
/**
 * A frame's centre lies this many frames after its index: the frame whose loudness and bass are
 * "at" time t is t·fps − this.
 */
export const FRAME_CENTRE = FRAME_HOPS / 2;

/** Frames quieter than this share of the song's loud (95th pct) frames, or than the floor, are silence. */
const SILENCE_SHARE = 0.01;
const SILENCE_FLOOR = 1e-4;

/** Frame RMS below which a frame is silence: 1% (−40 dB) of the song's loud frames, at least 1e-4. */
export function silenceGate(rms: Float64Array): number {
  const loud = percentile(Array.from(rms), 0.95);
  return Math.max(SILENCE_FLOOR, SILENCE_SHARE * loud);
}

/**
 * Where the sound ends (s): the end of the last hop-long slice of audio louder than the silence
 * gate; 0 when nothing is. Frames are four hops long, so a frame only tells where sound ends to
 * within ~93 ms; but each frame's energy is its four slices' energies, so the energy of a slice is
 * its frame's minus the next frame's plus the slice four hops later. Working back from the
 * silence at the end recovers the slices of the tail to within one hop (~23 ms).
 */
export function soundEndOf(frames: Pick<Onsets, 'fps' | 'rms'>, silence = silenceGate(frames.rms)): number {
  const { fps, rms } = frames;
  const n = rms.length;
  let last = n - 1;
  while (last >= 0 && !(rms[last]! > silence)) last--;
  if (last < 0) return 0;
  // Sounding to the very last frame: the sound runs to the end of what the frames cover.
  if (last === n - 1) return round((n - 1 + FRAME_HOPS) / fps);

  const frameEnergy = (f: number) => rms[f]! ** 2 * ONSET_FRAME;
  const slice = new Float64Array(n + FRAME_HOPS);
  // The last frame's slices can't be told apart (nothing follows it): spread its energy evenly.
  for (let k = n - 1; k < n - 1 + FRAME_HOPS; k++) slice[k] = frameEnergy(n - 1) / FRAME_HOPS;
  for (let k = n - 2; k >= last; k--) slice[k] = Math.max(0, frameEnergy(k) - frameEnergy(k + 1) + slice[k + FRAME_HOPS]!);
  const gate = silence ** 2 * ONSET_HOP;
  for (let k = n - 2 + FRAME_HOPS; k >= last; k--) if (slice[k]! > gate) return round((k + 1) / fps);
  return round((last + FRAME_CENTRE) / fps);
}

/**
 * Where the sound starts (s): the start of the first frame louder than the silence gate, so up to a
 * frame (~93 ms) early, never late: trimming leading silence mustn't clip the first attack. 0 when
 * nothing is louder.
 */
export function soundStartOf(frames: Pick<Onsets, 'fps' | 'rms'>, silence = silenceGate(frames.rms)): number {
  const { fps, rms } = frames;
  for (let i = 0; i < rms.length; i++) if (rms[i]! > silence) return round(i / fps);
  return 0;
}

/** The largest value within `halfWidth` frames of the (fractional) frame `x`. */
export function peak(values: Float64Array, x: number, halfWidth: number): number {
  const centre = Math.round(x);
  let best = 0;
  for (let i = Math.max(0, centre - halfWidth); i <= Math.min(values.length - 1, centre + halfWidth); i++) {
    best = Math.max(best, values[i]!);
  }
  return best;
}

/** The value at fraction `p` (0–1) of the sorted values (nearest rank); 0 for none. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]!;
}

export const mean = (values: number[]) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0);
export const mod = (n: number, m: number) => ((n % m) + m) % m;
/** Rounded to the millisecond (or to 0.001 of whatever else). */
export const round = (v: number) => Math.round(v * 1000) / 1000;
