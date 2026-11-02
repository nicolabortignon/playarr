import { describe, expect, it } from 'vitest';
import { halveRate } from './resample.ts';

const RATE = 22050;
const tone = (hz: number, seconds = 1) => Float32Array.from({ length: Math.round(RATE * seconds) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / RATE));
/** RMS of the middle half (away from the edges). */
const rms = (x: Float32Array) => {
  const part = x.subarray(x.length >> 2, (3 * x.length) >> 2);
  return Math.sqrt(part.reduce((s, v) => s + v * v, 0) / part.length);
};

describe('halveRate', () => {
  it('keeps what lies below 4 kHz as it is, in time', () => {
    for (const hz of [60, 440, 2000, 4000]) {
      const out = halveRate(tone(hz));
      expect(rms(out) / rms(tone(hz))).toBeCloseTo(1, 2);
      // No delay: sample k is the input's sample 2k.
      const k = 5000;
      expect(out[k]).toBeCloseTo(Math.sin((2 * Math.PI * hz * 2 * k) / RATE), 2);
    }
  });

  it('removes what would fold back below the new Nyquist frequency', () => {
    for (const hz of [6500, 8000, 10000]) expect(rms(halveRate(tone(hz))) / rms(tone(hz))).toBeLessThan(0.01);
  });

  it('gives one sample for every two, rounding up', () => {
    expect(halveRate(new Float32Array(9)).length).toBe(5);
    expect(halveRate(new Float32Array(10)).length).toBe(5);
    expect(halveRate(new Float32Array(0)).length).toBe(0);
  });
});
