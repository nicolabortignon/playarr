/**
 * Colonies: a multi-species Physarum (slime mold) simulation, after Jeff Jones (2010) and Sage
 * Jenson, with species attraction/repulsion as in fogleman/physarum.
 *
 * Each style in the playlist is a species in its own color, as numerous as its songs. Species
 * follow their own trails and avoid the others', so styles carve out territories; the more
 * eclectic the playlist, the harder they push apart. A species' behavior comes from its songs:
 * tempo sets its speed, a steady beat makes tight, straight veins and free time wide, wandering
 * ones; busyness makes it twitchier, dynamics make it look further ahead (bigger cells).
 */
import sharp from 'sharp';
import type { StyleFamily } from '../analysis/styles.ts';
import { hex, mix, type Lch } from './color.ts';
import type { Dna, Glyph } from './dna.ts';
import type { Palette } from './palette.ts';
import type { Rng } from './random.ts';

const N = 440; // simulation grid
const STEPS = 260;
const AGENTS_PER_CELL = 0.9;
const DEPOSIT = 5;
const DECAY = 0.1;
const TURNS = 4096; // headings are indices into sine/cosine tables
const COS = Float32Array.from({ length: TURNS }, (_, i) => Math.cos((i / TURNS) * Math.PI * 2));
const SIN = Float32Array.from({ length: TURNS }, (_, i) => Math.sin((i / TURNS) * Math.PI * 2));

interface Species {
  color: Lch;
  share: number;
  step: number;
  /** In heading-table units. */
  sensorAngle: number;
  rotation: number;
  sensorDistance: number;
}

export async function colonies({ dna, pal, rng }: { dna: Dna; pal: Palette; rng: Rng }): Promise<string> {
  const species = speciesOf(dna, pal);
  const k = species.length;
  const total = Math.round(N * N * AGENTS_PER_CELL);
  const r = rng.fork('agents');

  const xs = new Float32Array(total);
  const ys = new Float32Array(total);
  const hs = new Uint16Array(total);
  const sp = new Uint8Array(total);
  let filled = 0;
  species.forEach((s, i) => {
    const count = i === k - 1 ? total - filled : Math.round(total * s.share);
    // Each species starts loosely gathered in its own part of the canvas, then spreads.
    const cx = r.range(0.15, 0.85) * N;
    const cy = r.range(0.15, 0.85) * N;
    const spread = r.range(0.45, 0.75) * N;
    for (let a = filled; a < filled + count && a < total; a++) {
      const ang = r.range(0, Math.PI * 2);
      const dist = Math.sqrt(r.next()) * spread;
      xs[a] = wrap(cx + Math.cos(ang) * dist);
      ys[a] = wrap(cy + Math.sin(ang) * dist);
      hs[a] = Math.floor(r.next() * TURNS);
      sp[a] = i;
    }
    filled += count;
  });

  const trails = species.map(() => new Float32Array(N * N));
  const sum = new Float32Array(N * N);
  const scratch = new Float32Array(N * N);
  // What species s perceives: its own trail minus `repulsion` × everyone else's,
  // i.e. own × (1 + repulsion) − repulsion × sum of all trails: two reads per sensor.
  const repulsion = 0.4 + 0.8 * dna.diversity;
  const cell = (x: number, y: number) => {
    let ix = x | 0;
    let iy = y | 0;
    if (ix < 0) ix += N;
    else if (ix >= N) ix -= N;
    if (iy < 0) iy += N;
    else if (iy >= N) iy -= N;
    return iy * N + ix;
  };

  for (let step = 0; step < STEPS; step++) {
    for (let a = 0; a < total; a++) {
      const s = sp[a]!;
      const p = species[s]!;
      const own = trails[s]!;
      const h = hs[a]!;
      const x = xs[a]!;
      const y = ys[a]!;
      const d = p.sensorDistance;
      const hl = (h - p.sensorAngle + TURNS) & (TURNS - 1);
      const hr = (h + p.sensorAngle) & (TURNS - 1);
      const i0 = cell(x + COS[h]! * d, y + SIN[h]! * d);
      const il = cell(x + COS[hl]! * d, y + SIN[hl]! * d);
      const ir = cell(x + COS[hr]! * d, y + SIN[hr]! * d);
      const f = own[i0]! * (1 + repulsion) - repulsion * sum[i0]!;
      const fl = own[il]! * (1 + repulsion) - repulsion * sum[il]!;
      const fr = own[ir]! * (1 + repulsion) - repulsion * sum[ir]!;
      let nh = h;
      if (f > fl && f > fr) {
        // keep heading
      } else if (f < fl && f < fr) {
        nh = r.next() < 0.5 ? h - p.rotation : h + p.rotation;
      } else if (fl < fr) {
        nh = h + p.rotation;
      } else if (fr < fl) {
        nh = h - p.rotation;
      }
      nh = (nh + TURNS) & (TURNS - 1);
      const nx = wrap(x + COS[nh]! * p.step);
      const ny = wrap(y + SIN[nh]! * p.step);
      xs[a] = nx;
      ys[a] = ny;
      hs[a] = nh;
      own[cell(nx, ny)]! += DEPOSIT;
    }
    sum.fill(0);
    for (const t of trails) {
      diffuse(t, scratch);
      for (let i = 0; i < t.length; i++) sum[i]! += t[i]!;
    }
    // Long simulation: give the event loop (music streams) a turn now and then.
    if (step % 6 === 5) await new Promise((resolve) => setImmediate(resolve));
  }

  // Tone-map each species' trail and composite: inks glow on night, print on paper.
  const rgba = Buffer.alloc(N * N * 4);
  const bg = rgb(pal.bg);
  const inks = species.map((s) => rgb(s.color));
  const gains = trails.map((t) => 1.6 / (percentile(t, 0.97) || 1));
  for (let i = 0; i < N * N; i++) {
    let [cr, cg, cb] = bg;
    for (let j = 0; j < k; j++) {
      // Contrast curve: faint haze drops away, filaments stay crisp.
      const v = (1 - Math.exp(-trails[j]![i]! * gains[j]!)) ** 1.6;
      if (v <= 0.002) continue;
      const [ir, ig, ib] = inks[j]!;
      if (pal.dark) {
        cr = 1 - (1 - cr) * (1 - ir * v);
        cg = 1 - (1 - cg) * (1 - ig * v);
        cb = 1 - (1 - cb) * (1 - ib * v);
      } else {
        cr = cr * (1 - v + ir * v);
        cg = cg * (1 - v + ig * v);
        cb = cb * (1 - v + ib * v);
      }
    }
    rgba[i * 4] = Math.round(cr * 255);
    rgba[i * 4 + 1] = Math.round(cg * 255);
    rgba[i * 4 + 2] = Math.round(cb * 255);
    rgba[i * 4 + 3] = 255;
  }
  const png = await sharp(rgba, { raw: { width: N, height: N, channels: 4 } }).png().toBuffer();
  return `<image href="data:image/png;base64,${png.toString('base64')}" x="0" y="0" width="1000" height="1000" preserveAspectRatio="none"/>`;
}

