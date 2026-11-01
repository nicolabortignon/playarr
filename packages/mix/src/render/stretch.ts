// Time-stretch with the pitch kept, for playing B at A's tempo during a transition: WSOLA
// (waveform-similarity overlap-add). The output is built from short overlapping frames of the
// input, cross-faded; playing faster just means taking the frames from further apart in the
// input. Where each frame is taken from is nudged (within ±11.6 ms) to the spot whose waveform best
// continues the previous frame, so the cross-fades join matching waveforms instead of smearing.
//
// Time-domain and frame-based, so it keeps transients like kicks sharp (a phase vocoder smears
// them), costs little, and is exact at rate 1: frames taken back to back cross-fade the input
// into itself. That matters because a transition joins the original audio at both ends.
//
// How exact the tempo curve is followed: where the rate is 1, output sample n is the input sample
// the integral of the rate says, exactly. Elsewhere that holds at frame centres up to the search
// nudge, which leans toward the previous frame's natural continuation; with the drift penalty
// re-centred (below), frames sit on average ~0.7 ms behind the curve when speeding up 5% (ahead
// when slowing down), and kicks in a dense mix land within ~0.5 ms of it on average.

/** Sample rate transitions are rendered at. */
export const RENDER_RATE = 44100;

/** Playback rate over the output, by output time in seconds: 1.05 = 5% faster (more input used). */
export type RateAt = (outSeconds: number) => number;

/** Half a frame (frames are 2048 samples at 44.1 kHz, overlapping by half). */
const HOP_AT_44K = 1024;
/** How far a frame may move from its ideal place to find a matching waveform. */
const SEARCH_AT_44K = 512;
/** The coarse search runs on the signal averaged down by this factor, then refines at full rate. */
const DECIMATION = 4;
/** Full-rate positions tried on each side of the coarse winner. */
const REFINE = DECIMATION;
/**
 * Similarity (normalised cross-correlation, 1 = identical) a candidate gives up per full search
 * width it is from the ideal position. Plain WSOLA keeps picking the previous frame's natural
 * continuation (a perfect match) until it falls off the edge of the search window, so under dense
 * music (hats, reverb, noise: nothing else matches well) the beat sits ~11 ms off the tempo curve,
 * an audible flam against the other song. Measured on a dense test mix at 1.05: penalty 0.2 put
 * kicks up to 11 ms off, 1 → 9 ms, 2 → 5 ms, 3 → 3 ms. The cost is splices slightly out of phase
 * on tonal sounds, small because the ideal place moves only (rate − 1) × hop per frame: steady
 * sines from 45 to 110 Hz dip at most 6% in level at 3, against 1% at 0.2.
 */
const DRIFT_PENALTY = 3;
/**
 * Where the penalty is centred, as a fraction of how far the natural continuation falls behind the
 * ideal place each frame ((rate − 1) × hop). Centred on the ideal place itself, the picks still
 * lean toward the natural continuation: measured on the dense mix at 1.05, frames sat 1.3 ms
 * behind the curve on average. Centring halfway toward the other side halves that to 0.7 ms and
 * brings the kicks' mean offset to 0.3 ms (0.5 ms at 0.95), with no change to tonal splices.
 * (Leaving ±2 ms around the centre free of penalty was tried too: it made timing worse and
 * splices no better.)
 */
const PENALTY_CENTRE = 0.5;
/** Mean square below this (−90 dB) is silence: nothing to match, so take the ideal position. */
const SILENCE = 1e-9;

/**
 * Stretches `input` to exactly `outSamples` samples. Output sample n plays input position
 * `startOffset + sampleRate · ∫₀^{n/sampleRate} rate(t) dt` (positions in samples; see the top of
 * the file for how exactly). Frames are taken from whole-sample positions, without interpolation,
 * so a fractional `startOffset` is honoured to within half a sample. Input outside the array,
 * including before a negative `startOffset`, reads as silence. Throws if the rate is ever not a
 * finite positive number.
 */
export function stretch(input: Float32Array, rate: RateAt, outSamples: number, sampleRate: number, startOffset = 0): Float32Array {
  const splices = planSplices((into, base) => copyPadded(input, into, base), input.length, rate, outSamples, sampleRate, startOffset);
  return overlapAdd(input, splices, outSamples);
}

/**
 * `stretch` for a stereo pair: the frame positions are chosen once, on the mid signal (L+R)/2,
 * and used for both channels, so the two sides stay aligned and the stereo image intact.
 */
export function stretchStereo(
  left: Float32Array,
  right: Float32Array,
  rate: RateAt,
  outSamples: number,
  sampleRate: number,
  startOffset = 0,
): { left: Float32Array; right: Float32Array } {
  if (left.length !== right.length) throw new RangeError(`stereo channels differ in length: ${left.length} and ${right.length}`);
  const length = left.length;
  const fillMid = (into: Float32Array, base: number) => {
    const from = Math.max(0, base);
    const to = Math.min(length, base + into.length);
    for (let i = from; i < to; i++) into[i - base] = 0.5 * (left[i]! + right[i]!);
  };
  const splices = planSplices(fillMid, length, rate, outSamples, sampleRate, startOffset);
  return { left: overlapAdd(left, splices, outSamples), right: overlapAdd(right, splices, outSamples) };
}

