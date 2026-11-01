// Musical key detection: which of the 24 major and minor keys a song is in, as a Camelot code
// for harmonic mixing. The classic recipe (Krumhansl–Schmuckler): measure how much of each of the
// 12 pitch classes the song contains (a chromagram), then see which key's typical pitch-class
// profile that shape matches best.

import { toCamelot } from '../camelot.ts';
import type { Camelot } from '../types.ts';
import { Fft, hann } from './fft.ts';

/** ~370 ms at 11025 Hz (2.7 Hz per bin): fine enough to tell neighbouring semitones apart above ~80 Hz. */
const FRAME = 4096;
const HOP = 2048;
/**
 * The band the pitch classes are read from. Below ~80 Hz a semitone is under two FFT bins wide, so
 * notes smear into each other, and that's where kick drums sit: a loud, pitched kick would otherwise
 * pass for a note. Above ~2 kHz it's mostly overtones and cymbals. Bass lines still count through
 * their second and third harmonics.
 */
const LOW_HZ = 80;
const HIGH_HZ = 2000;
/** Frames quieter than this (RMS, about −60 dBFS) are silence and say nothing about the key. */
const SILENCE_RMS = 0.001;
/**
 * Spectral flatness (geometric over arithmetic mean of the power spectrum) runs from near 0 for a
 * few clear notes to ~0.56 for white noise. Frames at or below TONAL count fully, frames at or above
 * NOISY not at all, so snares, hi-hats and noise don't smear the pitch classes flat.
 */
const FLATNESS_TONAL = 0.1;
const FLATNESS_NOISY = 0.3;
/**
 * Only spectral peaks standing this many times (12 dB) above the spectrum around them count as
 * notes. The sloping tail of a kick drum or the random bumps of noise don't, so a drum loop with no
 * notes in it has no key rather than an arbitrary one.
 */
const PEAK_PROMINENCE = 4;
/** Bins either side of a peak that make up "the spectrum around it", skipping the peak's own main lobe. */
const FLOOR_NEAR = 3;
const FLOOR_FAR = 10;
/**
 * Lower notes count for more, by 1/√frequency. A note's overtones pile up on the pitch classes of
 * its fifth and third (C's third harmonic is a G), so without this a plain C major chord reads as
 * E minor; and the bass line, the lowest notes, is what most clearly spells out the tonic.
 */
const BASS_TILT = 0.5;
/** A gap this large between the best and second-best key (relative to the best) is full confidence. */
const CONFIDENT_GAP = 0.15;

// Key profiles from Krumhansl & Kessler (1982), "Tracing the dynamic changes in perceived tonal
// organization in a spatial representation of musical keys", Psychological Review 89(4), as
// tabulated in Krumhansl, "Cognitive Foundations of Musical Pitch" (1990): how well listeners judged
// each pitch class (counting semitones up from the tonic) to fit a major or a minor key.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface DetectedKey {
  camelot: Camelot;
  /** 0–1: how clearly the best key beat the runner-up. */
  confidence: number;
}

/**
 * The key of `samples` (mono, −1…1, at `rate`), or undefined when there's nothing tonal to go on:
 * silence, noise, drums only, or less than one frame of audio.
 */
export function detectKey(samples: Float32Array, rate = 11025): DetectedKey | undefined {
  const chroma = chromagram(samples, rate);
  if (!chroma) return undefined;

  const scores: { pitchClass: number; minor: boolean; score: number }[] = [];
  for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
    for (const minor of [false, true]) {
      const profile = minor ? MINOR_PROFILE : MAJOR_PROFILE;
      // The profile starts at the tonic; rotate it so index i is pitch class i.
      const rotated = Array.from({ length: 12 }, (_, i) => profile[(i - pitchClass + 12) % 12]!);
      scores.push({ pitchClass, minor, score: pearson(chroma, rotated) });
    }
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0]!;
  const second = scores[1]!;
  const gap = best.score > 0 ? (best.score - second.score) / best.score : 0;
  return { camelot: toCamelot(best.pitchClass, best.minor), confidence: scale(gap, 0, CONFIDENT_GAP) };
}

/**
 * How much of each pitch class (0 = C) the song holds: the spectral peaks between LOW_HZ and
 * HIGH_HZ of every tonal frame, each credited to its nearest semitone. Undefined if no frame had a
 * single note-like peak.
 */
