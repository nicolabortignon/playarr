import { getAll } from 'chromotome';
import { FAMILIES, type StyleFamily } from '../analysis/styles.ts';
import { fromHex, hex, lch, mix, type Lch } from './color.ts';
import type { Dna } from './dna.ts';
import type { Rng } from './random.ts';

export interface Palette {
  /** Night background with light inks, or paper with dark ones. */
  dark: boolean;
  bg: Lch;
  /** Main line color: paper on dark, ink on light. */
  fg: Lch;
  /** One per style in the palette, strongest style first, then the palette's other colors. */
  inks: { family?: StyleFamily; color: Lch }[];
  accent: Lch;
  /** Deep near-black, for records and silhouettes. */
  deep: Lch;
  /** 0–1 strength of the print grain. */
  grain: number;
  /** Which curated palette this came from. */
  name: string;
  inkFor(family?: StyleFamily): Lch;
}

/** A curated palette from chromotome (Kjetil Golid et al., MIT), read as OKLCH. */
interface Candidate {
  name: string;
  bg: Lch;
  colors: Lch[];
  dark: boolean;
}

/**
 * Hand-picked palettes beat computed ones, so the playlist *chooses* a palette rather than
 * inventing one. Each palette is also offered inverted (its darkest ink as night, its paper
 * as line color), because most curated palettes are light.
 */
const CANDIDATES: Candidate[] = getAll().flatMap((p): Candidate[] => {
  if (!p.background || p.colors.length < 2) return [];
  const bg = fromHex(p.background);
  const colors = p.colors.map(fromHex);
  const out: Candidate[] = [{ name: p.name, bg, colors: colors.filter((c) => contrast(c, bg) > 0.12), dark: bg.l < 0.45 }];
  const darkest = [...colors].sort((a, b) => a.l - b.l)[0]!;
  if (bg.l >= 0.45 && darkest.l < 0.3) {
    const rest = [...colors.filter((c) => c !== darkest), bg].filter((c) => contrast(c, darkest) > 0.12);
    out.push({ name: `${p.name} (night)`, bg: darkest, colors: rest, dark: true });
  }
  return out.filter((c) => c.colors.length >= 2);
});

/**
 * The palette that fits the playlist best:
 * - paper vs night from calm, brightness and the styles' own feel
 * - hues close to the playlist's style hues (each family owns a hue)
 * - vividness close to its energy (muted for older eras)
 * - enough colors for its diversity, not many more
 */
export function makePalette(dna: Dna, rng: Rng): Palette {
  const r = rng.fork('palette');
  const inkCount = Math.min(4, 1 + Math.round(dna.diversity * 3));
  const top = dna.styles.slice(0, inkCount);
  const weightSum = top.reduce((s, t) => s + t.weight, 0) || 1;
  const familyLight = top.reduce((s, t) => s + t.weight * FAMILIES[t.family].light, 0) / weightSum;
  const lightness = 0.5 * (1 - dna.intensity) + 0.2 * dna.brightness + 0.15 * dna.calm + 0.25 * familyLight + r.range(-0.05, 0.05);
  const dark = lightness < 0.42;
  const vintage = dna.era ? clamp((1992 - dna.era.median) / 30) : 0;
  const targetChroma = (0.08 + 0.12 * dna.intensity) * (1 - 0.35 * vintage);
  const wanted = top.length ? top : [{ family: undefined, weight: 1 }];

  const scored = CANDIDATES.map((c) => {
    let hue = 0;
    for (const t of wanted) {
      const h = t.family ? FAMILIES[t.family].hue : r.fork('nohue').range(0, 360);
      const best = Math.max(...c.colors.map((col) => hueMatch(col, h)));
      hue += (t.weight / weightSum) * best;
    }
    const meanChroma = c.colors.reduce((s, col) => s + col.c, 0) / c.colors.length;
    const score =
      1.3 * hue -
      (c.dark === dark ? 0 : 1) -
      2.2 * Math.abs(meanChroma - targetChroma) -
      0.06 * Math.max(0, inkCount + 1 - c.colors.length) -
      0.03 * Math.max(0, c.colors.length - (inkCount + 3)) +
      r.fork(c.name).range(0, 0.06);
    return { c, score };
  }).sort((a, b) => b.score - a.score);
  const chosen = scored[0]!.c;

  // Older music: the same palette, a little faded and warmer.
  const age = (col: Lch) => lch(col.l, col.c * (1 - 0.25 * vintage), col.h + vintage * 0.15 * hueDistance(col.h, 70));
  const pool = chosen.colors.map(age);

  // Give each style the palette color nearest its hue; the rest stay available as extra inks.
  const inks: Palette['inks'] = [];
  const free = [...pool];
  for (const t of wanted) {
    const h = t.family ? FAMILIES[t.family].hue : undefined;
    const pick = h === undefined ? free[0] : [...free].sort((a, b) => hueMatch(b, h) - hueMatch(a, h))[0];
    if (!pick) break;
    inks.push({ family: t.family, color: pick });
    free.splice(free.indexOf(pick), 1);
  }
  for (const col of free) inks.push({ family: undefined, color: col });

  const byChroma = [...free].sort((a, b) => b.c - a.c);
  const accent = byChroma[0] ?? [...pool].sort((a, b) => Math.abs(hueDistance(b.h, inks[0]!.color.h)) - Math.abs(hueDistance(a.h, inks[0]!.color.h)))[0]!;
  const lightest = [...pool, chosen.bg].sort((a, b) => b.l - a.l)[0]!;
  const darkest = [...pool].sort((a, b) => a.l - b.l)[0]!;
  const fg = dark
    ? lightest.l > 0.8 ? lightest : lch(0.93, 0.02, 85)
    : darkest.l < 0.35 ? darkest : lch(0.23, 0.03, chosen.bg.h);

  return {
    dark,
    bg: chosen.bg,
    fg,
    inks,
    accent,
    deep: darkest.l < 0.3 ? mix(darkest, lch(0.1, 0, 0), 0.3) : lch(dark ? 0.1 : 0.17, 0.015, chosen.bg.h),
    grain: 0.05 + 0.13 * vintage + 0.05 * dna.organic,
    name: chosen.name,
    inkFor(family) {
      if (!family) return inks[0]!.color;
      const exact = inks.find((i) => i.family === family);
      if (exact) return exact.color;
      // Not one of the palette's styles: the ink closest in hue.
      const h = FAMILIES[family].hue;
      return [...inks].sort((a, b) => hueMatch(b.color, h) - hueMatch(a.color, h))[0]!.color;
    },
  };
}

export { hex };

/** 0–1: how well a color stands for a hue (greys stand for none). */
function hueMatch(col: Lch, hue: number): number {
  const closeness = (1 + Math.cos((hueDistance(col.h, hue) * Math.PI) / 180)) / 2;
  return closeness ** 3 * clamp(col.c / 0.08);
}

/** Signed shortest rotation from `from` to `to`, in degrees. */
function hueDistance(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

function contrast(a: Lch, b: Lch) {
  return Math.abs(a.l - b.l) + Math.min(0.15, Math.abs(a.c - b.c));
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
