/**
 * Audio features from decoded PCM: what the song *sounds* like, measured rather than looked up.
 * Input is mono float samples at SAMPLE_RATE (ffmpeg does the decoding and downmixing).
 */

import { analyzeOnsets, halveRate, ONSET_HOP, type Onsets } from '@playarr/mix';

/** Bump when the analysis changes, so stored features are recomputed. */
export const ANALYSIS_VERSION = 1;
export const SAMPLE_RATE = 11025;
export const ENVELOPE_POINTS = 48;

const GATE_DB = -60; // frames quieter than this are silence

/** What sound analysis measures: how a song feels. Its tempo and beat come from beat analysis (its mix map). */
export interface SoundFeatures {
  version: number;
  /** 0–1: average loudness (−28 → −9 dBFS RMS). */
  loudness: number;
  /** 0–1: loudness range between quiet and loud passages (4 → 30 dB). */
  dynamics: number;
  /** 0–1: spectral centroid, dark/warm → bright/sharp (500 → 1800 Hz at this sample rate). */
  brightness: number;
  /** 0–1: note/drum onsets per second (1 → 4). */
  busyness: number;
  /** 0–1: share of energy below 150 Hz (0.15 → 0.7). */
  bass: number;
  /** Loudness over the song, ENVELOPE_POINTS values in 0–1 (absolute, so quiet songs stay low). */
  envelope: number[];
  /** Seconds of audio analyzed. */
  seconds: number;
  /** The physical measurements behind the 0–1 values, kept so the scales can be recalibrated. */
  raw: { meanDb: number; rangeDb: number; centroidHz: number; onsetsPerSec: number; lowShare: number };
}

/** A song's features as the rest of the server sees them: its sound, with its tempo and beat from beat analysis. */
export interface AudioFeatures extends SoundFeatures {
  /** Beats per minute, from beat analysis; 0 until the song has one. */
  bpm: number;
  /** 0–1: how sure beat analysis is of the beat (ambient ≈ 0, four-on-the-floor ≈ 1); 0 until the song has one. */
  pulse: number;
}

/** s16le PCM bytes → floats in −1…1. */
/**
 * `samples` at SAMPLE_RATE, from SAMPLE_RATE or twice it (songs are decoded at the beat model's
 * 22050 Hz, the rest of the analysis measures at half that).
 */
export function atSampleRate(samples: Float32Array, rate: number): Float32Array {
  if (rate === SAMPLE_RATE) return samples;
  if (rate === 2 * SAMPLE_RATE) return halveRate(samples);
  throw new RangeError(`Audio at ${rate} Hz can't be analyzed (${SAMPLE_RATE} or ${2 * SAMPLE_RATE} Hz only)`);
}

export function pcmToFloat(buf: Buffer): Float32Array {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

/**
 * Measures a song. `onsets` is the song's `analyzeOnsets` pass when the caller already has it (the
 * mix analysis needs the same one), so the FFT runs once per song.
 */
export function analyzePcm(
  samples: Float32Array,
  sampleRate = SAMPLE_RATE,
  onsets: Onsets = analyzeOnsets(samples, sampleRate),
): SoundFeatures {
  const fps = sampleRate / ONSET_HOP;
  const seconds = samples.length / sampleRate;
  // One FFT pass (shared with the mix analysis) gives the onsets and each frame's loudness and spectrum.
  const { onset, rms, lowEnergy, energy: power, centroid } = onsets;
  const frames = onset.length;
  if (frames < fps * 2) return silent(seconds);

  const energy = rms.map((r) => r * r);
  const db = energy.map((e) => 10 * Math.log10(e + 1e-12));
  const low = lowEnergy.map((p, f) => (power[f]! > 0 ? p / power[f]! : 0));

  // Loudness, dynamics, brightness and bass over the non-silent frames.
  const loud: number[] = [];
  let energySum = 0;
  let centroidSum = 0;
  let lowSum = 0;
  for (let f = 0; f < frames; f++) {
    if (db[f]! < GATE_DB) continue;
    loud.push(db[f]!);
    energySum += energy[f]!;
    centroidSum += centroid[f]! * energy[f]!;
    lowSum += low[f]! * energy[f]!;
  }
  if (loud.length < fps) return silent(seconds);
  loud.sort((a, b) => a - b);
  const meanDb = 10 * Math.log10(energySum / loud.length);
  const range = percentile(loud, 0.95) - percentile(loud, 0.1);

  const centroidHz = centroidSum / energySum;
  const onsetsPerSec = countPeaks(onset) / seconds;
  const lowShare = lowSum / energySum;

  return {
    version: ANALYSIS_VERSION,
    loudness: round(scale(meanDb, -28, -9)),
    dynamics: round(scale(range, 4, 30)),
    brightness: round(scale(centroidHz, 500, 1800)),
    busyness: round(scale(onsetsPerSec, 1, 4)),
    bass: round(scale(lowShare, 0.15, 0.7)),
    envelope: envelope(energy),
    seconds: round(seconds, 1),
    raw: {
      meanDb: round(meanDb, 1),
      rangeDb: round(range, 1),
      centroidHz: Math.round(centroidHz),
      onsetsPerSec: round(onsetsPerSec, 2),
      lowShare: round(lowShare),
    },
  };
}

/** Onsets: local maxima clearly above the envelope's average, at least ~70 ms apart. */
function countPeaks(onset: Float64Array): number {
  let count = 0;
  let last = -Infinity;
  for (let i = 3; i < onset.length - 3; i++) {
    const v = onset[i]!;
    if (v < 1.5 || i - last < 3) continue;
    let isMax = true;
    for (let j = i - 3; j <= i + 3 && isMax; j++) if (onset[j]! > v) isMax = false;
    if (isMax) {
      count++;
      last = i;
    }
  }
  return count;
}

function envelope(energy: Float64Array): number[] {
  const points: number[] = [];
  const per = energy.length / ENVELOPE_POINTS;
  for (let p = 0; p < ENVELOPE_POINTS; p++) {
    let s = 0;
    const from = Math.floor(p * per);
    const to = Math.max(from + 1, Math.floor((p + 1) * per));
    for (let i = from; i < to; i++) s += energy[i]!;
    points.push(scale(10 * Math.log10(s / (to - from) + 1e-12), -50, -6));
  }
  // Light smoothing: the shape matters, not frame-level spikes.
  return points.map((v, i) => round(0.25 * (points[i - 1] ?? v) + 0.5 * v + 0.25 * (points[i + 1] ?? v)));
}

function silent(seconds: number): SoundFeatures {
  return {
    version: ANALYSIS_VERSION,
    loudness: 0,
    dynamics: 0,
    brightness: 0,
    busyness: 0,
    bass: 0,
    envelope: Array.from({ length: ENVELOPE_POINTS }, () => 0),
    seconds: round(seconds, 1),
    raw: { meanDb: -120, rangeDb: 0, centroidHz: 0, onsetsPerSec: 0, lowShare: 0 },
  };
}

function percentile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
}

const scale = (v: number, lo: number, hi: number) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
const round = (v: number, digits = 3) => Math.round(v * 10 ** digits) / 10 ** digits;
