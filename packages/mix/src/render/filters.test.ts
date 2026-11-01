import { describe, expect, it } from 'vitest';
import { applyHighPass, applyLowShelf, FILTER_BLOCK } from './filters.ts';
import { RENDER_RATE } from './stretch.ts';

const rate = RENDER_RATE;

function sine(hz: number, seconds: number, amplitude = 0.5, sampleRate = rate): Float32Array {
  return Float32Array.from(
    { length: Math.round(seconds * sampleRate) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate),
  );
}

/** RMS level in dB of the steady part (after the filter's start-up transient has died away). */
function levelDb(signal: Float32Array, sampleRate: number): number {
  const from = Math.round(0.2 * sampleRate);
  let sum = 0;
  for (let i = from; i < signal.length; i++) sum += signal[i]! ** 2;
  return 10 * Math.log10(sum / (signal.length - from));
}

/** dB change a filter makes to a sine of `hz`. */
function gainAt(hz: number, filter: (channel: Float32Array, sampleRate: number) => void, sampleRate = rate): number {
  const input = sine(hz, 1, 0.5, sampleRate);
  const output = Float32Array.from(input);
  filter(output, sampleRate);
  return levelDb(output, sampleRate) - levelDb(input, sampleRate);
}

/** The largest jump between neighbouring samples: a click shows up as a step bigger than the music's own. */
function maxStep(signal: Float32Array): number {
  let max = 0;
  for (let i = 1; i < signal.length; i++) max = Math.max(max, Math.abs(signal[i]! - signal[i - 1]!));
  return max;
}

/** Samples a filter takes to fade in or out (mirrors filters.ts). */
const FADE = 4 * FILTER_BLOCK;

const peakOf = (signal: Float32Array) => signal.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

/** Bass plus a high tone, like a kick and hats: what a sweep or bass cut acts on. */
const music = Float32Array.from(sine(55, 3, 0.5), (v, i) => v + 0.1 * Math.sin((2 * Math.PI * 3000 * i) / rate));

describe('applyLowShelf', () => {
  const bassCut = (channel: Float32Array, sampleRate: number) => applyLowShelf(channel, () => -24, sampleRate);

  it('takes the bass out at −24 dB', () => {
    expect(gainAt(50, bassCut)).toBeLessThanOrEqual(-20); // measured −23.9 dB
  });

  it('leaves the mids alone', () => {
    expect(Math.abs(gainAt(2000, bassCut))).toBeLessThanOrEqual(0.5); // measured −0.02 dB
  });

  it('works the same at 48 kHz', () => {
    expect(gainAt(50, bassCut, 48000)).toBeLessThanOrEqual(-20);
    expect(Math.abs(gainAt(2000, bassCut, 48000))).toBeLessThanOrEqual(0.5);
  });

  it('passes the signal through untouched at 0 dB', () => {
    const input = sine(50, 0.5);
    const output = Float32Array.from(input);
    applyLowShelf(output, () => 0, rate);
    expect(output).toEqual(input);
  });

  it('asks for the gain once per block, with the block’s start time', () => {
    const asked: number[] = [];
    applyLowShelf(new Float32Array(FILTER_BLOCK * 3 + 5), (t) => (asked.push(t), -6), rate);
    expect(asked).toEqual([0, 1, 2, 3].map((b) => (b * FILTER_BLOCK) / rate));
  });

  it('cross-fades instead of clicking when the bass cut jumps on and off', () => {
    const output = Float32Array.from(music);
    applyLowShelf(output, (t) => (t >= 1 && t < 2 ? -24 : 0), rate);
    expect(maxStep(output)).toBeLessThanOrEqual(1.2 * maxStep(music));
  });

  it('is dry to the bit once it has faded out (a transition joins the untouched track there)', () => {
    const output = Float32Array.from(music);
    applyLowShelf(output, (t) => (t >= 1 && t < 2 ? -24 : 0), rate);
    const dry = 2 * rate + FILTER_BLOCK + FADE; // off from the first block at or after 2 s
    expect(output.subarray(dry)).toEqual(music.subarray(dry));
  });

  it('refuses a gain that isn’t a number', () => {
    expect(() => applyLowShelf(new Float32Array(1000), () => NaN, rate)).toThrow(RangeError);
  });
});

