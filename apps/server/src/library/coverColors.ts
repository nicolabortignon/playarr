import sharp from 'sharp';

/** An album cover's colors as `#rrggbb`: the API's `coverColor` and `coverAccent`. */
export interface CoverColors {
  /** What the cover reads as from afar, for the space it takes while it loads. */
  color: string;
  /** The vivid, legible accent it gives; absent when it has no color to give. */
  accent?: string;
}

/** Covers are read at 32×32, as the web draws them on a canvas. */
const SIDE = 32;

/**
 * An image's colors (JPEG, PNG, WebP…), read at 32×32 after cropping it square as the art routes crop covers (the web
 * reads its accent from those). Throws when the image can't be decoded.
 */
export async function readCoverColors(image: Buffer): Promise<CoverColors> {
  const { data, info } = await sharp(image, { failOn: 'none' })
    .resize(SIDE, SIDE, { fit: 'cover' })
    // Transparent parts read as black, as on iOS (which draws the cover with premultiplied alpha).
    .flatten({ background: '#000000' })
    .toColorspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const accent = extractAccent(data, info.channels);
  return { color: dominantColor(data, info.channels), ...(accent ? { accent } : {}) };
}

/**
 * The accent a cover gives, picked as apps/web/src/lib/color.ts `accentOf` picks it (keep the two in step; iOS's
 * AccentColor.swift is the same): pixels sorted into 12 hue buckets, weighted by saturation and mid-lightness, near
 * black, near white and gray left out; the heaviest bucket's average, its saturation clamped to 45–90 % and its
 * lightness to 56–68 %, then lightened until legible (`legibleLightness`). null when the cover has no color to give.
 */
export function extractAccent(pixels: Uint8Array, channels = 3): string | null {
  const buckets = Array.from({ length: 12 }, () => ({ w: 0, h: 0, s: 0, l: 0 }));
  for (let i = 0; i + 2 < pixels.length; i += channels) {
    const [h, s, l] = rgbToHsl(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
    // Favor saturated mid-tones; ignore near-black/near-white pixels.
    const weight = s * s * (1 - Math.abs(l - 0.5) * 2) + 0.001;
    if (l < 0.08 || l > 0.95) continue;
    // A gray pixel has no hue to vote for: rgbToHsl calls its hue 0 (red), and a gray cover's 1024 pixels would
    // outweigh the 0.5 asked for, giving it a dusty red accent.
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
  return hex(hslToRgb(h, s, l).map((c) => c * 255) as [number, number, number]);
}

/**
 * What a cover reads as from afar (the idea of Apple Music's artwork `bgColor`): its pixels sorted into boxes 32 levels
 * of red, green and blue wide, the box whose neighborhood (itself and the boxes around it) holds the most of them, and
 * the average of that neighborhood. The cover's largest area of one color, then, not its most vivid one.
 */
export function dominantColor(pixels: Uint8Array, channels = 3): string {
  const counts = new Uint32Array(512);
  const sums = new Float64Array(512 * 3);
  for (let i = 0; i + 2 < pixels.length; i += channels) {
    const box = ((pixels[i]! >> 5) << 6) | ((pixels[i + 1]! >> 5) << 3) | (pixels[i + 2]! >> 5);
    counts[box] = counts[box]! + 1;
    for (let c = 0; c < 3; c++) sums[box * 3 + c] = sums[box * 3 + c]! + pixels[i + c]!;
  }
  const around = (box: number) => {
    const out: number[] = [];
    const [r, g, b] = [box >> 6, (box >> 3) & 7, box & 7];
    for (let nr = Math.max(0, r - 1); nr <= Math.min(7, r + 1); nr++) {
      for (let ng = Math.max(0, g - 1); ng <= Math.min(7, g + 1); ng++) {
        for (let nb = Math.max(0, b - 1); nb <= Math.min(7, b + 1); nb++) out.push((nr << 6) | (ng << 3) | nb);
      }
    }
    return out;
  };
  let best = -1;
  let most = 0;
  for (let box = 0; box < 512; box++) {
    if (!counts[box]) continue;
    const n = around(box).reduce((sum, near) => sum + counts[near]!, 0);
    // Even neighborhoods: the box with more of its own.
    if (n > most || (n === most && counts[box]! > counts[best]!)) [best, most] = [box, n];
  }
  if (best < 0) return '#000000';
  const rgb: [number, number, number] = [0, 0, 0];
  for (const near of around(best)) for (let c = 0; c < 3; c++) rgb[c] = rgb[c]! + sums[near * 3 + c]!;
  return hex(rgb.map((sum) => sum / most) as [number, number, number]);
}

/**
 * The accent's ink is near black, and the accent is also text on the near-black page: below a relative luminance of
 * 0.2 (blues, purples, deep reds) one of the two falls under 4.5:1, so the lightness (percent) goes up a percent at a
 * time until it's there. As the web's `legibleLightness` and iOS's `AccentColor.legible`.
 */
export function legibleLightness(hue: number, saturation: number, lightness: number): number {
  let l = lightness;
  while (luminance(hslToRgb(hue, saturation, l)) < 0.2 && l < 95) l++;
  return l;
}

/** Relative luminance (WCAG) of sRGB channels 0–1: 0 for black, 1 for white. */
export function luminance([r, g, b]: [number, number, number]): number {
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
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

/** Hue (0–1), saturation and lightness of an 8-bit color. */
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

/** `#rrggbb` of 8-bit channels (rounded, kept to 0–255). */
function hex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;
}
