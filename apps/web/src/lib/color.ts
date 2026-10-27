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
