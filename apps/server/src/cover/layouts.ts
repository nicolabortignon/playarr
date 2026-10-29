/**
 * The four cover layouts. Every one draws each song as its own element, shaped by what the
 * song sounds like: its loudness over time (envelope), tempo, energy, busyness and style.
 */
import { hex, mix, lch, type Lch } from './color.ts';
import type { Dna, Glyph } from './dna.ts';
import type { Palette } from './palette.ts';
import { Rng, smoothNoise } from './random.ts';

export type Layout = 'ridges' | 'grooves' | 'blocks' | 'horizon';

export const S = 1000;

interface Ctx {
  dna: Dna;
  pal: Palette;
  rng: Rng;
  /** Defs (clip paths, gradients) collected while drawing. */
  defs: string[];
}

export const LAYOUTS: Record<Layout, (ctx: Ctx) => string> = { ridges, grooves, blocks, horizon };

/**
 * Ridges, after Joy Division's *Unknown Pleasures*: stacked lines, a band of them per song.
 * Each line's profile is the song's loudness over time, peaked toward the middle; ripples
 * follow its tempo and busyness. Lower lines hide the ones behind them.
 */
function ridges({ dna, pal, rng }: Ctx): string {
  const groups = group(dna.glyphs, 36);
  const perSong = clamp(Math.round(34 / Math.max(1, groups.length)), 1, 24);
  const lines = Math.max(1, groups.length * perSong);
  // Frame varies per playlist: a narrow column like the original, or wide and low.
  const marginX = rng.range(80, 210);
  const top = rng.range(170, 300);
  const bottom = S - rng.range(90, 160);
  const spacing = lines > 1 ? (bottom - top) / (lines - 1) : 0;
  const centre = 0.5 + rng.range(-0.12, 0.12);
  const loudest = groups.reduce((best, g, i) => (g.intensity > groups[best]!.intensity ? i : best), 0);
  const mono = dna.diversity < 0.3;
  const out: string[] = [];

  for (let j = 0; j < lines; j++) {
    const gi = Math.floor(j / perSong);
    const g = groups[gi] ?? neutralGlyph();
    const r = rng.fork(`ridge${j}`);
    const wobble = smoothNoise(r, 9);
    const grit = smoothNoise(r, 46);
    const base = lines > 1 ? top + j * spacing : (top + bottom) / 2;
    const room = spacing || 120;
    const amp = Math.min(room * (2.2 + 5 * g.intensity), 200);
    const width = 0.12 + 0.1 * (1 - g.pulse) + 0.05 * g.dynamics;
    const cycles = g.bpm / 7;
    const phase = r.range(0, Math.PI * 2);
    const pts: [number, number][] = [];
    for (let p = 0; p <= 110; p++) {
      const t = p / 110;
      const bell = Math.exp(-((t - centre) ** 2) / (2 * width * width));
      const ripple = (Math.sin(Math.PI * 2 * t * cycles + phase) * 0.6 + Math.sin(Math.PI * 4.06 * t * cycles + phase * 1.7) * 0.3) * g.busyness;
      const h =
        amp * bell * (0.2 + 0.8 * envAt(g.envelope, t)) * (0.85 + 0.3 * wobble(t)) * (1 + 0.5 * ripple) +
        room * 0.14 * (0.5 + 0.5 * grit(t));
      pts.push([marginX + t * (S - 2 * marginX), base - Math.max(0, h)]);
    }
    const stroke = gi === loudest && j % perSong === Math.floor(perSong / 2) ? pal.accent : mono ? pal.fg : pal.inkFor(g.family);
    const width_ = 2.4 + 2.6 * g.loudness;
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join('');
    out.push(
      `<path d="${line}L${f(S - marginX)} ${f(base + 2)}L${f(marginX)} ${f(base + 2)}Z" fill="${hex(pal.bg)}"/>`,
      `<path d="${line}" fill="none" stroke="${hex(stroke)}" stroke-width="${f(width_)}" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
  }
  return out.join('');
}

/**
 * Grooves: the playlist as a record. Each song is a band of rings, as wide as the song is long;
 * the rings wobble with the song's loudness over time (once around = the whole song) and ripple
 * at its tempo. Faster playlists cut finer grooves.
 */
function grooves({ dna, pal, rng }: Ctx): string {
  const preset = rng.fork('preset').pick(['centered', 'offset', 'offset', 'rising'] as const);
  let cx = S / 2;
  let cy = S / 2;
  let R = 430;
  if (preset === 'offset') {
    // Off-centre, running off the sleeve: big arcs across the corner.
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(170, 290);
    cx += Math.cos(a) * d;
    cy += Math.sin(a) * d;
    R = 560 + d * 0.6;
  } else if (preset === 'rising') {
    // Half a record rising from the bottom edge, like a sun.
    cx = rng.range(380, 620);
    cy = S - rng.range(40, 110);
    R = rng.range(560, 680);
  }
  const out: string[] = [];
  const rLabel = R * rng.range(0.25, 0.32);
  out.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(R + 8)}" fill="${hex(pal.deep)}"/>`);

  const songs = dna.glyphs.length ? group(dna.glyphs, 24) : [];
  const tempo = dna.tempo ?? 105;
  const spacing = clamp(24 - ((tempo - 70) / 110) * 13, 9, 24);
  const gap = spacing * 0.9;
  const usable = R - rLabel - 18 - gap * Math.max(0, songs.length - 1);
  const total = songs.reduce((s, g) => s + Math.max(g.seconds, 60), 0) || 1;
  let inner = rLabel + 14;
  songs.forEach((g, i) => {
    const band = (usable * Math.max(g.seconds, 60)) / total;
    const rings = Math.max(1, Math.floor(band / spacing));
    const r = rng.fork(`band${i}`);
    const phase = r.range(0, Math.PI * 2);
    const cycles = Math.max(3, Math.round(g.bpm / 9));
    const amp = Math.min(spacing * 0.45, band * 0.22) * (0.3 + g.loudness);
    const ripple = spacing * 0.2 * g.busyness;
    const color = hex(pal.inkFor(g.family));
    for (let k = 0; k < rings; k++) {
      const radius = inner + ((k + 0.5) * band) / rings;
      const pts: string[] = [];
      for (let p = 0; p < 168; p++) {
        const th = (p / 168) * Math.PI * 2;
        const rr = radius + amp * (envAt(g.envelope, p / 168) - 0.5) * 2 + ripple * Math.sin(th * cycles + phase + k);
        pts.push(`${p ? 'L' : 'M'}${f(cx + Math.cos(th - Math.PI / 2) * rr)} ${f(cy + Math.sin(th - Math.PI / 2) * rr)}`);
      }
      out.push(
        `<path d="${pts.join('')}Z" fill="none" stroke="${color}" stroke-width="${f(Math.min(spacing * 0.55, 2.8 + 3 * g.loudness))}" stroke-opacity="${f(0.75 + 0.25 * g.intensity)}"/>`,
      );
    }
    inner += band + gap;
  });


  // Label: two-tone, split at an angle; spindle hole in the middle.
  const split = rng.range(0, Math.PI * 2);
  const second = pal.inks[1]?.color ?? pal.fg;
  out.push(
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(rLabel)}" fill="${hex(pal.accent)}"/>`,
    `<path d="M${f(cx + Math.cos(split) * rLabel)} ${f(cy + Math.sin(split) * rLabel)}A${f(rLabel)} ${f(rLabel)} 0 0 1 ${f(cx - Math.cos(split) * rLabel)} ${f(cy - Math.sin(split) * rLabel)}Z" fill="${hex(second)}"/>`,
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(rLabel * 0.66)}" fill="none" stroke="${hex(pal.deep)}" stroke-opacity="0.25" stroke-width="2"/>`,
    `<circle cx="${f(cx)}" cy="${f(cy)}" r="11" fill="${hex(pal.bg)}"/>`,
  );
  return out.join('');
}

