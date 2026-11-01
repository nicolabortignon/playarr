// Where the bars and phrases of a song start, from the same onset pass and beat grid as the rest of
// the mix analysis. A beatmatched blend that lines up beats but not bars sounds "off" to anyone who
// dances, and dance music changes every 16 beats (a phrase), so transitions start on phrase edges.

import type { BeatGrid } from './beatGrid.ts';
import { ONSET_FRAME, ONSET_HOP, ONSET_LATENCY_FRAMES, type Onsets } from './onset.ts';

export interface Downbeats {
  /** The grid's beat index (0–3) of the first downbeat: bars start every 4 beats from there. */
  downbeatOffset: number;
  /** Energy 0–1 per 16-beat phrase from the first downbeat, relative to the loudest phrase. */
  phraseEnergy: number[];
}

const BEATS_PER_BAR = 4;
const BEATS_PER_PHRASE = 16;
/** A last, partial phrase counts if it has at least half a phrase of music. */
const MIN_LAST_PHRASE_BEATS = 8;
/**
 * Frames either side of a beat searched for its peak. The kick's bass sits in a few frames around
 * the beat (frames are ~93 ms long and ~23 ms apart), and the grid itself may be ~10 ms off.
 */
const LOW_HALF_WIDTH = 2;
const ONSET_HALF_WIDTH = 1;
/** Two bar positions whose bass accents are within this share of each other are a tie. */
const TIE_SHARE = 0.02;

/**
 * A frame's centre lies this many frames after its index (frame i covers samples
 * [i·HOP, i·HOP + FRAME)): the frame whose loudness and bass are "at" time t is t·fps − this.
 */
const FRAME_CENTRE = ONSET_FRAME / ONSET_HOP / 2;

const NOTHING: Downbeats = { downbeatOffset: 0, phraseEnergy: [] };

/**
 * Finds the bar and the phrases of a song from one `analyzeOnsets` pass and its `beatGrid`.
 *
 * The downbeat ("one" of the bar) is where most music puts its heaviest kick or a new bass note,
 * so of the four ways to split the beats into bars, the one whose first beats carry the most bass
 * (below ~150 Hz) relative to the rest wins. When the bass doesn't decide (a four-to-the-floor kick
 * that is equally loud on every beat), the one whose first beats have the strongest onsets does.
 *
 * Phrases are every 16 beats from the first downbeat; each one's energy is its mean loudness,
 * scaled so the loudest phrase is 1. Breakdowns, intros and outros come out low.
 */
export function downbeats(
  frames: Pick<Onsets, 'fps' | 'onset' | 'lowEnergy' | 'rms'>,
  grid: Pick<BeatGrid, 'bpm' | 'firstBeat'>,
  duration: number,
): Downbeats {
  const { fps, rms } = frames;
  if (!(grid.bpm > 0) || !rms.length || !rms.some((v) => v > 0)) return NOTHING;

  const period = 60 / grid.bpm;
  const end = Math.min(duration, (rms.length + FRAME_CENTRE) / fps);
  const beatTimes: number[] = [];
  for (let t = grid.firstBeat; t < end; t += period) beatTimes.push(t);
  if (beatTimes.length < BEATS_PER_BAR) return NOTHING;

  const downbeatOffset = barStart(frames, beatTimes);
  const phraseEnergy = phrases(frames, grid.firstBeat + downbeatOffset * period, period, end);
  return { downbeatOffset, phraseEnergy };
}

/**
 * The bar position (0–3) whose beats stand out most: highest mean bass at its beats over the mean
 * bass at all beats, ties broken by the same measure on the onset envelope.
 */
function barStart(frames: Pick<Onsets, 'fps' | 'onset' | 'lowEnergy'>, beatTimes: number[]): number {
  const { fps, lowEnergy, onset } = frames;
  // The bass of a beat is in the frames centred on it; its onset leads it by the envelope's latency.
  const low = beatTimes.map((t) => peak(lowEnergy, t * fps - FRAME_CENTRE, LOW_HALF_WIDTH));
  const attack = beatTimes.map((t) => peak(onset, t * fps - ONSET_LATENCY_FRAMES, ONSET_HALF_WIDTH));
  const lowAccent = accents(low);
  const onsetAccent = accents(attack);

  let best = 0;
  for (let offset = 1; offset < BEATS_PER_BAR; offset++) {
    const a = lowAccent[offset]!;
    const b = lowAccent[best]!;
    const tie = Math.abs(a - b) <= TIE_SHARE * Math.max(a, b);
    if (tie ? onsetAccent[offset]! > onsetAccent[best]! : a > b) best = offset;
  }
  return best;
}

/** For each bar position, the mean of `values` at beats offset, offset + 4, … over the mean of all. */
function accents(values: number[]): number[] {
  const overall = mean(values) || 1;
  return Array.from({ length: BEATS_PER_BAR }, (_, offset) => {
    const own = values.filter((_, i) => i % BEATS_PER_BAR === offset);
    return mean(own) / overall;
  });
}

/**
 * Mean loudness of each 16-beat phrase from `start`, relative to the loudest. Frames count toward
 * the phrase their centre falls in; a last phrase shorter than 8 beats is left out.
 */
function phrases(frames: Pick<Onsets, 'fps' | 'rms'>, start: number, period: number, end: number): number[] {
  const { fps, rms } = frames;
  const phraseSeconds = BEATS_PER_PHRASE * period;
  const count = Math.floor((end - start) / phraseSeconds);
  const partial = end - start - count * phraseSeconds >= MIN_LAST_PHRASE_BEATS * period;
  const sums = new Float64Array(count + (partial ? 1 : 0));
  const counts = new Float64Array(sums.length);
  for (let f = 0; f < rms.length; f++) {
    const phrase = Math.floor(((f + FRAME_CENTRE) / fps - start) / phraseSeconds);
    if (phrase < 0 || phrase >= sums.length) continue;
    sums[phrase]! += rms[f]!;
    counts[phrase]!++;
  }
  const energy = Array.from(sums, (s, i) => (counts[i] ? s / counts[i]! : 0));
  const loudest = Math.max(0, ...energy);
  if (!loudest) return [];
  return energy.map((e) => Math.round((e / loudest) * 1000) / 1000);
}

/** The largest value within `halfWidth` frames of the (fractional) frame `x`. */
function peak(values: Float64Array, x: number, halfWidth: number): number {
  const centre = Math.round(x);
  let best = 0;
  for (let i = Math.max(0, centre - halfWidth); i <= Math.min(values.length - 1, centre + halfWidth); i++) {
    best = Math.max(best, values[i]!);
  }
  return best;
}

const mean = (values: number[]) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0);
