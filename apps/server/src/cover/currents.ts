/**
 * Currents: ribbons traced through a flow field and packed so they never touch (the
 * flow-field-with-collisions technique popularized by Tyler Hobbs; written from scratch here).
 *
 * The field is the playlist: a steady beat makes it laminar, free time makes it swirl, tempo
 * spread makes it uneven. Every ribbon belongs to one song: louder songs draw wider ribbons,
 * legato songs longer ones, staccato songs shorter strokes; ribbons take their song's style color.
 * Two finishes besides solid: steady-beat playlists may cut every ribbon into its song's beats;
 * organic or older ones may draw hollow tubes.
 */
import { hex } from './color.ts';
import type { Dna, Glyph } from './dna.ts';
import type { Palette } from './palette.ts';
import { perlin, type Rng } from './random.ts';

const S = 1000;

interface Point {
  x: number;
  y: number;
  r: number;
  curve: number;
}

export function currents({ dna, pal, rng }: { dna: Dna; pal: Palette; rng: Rng }): string {
  const noise = perlin(rng.fork('field'));
  const warp = perlin(rng.fork('warp'));
  const laminar = dna.pulse;
  const frequency = 0.0008 + 0.0022 * (1 - laminar) + 0.001 * dna.tempoSpread;
  const turbulence = Math.PI * (0.22 + 1.05 * (1 - laminar) ** 1.5 + 0.25 * dna.dynamics);
  const base = rng.range(0, Math.PI * 2);
  // Very steady, beat-driven playlists sometimes snap to 45° steps: geometric, stepped streams.
  const quantize = laminar > 0.7 && rng.fork('quantize').chance(0.35) ? Math.PI / 4 : 0;
  const angleAt = (x: number, y: number) => {
    const wx = x + 120 * warp(x * 0.0015, y * 0.0015);
    const a = base + turbulence * noise(wx * frequency, y * frequency);
    return quantize ? Math.round(a / quantize) * quantize : a;
  };

  const margin = rng.fork('margin').pick([0, 0, 55, 85]);
  const inside = (x: number, y: number) => x >= margin && x <= S - margin && y >= margin && y <= S - margin;
  const density = rng.fork('density').pick([0.7, 1, 1, 1.35, 1.8]);
  const songs = dna.glyphs.length ? dna.glyphs : [];
  const totalSeconds = songs.reduce((s, g) => s + g.seconds, 0) || 1;
  const pickSong = (r: Rng): Glyph | undefined => {
    let t = r.next() * totalSeconds;
    for (const g of songs) if ((t -= g.seconds) <= 0) return g;
    return songs[songs.length - 1];
  };

  const maxR = 40 * density;
  const cell = maxR * 2;
  const cols = Math.ceil(S / cell) + 1;
  const grid = new Map<number, Point[]>();
  const key = (x: number, y: number) => Math.floor(y / cell) * cols + Math.floor(x / cell);
  const gap = 3 + 4 * density;
  const collides = (x: number, y: number, r: number, curve: number) => {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const p of grid.get((cy + dy) * cols + cx + dx) ?? []) {
          if (p.curve !== curve && (p.x - x) ** 2 + (p.y - y) ** 2 < (p.r + r + gap) ** 2) return true;
        }
      }
    }
    return false;
  };

  // Seeds on jittered grids, each visited in random order: a coarse pass lays the long ribbons,
  // a fine pass fills what's left. Even, dense packing without early stubs blocking everything.
  const sr = rng.fork('seeds');
  const seeds: [number, number, number][] = [];
  for (const [pass_, spacing] of [70 * density, 16 * density].entries()) {
    const pass: [number, number, number][] = [];
    for (let y = margin; y < S - margin; y += spacing) {
      for (let x = margin; x < S - margin; x += spacing) pass.push([x + sr.range(0, spacing), y + sr.range(0, spacing), pass_]);
    }
    for (let i = pass.length - 1; i > 0; i--) {
      const j = Math.floor(sr.next() * (i + 1));
      [pass[i], pass[j]] = [pass[j]!, pass[i]!];
    }
    seeds.push(...pass);
  }

  const finishRng = rng.fork('finish');
  const finish =
    dna.pulse > 0.6 && finishRng.chance(0.45) ? 'beats' : dna.organic > 0.5 && finishRng.chance(0.45) ? 'tubes' : 'solid';
  const out: string[] = [];
  let curveId = 0;
  for (const [sx, sy, pass] of seeds) {
    const r = rng.fork(`curve${curveId}`);
    const song = pickSong(r);
    if (!song) break;
    // The fill pass uses thinner ribbons, so gaps close with fine lines: layered, multi-scale.
    const radius = Math.max(1.6, (3 + 15 * song.loudness) * density * r.range(0.75, 1.25) * (pass ? r.range(0.3, 0.65) : 1));
    if (!inside(sx, sy) || collides(sx, sy, radius, curveId)) continue;
    // Legato songs flow on; busy, staccato ones break into shorter strokes (never stubs).
    const legato = (1 - song.busyness) * (0.45 + 0.55 * song.pulse);
    const step = Math.max(3, radius * 0.5);
    const maxLength = Math.max(radius * 7, (130 + 470 * legato) * r.range(0.6, 1.3));
    const maxSteps = Math.round(maxLength / step);

    // Trace both ways from the seed.
    const trace = (dir: 1 | -1) => {
      const pts: [number, number][] = [];
      let x = sx;
      let y = sy;
      for (let s = 0; s < maxSteps / 2; s++) {
        const a = angleAt(x, y);
        x += Math.cos(a) * step * dir;
        y += Math.sin(a) * step * dir;
        if (!inside(x, y) || collides(x, y, radius, curveId)) break;
        pts.push([x, y]);
      }
      return pts;
    };
    const pts = [...trace(-1).reverse(), [sx, sy] as [number, number], ...trace(1)];
    if ((pts.length - 1) * step < radius * 2.5) continue;
    for (const [x, y] of pts) {
      const k = key(x, y);
      const list = grid.get(k) ?? [];
      list.push({ x, y, r: radius, curve: curveId });
      grid.set(k, list);
    }
    const roll = r.next();
    const color = roll < 0.05 ? pal.accent : roll < 0.25 ? r.pick(pal.inks).color : pal.inkFor(song.family);
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join('');
    const w = f(radius * 2);
    if (finish === 'beats') {
      // One segment per beat of the ribbon's own song.
      const beat = Math.max(radius * 1.2, 3600 / song.bpm);
      out.push(`<path d="${d}" stroke="${hex(color)}" stroke-width="${w}" stroke-linecap="butt" stroke-dasharray="${f(beat * 0.72)} ${f(beat * 0.28)}"/>`);
    } else if (finish === 'tubes' && radius > 4) {
      out.push(
        `<path d="${d}" stroke="${hex(color)}" stroke-width="${w}"/>`,
        `<path d="${d}" stroke="${hex(pal.bg)}" stroke-width="${f(radius * 2 - Math.max(3, radius * 0.45))}"/>`,
      );
    } else {
      out.push(`<path d="${d}" stroke="${hex(color)}" stroke-width="${w}"/>`);
    }
    curveId++;
  }
  return `<g fill="none" stroke-linecap="round" stroke-linejoin="round">${out.join('')}</g>`;
}

const f = (n: number) => (Math.round(n * 10) / 10).toString();
