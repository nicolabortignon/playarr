import { describe, expect, it } from 'vitest';
import { accentOf, legibleLightness, oklchHue } from './color';

/** A 32×32 cover's RGBA pixels: `count` of them in `color`, the rest in `rest`. */
const pixels = (color: [number, number, number], count = 1024, rest: [number, number, number] = [0, 0, 0]) =>
  Array.from({ length: 1024 }, (_, i) => [...(i < count ? color : rest), 255]).flat();

describe('accentOf', () => {
  it('gives a blue cover its blue, lightened until it can be read', () => {
    expect(accentOf(pixels([0, 0, 255]))).toBe('hsl(240 90% 70%)');
  });

  it('gives a gray cover no accent, rather than a dusty red', () => {
    expect(accentOf(pixels([128, 128, 128]))).toBeNull();
  });

  it('lets a quarter of color win over gray', () => {
    expect(accentOf(pixels([0, 160, 160], 256, [128, 128, 128]))).toBe('hsl(180 90% 56%)');
  });
});

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