describe('applyHighPass', () => {
  const sweep = (channel: Float32Array, sampleRate: number) => applyHighPass(channel, () => 800, sampleRate);

  it('cuts well below the cutoff', () => {
    expect(gainAt(100, sweep)).toBeLessThanOrEqual(-15); // measured −36 dB
  });

  it('leaves well above the cutoff alone', () => {
    expect(Math.abs(gainAt(5000, sweep))).toBeLessThanOrEqual(1); // measured −0.002 dB
  });

  it('works the same at 48 kHz', () => {
    expect(gainAt(100, sweep, 48000)).toBeLessThanOrEqual(-15);
    expect(Math.abs(gainAt(5000, sweep, 48000))).toBeLessThanOrEqual(1);
  });

  it('is off at 20 Hz and below', () => {
    const input = sine(30, 0.5);
    const output = Float32Array.from(input);
    applyHighPass(output, () => 20, rate);
    expect(output).toEqual(input);
  });

  it('turns on and off without a click: the planner’s sweep, 20 Hz rising exponentially to 800 Hz, then off', () => {
    const output = Float32Array.from(music);
    applyHighPass(output, (t) => (t < 2 ? 20 * 40 ** (t / 2) : t < 2.5 ? 800 : 20), rate);
    expect(maxStep(output)).toBeLessThanOrEqual(1.2 * maxStep(music));
  });

  it('carries on exactly as if it had never stopped when it comes back after a short rest', () => {
    // At 30 Hz the filter remembers for a long time (a restart takes ~0.3 s to settle below 1e-6),
    // so only carrying the state through the rest makes the output bit-exact right after the fade.
    const cutoff = (t: number) => (t >= 1 && t < 1.03 ? 20 : 30);
    const resting = Float32Array.from(music);
    applyHighPass(resting, cutoff, rate);
    const alwaysOn = Float32Array.from(music);
    applyHighPass(alwaysOn, () => 30, rate);
    const settled = Math.round(1.05 * rate); // back on at 1.03 s, fade done 11.6 ms later
    expect(resting.subarray(settled)).toEqual(alwaysOn.subarray(settled));
  });

  it('matches an always-on filter to the bit once faded in after a long rest', () => {
    // The warm-up starts from zero WARM_UP samples back; by the end of the fade that start has died
    // away below a float's resolution even at 100 Hz, where a warm-up cut to 128 samples or skipped
    // still leaves 1e-5 (measured).
    for (const hz of [800, 100]) {
      const resting = Float32Array.from(music);
      applyHighPass(resting, (t) => (t >= 0.5 && t < 1.5 ? 20 : hz), rate);
      const alwaysOn = Float32Array.from(music);
      applyHighPass(alwaysOn, () => hz, rate);
      const settled = Math.round(1.52 * rate);
      expect(resting.subarray(settled)).toEqual(alwaysOn.subarray(settled));
    }
  });

  it('is dry to the bit once it has faded out', () => {
    const output = Float32Array.from(music);
    applyHighPass(output, (t) => (t >= 1 && t < 2 ? 800 : 20), rate);
    const dry = 2 * rate + FILTER_BLOCK + FADE; // off from the first block at or after 2 s
    expect(output.subarray(dry)).toEqual(music.subarray(dry));
  });

  it('refuses a cutoff that isn’t a number', () => {
    expect(() => applyHighPass(new Float32Array(1000), () => Infinity, rate)).toThrow(RangeError);
  });
});

describe('changing its mind mid-fade', () => {
  // A louder bass than `music`, so that jumping the fade instead of reversing it would show.
  const input = Float32Array.from(sine(55, 2, 0.6), (v, i) => v + 0.1 * Math.sin((2 * Math.PI * 3000 * i) / rate));
  const limit = 1.2 * maxStep(input);
  const blockOf = (t: number) => Math.round((t * rate) / FILTER_BLOCK);
  /** On for only `blocks` blocks from block 300: off again before the fade-in is done. */
  const onFor = (blocks: number) => (t: number) => blockOf(t) >= 300 && blockOf(t) < 300 + blocks;
  const cases = [
    // On from block 300 to 600, but neutral for blocks 400–401: back on with the fade-out half done.
    ['back on during the fade-out', (t: number) => onFor(300)(t) && !(blockOf(t) >= 400 && blockOf(t) < 402)],
    ['off again during the fade-in (on 1 block)', onFor(1)],
    ['off again during the fade-in (on 2 blocks)', onFor(2)],
  ] as const;

  for (const [name, on] of cases) {
    it(`the shelf doesn’t click when it turns ${name}`, () => {
      const output = Float32Array.from(input);
      applyLowShelf(output, (t) => (on(t) ? -24 : 0), rate);
      expect(maxStep(output)).toBeLessThanOrEqual(limit);
    });

    it(`the high-pass doesn’t click when it turns ${name}`, () => {
      const output = Float32Array.from(input);
      applyHighPass(output, (t) => (on(t) ? 800 : 20), rate);
      expect(maxStep(output)).toBeLessThanOrEqual(limit);
    });
  }
});

describe('parameter jumps between blocks', () => {
  const input = Float32Array.from(sine(60, 2, 0.6), (v, i) => v + 0.3 * Math.sin((2 * Math.PI * 3000 * i) / rate));
  const peak = peakOf(input);
  const block = FILTER_BLOCK / rate;

  function filtered(filter: (channel: Float32Array) => void): Float32Array {
    const output = Float32Array.from(input);
    filter(output);
    expect(output.every(Number.isFinite)).toBe(true);
    return output;
  }

  it('the shelf jumping between flat and −24 dB every few blocks stays bounded', () => {
    const output = filtered((c) => applyLowShelf(c, (t) => (Math.floor(t / block / 7) % 2 ? -24 : 0), rate));
    expect(peakOf(output)).toBeLessThanOrEqual(peak);
  });

  it('the high-pass jumping between off and 2 kHz every few blocks stays bounded', () => {
    const output = filtered((c) => applyHighPass(c, (t) => (Math.floor(t / block / 5) % 2 ? 2000 : 20), rate));
    expect(peakOf(output)).toBeLessThanOrEqual(peak);
  });

  it('the high-pass jumping across its whole range every block stays bounded', () => {
    const output = filtered((c) => applyHighPass(c, (t) => [20, 15000, 40, 800][Math.round(t / block) % 4]!, rate));
    expect(peakOf(output)).toBeLessThanOrEqual(peak);
  });

  it('a sudden drop of the cutoff (the case that bursts in direct form I) stays near the signal', () => {
    for (const [from, to] of [[2000, 40], [15000, 40], [800, 21]]) {
      const output = filtered((c) => applyHighPass(c, (t) => (t < 1 ? from! : to!), rate));
      expect(peakOf(output)).toBeLessThanOrEqual(1.15 * peak); // measured at most 1.06×
    }
  });
});
