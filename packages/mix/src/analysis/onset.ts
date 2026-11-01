// One pass of short FFT frames over a song, measuring what both the server's audio features and
// the mix analysis need: the onset envelope (where notes and drums start) plus per-frame loudness
// and bass energy. Doing it in one pass matters: an FFT over seven minutes of audio is most of the
// cost of analysing a song.

import { Fft, hann } from './fft.ts';

/** The rate songs are decoded at for analysis: plenty for beats and bass, and cheap. */
export const ANALYSIS_RATE = 11025;
/** Samples per FFT frame: ~93 ms at 11025 Hz, long enough to resolve the bass. */
export const ONSET_FRAME = 1024;
/** Samples between frame starts: ~23 ms at 11025 Hz, so ~43 frames per second. */
export const ONSET_HOP = 256;
/** Bins up to this frequency count as "low band": the kick drum and bass line. */
const LOW_BAND_HZ = 150;

/**
 * How far the onset envelope runs *ahead* of the frame index of the sound, in frames. Frame i
 * covers samples [i·HOP, i·HOP + FRAME), so a frame already "hears" a transient that is still
 * three quarters of a window ahead of its start, and the log-compressed flux jumps as soon as the
 * transient enters the window. A transient at time t therefore peaks in the envelope at frame
 * t·fps − ONSET_LATENCY_FRAMES (measured on click tracks, see onset.test.ts); to turn an envelope
 * position back into the time of the sound, add it: t = (frame + ONSET_LATENCY_FRAMES) / fps.
 */
export const ONSET_LATENCY_FRAMES = 2.85;
/**
 * The same lead for `beatOnset`, which peaks a little later than `onset`: the bass flux it adds
 * rises over more of the window, because a low note needs more of it to show in the spectrum.
 * Measured on click tracks and songs (see onset.test.ts); `beatGrid` applies it.
 */
export const BEAT_ONSET_LATENCY_FRAMES = 2.98;

export interface Onsets {
  /** Frames per second (rate / ONSET_HOP). */
  fps: number;
  /**
   * Spectral flux minus its local (1 s) average, half-wave rectified and normalized to unit RMS:
   * high where something starts. Frame i covers samples [i·HOP, i·HOP + FRAME).
   */
  onset: Float64Array;
  /**
   * The onset envelope with onsets in the bass (below ~150 Hz) counted again on top: what to find
   * the beat in. Log-compressed flux over the whole spectrum hears a soft off-beat hi-hat as loudly
   * as the kick, which can put a grid half a beat off or at double tempo; the beat people dance to
   * is mostly kick and bass.
   */
  beatOnset: Float64Array;
  /**
   * The onset envelope of the bass alone (below ~150 Hz), normalized to unit RMS: where kicks and
   * bass notes start. Tells a grid that skips every other kick (half tempo) from one that adds
   * off-beat hi-hats (double tempo).
   */
  lowOnset: Float64Array;
  /** Full-band RMS of each frame (time domain, unwindowed): its loudness. */
  rms: Float64Array;
  /** Spectral power of each frame at or below ~150 Hz: the kick and the bass. */
  lowEnergy: Float64Array;
  /** Total spectral power of each frame, so mid/high energy is `energy − lowEnergy`. */
  energy: Float64Array;
  /** Spectral centroid of each frame in Hz: how bright it sounds. */
  centroid: Float64Array;
}

/** Measures `samples` (mono, −1…1) frame by frame. Too-short input gives empty arrays. */
export function analyzeOnsets(samples: Float32Array, rate = ANALYSIS_RATE): Onsets {
  const fps = rate / ONSET_HOP;
  const frames = Math.max(0, Math.floor((samples.length - ONSET_FRAME) / ONSET_HOP) + 1);
  const bins = ONSET_FRAME / 2 + 1;
  const binHz = rate / ONSET_FRAME;
  const lowBin = Math.round(LOW_BAND_HZ / binHz);
  const window = hann(ONSET_FRAME);
  const fft = new Fft(ONSET_FRAME);
  const re = new Float64Array(ONSET_FRAME);
  const im = new Float64Array(ONSET_FRAME);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);

  const rms = new Float64Array(frames);
  const lowEnergy = new Float64Array(frames);
  const energy = new Float64Array(frames);
  const centroid = new Float64Array(frames);
  const flux = new Float64Array(frames);
  const lowFlux = new Float64Array(frames);

  for (let f = 0; f < frames; f++) {
    const offset = f * ONSET_HOP;
    let sumSq = 0;
    for (let i = 0; i < ONSET_FRAME; i++) {
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
    let lowRise = 0;
    for (let k = 0; k < bins; k++) {
      const p = re[k]! * re[k]! + im[k]! * im[k]!;
      const m = Math.sqrt(p);
      mags += m;
      weighted += m * k * binHz;
      power += p;
      if (k <= lowBin) lowPower += p;
      // Log-compressed spectral flux: onsets are where energy *rises* across the spectrum. The log
      // keeps a quiet hi-hat visible next to a loud kick.
      const lm = Math.log1p(100 * m);
      const d = lm - prev[k]!;
      if (d > 0) {
        rise += d;
        if (k <= lowBin) lowRise += d;
      }
      cur[k] = lm;
    }
    [prev, cur] = [cur, prev];
    rms[f] = Math.sqrt(sumSq / ONSET_FRAME);
    lowEnergy[f] = lowPower;
    energy[f] = power;
    centroid[f] = mags > 0 ? weighted / mags : 0;
    flux[f] = f === 0 ? 0 : rise;
    lowFlux[f] = f === 0 ? 0 : lowRise;
  }

  const onset = onsetEnvelope(flux, fps);
  const lowOnset = onsetEnvelope(lowFlux, fps);
  const beatOnset = onset.map((v, i) => v + lowOnset[i]!);
  return { fps, onset, beatOnset, lowOnset, rms, lowEnergy, energy, centroid };
}

/**
 * Spectral flux minus its local average (1 s), half-wave rectified and normalized. Subtracting the
 * local average keeps a loud chorus from looking like one long onset next to a quiet verse.
 */
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