/**
 * Where each frame comes from. Frame k is centred on output sample k·hop and plays the input
 * around `positions[k]`: output k·hop + m (0 ≤ m < hop) cross-fades from input positions[k] + m
 * (frame k's second half) to positions[k + 1] − hop + m (frame k + 1's first half).
 */
interface Splices {
  hop: number;
  positions: Float64Array;
}

/**
 * Picks every frame's input position. The ideal position comes from integrating the rate; the
 * chosen one is where, near that ideal, the input best matches the "natural continuation" of the
 * previous frame (what would have followed it in the input), so the cross-fade joins like with
 * like. Where the rate is exactly 1 the ideal position is taken as is: once the previous frame is
 * in place too, that is the natural continuation, and the output is the input sample for sample.
 * The first frame at rate 1 after a stretch is the one splice taken without a search: it jumps
 * from wherever the nudging left off (a few ms at most, given the drift penalty) straight onto the
 * curve, through a single 23 ms cross-fade, so the transition can hand over to normal playback at
 * exactly the planned spot.
 *
 * `fillSignal(into, base)` writes the signal to match on (mono input, or stereo mid) for input
 * positions base… into `into`, leaving zeros outside the input.
 */
function planSplices(
  fillSignal: (into: Float32Array, base: number) => void,
  inputLength: number,
  rate: RateAt,
  outSamples: number,
  sampleRate: number,
  startOffset: number,
): Splices {
  const scale = sampleRate / RENDER_RATE;
  const hop = Math.max(DECIMATION, DECIMATION * Math.round((HOP_AT_44K * scale) / DECIMATION));
  const search = Math.max(DECIMATION, Math.round(SEARCH_AT_44K * scale));
  const segments = Math.ceil(outSamples / hop);

  // Ideal positions: the rate integrated over each hop with Simpson's rule (exact for the linear
  // ramps of an automation curve, and exactly hop samples per hop at rate 1).
  const ideal = new Float64Array(segments + 1);
  const unity = new Uint8Array(segments);
  let position = startOffset;
  ideal[0] = Math.round(position);
  const rateAt = (seconds: number) => {
    const value = rate(seconds);
    if (!(Number.isFinite(value) && value > 0)) throw new RangeError(`playback rate at ${seconds} s is ${value}`);
    return value;
  };
  let rateStart = rateAt(0);
  for (let k = 0; k < segments; k++) {
    const rateMid = rateAt(((k + 0.5) * hop) / sampleRate);
    const rateEnd = rateAt(((k + 1) * hop) / sampleRate);
    position += (hop * (rateStart + 4 * rateMid + rateEnd)) / 6;
    ideal[k + 1] = Math.round(position);
    unity[k] = isUnity(rateStart) && isUnity(rateMid) && isUnity(rateEnd) ? 1 : 0;
    rateStart = rateEnd;
  }

  // The signal to match on, copied once into a zero-padded buffer covering every position the
  // search can touch, so the inner loops need no bounds checks; plus its decimated copy.
  let lowest = Infinity;
  let highest = -Infinity;
  for (const p of ideal) {
    lowest = Math.min(lowest, p);
    highest = Math.max(highest, p);
  }
  const margin = hop + search + 2 * REFINE + 2 * DECIMATION;
  const base = DECIMATION * Math.floor((lowest - margin) / DECIMATION);
  const signal = new Float32Array(DECIMATION * Math.ceil((highest + margin - base) / DECIMATION));
  if (base < inputLength && base + signal.length > 0) fillSignal(signal, base);
  const coarse = new Float32Array(signal.length / DECIMATION);
  for (let j = 0; j < coarse.length; j++) {
    let sum = 0;
    for (let d = 0; d < DECIMATION; d++) sum += signal[j * DECIMATION + d]!;
    coarse[j] = sum / DECIMATION;
  }
  const coarseLength = hop / DECIMATION;

  const positions = new Float64Array(segments + 1);
  positions[0] = ideal[0]!;
  for (let k = 0; k < segments; k++) {
    const target = ideal[k + 1]!;
    // The previous frame's continuation: input positions[k] … + hop, matched against the first
    // half of the next frame, which starts hop before its centre.
    const natural = positions[k]! - base;
    if (unity[k] || meanSquare(signal, natural, hop) < SILENCE) {
      positions[k + 1] = target;
      continue;
    }
    const idealStart = target - hop - base;
    const centre = idealStart + PENALTY_CENTRE * (target - ideal[k]! - hop);
    const score = (start: number, similarity: number) => similarity - (DRIFT_PENALTY * Math.abs(start - centre)) / search;

    // Coarse pass over the decimated signal, sliding the candidate's energy along.
    const t = Math.round(natural / DECIMATION);
    const first = Math.ceil((idealStart - search) / DECIMATION);
    const last = Math.floor((idealStart + search) / DECIMATION);
    const targetEnergy = sumOfSquares(coarse, t, coarseLength);
    let energy = sumOfSquares(coarse, first, coarseLength);
    let bestCoarse = idealStart;
    let bestScore = -Infinity;
    for (let j = first; j <= last; j++) {
      let cross = 0;
      for (let i = 0; i < coarseLength; i++) cross += coarse[t + i]! * coarse[j + i]!;
      const s = score(j * DECIMATION, normalised(cross, targetEnergy, energy));
      if (s > bestScore) {
        bestScore = s;
        bestCoarse = j * DECIMATION;
      }
      energy += coarse[j + coarseLength]! ** 2 - coarse[j]! ** 2;
    }

    // Refine at full rate around the coarse winner; the ideal position and the natural
    // continuation itself are always in the running.
    const targetFull = sumOfSquares(signal, natural, hop);
    let best = idealStart;
    bestScore = -Infinity;
    const consider = (start: number) => {
      if (Math.abs(start - idealStart) > search) return;
      const s = score(start, similarity(signal, natural, start, hop, targetFull));
      if (s > bestScore) {
        bestScore = s;
        best = start;
      }
    };
    consider(idealStart);
    consider(natural);
    for (let start = bestCoarse - REFINE; start <= bestCoarse + REFINE; start++) consider(start);
    positions[k + 1] = best + hop + base;
  }
  return { hop, positions };
}

