import { describe, expect, it } from 'vitest';
import { editDistance, normalize, scoreNearMatch } from './search.ts';

describe('editDistance', () => {
  it('counts a missing, extra, changed or swapped letter as one', () => {
    expect(editDistance('radiohed', 'radiohead', 2)).toBe(1);
    expect(editDistance('massivee', 'massive', 2)).toBe(1);
    expect(editDistance('teardrip', 'teardrop', 2)).toBe(1);
    expect(editDistance('mezzaine', 'mezzanine', 2)).toBe(1);
    expect(editDistance('mezzanien', 'mezzanine', 2)).toBe(1);
  });

  it('stops at one past the most it may be', () => {
    expect(editDistance('abcdef', 'uvwxyz', 1)).toBe(2);
    expect(editDistance('a', 'abcdefgh', 2)).toBe(3);
  });
});

describe('scoreNearMatch', () => {
  const near = (query: string, text: string) => scoreNearMatch(normalize(query), text);

  it('finds names a typo away', () => {
    expect(near('radiohed', 'Radiohead')).toBeGreaterThan(0);
    expect(near('massive atack', 'Massive Attack Mezzanine')).toBeGreaterThan(0);
    expect(near('mezanine', 'Massive Attack Mezzanine')).toBeGreaterThan(0);
  });

  it('finds names typed run together or split apart', () => {
    expect(near('daftpunk', 'Daft Punk')).toBeGreaterThan(0);
    expect(near('radio head', 'Radiohead')).toBeGreaterThan(0);
  });

  it('ranks the closer name higher', () => {
    expect(near('radiohed', 'Radioheads')).toBeGreaterThan(0);
    expect(near('radiohed', 'Radiohead')).toBeGreaterThan(near('radiohed', 'Radioheads'));
  });

  it('leaves short words alone, where one letter makes another word', () => {
    expect(near('cat', 'Car')).toBe(0);
    expect(near('mix', 'Max')).toBe(0);
  });

  it('finds nothing in names that are more than a typo away', () => {
    expect(near('angel', 'Kevin MacLeod Sneaky Snitch')).toBe(0);
  });
});
