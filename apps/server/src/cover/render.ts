import { hex } from './color.ts';
import type { Dna } from './dna.ts';
import { LAYOUTS, S, type Layout } from './layouts.ts';
import { makePalette, type Palette } from './palette.ts';
import { hash32, Rng } from './random.ts';
import { titleLayer } from './title.ts';

/** Bump when the artwork changes, so cached covers are redrawn. */
export const RENDER_VERSION = 2;

/**
 * Which visual language suits the playlist:
 * - currents: the default hero; flowing ribbons, most at home with legato, organic music
 * - colonies: eclectic mixes, styles as species carving out territories
 * - horizon: calm, beatless, organic (ambient, choral, folk)
 * - ridges: driving and bright (rock, metal, dance)
 * - grooves: the record; heavy, steady low end (hip hop, house) and the vinyl era
 * - blocks: a nod to mid-century sleeves, for older and varied playlists
 * A little seeded jitter decides close calls.
 */
export function chooseLayout(dna: Dna, rng: Rng): Layout {
  if (!dna.glyphs.length) return 'grooves';
  const r = rng.fork('layout');
  const calm = 1 - dna.intensity;
  const vintage = dna.era ? Math.min(1, Math.max(0, (1992 - dna.era.median) / 30)) : 0;
  const scores: [Layout, number][] = [
    ['currents', 0.55 + 0.2 * (1 - dna.busyness) + 0.1 * dna.organic],
    ['colonies', 0.15 + Math.max(0, dna.diversity - 0.3) * 1.4 + 0.15 * dna.dynamics],
    ['horizon', calm * (1 - dna.pulse) * 1.7 + dna.calm * 0.2 + dna.organic * 0.15],
    ['ridges', dna.pulse * 0.45 + (1 - dna.diversity) * 0.2 + dna.intensity * 0.25 + dna.brightness * 0.1 - 0.1],
    ['grooves', 0.4 + dna.bass * dna.pulse * 0.3 + vintage * 0.25],
    ['blocks', 0.15 + vintage * 0.35 + Math.max(0, dna.diversity - 0.4) * 0.6 + dna.busyness * 0.1],
  ];
  return scores.map(([l, s]): [Layout, number] => [l, s + r.range(-0.12, 0.12)]).sort((a, b) => b[1] - a[1])[0]![0];
}

export interface Art {
  layout: Layout;
  palette: Palette;
  /** SVG markup of the artwork itself (no background, title or grain). */
  body: string;
  defs: string[];
  seed: number;
}

/** The artwork: the expensive part, drawn once per (DNA, layout, variant) and cached. */
export async function drawArt(dna: Dna, layout?: Layout, variant = 0): Promise<Art> {
  // Variants re-roll every random choice while keeping the same music.
  const seed = variant ? hash32(`${dna.seed}:v${variant}`) : dna.seed;
  const rng = new Rng(seed);
  const chosen = layout ?? chooseLayout(dna, new Rng(dna.seed));
  const palette = makePalette(dna, rng);
  const defs: string[] = [];
  const body = await LAYOUTS[chosen]({ dna, pal: palette, rng: rng.fork(chosen), defs });
  return { layout: chosen, palette, body, defs, seed };
}

/** The finished cover: background, artwork, the (live) title, then print grain over everything. */
export function composeCover(art: Art, title?: string): string {
  const { palette: pal } = art;
  const speck = pal.dark ? 1 : 0;
  const grain = `<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="${art.seed % 1000}" stitchTiles="stitch"/><feColorMatrix type="matrix" values="0 0 0 0 ${speck} 0 0 0 0 ${speck} 0 0 0 0 ${speck} 3.2 0 0 0 -1.45"/></filter>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">`,
    `<defs>${art.defs.join('')}${grain}</defs>`,
    `<rect width="${S}" height="${S}" fill="${hex(pal.bg)}"/>`,
    art.body,
    title ? titleLayer(title, pal, art.layout) : '',
    `<rect width="${S}" height="${S}" filter="url(#grain)" opacity="${(Math.round(pal.grain * 100) / 100).toString()}"/>`,
    '</svg>',
  ].join('');
}

/** Art and composition in one go (for tests and previews). */
export async function renderCover(
  dna: Dna,
  layout?: Layout,
  opts: { variant?: number; title?: string } = {},
): Promise<{ svg: string; layout: Layout; palette: string }> {
  const art = await drawArt(dna, layout, opts.variant);
  return { svg: composeCover(art, opts.title), layout: art.layout, palette: art.palette.name };
}