/**
 * Blocks: a Bauhaus grid. Each song gets a tile sized by its length (in playlist order) and a
 * shape chosen by how it sounds: rings for a steady beat, stripes for busy rhythm, a disc for
 * calm, half-circles for drama, dots for crisp percussion, a wave for its loudness curve.
 */
function blocks(ctx: Ctx): string {
  const { dna, pal, rng, defs } = ctx;
  const full = rng.chance(0.35);
  const m = full ? 0 : rng.range(60, 92);
  const gutter = 8 + 14 * dna.intensity;
  const lineColor = pal.dark && dna.intensity > 0.5 ? pal.deep : pal.bg;
  const songs = dna.glyphs.length ? group(dna.glyphs, 16) : [neutralGlyph()];
  const tiles = treemap(songs, { x: m, y: m, w: S - 2 * m, h: S - 2 * m });
  const used = new Map<string, number>();
  const out = [`<rect x="${f(m)}" y="${f(m)}" width="${f(S - 2 * m)}" height="${f(S - 2 * m)}" fill="${hex(lineColor)}"/>`];

  tiles.forEach(({ rect, item: g }, i) => {
    const r = rng.fork(`tile${i}`);
    const x = rect.x + gutter / 2;
    const y = rect.y + gutter / 2;
    const w = Math.max(1, rect.w - gutter);
    const h = Math.max(1, rect.h - gutter);
    const ink = pal.inkFor(g.family);
    const blank = r.chance(0.2);
    const fill = blank ? (pal.dark ? mix(pal.bg, pal.fg, 0.08) : pal.bg) : lch(ink.l + r.range(-0.05, 0.05), ink.c, ink.h);
    const choices = [pal.fg, pal.accent, pal.deep, ...pal.inks.map((c) => c.color)].filter((c) => contrast(c, fill) > 0.18);
    const fg = choices.length ? r.pick(choices) : pal.fg;
    const id = `t${i}`;
    defs.push(`<clipPath id="${id}"><rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}"/></clipPath>`);
    out.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${hex(fill)}"/>`);
    out.push(`<g clip-path="url(#${id})">${shape(g, { x, y, w, h }, hex(fg), r, used)}</g>`);
  });
  return out.join('');
}

