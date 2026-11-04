/**
 * Where a mix cover's circles go ("orbit"): one album cover as a big circle bleeding off the top right, a thin ring
 * round it, and up to three small covers on the ring, tinted towards the mix's colour. Everything is in fractions of
 * the cover's side, and comes from the mix's key alone, so a mix keeps its look as its songs change, and looks the same
 * in the app (apps/ios/…/Components/MixOrbit.swift has this same arithmetic; their tests share expected numbers).
 * The circles keep out of the bottom-left corner, where the title is.
 */
export interface OrbitCircle {
  /** Centre and diameter, as fractions of the side. */
  x: number;
  y: number;
  d: number;
}

export interface OrbitLayout {
  hero: OrbitCircle;
  /** The ring round the hero: its radius, as a fraction of the side (centred on the hero). */
  ring: number;
  /** One per cover after the first, at most three. */
  satellites: OrbitCircle[];
  /** With a single cover: a small dot in the mix's colour on the ring, so the ring doesn't look empty. */
  dot: OrbitCircle | null;
}

const HERO = 0.62;
const RING = HERO / 2 + 0.12;
/** Places on the ring to try (degrees, clockwise from three o'clock); each is kept only if it `fits`. */
const SLOTS = [160, 192, 215, 30, 44, 140];
const SIZES = [0.19, 0.15, 0.12];
/** Where the words can reach: "Made for you", then the title at its longest (two lines, nearly the cover's width). */
const LABEL = { left: 0.07, right: 0.5, top: 0.61, bottom: 0.67 };
const TITLE = { left: 0.07, right: 0.93, top: 0.69, bottom: 0.93 };
type Box = typeof TITLE;

/** How far a circle's centre is from a box. */
const away = (c: OrbitCircle, b: Box) => Math.hypot(c.x - Math.min(Math.max(c.x, b.left), b.right), c.y - Math.min(Math.max(c.y, b.top), b.bottom));

/**
 * At least a quarter of the circle is on the cover (those at an edge bleed off it), it keeps a little clear of "Made
 * for you", and no more than grazes the title's box (a title is rarely that long).
 */
export function fits(c: OrbitCircle): boolean {
  const r = c.d / 2;
  const q = c.d / 4;
  if (c.x + r < q || c.x - r > 1 - q || c.y + r < q || c.y - r > 1 - q) return false;
  return away(c, LABEL) >= r + 0.02 && away(c, TITLE) >= r - 0.02;
}

/** FNV-1a, 32 bits. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: small, fast, and the same sequence in Swift. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + (Math.imul(t ^ (t >>> 7), t | 61) >>> 0))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Two satellites don't touch: a small gap between them. */
export const apart = (a: OrbitCircle, b: OrbitCircle) => Math.hypot(a.x - b.x, a.y - b.y) >= (a.d + b.d) / 2 + 0.02;

const round = (n: number) => Math.round(n * 10000) / 10000;

export function orbitLayout(key: string, covers: number): OrbitLayout {
  const next = random(hash32(key));
  const hero = { x: round(0.66 + next() * 0.06), y: round(0.27 + next() * 0.05), d: HERO };
  // The slots in an order of this mix's own: a Fisher–Yates shuffle.
  const slots = [...SLOTS];
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [slots[i], slots[j]] = [slots[j]!, slots[i]!];
  }
  const at = (slot: number, d: number): OrbitCircle => {
    const angle = ((slot + (next() - 0.5) * 12) * Math.PI) / 180;
    return { x: round(hero.x + Math.cos(angle) * RING), y: round(hero.y + Math.sin(angle) * RING), d };
  };
  const count = Math.max(0, Math.min(3, covers - 1));
  const satellites: OrbitCircle[] = [];
  let dot: OrbitCircle | null = null;
  for (const slot of slots) {
    if (covers === 1) {
      const c = at(slot, 0.05);
      if (fits(c)) {
        dot = c;
        break;
      }
    } else {
      if (satellites.length === count) break;
      const c = at(slot, SIZES[satellites.length]!);
      if (fits(c) && satellites.every((o) => apart(o, c))) satellites.push(c);
    }
  }
  return { hero, ring: round(RING), satellites, dot };
}
