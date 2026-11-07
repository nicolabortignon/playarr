import { describe, expect, it } from 'vitest';
import { syntheticLibrary } from '../testing/syntheticLibrary.ts';
import { editDistance, matchScorer, nearScorer, normalize, scoreNearMatch } from './search.ts';

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

/** search.ts as it was before plan 3: what the faster code must still answer, word for word. */
const before = {
  normalize: (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[’'`]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim(),
  scoreMatch(query: string, text: string): number {
    const t = before.normalize(text);
    if (!t) return 0;
    if (t === query) return 100;
    if (t.startsWith(query)) return 80;
    if (t.includes(` ${query}`)) return 60;
    if (t.includes(query)) return 40;
    const words = query.split(' ');
    if (words.length > 1 && words.every((w) => t.includes(w))) return 20;
    return 0;
  },
  scoreNearMatch(query: string, text: string): number {
    const slack = (word: string) => (word.length >= 8 ? 2 : word.length >= 4 ? 1 : 0);
    const t = before.normalize(text);
    if (!t) return 0;
    const joined = query.replaceAll(' ', '');
    const whole = editDistance(joined, t.replaceAll(' ', ''), slack(joined));
    if (whole <= slack(joined)) return 10 - whole;
    const words = t.split(' ');
    let off = 0;
    for (const q of query.split(' ')) {
      const max = slack(q);
      let best = max + 1;
      for (const w of words) {
        best = Math.min(best, editDistance(q, w, max));
        if (best === 0) break;
      }
      if (best > max) return 0;
      off += best;
    }
    return 10 - off;
  },
};

/** Names as libraries have them: every script, accents, punctuation, ligatures, spacing a tagger left. */
const TRICKY = [
  'L’Impératrice', 'Sigur Rós', 'Mötley Crüe', 'Beyoncé', 'AC/DC', 'Guns N’ Roses', 'P!nk', 'Ke$ha', 'Florence + the Machine',
  'MØ', 'Ólafur Arnalds', 'Œuvre', 'ﬁnal ﬂight', 'Ⅻ Roman', '¼ Moon', 'x²', 'İstanbul', 'ΟΔΟΣ', 'Ελένη Καραΐνδρου', 'Пётр Чайковский',
  '坂本龍一', 'サカナクション', '방탄소년단', 'فيروز', 'עומר אדם', 'Ⓐ circled', 'tab\there', 'non\u00a0breaking', '  spaced   out  ',
  'under_score', "rock'n'roll", 'back`tick', '...', '', '—', 'Café Tacvba', 'Zoë Keating', 'Røyksopp', 'Dvořák', 'ﬀ', 'e\u0301 (an e and an accent)',
];

describe('search, computed once per name', () => {
  const lib = syntheticLibrary({ tracks: 3000, seed: 7 });
  const names = [...new Set([...TRICKY, ...lib.files.flatMap((f) => [f.tags.title, f.tags.artist, f.tags.album, f.rel].filter((x): x is string => !!x))])];

  it('normalizes every name exactly as before, plain ASCII by its quicker way', () => {
    for (const name of names) expect(normalize(name), name).toBe(before.normalize(name));
  });

  it('normalizes "artist title" as the artist and the title normalized and joined by a space', () => {
    const both = (a: string, b: string) => (a && b ? `${a} ${b}` : a || b);
    for (let i = 0; i + 1 < names.length; i += 3) {
      const [a, b] = [names[i]!, names[i + 1]!];
      expect(both(normalize(a), normalize(b)), `${a} | ${b}`).toBe(normalize(`${a} ${b}`));
    }
  });

  it('scores names as before, matched as typed or a letter or two away', () => {
    const queries = [...lib.queries.map((q) => q.q), 'radiohed', 'massive atack', 'daftpunk', 'radio head', 'love', 'th', 'a', 'mezanine'].map(normalize);
    for (const q of queries) {
      const exact = matchScorer(q);
      const near = nearScorer(q);
      for (const name of names) {
        expect(exact(normalize(name)), `${q} ~ ${name}`).toBe(before.scoreMatch(q, name));
        expect(near(normalize(name)), `${q} ≈ ${name}`).toBe(before.scoreNearMatch(q, name));
      }
    }
  });
});