type Rect = { x: number; y: number; w: number; h: number };

function shape(g: Glyph, { x, y, w, h }: Rect, color: string, r: Rng, used: Map<string, number>): string {
  const min = Math.min(w, h);
  const scores: [string, number][] = [
    ['rings', g.pulse * 0.55 + (g.bpm > 115 ? 0.1 : 0)],
    ['stripes', g.busyness * 0.9],
    ['disc', (1 - g.intensity) * 0.8],
    ['half', g.dynamics * 0.75],
    ['quarter', 0.35],
    ['dots', g.busyness * 0.45 + g.brightness * 0.35],
    ['wave', (1 - g.pulse) * 0.35 + g.dynamics * 0.35],
  ];
  // Each repeat of a shape counts against it, so a grid stays varied.
  const kind = scores
    .map(([k, s]): [string, number] => [k, s + r.range(0, 0.3) - 0.22 * (used.get(k) ?? 0)])
    .sort((a, b) => b[1] - a[1])[0]![0];
  used.set(kind, (used.get(kind) ?? 0) + 1);
  const cx = x + w / 2;
  const cy = y + h / 2;
  switch (kind) {
    case 'rings': {
      const n = 2 + Math.round(g.bpm / 30);
      const corner = r.pick([[x, y], [x + w, y], [x, y + h], [x + w, y + h], [cx, cy]] as const);
      const reach = corner[0] === cx ? min / 2 : Math.hypot(w, h);
      const step = reach / n;
      return Array.from({ length: n }, (_, k) => `<circle cx="${f(corner[0])}" cy="${f(corner[1])}" r="${f(step * (k + 0.75))}" fill="none" stroke="${color}" stroke-width="${f(step * 0.38)}"/>`).join('');
    }
    case 'stripes': {
      const n = 3 + Math.round(g.bpm / 16);
      const angle = [0, 45, 90, 135][Math.min(3, Math.floor(g.brightness * 4))]!;
      const span = Math.hypot(w, h);
      const step = span / n;
      const bars = Array.from({ length: n + 1 }, (_, k) => `<rect x="${f(cx - span / 2)}" y="${f(cy - span / 2 + k * step)}" width="${f(span)}" height="${f(step * 0.48)}" fill="${color}"/>`);
      return `<g transform="rotate(${angle} ${f(cx)} ${f(cy)})">${bars.join('')}</g>`;
    }
    case 'disc':
      return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(min * (0.22 + 0.2 * g.loudness))}" fill="${color}"/>`;
    case 'half': {
      const side = r.int(0, 3);
      const [px, py, rad] = ([[cx, y, w / 2], [x + w, cy, h / 2], [cx, y + h, w / 2], [x, cy, h / 2]] as const)[side]!;
      return `<circle cx="${f(px)}" cy="${f(py)}" r="${f(Math.min(rad, min))}" fill="${color}"/>`;
    }
    case 'quarter': {
      const [px, py] = r.pick([[x, y], [x + w, y], [x, y + h], [x + w, y + h]] as const);
      return `<circle cx="${f(px)}" cy="${f(py)}" r="${f(min)}" fill="${color}"/>`;
    }
    case 'dots': {
      const step = min / (3 + 5 * g.busyness);
      const dots: string[] = [];
      for (let yy = y + step / 2; yy < y + h; yy += step) {
        for (let xx = x + step / 2; xx < x + w; xx += step) dots.push(`<circle cx="${f(xx)}" cy="${f(yy)}" r="${f(step * 0.24)}"/>`);
      }
      return `<g fill="${color}">${dots.join('')}</g>`;
    }
    default: {
      const pts = Array.from({ length: 41 }, (_, k) => `L${f(x + (k / 40) * w)} ${f(y + h - envAt(g.envelope, k / 40) * h * 0.82)}`);
      return `<path d="M${f(x)} ${f(y + h)}${pts.join('')}L${f(x + w)} ${f(y + h)}Z" fill="${color}"/>`;
    }
  }
}

