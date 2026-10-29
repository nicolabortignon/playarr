/** Colors are designed in OKLCH (perceptual lightness/chroma/hue) and written out as sRGB hex. */

export interface Lch {
  l: number; // 0–1
  c: number; // 0–~0.37
  h: number; // degrees
}

export const lch = (l: number, c: number, h: number): Lch => ({ l, c, h: ((h % 360) + 360) % 360 });

/** Hex, reducing chroma until the color fits in sRGB (keeps lightness and hue). */
export function hex({ l, c, h }: Lch): string {
  const rad = (h * Math.PI) / 180;
  for (let cc = c; cc > 0; cc -= 0.004) {
    const rgb = oklabToSrgb(l, cc * Math.cos(rad), cc * Math.sin(rad));
    if (rgb.every((v) => v >= -0.0005 && v <= 1.0005)) return toHex(rgb);
  }
  return toHex(oklabToSrgb(l, 0, 0));
}

/** Mix in OKLab, so blends stay clean (no muddy grey midpoints). */
export function mix(a: Lch, b: Lch, t: number): Lch {
  const [aa, ab] = [a.c * Math.cos((a.h * Math.PI) / 180), a.c * Math.sin((a.h * Math.PI) / 180)];
  const [ba, bb] = [b.c * Math.cos((b.h * Math.PI) / 180), b.c * Math.sin((b.h * Math.PI) / 180)];
  const l = a.l + (b.l - a.l) * t;
  const x = aa + (ba - aa) * t;
  const y = ab + (bb - ab) * t;
  return lch(l, Math.hypot(x, y), (Math.atan2(y, x) * 180) / Math.PI);
}

/** sRGB hex → OKLCH. */
export function fromHex(value: string): Lch {
  const n = Number.parseInt(value.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return lch(L, Math.hypot(A, B), (Math.atan2(B, A) * 180) / Math.PI);
}

function oklabToSrgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.sign(v) * Math.abs(v) ** (1 / 2.4) - 0.055)) as [
    number,
    number,
    number,
  ];
}

function toHex(rgb: number[]): string {
  return `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}
