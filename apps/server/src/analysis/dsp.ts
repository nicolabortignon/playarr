/**
 * Audio features from decoded PCM: what the song *sounds* like, measured rather than looked up.
 * Input is mono float samples at SAMPLE_RATE (ffmpeg does the decoding and downmixing).
 */

/** Bump when the analysis changes, so stored features are recomputed. */
export const ANALYSIS_VERSION = 1;
export const SAMPLE_RATE = 11025;
export const ENVELOPE_POINTS = 48;

const FRAME = 1024; // ~93 ms
const HOP = 256; // ~23 ms → 43 frames per second
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
  const fps = sampleRate / HOP;
  const frames = Math.floor((samples.length - FRAME) / HOP) + 1;
  const seconds = samples.length / sampleRate;
  if (frames < fps * 2) return silent(seconds);

  const bins = FRAME / 2 + 1;
  const binHz = sampleRate / FRAME;
  const lowBin = Math.round(150 / binHz);
  const window = hann(FRAME);
  const fft = new Fft(FRAME);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);

  const energy = new Float64Array(frames);
  const db = new Float64Array(frames);
  const centroid = new Float64Array(frames);
  const low = new Float64Array(frames);
  const flux = new Float64Array(frames);

  for (let f = 0; f < frames; f++) {
    const offset = f * HOP;
    let sumSq = 0;
    for (let i = 0; i < FRAME; i++) {
      const x = samples[offset + i]!;
      sumSq += x * x;
      re[i] = x * window[i]!;
      im[i] = 0;
    }
    fft.transform(re, im);
    let mags = 0;
    let weighted = 0;
    let power = 0;
    let lowPower = 0;
    let rise = 0;
    for (let k = 0; k < bins; k++) {
      const p = re[k]! * re[k]! + im[k]! * im[k]!;
      const m = Math.sqrt(p);
      mags += m;
      weighted += m * k * binHz;
      power += p;
      if (k <= lowBin) lowPower += p;
      // Log-compressed spectral flux: onsets are where energy *rises* across the spectrum.
      const lm = Math.log1p(100 * m);
      const d = lm - prev[k]!;
      if (d > 0) rise += d;
      cur[k] = lm;
    }
    [prev, cur] = [cur, prev];
    energy[f] = sumSq / FRAME;
    db[f] = 10 * Math.log10(energy[f]! + 1e-12);
    centroid[f] = mags > 0 ? weighted / mags : 0;
    low[f] = power > 0 ? lowPower / power : 0;
    flux[f] = f === 0 ? 0 : rise;
  }

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

  const onset = onsetEnvelope(flux, fps);
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

/** Spectral flux minus its local average (1 s), half-wave rectified and normalized. */
function onsetEnvelope(flux: Float64Array, fps: number): Float64Array {
  const n = flux.length;
  const half = Math.round(fps / 2);
  const out = new Float64Array(n);
  let sum = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < n; i++) {
    while (hi < Math.min(n - 1, i + half)) sum += flux[++hi]!;
    while (lo < i - half) sum -= flux[lo++]!;
    out[i] = Math.max(0, flux[i]! - sum / (hi - lo + 1));
  }
  const std = Math.sqrt(out.reduce((s, x) => s + x * x, 0) / n) || 1;
  for (let i = 0; i < n; i++) out[i]! /= std;
  return out;
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

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

function percentile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
}

const scale = (v: number, lo: number, hi: number) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
const round = (v: number, digits = 3) => Math.round(v * 10 ** digits) / 10 ** digits;

/** Iterative radix-2 complex FFT, in place. */
class Fft {
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

  constructor(private readonly n: number) {
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
  }

  transform(re: Float64Array, im: Float64Array) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i]!;
      if (j > i) {
        [re[i], re[j]] = [re[j]!, re[i]!];
        [im[i], im[j]] = [im[j]!, im[i]!];
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step]!;
          const wi = this.sin[k * step]!;
          const a = start + k;
          const b = a + half;
          const tr = re[b]! * wr - im[b]! * wi;
          const ti = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - tr;
          im[b] = im[a]! - ti;
          re[a]! += tr;
          im[a]! += ti;
        }
      }
    }
  }
}
