import { useEffect, useState } from 'react';
import { sized } from './api';

const cache = new Map<string, string | null>();

/**
 * Pick a vivid, legible accent color from an image (same-origin, so canvas is readable).
 * Buckets pixels by hue, weights by saturation, then clamps lightness for dark UI.
 */
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

  const buckets = Array.from({ length: 12 }, () => ({ w: 0, h: 0, s: 0, l: 0 }));
  for (let i = 0; i < data.length; i += 4) {
    const [h, s, l] = rgbToHsl(data[i]!, data[i + 1]!, data[i + 2]!);
    // Favor saturated mid-tones; ignore near-black/near-white pixels.
    const weight = s * s * (1 - Math.abs(l - 0.5) * 2) + 0.001;
    if (l < 0.08 || l > 0.95) continue;
    const b = buckets[Math.floor(h * 12) % 12]!;
    b.w += weight;
    b.h += h * weight;
    b.s += s * weight;
    b.l += l * weight;
  }
  const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
  if (best.w < 0.5) {
    cache.set(url, null);
    return null;
  }
  const h = best.h / best.w;
  const s = Math.min(0.9, Math.max(0.45, best.s / best.w));
  const l = Math.min(0.68, Math.max(0.56, best.l / best.w));
  const color = `hsl(${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
  cache.set(url, color);
  return color;
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
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const k = (n: number) => (n + Number(m[1]) / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return oklchHue(f(0), f(8), f(4));
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
