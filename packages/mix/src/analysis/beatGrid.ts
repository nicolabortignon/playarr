// The beat grid of a song: its tempo to a hundredth of a BPM and where the beats fall, from the
// onset envelope (see onset.ts). Beatmatching two songs for a minute needs far more precision than
// "about 124": at 0.1 BPM off, the kicks drift apart by a sixteenth note within half a minute.

import { ONSET_LATENCY_FRAMES } from './onset.ts';

export interface BeatGrid {
  /** Beats per minute, rounded to 0.01. Not folded into an octave: 174 stays 174. */
  bpm: number;
  /** Time (s, to the ms) of the first grid beat at or after 0; beat n is at firstBeat + n·60/bpm. */
  firstBeat: number;
  /** Every 30 s stretch of the excerpt agrees with the one grid: safe for long blends. */
  gridStable: boolean;
  /** 0–1: how much the envelope stands out on the grid's beats compared with between them. */
  beatConfidence: number;
}

/** Tempos the autocorrelation looks at for the first, rough estimate. */
const SEARCH_MIN_BPM = 60;
const SEARCH_MAX_BPM = 200;
/** Tempos a grid may end up with: below 70, the double tempo is what a DJ would count. */
const MIN_BPM = 70;
const MAX_BPM = 200;
/** Beats in the comb that picks between a tempo, its double and its half. */
const OCTAVE_COMB_TEETH = 16;
/**
 * How much the faster of two tempo octaves is favoured. A grid at half the tempo can always pick
 * the accented half of the beats (downbeats, a backbeat snare), so its comb scores about as well
 * as the true tempo's; the slower one only wins when the beats it skips are clearly weaker
 * (an off-beat hi-hat rather than a kick).
 */
const FASTER_OCTAVE_BONUS = 1.1;
/** The refinement searches this far either side of the rough tempo, in BPM steps of REFINE_STEP. */
const REFINE_RANGE = 0.02;
const REFINE_STEP = 0.01;
/** Phase resolution, in frames, while searching tempos (coarse) and for the final grid (fine). */
const SEARCH_PHASE_STEP = 0.25;
const FINE_PHASE_STEP = 0.05;
/** The stability check compares the grid with the beats of every window this long. */
const WINDOW_SECONDS = 30;
const STABLE_PHASE_SECONDS = 0.025;
const STABLE_BPM_SHARE = 0.005;
/** Frames either side of a beat that count as "at the beat" for the confidence. */
const BEAT_HALF_WIDTH = 2;
/** Less than this many seconds of onsets is too little to call a tempo. */
const MIN_SECONDS = 4;

const NO_GRID: BeatGrid = { bpm: 0, firstBeat: 0, gridStable: false, beatConfidence: 0 };

/**
 * Finds the tempo and phase of the beat in an onset envelope (`fps` frames per second), normally
 * `analyzeOnsets(…).beatOnset`, the one that counts the bass twice so off-beat hi-hats don't win:
 * 1. a rough tempo from the envelope's autocorrelation, leaning toward 120 BPM;
 * 2. the rough tempo, its double and its half compared with a 16-beat comb, so a 174 BPM song isn't
 *    folded to 87 nor a 90 BPM song doubled because of its off-beat hi-hats;
 * 3. the tempo refined to 0.01 BPM by the comb over the whole excerpt;
 * 4. the phase that puts the comb's teeth on the most onset energy;
 * 5. the same refinement in every 30 s window, to tell a steady grid from a wandering one.
 */
export function beatGrid(onset: Float64Array, fps: number): BeatGrid {
  const n = onset.length;
  if (n < MIN_SECONDS * fps || !onset.some((v) => v > 0)) return NO_GRID;

  const rough = roughTempo(onset, fps);
  const candidates = [rough, rough * 2, rough / 2].filter((bpm) => bpm >= MIN_BPM && bpm <= MAX_BPM);
  const slowest = Math.min(...candidates);
  const octave = maxBy(candidates, (bpm) => {
    const bonus = FASTER_OCTAVE_BONUS ** Math.log2(bpm / slowest);
    return octaveComb(onset, periodOf(bpm, fps)) * bonus;
  });

  const bpm = round(refineTempo(onset, fps, 0, n, octave), 2);
  const period = periodOf(bpm, fps);
  const phase = bestPhase(onset, 0, n, period, FINE_PHASE_STEP).phase;

  // The envelope runs a few frames ahead of the sound; shift the grid back onto the transients.
  const beatSeconds = ((phase + ONSET_LATENCY_FRAMES) % period) / fps;
  const firstBeat = round(beatSeconds, 3) < 60 / bpm ? round(beatSeconds, 3) : 0;

  return {
    bpm,
    firstBeat,
    gridStable: isStable(onset, fps, bpm, phase),
    beatConfidence: round(confidence(onset, period, phase), 3),
  };
}

