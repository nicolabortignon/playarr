import { FAMILIES, type StyleFamily } from '../analysis/styles.ts';
import { hex, lch, mix, type Lch } from './color.ts';
import type { Dna } from './dna.ts';
import type { Rng } from './random.ts';

export interface Palette {
  /** Night background with light inks, or paper with dark ones. */
  dark: boolean;
  bg: Lch;
  /** Main line color: paper on dark, ink on light. */
  fg: Lch;
  /** One per style in the palette, strongest style first. */
  inks: { family?: StyleFamily; color: Lch }[];
  accent: Lch;
  /** Deep near-black, for records and silhouettes. */
  deep: Lch;
  /** 0–1 strength of the print grain. */
  grain: number;
  inkFor(family?: StyleFamily): Lch;
}

/**
 * Colors from the playlist's character:
 * - hue from its styles (each family owns a hue), as many inks as it has distinct styles
 * - chroma from energy; light paper vs night from calm, brightness and the styles' own feel
 * - era: older music is warmer, more faded, and grainier, like old print
 */
export function makePalette(dna: Dna, rng: Rng): Palette {
  const r = rng.fork('palette');
  const inkCount = Math.min(4, 1 + Math.round(dna.diversity * 3));
  const top = dna.styles.slice(0, inkCount);
  const hueOf = (family?: StyleFamily) => (family ? FAMILIES[family].hue : r.fork('nohue').range(0, 360));
  const dominant = hueOf(top[0]?.family);

  const vintage = dna.era ? clamp((1992 - dna.era.median) / 30) : 0;
  const modern = dna.era ? clamp((dna.era.median - 2005) / 15) : 0.3;
  // Old music drifts toward warm amber, like aged paper and faded inks.
  const age = (h: number) => h + dna.warmth * 12 + vintage * 0.25 * hueDistance(h, 70);

  const familyLight = top.reduce((s, t) => s + t.weight * FAMILIES[t.family].light, 0) / (top.reduce((s, t) => s + t.weight, 0) || 1);
  const lightness = 0.5 * (1 - dna.intensity) + 0.2 * dna.brightness + 0.15 * dna.calm + 0.25 * familyLight + r.range(-0.05, 0.05);
  const dark = lightness < 0.42;

  const chroma = (0.075 + 0.13 * dna.intensity + 0.03 * modern) * (1 - 0.35 * vintage);
  const bg = dark
    ? lch(0.17 + 0.05 * dna.brightness, 0.035 * (1 - 0.5 * vintage), age(dominant + r.range(-10, 10)))
    : mix(lch(0.945 - 0.035 * vintage, 0.012 + 0.03 * vintage, 82), lch(0.93, 0.03, dominant), 0.18);
  const fg = dark ? lch(0.93, 0.02, 85) : lch(0.23, 0.035, age(dominant));
  const inkL = dark ? 0.75 : 0.57;

  const inks: Palette['inks'] = top.length
    ? top.map((t, i) => ({
        family: t.family,
        color: lch(inkL + (i % 2 ? -0.06 : 0), chroma * (i ? 0.92 : 1), age(hueOf(t.family) + r.fork(`ink${i}`).range(-8, 8))),
      }))
    : [{ family: undefined, color: lch(inkL, chroma, age(dominant)) }];
  // One style only: add a tonal partner so there's still depth.
  if (inks.length === 1) {
    const c = inks[0]!.color;
    inks.push({ family: inks[0]!.family, color: lch(c.l + (dark ? -0.2 : 0.18), c.c * 0.75, c.h + 6) });
  }

  // Accent: the complement when the palette is all one hue, else the second style, pushed.
  const accent =
    top.length >= 2
      ? lch(inkL + 0.04, Math.min(0.24, chroma * 1.35), inks[1]!.color.h)
      : lch(dark ? 0.78 : 0.62, Math.min(0.22, chroma * 1.4), age(dominant + 180 + r.range(-25, 25)));

  return {
    dark,
    bg,
    fg,
    inks,
    accent,
    deep: lch(dark ? 0.11 : 0.18, 0.015, dominant),
    grain: 0.05 + 0.13 * vintage + 0.05 * dna.organic,
    inkFor(family) {
      if (!family) return inks[0]!.color;
      const exact = inks.find((i) => i.family === family);
      if (exact) return exact.color;
      // Not one of the palette's styles: the ink closest in hue.
      const h = FAMILIES[family].hue;
      return [...inks].sort((a, b) => Math.abs(hueDistance(a.color.h, h)) - Math.abs(hueDistance(b.color.h, h)))[0]!.color;
    },
  };
}

export { hex };

/** Signed shortest rotation from `from` to `to`, in degrees. */
function hueDistance(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
