// The beat grid and the bars from Beat This!'s answer (see beatThis.ts). The model hears the beat the
// way people do, kick or no kick, so it doesn't lock onto off-beat hi-hats or a rolling off-beat bass
// the way an onset comb can, doesn't count a song at half or double its tempo, and knows where bars
// start. What it doesn't give is a DJ's precision: its frames are 20 ms apart. So the model says which
// tempo (to a couple of percent), which beats and which bars; beatGrid's comb over the onsets gives the
// tempo to 0.01 BPM and puts the grid on the transients.

import type { BeatActivations } from './beatThis.ts';
import { refineBeatTempo, type BeatGrid } from './beatGrid.ts';
import { BEAT_ONSET_LATENCY_FRAMES, type Onsets } from './onset.ts';
import { BEATS_PER_BAR } from './shared.ts';

export interface NeuralGrid extends BeatGrid {
  /** The grid's beat index (0–3) of the first downbeat, from the model's bars. */
  downbeatOffset: number;
  /** 0–1: how clearly the model's downbeats agree on one of the four bar positions. */
  barConfidence: number;
}

/** Fewer beats than this in a song is no beat to mix on (a few hits in ambient music). */
const MIN_BEATS = 16;
/** Tempos a grid may end up with, as beatGrid's: below 70, the double tempo is what a DJ counts. */
const MIN_BPM = 70;
const MAX_BPM = 200;
/** A model beat this far from the grid doesn't count as on it (beat-tracking evaluations use 70 ms). */
const MATCH_SECONDS = 0.07;
/** How far the onsets may move the model's grid: well under the gap to an off-beat at any tempo. */
const NUDGE_SECONDS = 0.04;
const NUDGE_STEP = 0.002;
/** The onsets only move the grid when their comb at the best nudge beats the average by this much. */
const NUDGE_MIN_GAIN = 1.1;
/** Stability: in every 30 s window with this many beats, the beats' median offset from the grid… */
const WINDOW_SECONDS = 30;
const WINDOW_MIN_BEATS = 8;
/** …stays within this of the song's: 25 ms is where a blend's kicks start to flam. */
const STABLE_PHASE_SECONDS = 0.025;
/** A grid that fewer of its beats agree with than this is never called stable (as beatGrid's). */
const STABLE_MIN_CONFIDENCE = 0.35;
/** Frames either side of a grid beat searched for the model's downbeat. */
const DOWNBEAT_HALF_WIDTH = 2;
/** A margin of this share between the best and second-best bar position counts as fully sure. */
const SURE_BAR_MARGIN = 0.5;

const NO_GRID: NeuralGrid = { bpm: 0, firstBeat: 0, gridStable: false, beatConfidence: 0, downbeatOffset: 0, barConfidence: 0 };

/**
 * The beat grid of a song (or stretch of one, `seconds` long) from the model's answer, with the
 * onset envelope (`analyzeOnsets`) to put it on the transients.
 *
 * 1. the model's beats: its peaks over even odds, to a fraction of a frame;
 * 2. the tempo: the median gap between them (doubled below 70 BPM, halved above 200), refined to
 *    0.01 BPM by beatGrid's comb over the onset envelope within 2% of it;
 * 3. the phase: where the model's beats fall on that period (their circular mean, so a few beats off
 *    the beat in a breakdown barely move it), then nudged by up to 40 ms onto the onset envelope's
 *    comb, if that has a clear peak (so beats sit on the transients, as beatGrid's do);
 * 4. how sure: the share of the grid's beats, between the model's first and last, with a model beat
 *    within 70 ms; stable when that's at least 0.35 and every 30 s window's beats sit where the song's
 *    do (within 25 ms), so a tempo that drifts or changes isn't called stable;
 * 5. the bar: of the four grid positions, the one with the most downbeat in the model's answer.
 *
 * No beat (fewer than 16 of the model's) gives bpm 0.
 */
export function neuralGrid(frames: Pick<Onsets, 'fps' | 'beatOnset'>, activations: BeatActivations, seconds: number): NeuralGrid {
  const beats = peakTimes(activations.beat, activations.fps);
  if (beats.length < MIN_BEATS) return NO_GRID;

  const gaps = beats.slice(1).map((t, i) => t - beats[i]!);
  let period = median(gaps);
  while (60 / period < MIN_BPM) period /= 2;
  while (60 / period > MAX_BPM) period *= 2;

  period = 60 / refineBeatTempo(frames, 60 / period);
  const centre = circularMean(beats, period);
  const phase = centre + nudge(frames, centre, period, beats[0]!, Math.min(seconds, beats.at(-1)! + period));

  // How the model's beats sit on the grid: their offsets, and how many grid beats have one near.
  const offsets = beats.map((t) => wrap(t - phase, period));
  const near = offsets.filter((o) => Math.abs(o) <= MATCH_SECONDS).length;
  const gridBeats = Math.floor((beats.at(-1)! - beats[0]!) / period) + 1;
  const beatConfidence = round(Math.min(1, near / gridBeats), 3);

  const firstBeat = round(mod(phase, period), 3);
  const downbeat = barStart(activations, firstBeat, period, seconds);
  return {
    bpm: round(60 / period, 2),
    firstBeat,
    gridStable: beatConfidence >= STABLE_MIN_CONFIDENCE && holds(beats, offsets),
    beatConfidence,
    downbeatOffset: downbeat.offset,
    barConfidence: round(downbeat.confidence, 3),
  };
}

