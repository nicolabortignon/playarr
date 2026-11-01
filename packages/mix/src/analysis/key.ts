// Musical key detection: which of the 24 major and minor keys a song is in, as a Camelot code
// for harmonic mixing. The classic recipe (Krumhansl–Schmuckler): measure how much of each of the
// 12 pitch classes the song contains (a chromagram), then see which key's typical pitch-class
// profile that shape matches best.

import { keysCompatible, toCamelot } from '../camelot.ts';
import type { Camelot } from '../types.ts';
import { Fft, hann } from './fft.ts';

/** ~370 ms at 11025 Hz (2.7 Hz per bin): fine enough to tell neighbouring semitones apart above ~80 Hz. */
const FRAME = 4096;
const HOP = 2048;
/**
 * The band the pitch classes are read from. Below ~80 Hz a semitone is under two FFT bins wide, so
 * notes smear into each other, and that's where kick drums sit: a loud, pitched kick would otherwise
 * pass for a note. Above ~2 kHz it's mostly overtones and cymbals.
 */
const LOW_HZ = 80;
const HIGH_HZ = 2000;
/**
 * Between SUB_HZ and LOW_HZ only sustained notes count, so a sine sub-bass, which has no harmonics
 * higher up to stand in for it, still spells out the tonic. A peak there must be as narrow as a
 * steady tone's: a kick dies away within the frame, which spreads its peak over several bins, so the
 * magnitudes two bins either side must average under SUB_SHARPNESS of the peak's. And it must come
 * back at the same semitone SUSTAIN_FRAMES frames in a row (~0.75 s), longer than a kick rings.
 * Shorter sub-bass notes still don't count.
 */
const SUB_HZ = 40;
const SUSTAIN_FRAMES = 3;
const SUB_SHARPNESS = 0.3;
/** Frames quieter than this (RMS, about −60 dBFS) are silence and say nothing about the key. */
const SILENCE_RMS = 0.001;
/**
 * Spectral flatness (geometric over arithmetic mean of the power spectrum) runs from near 0 for a
 * few clear notes to ~0.56 for white noise; pink noise sits around 0.49, and a chord under white
 * noise at half its level around 0.31. Frames at or below TONAL count fully, frames at or above NOISY
 * not at all. The prominence test below already turns away nearly all of noise's random bumps, but
 * over a minute or two of noise enough of them pass to add up to a made-up key.
 */
const FLATNESS_TONAL = 0.2;
const FLATNESS_NOISY = 0.45;
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
 * E minor; and the bass line, the lowest notes, is what most clearly spells out the tonic. Sub-bass
 * notes below LOW_HZ count only as much as one at LOW_HZ, so they can't drown out everything else.
 */
const BASS_TILT = 0.5;
/** Seconds' worth of frames with notes in them needed before there's a key to report at all. */
const MIN_TONAL_SECONDS = 2;
/**
 * Confidence is the product of two things: how far the best key's correlation is ahead of the best
 * key that would clash with it, from nothing at TIED_GAP to full marks at CONFIDENT_GAP; and how well
 * the best key fits at all, from nothing at a correlation of WEAK_FIT to full marks at STRONG_FIT. A
 * lone note (gap ~0.05) or a cluster of all 12 notes (fit ~0.4) is no evidence of a key, so either
 * keeps the confidence low. So does a lone major triad, whose clashing rival is the minor key a third
 * up (C–E–G against E–G–B) only 0.06–0.11 behind.
 */
const TIED_GAP = 0.04;
const CONFIDENT_GAP = 0.11;
const WEAK_FIT = 0.6;
const STRONG_FIT = 0.85;

// Key profiles from Krumhansl & Kessler (1982), "Tracing the dynamic changes in perceived tonal
// organization in a spatial representation of musical keys", Psychological Review 89(4), as
// tabulated in Krumhansl, "Cognitive Foundations of Musical Pitch" (1990): how well listeners judged
// each pitch class (counting semitones up from the tonic) to fit a major or a minor key.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface DetectedKey {
  camelot: Camelot;
  /**
   * 0–1: how much to trust `camelot`. High only when the pitch classes fit the key well and clearly
   * better than any key that would clash with it. Its relative major/minor and the keys a fifth away
   * don't count against it, since a DJ mixes those just the same.
   */
  confidence: number;
}

/**
 * The key of `samples` (mono, −1…1, at `rate`), or undefined when there's too little tonal evidence
 * to go on: silence, noise, drums only, or under MIN_TONAL_SECONDS of audio with notes in it.
 */
export function detectKey(samples: Float32Array, rate = 11025): DetectedKey | undefined {
  const chroma = chromagram(samples, rate);
  if (!chroma) return undefined;

  const scores: { camelot: Camelot; score: number }[] = [];
  for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
    for (const minor of [false, true]) {
      const profile = minor ? MINOR_PROFILE : MAJOR_PROFILE;
      // The profile starts at the tonic; rotate it so index i is pitch class i.
      const rotated = Array.from({ length: 12 }, (_, i) => profile[(i - pitchClass + 12) % 12]!);
      scores.push({ camelot: toCamelot(pitchClass, minor), score: pearson(chroma, rotated) });
    }
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0]!;
  // There's always one: only 4 of the 24 keys are compatible with any key.
  const rival = scores.find((s) => !keysCompatible(s.camelot, best.camelot))!;
  const ahead = scale(best.score - rival.score, TIED_GAP, CONFIDENT_GAP);
  const fit = scale(best.score, WEAK_FIT, STRONG_FIT);
  return { camelot: best.camelot, confidence: ahead * fit };
}

