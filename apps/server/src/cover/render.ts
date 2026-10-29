import { hex } from './color.ts';
import type { Dna } from './dna.ts';
import { LAYOUTS, S, type Layout } from './layouts.ts';
import { makePalette } from './palette.ts';
import { Rng } from './random.ts';

/** Bump when the artwork changes, so cached covers are redrawn. */
export const RENDER_VERSION = 1;

/**
 * Which visual language suits the playlist:
 * - horizon: calm, beatless, organic (ambient, choral, folk)
 * - ridges: driving and bright (rock, metal, dance)
 * - grooves: the record; heavy, steady low end (hip hop, house) and the vinyl era
 * - blocks: eclectic mixes, and a nod to mid-century jazz sleeves
 * A little seeded jitter decides close calls.
 */
export function chooseLayout(dna: Dna, rng: Rng): Layout {
  if (!dna.glyphs.length) return 'grooves';
  const r = rng.fork('layout');
  const calm = 1 - dna.intensity;
  const vintage = dna.era ? Math.min(1, Math.max(0, (1992 - dna.era.median) / 30)) : 0;
  const scores: [Layout, number][] = [
    ['horizon', calm * (1 - dna.pulse) * 1.7 + dna.calm * 0.2 + dna.organic * 0.15],
    ['ridges', dna.pulse * 0.45 + (1 - dna.diversity) * 0.2 + dna.intensity * 0.25 + dna.brightness * 0.1],
    ['grooves', 0.5 + dna.bass * dna.pulse * 0.3 + vintage * 0.15],
    ['blocks', Math.max(0, dna.diversity - 0.3) * 1.5 + dna.busyness * 0.1 + vintage * 0.1],
  ];
  return scores.map(([l, s]): [Layout, number] => [l, s + r.range(-0.12, 0.12)]).sort((a, b) => b[1] - a[1])[0]![0];
}

export function renderCover(dna: Dna, layout?: Layout): { svg: string; layout: Layout } {
  const rng = new Rng(dna.seed);
  const chosen = layout ?? chooseLayout(dna, rng);
  const pal = makePalette(dna, rng);
  const defs: string[] = [];
  const body = LAYOUTS[chosen]({ dna, pal, rng: rng.fork(chosen), defs });

  // Print grain: specks of ink on paper, or of paper on night.
  const speck = pal.dark ? 1 : 0;
  defs.push(
    `<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="${dna.seed % 1000}" stitchTiles="stitch"/><feColorMatrix type="matrix" values="0 0 0 0 ${speck} 0 0 0 0 ${speck} 0 0 0 0 ${speck} 3.2 0 0 0 -1.45"/></filter>`,
  );
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">`,
    `<defs>${defs.join('')}</defs>`,
    `<rect width="${S}" height="${S}" fill="${hex(pal.bg)}"/>`,
    body,
    `<rect width="${S}" height="${S}" filter="url(#grain)" opacity="${(Math.round(pal.grain * 100) / 100).toString()}"/>`,
    '</svg>',
  ].join('');
  return { svg, layout: chosen };
}
