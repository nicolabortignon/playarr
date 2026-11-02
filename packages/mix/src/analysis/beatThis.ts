// What the Beat This! beat tracker (Foscarin, Schlüter & Widmer, ISMIR 2024; github.com/CPJKU/beat_this,
// MIT) reads and what it answers. The model itself runs on the server (an ONNX file, see
// apps/server/src/analysis/beatModel.ts); this is its input, the log-mel spectrogram, computed exactly
// as its Python preprocessing does (torchaudio's MelSpectrogram), and the type of its answer.

import { Fft } from './fft.ts';

/** The model hears mono audio at this rate. */
export const BEAT_THIS_RATE = 22050;
/** Spectrogram frames (and answers) per second: a hop of 441 samples. */
export const BEAT_THIS_FPS = 50;
/** Mel bands per frame. */
export const BEAT_THIS_BANDS = 128;

const N_FFT = 1024;
const HOP = BEAT_THIS_RATE / BEAT_THIS_FPS;
const F_MIN = 30;
const F_MAX = 11000;
const LOG_MULTIPLIER = 1000;

/**
 * The model's answer for a stretch of song: per frame (1/50 s, frame f centred on f/50 s), how
 * likely a beat and a downbeat (the first beat of a bar) is there, as logits (0 = even odds).
 */
export interface BeatActivations {
  fps: number;
  beat: Float32Array;
  downbeat: Float32Array;
}

/**
 * The model's input: log(1 + 1000·mel) of each frame, frames × 128 bands, row by row. Frame f is
 * centred on sample f·441 (the signal is mirrored at both ends to fill the first and last frames), so
 * there are floor(n / 441) + 1 frames. Magnitudes are divided by √1024; mel filters follow the
 * Slaney scale from 30 Hz to 11 kHz without normalisation.
 */
export function beatThisSpectrogram(samples: Float32Array): Float32Array {
  const n = samples.length;
  if (n < 2) return new Float32Array(0);
  const frames = Math.floor(n / HOP) + 1;
  const half = N_FFT / 2;
  // Reflect padding, as torch.stft(center=True) does: sample -i is sample i.
  const at = (i: number) => samples[i < 0 ? Math.min(-i, n - 1) : i >= n ? Math.max(0, 2 * (n - 1) - i) : i]!;
  const window = periodicHann(N_FFT);
  // normalized="frame_length": torch.stft's normalisation, by the frame length's square root.
  const norm = Math.sqrt(N_FFT);
  const filters = melFilters();
  const fft = new Fft(N_FFT);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const magnitude = new Float64Array(half + 1);
  const out = new Float32Array(frames * BEAT_THIS_BANDS);
  for (let f = 0; f < frames; f++) {
    const start = f * HOP - half;
    for (let i = 0; i < N_FFT; i++) {
      re[i] = at(start + i) * window[i]!;
      im[i] = 0;
    }
    fft.transform(re, im);
    for (let k = 0; k <= half; k++) magnitude[k] = Math.hypot(re[k]!, im[k]!) / norm;
    for (let m = 0; m < BEAT_THIS_BANDS; m++) {
      const { from, weights } = filters[m]!;
      let sum = 0;
      for (let k = 0; k < weights.length; k++) sum += weights[k]! * magnitude[from + k]!;
      out[f * BEAT_THIS_BANDS + m] = Math.log1p(LOG_MULTIPLIER * sum);
    }
  }
  return out;
}

/** The Hann window torch.hann_window makes by default (periodic: as if one sample longer). */
function periodicHann(n: number): Float64Array {
  return Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
}

/**
 * Triangular filters evenly spaced on the Slaney mel scale between F_MIN and F_MAX, over the FFT's
 * bins (0 to the Nyquist frequency), as torchaudio's melscale_fbanks(norm=None, mel_scale='slaney').
 * Each keeps only its non-zero span.
 */
function melFilters(): { from: number; weights: Float64Array }[] {
  const bins = N_FFT / 2 + 1;
  const binHz = (k: number) => (k * Math.floor(BEAT_THIS_RATE / 2)) / (bins - 1);
  const low = hzToMel(F_MIN);
  const high = hzToMel(F_MAX);
  const edges = Array.from({ length: BEAT_THIS_BANDS + 2 }, (_, i) => melToHz(low + ((high - low) * i) / (BEAT_THIS_BANDS + 1)));
  return Array.from({ length: BEAT_THIS_BANDS }, (_, m) => {
    const [left, centre, right] = [edges[m]!, edges[m + 1]!, edges[m + 2]!];
    const all = Array.from({ length: bins }, (_, k) => Math.max(0, Math.min((binHz(k) - left) / (centre - left), (right - binHz(k)) / (right - centre))));
    const from = all.findIndex((w) => w > 0);
    const to = all.length - [...all].reverse().findIndex((w) => w > 0);
    return from < 0 ? { from: 0, weights: new Float64Array(0) } : { from, weights: Float64Array.from(all.slice(from, to)) };
  });
}

// The Slaney mel scale: linear below 1 kHz, logarithmic above.
const LINEAR_HZ_PER_MEL = 200 / 3;
const LOG_START_HZ = 1000;
const LOG_START_MEL = LOG_START_HZ / LINEAR_HZ_PER_MEL;
const LOG_STEP = Math.log(6.4) / 27;
const hzToMel = (hz: number) => (hz >= LOG_START_HZ ? LOG_START_MEL + Math.log(hz / LOG_START_HZ) / LOG_STEP : hz / LINEAR_HZ_PER_MEL);
const melToHz = (mel: number) => (mel >= LOG_START_MEL ? LOG_START_HZ * Math.exp(LOG_STEP * (mel - LOG_START_MEL)) : mel * LINEAR_HZ_PER_MEL);
