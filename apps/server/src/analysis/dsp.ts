/**
 * Audio features from decoded PCM: what the song *sounds* like, measured rather than looked up.
 * Input is mono float samples at SAMPLE_RATE (ffmpeg does the decoding and downmixing).
 */

import { analyzeOnsets, ONSET_HOP } from '@playarr/mix';

/** Bump when the analysis changes, so stored features are recomputed. */
export const ANALYSIS_VERSION = 1;
export const SAMPLE_RATE = 11025;
export const ENVELOPE_POINTS = 48;

const GATE_DB = -60; // frames quieter than this are silence

export interface AudioFeatures {
  version: number;
  /** Beats per minute, folded into 70–180. Only meaningful when `pulse` is high. */
  bpm: number;
  /** 0–1: how clear and steady the beat is (ambient ≈ 0, four-on-the-floor ≈ 1). */
  pulse: number;
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
  raw: { meanDb: number; rangeDb: number; centroidHz: number; onsetsPerSec: number; lowShare: number; beatPeak: number };
}

/** s16le PCM bytes → floats in −1…1. */
export function pcmToFloat(buf: Buffer): Float32Array {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

export function analyzePcm(samples: Float32Array, sampleRate = SAMPLE_RATE): AudioFeatures {
  const fps = sampleRate / ONSET_HOP;
  const seconds = samples.length / sampleRate;
  // One FFT pass (shared with the mix analysis) gives the onsets and each frame's loudness and spectrum.
  const { onset, rms, lowEnergy, energy: power, centroid } = analyzeOnsets(samples, sampleRate);
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

  const { bpm, beatPeak } = tempo(onset, fps);
  const centroidHz = centroidSum / energySum;
  const onsetsPerSec = countPeaks(onset) / seconds;
  const lowShare = lowSum / energySum;

  return {
    version: ANALYSIS_VERSION,
    bpm: round(bpm, 1),
    pulse: round(scale(beatPeak, 0.05, 0.9)),
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
      beatPeak: round(beatPeak),
    },
  };
}

/**
 * Tempo from the autocorrelation of the onset envelope, weighted toward ~120 BPM (one octave
 * either side) to settle half/double ambiguity, then refined from the peaks at 2×, 3×, 4× the period.
 */
function tempo(onset: Float64Array, fps: number): { bpm: number; beatPeak: number } {
  const minLag = Math.floor((fps * 60) / 200);
  const maxLag = Math.ceil((fps * 60) / 50);
  const acf = autocorrelation(onset, maxLag * 4 + 2);
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
  let beatPeak = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (acf[lag]! < acf[lag - 1]! || acf[lag]! < acf[lag + 1]!) continue;
    const bpm = (fps * 60) / lag;
    const prior = Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
    const p = prominence(lag);
    if (p * prior > bestScore) {
      bestScore = p * prior;
      best = lag;
      beatPeak = p;
    }
  }
  // Least-squares period through the peaks at k × lag.
  let num = 0;
  let den = 0;
  for (let k = 1; k <= 4; k++) {
    const peak = refinePeak(acf, Math.round(best * k), 2);
    if (peak === undefined) break;
    num += k * peak;
    den += k * k;
  }
  const period = den ? num / den : best;
  let bpm = (fps * 60) / period;
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return { bpm, beatPeak };
}

/** Normalized (acf[0] = 1), unbiased autocorrelation of the mean-removed signal. */
function autocorrelation(signal: Float64Array, maxLag: number): Float64Array {
  const n = signal.length;
  const mean = signal.reduce((s, v) => s + v, 0) / n;
  const x = signal.map((v) => v - mean);
  const out = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag && lag < n; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i]! * x[i + lag]!;
    out[lag] = s / (n - lag);
  }
  const zero = out[0] || 1;
  for (let lag = 0; lag <= maxLag; lag++) out[lag]! /= zero;
  return out;
}

/** Sub-frame position of the local maximum near `around` (parabolic interpolation). */
function refinePeak(acf: Float64Array, around: number, radius: number): number | undefined {
  let best = -1;
  for (let i = Math.max(1, around - radius); i <= Math.min(acf.length - 2, around + radius); i++) {
    if (best < 0 || acf[i]! > acf[best]!) best = i;
  }
  if (best < 1 || best >= acf.length - 1) return undefined;
  const a = acf[best - 1]!;
  const b = acf[best]!;
  const c = acf[best + 1]!;
  const denom = a - 2 * b + c;
  return best + (denom ? (0.5 * (a - c)) / denom : 0);
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

function silent(seconds: number): AudioFeatures {
  return {
    version: ANALYSIS_VERSION,
    bpm: 0,
    pulse: 0,
    loudness: 0,
    dynamics: 0,
    brightness: 0,
    busyness: 0,
    bass: 0,
    envelope: Array.from({ length: ENVELOPE_POINTS }, () => 0),
    seconds: round(seconds, 1),
    raw: { meanDb: -120, rangeDb: 0, centroidHz: 0, onsetsPerSec: 0, lowShare: 0, beatPeak: 0 },
  };
}

function percentile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
}

const scale = (v: number, lo: number, hi: number) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
const round = (v: number, digits = 3) => Math.round(v * 10 ** digits) / 10 ** digits;
