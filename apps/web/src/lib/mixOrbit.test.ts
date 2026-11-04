import { describe, expect, it } from 'vitest';
import { apart, fits, hash32, orbitLayout, random, toneFromCovers, washStops } from './mixOrbit';

describe('orbitLayout', () => {
  // The same numbers are expected by the app's MixOrbitTests: the two must draw a mix alike.
  it('lays a mix out from its key alone, as the app does', () => {
    expect(hash32('vibes')).toBe(164168766);
    expect(hash32('genre-jazz')).toBe(3314012070);
    const next = random(hash32('vibes'));
    expect(next()).toBeCloseTo(0.14976447564549744, 12);
    expect(orbitLayout('vibes', 4)).toEqual({
      hero: { x: 0.669, y: 0.3149, d: 0.62 },
      ring: 0.43,
      satellites: [
        { x: 0.2975, y: 0.0983, d: 0.19 },
        { x: 0.2564, y: 0.436, d: 0.15 },
        { x: 0.9687, y: 0.6232, d: 0.12 },
      ],
      dot: null,
    });
    expect(orbitLayout('decade-1990', 1)).toEqual({ hero: { x: 0.6885, y: 0.2895, d: 0.62 }, ring: 0.43, satellites: [], dot: { x: 0.3562, y: 0.0165, d: 0.05 } });
  });

  it('gives each cover after the first a circle, three at most', () => {
    expect(orbitLayout('vibes', 0).satellites).toHaveLength(0);
    expect(orbitLayout('vibes', 2).satellites).toHaveLength(1);
    expect(orbitLayout('vibes', 3).satellites).toHaveLength(2);
    expect(orbitLayout('vibes', 9).satellites).toHaveLength(3);
  });

  it('keeps every circle on the cover, clear of the title and of each other, whatever the key', () => {
    let three = 0;
    for (let i = 0; i < 500; i++) {
      const { hero, satellites } = orbitLayout(`mix-${i}`, 4);
      // Where three don't fit round this mix's ring, fewer show.
      expect(satellites.length).toBeGreaterThanOrEqual(1);
      if (satellites.length === 3) three++;
      for (const c of [hero, ...satellites]) expect(fits(c)).toBe(true);
      for (let a = 0; a < satellites.length; a++) for (let b = a + 1; b < satellites.length; b++) expect(apart(satellites[a]!, satellites[b]!)).toBe(true);
    }
    expect(three).toBeGreaterThan(450);
    expect(fits({ x: 0.3, y: 0.8, d: 0.2 })).toBe(false); // on the title
    expect(fits({ x: 1.08, y: 0.4, d: 0.12 })).toBe(false); // nearly all off the cover
  });

  // Also expected by MixOrbitTests.
  it('runs a wash between two hues the short way round, at the same lightness as any other mix', () => {
    expect(washStops(350, 30).map((s) => s.h)).toEqual([350, 359, 8, 19, 30]);
    expect(washStops(10, 300).map((s) => s.h)).toEqual([10, 354.25, 338.5, 319.25, 300]);
    expect(washStops(200)).toEqual([
      { at: 0, l: 0.5, c: 0.15, h: 200 },
      { at: 0.225, l: 0.42, c: 0.13, h: 200 },
      { at: 0.45, l: 0.34, c: 0.11, h: 200 },
      { at: 0.725, l: 0.26, c: 0.085, h: 200 },
      { at: 1, l: 0.18, c: 0.06, h: 200 },
    ]);
    expect(['vibes', 'discovery', 'repeat', 'genre', 'decade', 'energy'].filter(toneFromCovers)).toEqual(['vibes', 'discovery', 'repeat']);
  });
});
