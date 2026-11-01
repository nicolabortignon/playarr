import { describe, expect, it } from 'vitest';
import { clickTrack, noise, song } from '../testSignals.ts';
import { RENDER_RATE, stretch, stretchStereo } from './stretch.ts';

const rate = RENDER_RATE;

function sine(hz: number, seconds: number): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));
}

function risingZeroCrossings(signal: Float32Array): number {
  let count = 0;
  for (let i = 1; i < signal.length; i++) if (signal[i - 1]! < 0 && signal[i]! >= 0) count++;
  return count;
}

/** Time of the first sample louder than `threshold` within ±20 ms of `around`, in seconds. */
function onsetNear(signal: Float32Array, around: number, threshold = 0.1): number | undefined {
  const from = Math.max(0, Math.round((around - 0.02) * rate));
  const to = Math.min(signal.length, Math.round((around + 0.02) * rate));
  for (let i = from; i < to; i++) if (Math.abs(signal[i]!) > threshold) return i / rate;
  return undefined;
}

/**
 * Where each kick of a click track lands in the stretched output against where it should, in
 * seconds. `outTimeOf` maps an input time to the output time the integral of the rate puts it at.
 * The onset is found by a level threshold a fixed distance into the kick's waveform; stretching
 * keeps the waveform, so that distance is measured on the input and carried over.
 */
function kickErrors(input: Float32Array, beats: number[], output: Float32Array, outTimeOf: (inSeconds: number) => number): number[] {
  const errors: number[] = [];
  for (const beat of beats) {
    const expected = outTimeOf(beat);
    if (expected < 0.05 || expected > output.length / rate - 0.05) continue;
    const intoWaveform = onsetNear(input, beat)! - beat;
    const found = onsetNear(output, expected + intoWaveform);
    expect(found, `kick for input beat ${beat.toFixed(3)} s`).toBeDefined();
    errors.push(found! - intoWaveform - expected);
  }
  return errors;
}

/**
 * How far (seconds) the 50 ms of input from 10 ms before `inAt` lands from output time `outAt`:
 * the lag within ±12 ms (just over the most a frame can move) where the output best matches it.
 */
function lagNear(input: Float32Array, inAt: number, output: Float32Array, outAt: number): number {
  const length = Math.round(0.05 * rate);
  const inStart = Math.round((inAt - 0.01) * rate);
  const outStart = Math.round((outAt - 0.01) * rate);
  const reach = Math.round(0.012 * rate);
  let best = -Infinity;
  let bestLag = 0;
  for (let lag = -reach; lag <= reach; lag++) {
    let cross = 0;
    let energy = 0;
    for (let i = 0; i < length; i++) {
      const o = output[outStart + lag + i]!;
      cross += input[inStart + i]! * o;
      energy += o * o;
    }
    const score = cross / Math.sqrt(energy + 1e-12);
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  return bestLag / rate;
}

function maxAbs(values: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i < values.length; i++) max = Math.max(max, Math.abs(values[i]!));
  return max;
}

