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
