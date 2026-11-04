import { describe, expect, it } from 'vitest';
import { oklchHue } from './color';

describe('oklchHue', () => {
  it('places sRGB colours on the OKLCH wheel the mix covers are drawn with', () => {
    expect(oklchHue(1, 0, 0)).toBeCloseTo(29.23, 2);
    expect(oklchHue(0, 1, 0)).toBeCloseTo(142.5, 1);
    expect(oklchHue(0, 0, 1)).toBeCloseTo(264.05, 2);
  });
});