/**
 * The model's beats in seconds: frames over even odds that are the highest within 3 frames either
 * side (the model's own rule), one per run of equal peaks, each refined by a parabola through it and
 * its neighbours.
 */
function peakTimes(logits: Float32Array, fps: number): number[] {
  const times: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < logits.length; i++) {
    const v = logits[i]!;
    if (!(v > 0)) continue;
    let highest = true;
    for (let j = Math.max(0, i - 3); j <= Math.min(logits.length - 1, i + 3) && highest; j++) if (logits[j]! > v) highest = false;
    if (!highest || i - last <= 1) continue;
    last = i;
    const [a, b, c] = [logits[i - 1] ?? v, v, logits[i + 1] ?? v];
    const denom = a - 2 * b + c;
    const offset = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
    times.push((i + offset) / fps);
  }
  return times;
}

/** Where `times` fall on a grid of `period`: the phase (0…period) of their circular mean. */
function circularMean(times: number[], period: number): number {
  let x = 0;
  let y = 0;
  for (const t of times) {
    const angle = (2 * Math.PI * t) / period;
    x += Math.cos(angle);
    y += Math.sin(angle);
  }
  return mod((Math.atan2(y, x) / (2 * Math.PI)) * period, period);
}

/**
 * How far (±40 ms) to move the grid so its beats land on the most onset energy between `from` and
 * `to`: 0 unless the best spot clearly beats the average one (a beat the onsets don't hear, like a
 * pad's, stays where the model put it).
 */
function nudge({ fps, beatOnset }: Pick<Onsets, 'fps' | 'beatOnset'>, phase: number, period: number, from: number, to: number): number {
  const comb = (shift: number) => {
    let sum = 0;
    for (let t = phase + shift + Math.ceil((from - phase - shift) / period) * period; t < to; t += period) {
      sum += sample(beatOnset, t * fps - BEAT_ONSET_LATENCY_FRAMES);
    }
    return sum;
  };
  const scores: { shift: number; score: number }[] = [];
  for (let shift = -NUDGE_SECONDS; shift <= NUDGE_SECONDS + 1e-9; shift += NUDGE_STEP) scores.push({ shift, score: comb(shift) });
  const best = scores.reduce((a, b) => (b.score > a.score ? b : a));
  const average = scores.reduce((s, x) => s + x.score, 0) / scores.length;
  return best.score > NUDGE_MIN_GAIN * average ? best.shift : 0;
}

/**
 * The grid holds: in every 30 s window with at least 8 of the model's beats, their median offset from
 * the grid is within 25 ms of the song's. `offsets` are the beats' offsets from the grid, in order.
 */
function holds(beats: number[], offsets: number[]): boolean {
  const overall = median(offsets);
  for (let start = beats[0]!; start < beats.at(-1)!; start += WINDOW_SECONDS) {
    const inside = offsets.filter((_, i) => beats[i]! >= start && beats[i]! < start + WINDOW_SECONDS);
    if (inside.length < WINDOW_MIN_BEATS) continue;
    if (Math.abs(median(inside) - overall) > STABLE_PHASE_SECONDS) return false;
  }
  return true;
}

/**
 * Which of the four grid positions starts the bar: the one whose beats carry the most downbeat (the
 * model's odds, at its peak near each beat), and how clearly: the margin over the second best as a
 * share of the best, full at 50%.
 */
function barStart({ downbeat, fps }: BeatActivations, firstBeat: number, period: number, seconds: number) {
  const sums = new Array<number>(BEATS_PER_BAR).fill(0);
  for (let n = 0, t = firstBeat; t < seconds; n++, t = firstBeat + n * period) {
    const centre = Math.round(t * fps);
    let odds = 0;
    for (let i = Math.max(0, centre - DOWNBEAT_HALF_WIDTH); i <= Math.min(downbeat.length - 1, centre + DOWNBEAT_HALF_WIDTH); i++) {
      odds = Math.max(odds, sigmoid(downbeat[i]!));
    }
    sums[n % BEATS_PER_BAR]! += odds;
  }
  const order = [0, 1, 2, 3].sort((a, b) => sums[b]! - sums[a]!);
  const [best, second] = [sums[order[0]!]!, sums[order[1]!]!];
  return { offset: order[0]!, confidence: best > 0 ? Math.min(1, (best - second) / best / SURE_BAR_MARGIN) : 0 };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Linear interpolation of the envelope at a fractional frame; 0 outside it. */
function sample(values: Float64Array, x: number): number {
  if (x < 0 || x > values.length - 1) return 0;
  const i = Math.floor(x);
  const t = x - i;
  return values[i]! * (1 - t) + (values[i + 1] ?? 0) * t;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
/** `x` wrapped into −period/2 … period/2. */
const wrap = (x: number, period: number) => x - Math.round(x / period) * period;
const mod = (x: number, m: number) => ((x % m) + m) % m;
const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
