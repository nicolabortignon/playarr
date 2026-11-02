// The beat grid of a song: its tempo to a hundredth of a BPM and where the beats fall, from the
// onset envelopes of onset.ts. Beatmatching two songs for a minute needs far more precision than
// "about 124": at 0.1 BPM off, the kicks drift apart by ~25 ms within 30 s, which is audible.

import { BEAT_ONSET_LATENCY_FRAMES, type Onsets } from './onset.ts';

export interface BeatGrid {
  /** Beats per minute, rounded to 0.01. Not folded into an octave: 174 stays 174. */
  bpm: number;
  /** Time (s, to the ms) of the first grid beat at or after 0; beat n is at firstBeat + n·60/bpm. */
  firstBeat: number;
  /**
   * The one grid holds over the whole excerpt: every stretch with a beat of its own agrees with it
   * (stretches without one, like a breakdown, are skipped). Meaningful together with
   * `beatConfidence`: it is always false when the confidence is below 0.35, so noise or beatless
   * music never counts as stable.
   */
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
/**
 * The slower of two tempo octaves skips kicks when the bass between its beats is at least this
 * share of the bass on them. Measured: a song or click track whose kick plays every beat gives
 * ~0.96 at half tempo; one with only a hi-hat between the kicks gives ~0.06.
 */
const SKIPPED_KICK_SHARE = 0.5;
/**
 * Below this ratio of best-phase bass comb to the comb of the average bass level there is no bass
 * beat to go by (no kick, or no bass at all), and the octave falls back to the full envelope.
 */
const BASS_BEAT_RATIO = 2;
/** Beats in the comb that picks the octave when there's no bass beat to go by. */
const OCTAVE_COMB_TEETH = 16;
/**
 * How much the faster of two octaves is favoured in that fallback. A grid at half tempo can always
 * pick the accented half of the beats, so its comb scores about as well as the true tempo's; the
 * slower one only wins when the beats it skips are clearly weaker.
 */
const FASTER_OCTAVE_BONUS = 1.1;
/** How far either side of the rough tempo the refinement searches (share of the tempo). */
const REFINE_RANGE = 0.02;
/** …either side of a doubled or halved tempo, which is already that precise. */
const OCTAVE_REFINE_RANGE = 0.005;
/** …and either side of the global tempo in each stability window, which only has to confirm it. */
const WINDOW_REFINE_RANGE = 0.01;
/**
 * The refinement steps through tempos coarsely on a smoothed envelope, then finely around the best
 * coarse tempo on the envelope itself. Smoothing widens the comb's peak so a coarse step can't
 * jump over it on a long excerpt, where the peak is narrowest.
 */
const COARSE_STEP = 0.1;
const FINE_STEP = 0.01;
const FINE_REACH = 0.15;
/** Phase resolution, in frames, while searching tempos (coarse, fine) and for the final grid. */
const COARSE_PHASE_STEP = 0.5;
const SEARCH_PHASE_STEP = 0.25;
const FINE_PHASE_STEP = 0.05;
/** Stability: windows of at least this length, each of whose beats must agree with the grid. */
const WINDOW_SECONDS = 30;
const STABLE_PHASE_SECONDS = 0.025;
const STABLE_BPM_SHARE = 0.005;
/** A window whose own grid has less contrast than this has no beat to check (a breakdown). */
const WINDOW_MIN_CONFIDENCE = 0.3;
/** A grid with less overall confidence than this is never called stable. */
const STABLE_MIN_CONFIDENCE = 0.35;
/** Frames either side of a beat that count as "at the beat" for the confidence. */
const BEAT_HALF_WIDTH = 2;
/** Less than this many seconds of onsets is too little to call a tempo. */
const MIN_SECONDS = 4;

const NO_GRID: BeatGrid = { bpm: 0, firstBeat: 0, gridStable: false, beatConfidence: 0 };

/** An onset envelope, the same smoothed for coarse searches, and its frame rate. */
interface Envelope {
  onset: Float64Array;
  smooth: Float64Array;
  fps: number;
}

/**
 * Finds the tempo and phase of the beat. Expects envelopes from `analyzeOnsets`, whose timing it
 * relies on: it shifts the grid by BEAT_ONSET_LATENCY_FRAMES to put beats on the transients. Pass
 * the whole `analyzeOnsets` result, or `beatOnset`, `fps` and (for the octave) `lowOnset`.
 *
 * 1. a rough tempo from the envelope's autocorrelation, leaning toward 120 BPM;
 * 2. the octave: starting from the slowest of the rough tempo, its half and its double that lie in
 *    70–200 BPM, double while the slower grid skips kicks (bass between its beats as strong as on
 *    them), so a 174 BPM song with a backbeat snare isn't halved nor a 90 BPM song with off-beat
 *    hi-hats doubled. Without a bass beat, a 16-beat comb on the full envelope decides;
 * 3. the tempo refined to 0.01 BPM by a comb over the whole excerpt (before step 2 too, so the
 *    octave is judged on an exact grid);
 * 4. the phase that puts the comb's teeth on the most onset energy;
 * 5. the same refinement in every ≥30 s window, to tell a steady grid from a wandering one.
 */
export function beatGrid(frames: Pick<Onsets, 'fps' | 'beatOnset' | 'lowOnset'>): BeatGrid;
export function beatGrid(onset: Float64Array, fps: number, lowOnset?: Float64Array): BeatGrid;
export function beatGrid(
  input: Float64Array | Pick<Onsets, 'fps' | 'beatOnset' | 'lowOnset'>,
  fps?: number,
  lowOnset?: Float64Array,
): BeatGrid {
  if (input instanceof Float64Array) return findGrid(input, fps!, lowOnset);
  return findGrid(input.beatOnset, input.fps, input.lowOnset);
}

function findGrid(onset: Float64Array, fps: number, lowOnset: Float64Array | undefined): BeatGrid {
  const n = onset.length;
  if (n < MIN_SECONDS * fps || !onset.some((v) => v > 0)) return NO_GRID;
  const envelope: Envelope = { onset, smooth: smoothed(onset), fps };

  // Refined before the octave is chosen: a comb a fraction of a percent off the tempo drifts off
  // the beats within a minute and can't tell kicks from the gaps between them.
  const refined = refineTempo(envelope, 0, n, roughTempo(onset, fps), REFINE_RANGE);
  const candidates = [refined / 2, refined, refined * 2].filter((bpm) => bpm >= MIN_BPM && bpm <= MAX_BPM);
  const octave = chooseOctave(envelope, lowOnset, candidates);
  // A doubled or halved tempo keeps its relative precision; one more narrow pass restores 0.01 BPM.
  const bpm = round(octave === refined ? refined : refineTempo(envelope, 0, n, octave, OCTAVE_REFINE_RANGE), 2);
  const period = periodOf(bpm, fps);
  const phase = bestPhase(onset, 0, n, period, FINE_PHASE_STEP).phase;

  // The envelope runs a few frames ahead of the sound; shift the grid back onto the transients.
  const beatSeconds = round(((phase + BEAT_ONSET_LATENCY_FRAMES) % period) / fps, 3);
  const firstBeat = beatSeconds < 60 / bpm ? beatSeconds : 0;
  const beatConfidence = round(confidence(onset, 0, n, period, phase), 3);

  return {
    bpm,
    firstBeat,
    gridStable: beatConfidence >= STABLE_MIN_CONFIDENCE && isStable(envelope, bpm, phase),
    beatConfidence,
  };
}

/**
 * The tempo within ±2% of `bpm` whose comb collects the most onset energy over the whole excerpt, to
 * 0.01 BPM: beatGrid's precision for a tempo found some other way (the beat model's, see neuralGrid).
 */
export function refineBeatTempo(frames: Pick<Onsets, 'fps' | 'beatOnset'>, bpm: number): number {
  const { beatOnset: onset, fps } = frames;
  if (onset.length < MIN_SECONDS * fps || !onset.some((v) => v > 0)) return round(bpm, 2);
  return round(refineTempo({ onset, smooth: smoothed(onset), fps }, 0, onset.length, bpm, REFINE_RANGE), 2);
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
 * Which of `candidates` (ascending, each double the one before) is the tempo. The kick and bass
 * decide when there's a bass beat: a grid that leaves kicks between its beats is too slow. The
 * full envelope can't tell, as a backbeat snare makes half tempo look as strong as the beat.
 */
function chooseOctave(envelope: Envelope, lowOnset: Float64Array | undefined, candidates: number[]): number {
  const { fps } = envelope;
  if (lowOnset && candidates.length > 1) {
    const n = lowOnset.length;
    const averageBass = lowOnset.reduce((s, v) => s + v, 0) / n;
    let index = 0;
    for (; index < candidates.length; index++) {
      const period = periodOf(candidates[index]!, fps);
      const onBeats = bestPhase(lowOnset, 0, n, period, SEARCH_PHASE_STEP);
      if (index === 0 && onBeats.score < BASS_BEAT_RATIO * averageBass * (n / period)) break; // no bass beat
      const between = comb(lowOnset, onBeats.phase + period / 2, period, n);
      if (index === candidates.length - 1 || between <= SKIPPED_KICK_SHARE * onBeats.score) return candidates[index]!;
    }
  }
  return combOctave(envelope, candidates);
}

/** The fallback octave choice: a 16-beat comb on the full envelope, favouring the faster tempo. */
function combOctave({ onset, fps }: Envelope, candidates: number[]): number {
  const slowest = candidates[0]!;
  let best = slowest;
  let bestScore = -Infinity;
  for (const bpm of candidates) {
    const score = octaveComb(onset, periodOf(bpm, fps)) * FASTER_OCTAVE_BONUS ** Math.log2(bpm / slowest);
    if (score > bestScore) {
      bestScore = score;
      best = bpm;
    }
  }
  return best;
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
 * The tempo within ±`range` of `bpm` whose comb, at its best phase, collects the most onset energy
 * in frames [from, to): 0.1 BPM steps, then 0.01 steps around the best, then a parabola through
 * the best three. Over a minute of beats the teeth walk off the onsets for even a small tempo
 * error, so the peak is sharp. A best tempo at the edge of the range means the range was off
 * centre; the search is re-centred there once.
 */
function refineTempo(envelope: Envelope, from: number, to: number, bpm: number, range: number): number {
  const first = searchTempo(envelope, from, to, bpm, range);
  return first.atEdge ? searchTempo(envelope, from, to, first.bpm, range).bpm : first.bpm;
}

function searchTempo({ onset, smooth, fps }: Envelope, from: number, to: number, centre: number, range: number) {
  const score = (signal: Float64Array, bpm: number, phaseStep: number) =>
    bestPhase(signal, from, to, periodOf(bpm, fps), phaseStep).score;

  const coarseSteps = Math.max(1, Math.round((centre * range) / COARSE_STEP));
  const coarse: number[] = [];
  for (let s = -coarseSteps; s <= coarseSteps; s++) coarse.push(score(smooth, centre + s * COARSE_STEP, COARSE_PHASE_STEP));
  const bestCoarse = coarse.indexOf(Math.max(...coarse));
  const roughBpm = centre + (bestCoarse - coarseSteps) * COARSE_STEP;

  const fineSteps = Math.round(FINE_REACH / FINE_STEP);
  const fine: number[] = [];
  for (let s = -fineSteps; s <= fineSteps; s++) fine.push(score(onset, roughBpm + s * FINE_STEP, SEARCH_PHASE_STEP));
  const best = fine.indexOf(Math.max(...fine));
  const offset = best > 0 && best < fine.length - 1 ? parabolicOffset(fine[best - 1]!, fine[best]!, fine[best + 1]!) : 0;
  return {
    bpm: roughBpm + (best - fineSteps + offset) * FINE_STEP,
    atEdge: bestCoarse === 0 || bestCoarse === coarse.length - 1,
  };
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
 * Whether every window with a beat agrees with the global grid: its own best tempo within ±0.5%
 * and its own beats within ±25 ms of the global ones. Excerpts of 30 s or more are split into at
 * least two equal windows of at least 30 s, so a tempo change halfway is caught. A window whose own
 * grid has little contrast (a breakdown) is skipped, unless it has a clear beat at another tempo;
 * if no window has a beat, there's nothing stable.
 */
function isStable(envelope: Envelope, bpm: number, phase: number): boolean {
  const { onset, fps } = envelope;
  const n = onset.length;
  const period = periodOf(bpm, fps);
  const windowFrames = WINDOW_SECONDS * fps;
  const windows = n < windowFrames ? 1 : Math.max(2, Math.floor(n / windowFrames));
  let confident = 0;
  for (let w = 0; w < windows; w++) {
    const from = Math.round((w * n) / windows);
    const to = Math.round(((w + 1) * n) / windows);
    const localBpm = refineTempo(envelope, from, to, bpm, WINDOW_REFINE_RANGE);
    const localPeriod = periodOf(localBpm, fps);
    const local = bestPhase(onset, from, to, localPeriod, FINE_PHASE_STEP).phase;
    if (confidence(onset, from, to, localPeriod, local) < WINDOW_MIN_CONFIDENCE) {
      if (hasOwnBeat(envelope, from, to)) return false;
      continue;
    }
    confident++;
    if (Math.abs(localBpm - bpm) > STABLE_BPM_SHARE * bpm) return false;
    // Compare at the window's middle beat, where a slightly different local tempo matters least.
    const middle = local + Math.floor((to - from) / 2 / localPeriod) * localPeriod;
    if (Math.abs(wrap(middle - phase, period)) / fps > STABLE_PHASE_SECONDS) return false;
  }
  return confident > 0;
}

/** Whether frames [from, to) have a clear beat of their own, found from scratch. */
function hasOwnBeat({ onset, smooth, fps }: Envelope, from: number, to: number): boolean {
  const slice: Envelope = { onset: onset.subarray(from, to), smooth: smooth.subarray(from, to), fps };
  if (slice.onset.length < MIN_SECONDS * fps || !slice.onset.some((v) => v > 0)) return false;
  const bpm = refineTempo(slice, 0, slice.onset.length, roughTempo(slice.onset, fps), REFINE_RANGE);
  const period = periodOf(bpm, fps);
  const phase = bestPhase(slice.onset, 0, slice.onset.length, period, SEARCH_PHASE_STEP).phase;
  return confidence(slice.onset, 0, slice.onset.length, period, phase) >= WINDOW_MIN_CONFIDENCE;
}

/**
 * How far the envelope on the grid's beats stands above the envelope between them over frames
 * [from, to), in standard deviations of the envelope there, mapped 0.5 → 0 and 3 → 1. Noise lands
 * about as much energy on any grid as off it; a clean beat is several deviations above.
 */
function confidence(onset: Float64Array, from: number, to: number, period: number, phase: number): number {
  const end = Math.min(to, onset.length - 1);
  let atBeats = 0;
  let beats = 0;
  for (let x = phase + Math.ceil((from - phase) / period) * period; x < end; x += period) {
    atBeats += sample(onset, x);
    beats++;
  }
  let elsewhere = 0;
  let others = 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = from; i < to; i++) {
    sum += onset[i]!;
    sumSq += onset[i]! ** 2;
    if (Math.abs(wrap(i - phase, period)) > BEAT_HALF_WIDTH) {
      elsewhere += onset[i]!;
      others++;
    }
  }
  const mean = sum / (to - from);
  const std = Math.sqrt(Math.max(0, sumSq / (to - from) - mean * mean));
  if (!beats || !others || !std) return 0;
  return scale((atBeats / beats - elsewhere / others) / std, 0.5, 3);
}

/** The envelope under a small triangular blur (5 frames wide): a broader peak for coarse searches. */
function smoothed(onset: Float64Array): Float64Array {
  const weights = [1, 2, 3, 2, 1];
  return onset.map((_, i) => {
    let sum = 0;
    weights.forEach((w, k) => (sum += w * (onset[i + k - 2] ?? 0)));
    return sum / 9;
  });
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

const periodOf = (bpm: number, fps: number) => (fps * 60) / bpm;
const scale = (v: number, lo: number, hi: number) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
