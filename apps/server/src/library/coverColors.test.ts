import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { dominantColor, extractAccent, luminance, readCoverColors } from './coverColors.ts';

/** A square cover of one color, as a PNG. */
const solid = (color: string, size = 300) => sharp({ create: { width: size, height: size, channels: 3, background: color } }).png().toBuffer();

/** 32×32 RGB pixels: `count` of `color`, the rest `rest` (as iOS's AccentColorTests make them). */
type Rgb = [number, number, number];
const pixels = (color: Rgb, count = 1024, rest: Rgb = [0, 0, 0]) =>
  Uint8Array.from({ length: 1024 * 3 }, (_, i) => (Math.floor(i / 3) < count ? color : rest)[i % 3]!);

/** sRGB channels 0–1 of `#rrggbb`. */
const channels = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;

describe('readCoverColors', () => {
  it('lifts a saturated blue cover’s accent until it’s legible, as the web does', async () => {
    const colors = await readCoverColors(await solid('#0000ff'));
    // Blue at the web's 56 % lightness has a luminance of 0.09: lifted to 70 %, hsl(240 90% 70%).
    expect(colors).toEqual({ color: '#0000ff', accent: '#6e6ef7' });
    expect(luminance(channels(colors.accent!))).toBeGreaterThanOrEqual(0.2);
  });

  it('gives a gray cover its color and no accent', async () => {
    // One channel, as black-and-white JPEGs often are.
    const gray = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#808080' } }).toColorspace('b-w').jpeg().toBuffer();
    expect(await readCoverColors(gray)).toEqual({ color: '#808080' });
  });

  it('reads a mostly black cover with a red patch as dark, with a red accent', async () => {
    const patch = await solid('#ff0000', 64);
    const cover = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#000000' } })
      .composite([{ input: patch, top: 96, left: 96 }])
      .jpeg({ quality: 95 })
      .toBuffer();
    const colors = await readCoverColors(cover);
    expect(luminance(channels(colors.color))).toBeLessThan(0.005);
    // Pure red is hsl(0 90% 56%) on the web: saturation clamped, light enough to read.
    expect(colors.accent).toBe('#f42a2a');
  });

  it('crops a wide picture square, as the art routes crop covers', async () => {
    const red = await solid('#ff0000', 100);
    const wide = await sharp({ create: { width: 300, height: 100, channels: 3, background: '#0000ff' } })
      .composite([
        { input: red, left: 0, top: 0 },
        { input: red, left: 200, top: 0 },
      ])
      .png()
      .toBuffer();
    const colors = await readCoverColors(wide);
    // The resize blends a sliver of the red beside the square into its edges.
    channels(colors.color).forEach((c, i) => expect(c).toBeCloseTo([0, 0, 1][i]!, 1));
    expect(colors.accent).toBe('#6e6ef7');
  });

  it('reads a transparent picture’s clear parts as black', async () => {
    const clear = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    expect(await readCoverColors(clear)).toEqual({ color: '#000000' });
  });

  it('fails on what isn’t an image', async () => {
    await expect(readCoverColors(Buffer.from('not an image'))).rejects.toThrow();
  });
});

describe('extractAccent', () => {
  // The cases of iOS's AccentColorTests, which follow the web.
  it('clamps a vivid color for the dark app', () => {
    expect(extractAccent(pixels([255, 0, 0]))).toBe('#f42a2a');
  });

  it('ignores near black and near white', () => {
    expect(extractAccent(pixels([0, 0, 0]))).toBeNull();
    expect(extractAccent(pixels([250, 250, 250]))).toBeNull();
  });

  it('lets the most colorful hue win over more gray', () => {
    // A quarter teal, the rest mid gray: hsl(180 90% 56%).
    expect(extractAccent(pixels([0, 160, 160], 256, [128, 128, 128]))).toBe('#2af4f4');
  });

  it('needs enough color to choose', () => {
    expect(extractAccent(pixels([10, 10, 60], 2))).toBeNull();
  });

  it('reads pixels with an alpha channel', () => {
    const rgba = Uint8Array.from({ length: 1024 * 4 }, (_, i) => [255, 0, 0, 255][i % 4]!);
    expect(extractAccent(rgba, 4)).toBe('#f42a2a');
  });
});

describe('dominantColor', () => {
  it('is the largest area of one color, not the most vivid', () => {
    expect(dominantColor(pixels([230, 20, 20], 384, [10, 10, 12]))).toBe('#0a0a0c');
  });

  it('keeps an area together across the edge of its boxes', () => {
    // Two near shades of gray either side of 32 make the largest area, though blue alone outnumbers each.
    const split = Uint8Array.from([...Array<Rgb>(300).fill([30, 30, 30]), ...Array<Rgb>(300).fill([34, 34, 34]), ...Array<Rgb>(424).fill([0, 0, 200])].flat());
    expect(dominantColor(split)).toBe('#202020');
  });
});
