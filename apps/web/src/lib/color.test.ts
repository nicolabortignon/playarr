import { describe, expect, it } from 'vitest';
import { legibleLightness, oklchHue } from './color';

describe('oklchHue', () => {
  it('places sRGB colours on the OKLCH wheel the mix covers are drawn with', () => {
    expect(oklchHue(1, 0, 0)).toBeCloseTo(29.23, 2);
    expect(oklchHue(0, 1, 0)).toBeCloseTo(142.5, 1);
    expect(oklchHue(0, 0, 1)).toBeCloseTo(264.05, 2);
  });
});

describe('legibleLightness', () => {
  it('keeps a color light enough to read as it is', () => {
    expect(legibleLightness(0, 90, 56)).toBe(56);
  });

  it('lifts a color too dark to read until near-black ink on it, and it on near black, clear 4.5:1', () => {
    // Pure blue at 56 % is a luminance of 0.09; at 70 % it's 0.2, as iOS lifts it.
    expect(legibleLightness(240, 90, 56)).toBe(70);
  });
});