function chromagram(samples: Float32Array, rate: number): Float64Array | undefined {
  const binHz = rate / FRAME;
  const firstBin = Math.max(1, Math.ceil(LOW_HZ / binHz));
  const lastBin = Math.min(FRAME / 2 - 1, Math.floor(HIGH_HZ / binHz));
  const half = FRAME / 2;

  const window = hann(FRAME);
  const fft = new Fft(FRAME);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const magnitude = new Float64Array(half + 1);
  const chroma = new Float64Array(12);
  let counted = 0;

  for (let start = 0; start + FRAME <= samples.length; start += HOP) {
    let energy = 0;
    for (let i = 0; i < FRAME; i++) {
      const v = samples[start + i]!;
      energy += v * v;
      re[i] = v * window[i]!;
      im[i] = 0;
    }
    if (Math.sqrt(energy / FRAME) < SILENCE_RMS) continue;
    fft.transform(re, im);
    for (let k = 0; k <= half; k++) magnitude[k] = Math.hypot(re[k]!, im[k]!);

    const tonal = scale(flatness(magnitude, firstBin, lastBin), FLATNESS_NOISY, FLATNESS_TONAL);
    if (tonal === 0) continue;

    let credited = false;
    for (let k = firstBin; k <= lastBin; k++) {
      const here = magnitude[k]!;
      const below = magnitude[k - 1]!;
      const above = magnitude[k + 1]!;
      if (!(here > below && here >= above)) continue;
      if (here < PEAK_PROMINENCE * localFloor(magnitude, k)) continue;

      const hz = peakFrequency(below, here, above, k) * binHz;
      const midi = 69 + 12 * Math.log2(hz / 440); // A4 = 440 Hz = MIDI 69
      const nearest = Math.round(midi);
      // Fully when the peak is on a semitone, fading to nothing a quarter-tone off, where it's as
      // likely one note as the other (or just out of tune).
      const inTune = Math.cos(Math.PI * (midi - nearest)) ** 2;
      const bass = (LOW_HZ / hz) ** BASS_TILT;
      chroma[((nearest % 12) + 12) % 12]! += tonal * inTune * bass * here;
      credited = true;
    }
    if (credited) counted++;
  }
  return counted > 0 ? chroma : undefined;
}

/** Spectral flatness of the power spectrum over bins [from, to]: ~0 for clear notes, ~0.56 for white noise. */
function flatness(magnitude: Float64Array, from: number, to: number): number {
  let logSum = 0;
  let powerSum = 0;
  for (let k = from; k <= to; k++) {
    const power = magnitude[k]! ** 2;
    logSum += Math.log(power + 1e-20);
    powerSum += power;
  }
  const bins = to - from + 1;
  return Math.exp(logSum / bins) / (powerSum / bins + 1e-20);
}

/** Average magnitude of the bins FLOOR_NEAR to FLOOR_FAR away from bin `k` on both sides. */
function localFloor(magnitude: Float64Array, k: number): number {
  let sum = 0;
  let count = 0;
  for (let distance = FLOOR_NEAR; distance <= FLOOR_FAR; distance++) {
    for (const j of [k - distance, k + distance]) {
      if (j < 1 || j >= magnitude.length) continue;
      sum += magnitude[j]!;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Where between bins a peak really is: a parabola through the log magnitudes of the peak bin `k`
 * and its neighbours. At low frequencies a bin is a third of a semitone wide, so this matters.
 */
function peakFrequency(below: number, here: number, above: number, k: number): number {
  const a = Math.log(below + 1e-20);
  const b = Math.log(here + 1e-20);
  const c = Math.log(above + 1e-20);
  const curvature = a - 2 * b + c;
  return curvature < 0 ? k + (0.5 * (a - c)) / curvature : k;
}

/** Pearson correlation of two equal-length series: 1 when they rise and fall together. */
function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i]! / n;
    meanB += b[i]! / n;
  }
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  return varA > 0 && varB > 0 ? cov / Math.sqrt(varA * varB) : 0;
}

/** Maps x linearly from [from, to] onto [0, 1], clamped (works with from > to too). */
function scale(x: number, from: number, to: number): number {
  return Math.min(1, Math.max(0, (x - from) / (to - from)));
}