/**
 * Horizon: for calm, beatless playlists. Layers of hills, back to front, one per song, each
 * ridge the song's loudness over time; a sun that is larger the slower the music, cut into
 * stripes when there is a beat.
 */
function horizon({ dna, pal, rng, defs }: Ctx): string {
  const out: string[] = [];
  const horizonY = rng.range(520, 610);
  const glow = mix(pal.bg, pal.accent, pal.dark ? 0.3 : 0.22);
  defs.push(
    `<linearGradient id="sky" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${f(horizonY)}"><stop offset="0" stop-color="${hex(pal.bg)}"/><stop offset="1" stop-color="${hex(glow)}"/></linearGradient>`,
  );
  out.push(`<rect width="${S}" height="${S}" fill="url(#sky)"/>`);

  const tempo = dna.tempo ?? 80;
  const sunR = 95 + 150 * (1 - clamp((tempo - 70) / 110));
  const sunX = rng.range(290, 710);
  const sunY = horizonY - sunR * rng.range(0.1, 0.85);
  out.push(`<circle cx="${f(sunX)}" cy="${f(sunY)}" r="${f(sunR)}" fill="${hex(pal.accent)}"/>`);
  if (dna.pulse > 0.3) {
    // Retro sunset cuts: more of them for faster music, widening toward the horizon.
    const cuts = 3 + Math.round(tempo / 28);
    for (let k = 0; k < cuts; k++) {
      const t = k / cuts;
      const yy = sunY + sunR * (0.05 + 0.95 * t);
      out.push(`<rect x="${f(sunX - sunR - 2)}" y="${f(yy)}" width="${f(sunR * 2 + 4)}" height="${f(2 + 9 * t)}" fill="url(#sky)"/>`);
    }
  }

  const songs = dna.glyphs.length ? group(dna.glyphs, 8) : [neutralGlyph()];
  songs.forEach((g, i) => {
    const r = rng.fork(`hill${i}`);
    const wobble = smoothNoise(r, 7);
    const depth = songs.length > 1 ? i / (songs.length - 1) : 1;
    const baseY = horizonY + 14 + (S - horizonY) * depth * 0.72;
    const amp = 38 + 110 * g.dynamics + 45 * g.loudness;
    const flip = r.chance(0.5);
    const pts: string[] = [];
    for (let p = 0; p <= 70; p++) {
      const t = p / 70;
      const env = envAt(g.envelope, flip ? 1 - t : t);
      pts.push(`L${f(-10 + t * (S + 20))} ${f(baseY - amp * env * (0.75 + 0.25 * wobble(t)))}`);
    }
    const ink = pal.inkFor(g.family);
    // One family of tones, back to front: hazy near the horizon, darker (or richer) up close.
    const color = pal.dark
      ? mix(mix(pal.bg, mix(ink, pal.accent, 0.3), 0.32), pal.deep, depth * 0.85)
      : mix(pal.bg, mix(ink, pal.deep, depth * 0.3), 0.22 + 0.6 * depth);
    out.push(`<path d="M-10 ${S + 10}${pts.join('')}L${S + 10} ${S + 10}Z" fill="${hex(color)}"/>`);
  });
  return out.join('');
}