/**
 * The strongest autocorrelation peak between 60 and 200 BPM, weighted toward 120 (one octave
 * either side), as in the server's audio features. Only a starting point: steps 2–3 settle the
 * octave and the precision.
 */
function roughTempo(onset: Float64Array, fps: number): number {
  const minLag = Math.floor((fps * 60) / SEARCH_MAX_BPM);
  const maxLag = Math.ceil((fps * 60) / SEARCH_MIN_BPM);
  const acf = autocorrelation(onset, maxLag * 2);
  // A beat is a peak with dips on both sides (the off-beats), not a bump on a falling slope.
  const prominence = (lag: number) => {
    const reach = Math.max(2, Math.round(lag / 2));
    let left = Infinity;
    let right = Infinity;
    for (let i = Math.max(1, lag - reach); i < lag; i++) left = Math.min(left, acf[i]!);
    for (let i = lag + 1; i <= Math.min(acf.length - 1, lag + reach); i++) right = Math.min(right, acf[i]!);
    return acf[lag]! - Math.max(left, right);
  };
  let best = minLag;
  let bestScore = -Infinity;
  for (let lag = Math.max(1, minLag); lag <= maxLag; lag++) {
    if (acf[lag]! < acf[lag - 1]! || acf[lag]! < acf[lag + 1]!) continue;
    const prior = Math.exp(-0.5 * Math.log2((fps * 60) / lag / 120) ** 2);
    const score = prominence(lag) * prior;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  return (fps * 60) / (best + parabolicOffset(acf[best - 1]!, acf[best]!, acf[best + 1]!));
}

/** Normalized (acf[0] = 1), unbiased autocorrelation of the mean-removed signal. */
function autocorrelation(signal: Float64Array, maxLag: number): Float64Array {
  const n = signal.length;
  const mean = signal.reduce((s, v) => s + v, 0) / n;
  const x = signal.map((v) => v - mean);
  const out = new Float64Array(maxLag + 2);
  for (let lag = 0; lag < out.length && lag < n; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i]! * x[i + lag]!;
    out[lag] = s / (n - lag);
  }
  const zero = out[0] || 1;
  for (let lag = 0; lag < out.length; lag++) out[lag]! /= zero;
  return out;
}

/**
 * The most onset energy any run of 16 evenly spaced teeth `period` frames apart can collect,
 * anywhere in the excerpt. A fixed number of teeth (rather than the whole excerpt) keeps a double
 * tempo from winning merely by having twice as many teeth to land on off-beats.
 */
function octaveComb(onset: Float64Array, period: number): number {
  let best = 0;
  for (let phase = 0; phase < period; phase += SEARCH_PHASE_STEP) {
    const teeth: number[] = [];
    for (let x = phase; x < onset.length - 1; x += period) teeth.push(sample(onset, x));
    let sum = 0;
    for (let k = 0; k < teeth.length; k++) {
      sum += teeth[k]!;
      if (k >= OCTAVE_COMB_TEETH) sum -= teeth[k - OCTAVE_COMB_TEETH]!;
      if (k >= OCTAVE_COMB_TEETH - 1 || k === teeth.length - 1) best = Math.max(best, sum);
    }
  }
  return best;
}

/**
 * The tempo within ±2% of `bpm` (0.01 BPM steps, then a parabola through the best three) whose
 * comb, at its best phase, collects the most onset energy in frames [from, to). Over a minute of
 * beats the teeth walk off the onsets for even a small tempo error, so the peak is sharp.
 */
function refineTempo(onset: Float64Array, fps: number, from: number, to: number, bpm: number): number {
  const steps = Math.round((bpm * REFINE_RANGE) / REFINE_STEP);
  const scores: number[] = [];
  for (let s = -steps; s <= steps; s++) {
    scores.push(bestPhase(onset, from, to, periodOf(bpm + s * REFINE_STEP, fps), SEARCH_PHASE_STEP).score);
  }
  const best = scores.indexOf(Math.max(...scores));
  const offset = best > 0 && best < scores.length - 1 ? parabolicOffset(scores[best - 1]!, scores[best]!, scores[best + 1]!) : 0;
  return bpm + (best - steps + offset) * REFINE_STEP;
}