/** Renders the output: each hop cross-fades (Hann) from one frame's second half into the next's first. */
function overlapAdd(input: Float32Array, { hop, positions }: Splices, outSamples: number): Float32Array {
  const out = new Float32Array(outSamples);
  // Rising half of a Hann window of 2·hop; the falling half is 1 minus it, so two overlapping
  // frames always sum to a gain of exactly 1.
  const fadeIn = fadeInCurve(hop);
  const n = input.length;
  for (let k = 0; k * hop < outSamples; k++) {
    const at = k * hop;
    const length = Math.min(hop, outSamples - at);
    const from = positions[k]!;
    const to = positions[k + 1]! - hop;
    if (from >= 0 && to >= 0 && from + length <= n && to + length <= n) {
      // Written as a + w·(b − a) so frames that line up (b = a) give back the input exactly.
      for (let m = 0; m < length; m++) {
        const a = input[from + m]!;
        out[at + m] = a + fadeIn[m]! * (input[to + m]! - a);
      }
    } else {
      for (let m = 0; m < length; m++) {
        const a = sampleAt(input, from + m);
        out[at + m] = a + fadeIn[m]! * (sampleAt(input, to + m) - a);
      }
    }
  }
  return out;
}

const fadeInCurves = new Map<number, Float64Array>();
function fadeInCurve(hop: number): Float64Array {
  let curve = fadeInCurves.get(hop);
  if (!curve) {
    curve = Float64Array.from({ length: hop }, (_, m) => 0.5 - 0.5 * Math.cos((Math.PI * m) / hop));
    fadeInCurves.set(hop, curve);
  }
  return curve;
}

/** Rate 1, allowing for an automation curve's interpolation landing a hair off it. */
const isUnity = (rate: number) => Math.abs(rate - 1) < 1e-9;

const sampleAt = (input: Float32Array, i: number) => (i >= 0 && i < input.length ? input[i]! : 0);

function copyPadded(input: Float32Array, into: Float32Array, base: number): void {
  const from = Math.max(0, base);
  const to = Math.min(input.length, base + into.length);
  if (to > from) into.set(input.subarray(from, to), from - base);
}

function sumOfSquares(signal: Float32Array, start: number, length: number): number {
  let sum = 0;
  for (let i = start; i < start + length; i++) sum += signal[i]! ** 2;
  return sum;
}

const meanSquare = (signal: Float32Array, start: number, length: number) => sumOfSquares(signal, start, length) / length;

/** Normalised cross-correlation from the dot product and both energies; 0 when either is silent. */
function normalised(cross: number, energyA: number, energyB: number): number {
  const scale = energyA * energyB;
  return scale > 1e-20 ? cross / Math.sqrt(scale) : 0;
}

/** Normalised cross-correlation of signal[a…a+length) and signal[b…b+length); `energyA` precomputed. */
function similarity(signal: Float32Array, a: number, b: number, length: number, energyA: number): number {
  let cross = 0;
  let energyB = 0;
  for (let i = 0; i < length; i++) {
    const vb = signal[b + i]!;
    cross += signal[a + i]! * vb;
    energyB += vb * vb;
  }
  return normalised(cross, energyA, energyB);
}