/** One species per palette style (at least two), with behavior from its songs' sound. */
function speciesOf(dna: Dna, pal: Palette): Species[] {
  const groups = new Map<StyleFamily | undefined, Glyph[]>();
  for (const g of dna.glyphs) {
    const family = pal.inks.some((i) => i.family === g.family) ? g.family : pal.inks[0]!.family;
    groups.set(family, [...(groups.get(family) ?? []), g]);
  }
  let entries = [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, 4);
  // A single style still needs a rival to form territories: split it into calmer and louder songs.
  if (entries.length < 2) {
    const songs = [...(entries[0]?.[1] ?? [])].sort((a, b) => a.intensity - b.intensity);
    const half = Math.max(1, Math.floor(songs.length / 2));
    entries = [
      [entries[0]?.[0], songs.slice(0, half)],
      [undefined, songs.slice(half).length ? songs.slice(half) : songs],
    ];
  }
  const total = entries.reduce((s, [, songs]) => s + songs.length, 0) || 1;
  return entries.map(([family, songs], i) => {
    const avg = (pick: (g: Glyph) => number, fallback: number) =>
      songs.length ? songs.reduce((s, g) => s + pick(g), 0) / songs.length : fallback;
    const tempo = clamp((avg((g) => g.bpm, 110) - 70) / 110);
    const pulse = avg((g) => g.pulse, 0.5);
    const busy = avg((g) => g.busyness, 0.4);
    const dynamics = avg((g) => g.dynamics, 0.4);
    const sensorAngle = Math.round(((18 + 42 * (1 - pulse)) / 360) * TURNS);
    const color = family !== undefined || i === 0 ? pal.inkFor(family) : (pal.inks[1]?.color ?? mix(pal.accent, pal.fg, 0.3));
    return {
      color,
      share: Math.max(0.12, songs.length / total),
      step: 0.7 + 0.9 * tempo,
      sensorAngle,
      rotation: Math.round(sensorAngle * (0.6 + 0.9 * busy)),
      sensorDistance: 4 + 8 * dynamics + 4 * (1 - busy),
    };
  });
}

/** 3×3 box blur (two separable passes, wrapping at the edges), then decay. */
function diffuse(t: Float32Array, scratch: Float32Array) {
  for (let y = 0; y < N; y++) {
    const row = y * N;
    for (let x = 0; x < N; x++) {
      const l = x === 0 ? N - 1 : x - 1;
      const rr = x === N - 1 ? 0 : x + 1;
      scratch[row + x] = t[row + l]! + t[row + x]! + t[row + rr]!;
    }
  }
  const scale = (1 - DECAY) / 9;
  for (let y = 0; y < N; y++) {
    const up = (y === 0 ? N - 1 : y - 1) * N;
    const row = y * N;
    const down = (y === N - 1 ? 0 : y + 1) * N;
    for (let x = 0; x < N; x++) t[row + x] = (scratch[up + x]! + scratch[row + x]! + scratch[down + x]!) * scale;
  }
}

function percentile(t: Float32Array, q: number): number {
  const sample: number[] = [];
  for (let i = 0; i < t.length; i += 37) sample.push(t[i]!);
  sample.sort((a, b) => a - b);
  return sample[Math.floor(q * (sample.length - 1))]!;
}

function rgb(c: Lch): [number, number, number] {
  const h = hex(c);
  return [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}

const wrap = (v: number) => (v < 0 ? v + N : v >= N ? v - N : v);
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