/** The phase (frame of a tooth, in [from, from + period)) collecting the most energy in [from, to). */
function bestPhase(onset: Float64Array, from: number, to: number, period: number, step: number) {
  let phase = from;
  let score = -Infinity;
  for (let p = from; p < from + period; p += step) {
    const s = comb(onset, p, period, to);
    if (s > score) {
      score = s;
      phase = p;
    }
  }
  return { phase, score };
}

/** Onset energy at phase, phase + period, … up to frame `to`. */
function comb(onset: Float64Array, phase: number, period: number, to: number): number {
  const end = Math.min(to, onset.length - 1);
  let sum = 0;
  for (let x = phase; x < end; x += period) sum += sample(onset, x);
  return sum;
}

/**
 * Whether every 30 s window agrees with the global grid: its own best tempo within ±0.5% and its
 * own beats within ±25 ms of the global ones. A last stretch shorter than a window joins the one
 * before it; an excerpt shorter than a window is one window.
 */
function isStable(onset: Float64Array, fps: number, bpm: number, phase: number): boolean {
  const period = periodOf(bpm, fps);
  const windowFrames = WINDOW_SECONDS * fps;
  const windows = Math.max(1, Math.floor(onset.length / windowFrames));
  for (let w = 0; w < windows; w++) {
    const from = Math.round(w * windowFrames);
    const to = w === windows - 1 ? onset.length : Math.round((w + 1) * windowFrames);
    const localBpm = refineTempo(onset, fps, from, to, bpm);
    if (Math.abs(localBpm - bpm) > STABLE_BPM_SHARE * bpm) return false;
    const localPeriod = periodOf(localBpm, fps);
    const local = bestPhase(onset, from, to, localPeriod, FINE_PHASE_STEP).phase;
    // Compare at the window's middle beat, where a slightly different local tempo matters least.
    const middle = local + Math.floor((to - from) / 2 / localPeriod) * localPeriod;
    const offGrid = Math.abs(wrap(middle - phase, period));
    if (offGrid / fps > STABLE_PHASE_SECONDS) return false;
  }
  return true;
}

/**
 * How far the envelope on the grid's beats stands above the envelope between them, in standard
 * deviations of the envelope, mapped 0.5 → 0 and 3 → 1. Noise lands about as much energy on any
 * grid as off it; a clean beat is several deviations above.
 */
function confidence(onset: Float64Array, period: number, phase: number): number {
  const n = onset.length;
  let atBeats = 0;
  let beats = 0;
  for (let x = phase; x < n - 1; x += period) {
    atBeats += sample(onset, x);
    beats++;
  }
  let elsewhere = 0;
  let others = 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    sum += onset[i]!;
    sumSq += onset[i]! ** 2;
    if (Math.abs(wrap(i - phase, period)) > BEAT_HALF_WIDTH) {
      elsewhere += onset[i]!;
      others++;
    }
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  if (!beats || !others || !std) return 0;
  return scale((atBeats / beats - elsewhere / others) / std, 0.5, 3);
}

/** Linear interpolation of the envelope at a fractional frame. */
function sample(onset: Float64Array, x: number): number {
  const i = Math.floor(x);
  const t = x - i;
  return onset[i]! * (1 - t) + (onset[i + 1] ?? 0) * t;
}

/** Offset (−0.5…0.5) of the top of a parabola through three equally spaced points. */
function parabolicOffset(a: number, b: number, c: number): number {
  const denom = a - 2 * b + c;
  return denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
}

/** `x` wrapped into −period/2 … period/2. */
function wrap(x: number, period: number): number {
  return x - Math.round(x / period) * period;
}

function maxBy(items: number[], score: (item: number) => number): number {
  let best = items[0]!;
  let bestScore = -Infinity;
  for (const item of items) {
    const s = score(item);
    if (s > bestScore) {
      bestScore = s;
      best = item;
    }
  }
  return best;
}

const periodOf = (bpm: number, fps: number) => (fps * 60) / bpm;
const scale = (v: number, lo: number, hi: number) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