describe('stretch', () => {
  it('keeps the pitch of a sine slowed to 0.95 and returns exactly the length asked for', () => {
    const input = sine(440, 12);
    const outSamples = 10 * rate + 37;
    const output = stretch(input, () => 0.95, outSamples, rate);
    expect(output.length).toBe(outSamples);
    const hz = risingZeroCrossings(output) / (outSamples / rate);
    expect(Math.abs(hz - 440) / 440).toBeLessThanOrEqual(0.01); // measured 439.96 Hz
  });

  it('plays a 120 BPM click track at 1.05 with kicks every 0.5 / 1.05 s', () => {
    const { samples, beats } = clickTrack({ bpm: 120, seconds: 23, rate });
    const output = stretch(samples, () => 1.05, 20 * rate, rate);
    const errors = kickErrors(samples, beats, output, (t) => t / 1.05);
    expect(errors.length).toBeGreaterThanOrEqual(38);
    const intervals = beats.slice(1).map((b, i) => b - beats[i]!);
    expect(maxAbs(intervals.map((d) => d - 0.5))).toBeLessThan(1e-9);
    expect(maxAbs(errors)).toBeLessThanOrEqual(0.002); // measured 0.77 ms
  });

  it('follows a rate ramp from 1.04 down to 1.0: kicks land where the integral of the rate says', () => {
    const seconds = 20;
    const { samples, beats } = clickTrack({ bpm: 120, seconds: 23, rate });
    const rampRate = (t: number) => 1.04 - (0.04 * Math.min(t, seconds)) / seconds;
    const output = stretch(samples, rampRate, seconds * rate, rate);
    // ∫₀ᵗ rate = 1.04 t − 0.001 t², solved for t.
    const errors = kickErrors(samples, beats, output, (b) => (1.04 - Math.sqrt(1.04 ** 2 - 0.004 * b)) / 0.002);
    expect(maxAbs(errors)).toBeLessThanOrEqual(0.003); // measured 0.58 ms
  });

  it('keeps the beat on the tempo curve under a dense mix, where nothing but the natural continuation matches well', () => {
    const { samples, beats } = song({ bpm: 120, rate, introBeats: 0, bodyBeats: 48, outroBeats: 0, startDense: true });
    const hiss = noise(30, rate, 3);
    const input = samples.map((v, i) => v + 0.1 * hiss[i]!);
    for (const speed of [1.05, 0.95]) {
      const output = stretch(input, () => speed, 20 * rate, rate);
      const lags = beats.filter((b) => b / speed > 0.2 && b / speed < 19.5).map((b) => lagNear(input, b, output, b / speed));
      const errors = lags.map(Math.abs).sort((a, b) => a - b);
      const meanError = errors.reduce((s, e) => s + e, 0) / errors.length;
      const bias = lags.reduce((s, e) => s + e, 0) / lags.length;
      const p90 = errors[Math.floor(0.9 * errors.length)]!;
      // Measured at 1.05 / 0.95: mean error 1.0 / 1.6 ms, 90% within 1.7 / 2.8 ms, bias −0.3 / +0.5 ms.
      expect(meanError).toBeLessThanOrEqual(0.0025);
      expect(p90).toBeLessThanOrEqual(0.0045);
      expect(Math.abs(bias)).toBeLessThanOrEqual(0.0007);
    }
  });

  it('is the input itself at rate 1', () => {
    const { samples } = song({ bpm: 124, rate, introBeats: 16, bodyBeats: 16, outroBeats: 8 });
    const offset = 12345;
    const outSamples = 8 * rate + 99;
    const output = stretch(samples, () => 1, outSamples, rate, offset);
    expect(maxAbs(output.map((v, i) => v - samples[offset + i]!))).toBeLessThanOrEqual(1e-6);
  });

  it('is the input itself at rate 1 at other sample rates too', () => {
    const input = noise(3, 48000, 5);
    const output = stretch(input, () => 1, 2 * 48000, 48000, 777);
    expect(maxAbs(output.map((v, i) => v - input[777 + i]!))).toBeLessThanOrEqual(1e-6);
  });

  it('settles back onto the original audio once an ease-back reaches rate 1', () => {
    // How B ends a transition: faster, easing back to its own tempo, then normal playback resumes
    // where the integral says. The tail at rate 1 must be the original samples, so the join is seamless.
    const { samples } = song({ bpm: 124, rate, introBeats: 16, bodyBeats: 32, outroBeats: 8 });
    const ease = (t: number) => (t < 2 ? 1.04 : t < 6 ? 1.04 - (0.04 * (t - 2)) / 4 : 1);
    const outSeconds = 10;
    const output = stretch(samples, ease, outSeconds * rate, rate);
    const consumed = 1.04 * 2 + 1.02 * 4 + 1 * (outSeconds - 6); // input seconds at the end
    const endInInput = Math.round(consumed * rate);
    const lastSecond = rate;
    let worst = 0;
    for (let i = 1; i <= lastSecond; i++) worst = Math.max(worst, Math.abs(output[output.length - i]! - samples[endInInput - i]!));
    expect(worst).toBeLessThanOrEqual(1e-6);
  });

  it('starts from startOffset at any rate', () => {
    const { samples, beats } = clickTrack({ bpm: 120, seconds: 25, rate });
    const offset = Math.round(3.3 * rate);
    const output = stretch(samples, () => 0.97, 15 * rate, rate, offset);
    const errors = kickErrors(samples, beats, output, (t) => (t - offset / rate) / 0.97);
    expect(errors.length).toBeGreaterThanOrEqual(25);
    expect(maxAbs(errors)).toBeLessThanOrEqual(0.002);
  });

  it('plays silence before the input when startOffset is negative', () => {
    const input = noise(2, rate, 9);
    const lead = 3000;
    const output = stretch(input, () => 1, rate, rate, -lead);
    expect(maxAbs(output.subarray(0, lead))).toBe(0);
    expect(maxAbs(output.subarray(lead).map((v, i) => v - input[i]!))).toBeLessThanOrEqual(1e-6);
  });

  it('refuses a rate that isn’t a finite positive number', () => {
    const input = new Float32Array(rate);
    expect(() => stretch(input, () => 0, rate / 2, rate)).toThrow(RangeError);
    expect(() => stretch(input, (t) => (t > 0.2 ? NaN : 1), rate / 2, rate)).toThrow(RangeError);
    expect(() => stretch(input, () => -1, rate / 2, rate)).toThrow(RangeError);
  });

  it('pads with silence past the end of the input instead of failing', () => {
    const output = stretch(sine(440, 1), () => 1.05, 2 * rate, rate);
    expect(output.length).toBe(2 * rate);
    expect(output.every(Number.isFinite)).toBe(true);
    expect(maxAbs(output.subarray(Math.round(1.1 * rate)))).toBe(0);
  });
});

