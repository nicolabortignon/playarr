import { describe, expect, it } from 'vitest';
import { applyHighPass, applyLowShelf, FILTER_BLOCK } from './biquad.ts';
import { RENDER_RATE } from './stretch.ts';

const rate = RENDER_RATE;

function sine(hz: number, seconds: number, amplitude = 0.5): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate));
}

/** RMS level in dB of the steady part (after the filter's start-up transient has died away). */
function levelDb(signal: Float32Array): number {
  const from = Math.round(0.2 * rate);
  let sum = 0;
  for (let i = from; i < signal.length; i++) sum += signal[i]! ** 2;
  return 10 * Math.log10(sum / (signal.length - from));
}

/** dB change a filter makes to a sine of `hz`. */
function gainAt(hz: number, filter: (channel: Float32Array) => void): number {
  const input = sine(hz, 1);
  const output = Float32Array.from(input);
  filter(output);
  return levelDb(output) - levelDb(input);
}

describe('applyLowShelf', () => {
  const bassCut = (channel: Float32Array) => applyLowShelf(channel, () => -24, rate);

  it('takes the bass out at −24 dB', () => {
    const gain = gainAt(50, bassCut);
    console.log(`low shelf −24 dB: 50 Hz ${gain.toFixed(2)} dB`);
    expect(gain).toBeLessThanOrEqual(-20);
  });

  it('leaves the mids alone', () => {
    const gain = gainAt(2000, bassCut);
    console.log(`low shelf −24 dB: 2 kHz ${gain.toFixed(3)} dB`);
    expect(Math.abs(gain)).toBeLessThanOrEqual(0.5);
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
});

describe('applyHighPass', () => {
  const sweep = (channel: Float32Array) => applyHighPass(channel, () => 800, rate);

  it('cuts well below the cutoff', () => {
    const gain = gainAt(100, sweep);
    console.log(`high-pass 800 Hz: 100 Hz ${gain.toFixed(2)} dB`);
    expect(gain).toBeLessThanOrEqual(-15);
  });

  it('leaves well above the cutoff alone', () => {
    const gain = gainAt(5000, sweep);
    console.log(`high-pass 800 Hz: 5 kHz ${gain.toFixed(3)} dB`);
    expect(Math.abs(gain)).toBeLessThanOrEqual(1);
  });

  it('is off at 20 Hz and below', () => {
    const input = sine(30, 0.5);
    const output = Float32Array.from(input);
    applyHighPass(output, () => 20, rate);
    expect(output).toEqual(input);
  });
});

describe('parameter jumps between blocks', () => {
  // Bass-heavy music-like signal: a loud low sine plus a quieter high one.
  const input = Float32Array.from(sine(60, 2, 0.6), (v, i) => v + 0.3 * Math.sin((2 * Math.PI * 3000 * i) / rate));
  const peak = input.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const block = FILTER_BLOCK / rate;

  function check(name: string, filter: (channel: Float32Array) => void) {
    const output = Float32Array.from(input);
    filter(output);
    const outPeak = output.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    console.log(`${name}: peak in ${peak.toFixed(3)}, out ${outPeak.toFixed(3)}`);
    expect(output.every(Number.isFinite)).toBe(true);
    expect(outPeak).toBeLessThanOrEqual(peak);
  }

  it('the shelf jumping between flat and −24 dB every few blocks stays bounded', () => {
    check('shelf jumps', (c) => applyLowShelf(c, (t) => (Math.floor(t / block / 7) % 2 ? -24 : 0), rate));
  });

  it('the high-pass jumping between off and 2 kHz every few blocks stays bounded', () => {
    check('high-pass jumps', (c) => applyHighPass(c, (t) => (Math.floor(t / block / 5) % 2 ? 2000 : 20), rate));
  });

  it('the high-pass jumping across its whole range every block stays bounded', () => {
    check('high-pass every block', (c) => applyHighPass(c, (t) => [20, 15000, 40, 800][Math.round(t / block) % 4]!, rate));
  });

  it('a sudden drop of the cutoff (the case that bursts in direct form I) stays near the signal', () => {
    for (const [from, to] of [[2000, 40], [15000, 40], [800, 21]]) {
      const output = Float32Array.from(input);
      applyHighPass(output, (t) => (t < 1 ? from! : to!), rate);
      const outPeak = output.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      console.log(`high-pass ${from} → ${to} Hz: peak in ${peak.toFixed(3)}, out ${outPeak.toFixed(3)}`);
      expect(outPeak).toBeLessThanOrEqual(1.15 * peak);
    }
  });
});
