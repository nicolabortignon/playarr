/** Deterministic randomness: the same playlist always draws the same cover. */

/** FNV-1a, 32-bit. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 with helpers. `fork(label)` gives an independent stream, so one element's draws don't shift another's. */
export class Rng {
  private state: number;

  constructor(private readonly seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  int(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  fork(label: string | number): Rng {
    return new Rng(hash32(`${this.seed}:${label}`));
  }
}

/** Smooth 1-D value noise in about −1…1, for hand-drawn wobble. */
export function smoothNoise(rng: Rng, points = 12): (t: number) => number {
  const knots = Array.from({ length: points + 1 }, () => rng.range(-1, 1));
  return (t: number) => {
    const x = Math.min(0.9999, Math.max(0, t)) * points;
    const i = Math.floor(x);
    const f = x - i;
    const s = f * f * (3 - 2 * f);
    return knots[i]! * (1 - s) + knots[i + 1]! * s;
  };
}