describe('stretchStereo', () => {
  it('splices both channels at the same places: a panned signal stays exactly panned', () => {
    const { samples } = song({ bpm: 126, rate, introBeats: 8, bodyBeats: 16, outroBeats: 8 });
    const right = samples.map((v) => 0.4 * v);
    const out = stretchStereo(samples, right, () => 1.05, 10 * rate, rate);
    expect(out.left.length).toBe(10 * rate);
    expect(out.right.length).toBe(10 * rate);
    expect(maxAbs(out.right.map((v, i) => v - 0.4 * out.left[i]!))).toBeLessThanOrEqual(1e-6);
  });

  it('refuses channels of different lengths', () => {
    expect(() => stretchStereo(new Float32Array(100), new Float32Array(99), () => 1, 50, rate)).toThrow(RangeError);
  });

  it('keeps the correlation between channels that differ', () => {
    const { samples } = song({ bpm: 126, rate, introBeats: 8, bodyBeats: 16, outroBeats: 8 });
    const left = Float32Array.from(samples, (v, i) => v + 0.3 * hiss1[i % hiss1.length]!);
    const right = Float32Array.from(samples, (v, i) => 0.7 * v + 0.3 * hiss2[i % hiss2.length]!);
    const out = stretchStereo(left, right, () => 0.96, 10 * rate, rate);
    const before = correlation(left.subarray(0, 10 * rate), right.subarray(0, 10 * rate));
    const after = correlation(out.left, out.right); // measured 0.402 before, 0.407 after
    expect(Math.abs(after - before)).toBeLessThanOrEqual(0.05);
  });

  it('is fast enough for a NAS: 120 s of stereo', { timeout: 60000 }, () => {
    const { samples } = song({ bpm: 124, rate, introBeats: 32, bodyBeats: 160, outroBeats: 64 });
    const left = Float32Array.from(samples, (v, i) => v + 0.1 * hiss1[i % hiss1.length]!);
    const right = Float32Array.from(samples, (v, i) => v + 0.1 * hiss2[i % hiss2.length]!);
    const started = performance.now();
    const ramp = (t: number) => 1.05 - (0.05 * t) / 120;
    stretchStereo(left, right, ramp, 120 * rate, rate);
    const seconds = (performance.now() - started) / 1000;
    expect(seconds).toBeLessThan(30); // measured 0.5–1.2 s on a (busy) laptop
  });
});

const hiss1 = noise(3, rate, 7);
const hiss2 = noise(3, rate, 8);

function correlation(a: Float32Array, b: Float32Array): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i]! * b[i]!;
    aa += a[i]! ** 2;
    bb += b[i]! ** 2;
  }
  return ab / Math.sqrt(aa * bb);
}