/** At most `max` glyphs: long playlists merge neighbours (averaged), keeping order. */
function group(glyphs: Glyph[], max: number): Glyph[] {
  if (glyphs.length <= max) return glyphs;
  const out: Glyph[] = [];
  for (let k = 0; k < max; k++) {
    const part = glyphs.slice(Math.floor((k * glyphs.length) / max), Math.floor(((k + 1) * glyphs.length) / max));
    const avg = (pick: (g: Glyph) => number) => part.reduce((s, g) => s + pick(g), 0) / part.length;
    out.push({
      ...part[0]!,
      seconds: part.reduce((s, g) => s + g.seconds, 0),
      bpm: avg((g) => g.bpm),
      pulse: avg((g) => g.pulse),
      loudness: avg((g) => g.loudness),
      dynamics: avg((g) => g.dynamics),
      brightness: avg((g) => g.brightness),
      busyness: avg((g) => g.busyness),
      intensity: avg((g) => g.intensity),
      envelope: part[0]!.envelope.map((_, i) => avg((g) => g.envelope[i]!)),
    });
  }
  return out;
}

/** Ordered treemap: split the list where the weight halves, along the rectangle's longer side. */
function treemap(items: Glyph[], rect: Rect): { rect: Rect; item: Glyph }[] {
  if (items.length === 1) return [{ rect, item: items[0]! }];
  const weights = items.map((g) => Math.max(g.seconds, 45));
  const total = weights.reduce((s, w) => s + w, 0);
  let k = 1;
  let acc = weights[0]!;
  while (k < items.length - 1 && Math.abs(acc + weights[k]! - total / 2) < Math.abs(acc - total / 2)) acc += weights[k++]!;
  const share = acc / total;
  const [a, b] =
    rect.w >= rect.h
      ? [{ ...rect, w: rect.w * share }, { ...rect, x: rect.x + rect.w * share, w: rect.w * (1 - share) }]
      : [{ ...rect, h: rect.h * share }, { ...rect, y: rect.y + rect.h * share, h: rect.h * (1 - share) }];
  return [...treemap(items.slice(0, k), a), ...treemap(items.slice(k), b)];
}

function neutralGlyph(): Glyph {
  return {
    id: 'none',
    seconds: 200,
    analyzed: false,
    bpm: 100,
    pulse: 0.3,
    loudness: 0.4,
    dynamics: 0.3,
    brightness: 0.4,
    busyness: 0.3,
    bass: 0.4,
    envelope: Array.from({ length: 48 }, (_, i) => 0.3 + 0.2 * Math.sin((i / 47) * Math.PI)),
    intensity: 0.4,
  };
}

function envAt(env: number[], t: number): number {
  if (!env.length) return 0.5;
  const x = clamp(t) * (env.length - 1);
  const i = Math.floor(x);
  return env[i]! + (env[Math.min(env.length - 1, i + 1)]! - env[i]!) * (x - i);
}

const contrast = (a: Lch, b: Lch) => Math.abs(a.l - b.l) + Math.min(0.15, Math.abs(a.c - b.c));
const f = (n: number) => (Math.round(n * 10) / 10).toString();
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