/**
 * How much of each pitch class (0 = C) the song holds: the spectral peaks between LOW_HZ and
 * HIGH_HZ of every tonal frame (and sustained ones down to SUB_HZ), each credited to its nearest
 * semitone after allowing for the song's tuning. Undefined if under MIN_TONAL_SECONDS of frames had
 * a note-like peak.
 */
function chromagram(samples: Float32Array, rate: number): Float64Array | undefined {
  const binHz = rate / FRAME;
  const subBin = Math.max(2, Math.ceil(SUB_HZ / binHz));
  const firstBin = Math.max(1, Math.ceil(LOW_HZ / binHz));
  const lastBin = Math.min(FRAME / 2 - 1, Math.floor(HIGH_HZ / binHz));
  const half = FRAME / 2;

  const window = hann(FRAME);
  const fft = new Fft(FRAME);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const magnitude = new Float64Array(half + 1);
  // Every peak, kept until the tuning is known: its pitch in (fractional) MIDI notes, its magnitude,
  // and how much it counts for apart from that (frame tonality and bass tilt).
  const pitches: number[] = [];
  const magnitudes: number[] = [];
  const weights: number[] = [];
  // For each MIDI note below LOW_HZ, how many frames in a row it has had a sustained-looking peak.
  const runs = new Map<number, number>();
  let counted = 0;

  for (let start = 0; start + FRAME <= samples.length; start += HOP) {
    let energy = 0;
    for (let i = 0; i < FRAME; i++) {
      const v = samples[start + i]!;
      energy += v * v;
      re[i] = v * window[i]!;
      im[i] = 0;
    }
    if (Math.sqrt(energy / FRAME) < SILENCE_RMS) {
      runs.clear();
      continue;
    }
    fft.transform(re, im);
    for (let k = 0; k <= half; k++) magnitude[k] = Math.hypot(re[k]!, im[k]!);

    const tonal = scale(flatness(magnitude, firstBin, lastBin), FLATNESS_NOISY, FLATNESS_TONAL);
    if (tonal === 0) {
      runs.clear();
      continue;
    }

    let credited = false;
    const sustained = new Set<number>();
    for (let k = subBin; k <= lastBin; k++) {
      const here = magnitude[k]!;
      const below = magnitude[k - 1]!;
      const above = magnitude[k + 1]!;
      if (!(here > below && here >= above)) continue;
      if (here < PEAK_PROMINENCE * localFloor(magnitude, k)) continue;

      const hz = peakFrequency(below, here, above, k) * binHz;
      const midi = 69 + 12 * Math.log2(hz / 440); // A4 = 440 Hz = MIDI 69
      if (k < firstBin) {
        // Below LOW_HZ: only a narrow peak that has been there SUSTAIN_FRAMES frames in a row.
        if (magnitude[k - 2]! + magnitude[k + 2]! > 2 * SUB_SHARPNESS * here) continue;
        const note = Math.round(midi);
        const run = (runs.get(note) ?? 0) + 1;
        sustained.add(note);
        runs.set(note, run);
        if (run < SUSTAIN_FRAMES) continue;
      }
      pitches.push(midi);
      magnitudes.push(here);
      weights.push(tonal * (LOW_HZ / Math.max(hz, LOW_HZ)) ** BASS_TILT);
      credited = true;
    }
    for (const note of runs.keys()) if (!sustained.has(note)) runs.delete(note);
    if (credited) counted++;
  }
  if ((counted * HOP) / rate < MIN_TONAL_SECONDS) return undefined;

  // The tuning: the magnitude-weighted circular mean of how far each peak sits from its nearest
  // semitone, in semitones (so within ±0.5, i.e. ±50 cents). Circular, because a peak 49 cents sharp
  // and one 49 cents flat are 2 cents apart, not 98.
  let x = 0;
  let y = 0;
  pitches.forEach((midi, i) => {
    const angle = 2 * Math.PI * (midi - Math.round(midi));
    x += magnitudes[i]! * Math.cos(angle);
    y += magnitudes[i]! * Math.sin(angle);
  });
  const tuning = Math.atan2(y, x) / (2 * Math.PI);

  const chroma = new Float64Array(12);
  pitches.forEach((untuned, i) => {
    const midi = untuned - tuning;
    const nearest = Math.round(midi);
    // Fully when the peak is on a semitone, fading to nothing a quarter-tone off, where it's as
    // likely one note as the other (or just out of tune).
    const inTune = Math.cos(Math.PI * (midi - nearest)) ** 2;
    chroma[((nearest % 12) + 12) % 12]! += inTune * weights[i]! * magnitudes[i]!;
  });
  return chroma;
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
    if (k - distance >= 1) {
      sum += magnitude[k - distance]!;
      count++;
    }
    if (k + distance < magnitude.length) {
      sum += magnitude[k + distance]!;
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
