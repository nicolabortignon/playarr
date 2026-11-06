import { useEffect, useState } from 'react';
import { sized } from './api';

const cache = new Map<string, string | null>();

/** Pick a vivid, legible accent color from an image (same-origin, so canvas is readable), as `accentOf` picks it. */
export async function extractAccent(url: string): Promise<string | null> {
  if (cache.has(url)) return cache.get(url)!;
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch {
    cache.set(url, null);
    return null;
  }

  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const color = accentOf(data);
  cache.set(url, color);
  return color;
}

/**
 * The accent of a cover's RGBA pixels (drawn at 32×32), as `hsl(h s% l%)`; null when it has no color to give. Buckets
 * pixels by hue, weights by saturation, then clamps lightness for dark UI, raising it where the color is too dark to
 * read (`legibleLightness`). The server picks albums' `coverAccent` the same way
 * (apps/server/src/library/coverColors.ts), and iOS its accent (AccentColor.swift): keep the three in step.
 */
export function accentOf(data: ArrayLike<number>): string | null {
  const buckets = Array.from({ length: 12 }, () => ({ w: 0, h: 0, s: 0, l: 0 }));
  for (let i = 0; i + 2 < data.length; i += 4) {
    const [h, s, l] = rgbToHsl(data[i]!, data[i + 1]!, data[i + 2]!);
    // Favor saturated mid-tones; ignore near-black/near-white pixels.
    const weight = s * s * (1 - Math.abs(l - 0.5) * 2) + 0.001;
    if (l < 0.08 || l > 0.95) continue;
    // A gray pixel has no hue to vote for (rgbToHsl calls it red), or a gray cover would get a dusty red accent.
    if (s === 0) continue;
    const b = buckets[Math.floor(h * 12) % 12]!;
    b.w += weight;
    b.h += h * weight;
    b.s += s * weight;
    b.l += l * weight;
  }
  const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
  if (best.w < 0.5) return null;
  const h = Math.round((best.h / best.w) * 360);
  const s = Math.round(Math.min(0.9, Math.max(0.45, best.s / best.w)) * 100);
  const l = legibleLightness(h, s, Math.round(Math.min(0.68, Math.max(0.56, best.l / best.w)) * 100));
  return `hsl(${h} ${s}% ${l}%)`;
}

/** The OKLCH hue (degrees) of the accent a cover gives, read once per cover; null when it has no colour to give. */
export async function accentHue(url: string): Promise<number | null> {
  const color = await extractAccent(url);
  return color ? hslHue(color) : null;
}

/** `accentHue` when the cover has been read already, without waiting; undefined when it hasn't. */
export function knownAccentHue(url: string): number | null | undefined {
  if (!cache.has(url)) return undefined;
  const color = cache.get(url);
  return color ? hslHue(color) : null;
}

/** The OKLCH hue of one of `extractAccent`'s `hsl(h s% l%)` colours. */
function hslHue(color: string): number | null {
  const m = color.match(/^hsl\((\d+) (\d+)% (\d+)%\)$/);
  if (!m) return null;
  return oklchHue(...hslToRgb(Number(m[1]), Number(m[2]), Number(m[3])));
}

/**
 * The accent's ink is near black, and the accent is also text on the near-black page: below a relative luminance of
 * 0.2 (blues, purples, deep reds) one of the two falls under 4.5:1, so the lightness (percent) goes up a percent at a
 * time until it's there. As iOS's `AccentColor.legible`.
 */
export function legibleLightness(hue: number, saturation: number, lightness: number): number {
  let l = lightness;
  while (luminance(hslToRgb(hue, saturation, l)) < 0.2 && l < 95) l++;
  return l;
}

/** sRGB channels (0–1) of a hue in degrees, saturation and lightness in percent. */
function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

/** Relative luminance (WCAG) of sRGB channels 0–1: 0 for black, 1 for white. */
export function luminance([r, g, b]: [number, number, number]): number {
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** The OKLCH hue (degrees) of an sRGB colour, channels 0–1. */
export function oklchHue(r: number, g: number, b: number): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return ((Math.atan2(Bb, A) * 180) / Math.PI + 360) % 360;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}


/** Accent color for a specific cover (e.g. an album page header), independent of what's playing. */
export function useCoverAccent(coverUrl: string | undefined): string | null {
  const [color, setColor] = useState<string | null>(null);
  useEffect(() => {
    if (!coverUrl) return setColor(null);
    let cancelled = false;
    void extractAccent(sized(coverUrl, 96)!).then((c) => !cancelled && setColor(c));
    return () => {
      cancelled = true;
    };
  }, [coverUrl]);
  return color;
}
