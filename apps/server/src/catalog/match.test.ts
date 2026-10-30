import { describe, expect, it } from 'vitest';
import { scoreRelease, titleSimilarity, verdict, type FileFacts } from './match.ts';
import type { MbReleaseInfo } from './mbRelease.ts';

const release: MbReleaseInfo = {
  id: 'rel-1',
  title: 'Mezzanine',
  artistName: 'Massive Attack',
  artistId: 'art-1',
  releaseGroup: { id: 'rg-1', title: 'Mezzanine', primaryType: 'Album', secondaryTypes: [], firstReleaseDate: '1998-04-17' },
  tracks: [
    { disc: 1, position: 1, title: 'Angel', length: 379, recordingId: 'rec-1' },
    { disc: 1, position: 2, title: 'Risingson', length: 299, recordingId: 'rec-2' },
    { disc: 1, position: 3, title: 'Teardrop', length: 330, recordingId: 'rec-3' },
  ],
};
const file = (rel: string, title: string, trackNumber: number, duration: number): FileFacts => ({
  rel, title, trackNumber, discNumber: 1, duration,
});

describe('titleSimilarity', () => {
  it('ignores case, accents, punctuation and remaster notes', () => {
    expect(titleSimilarity('Teardrop', 'teardrop')).toBe(1);
    expect(titleSimilarity('Angel (2019 Remaster)', 'Angel')).toBe(1);
    expect(titleSimilarity('Risingson', 'Risinsgon')).toBeGreaterThan(0.7);
    expect(titleSimilarity('Angel', 'Teardrop')).toBeLessThan(0.3);
  });
});

describe('scoreRelease', () => {
  it('matches a complete album automatically', () => {
    const s = scoreRelease([file('01.flac', 'Angel', 1, 380), file('02.flac', 'Risingson', 2, 298), file('03.flac', 'Teardrop', 3, 331)], release);
    expect(s.score).toBeGreaterThan(0.95);
    expect(s.alignment.map((a) => [a.rel, a.track.recordingId])).toEqual(
      expect.arrayContaining([['01.flac', 'rec-1'], ['02.flac', 'rec-2'], ['03.flac', 'rec-3']]),
    );
    expect(verdict(s)).toBe('auto');
  });

  it('matches part of an album automatically', () => {
    expect(verdict(scoreRelease([file('a.flac', 'Teardrop', 0, 330)], release))).toBe('auto');
  });

  it('asks for review when durations disagree', () => {
    const s = scoreRelease([file('01.flac', 'Angel', 0, 200), file('02.flac', 'Risingson', 0, 120)], release);
    expect(verdict(s)).toBe('review');
  });

  it('rejects a different album', () => {
    const s = scoreRelease([file('01.flac', 'Glory Box', 11, 301), file('02.flac', 'Roads', 6, 305)], release);
    expect(verdict(s)).toBe('unmatched');
  });

  it('penalizes more files than the release has tracks', () => {
    const files = [1, 2, 3, 4, 5, 6].map((n) => file(`${n}.flac`, ['Angel', 'Risingson', 'Teardrop'][n % 3]!, n, 300));
    expect(scoreRelease(files, release).score).toBeLessThan(0.6);
  });

  it('has no verdict without a candidate', () => {
    expect(verdict(undefined)).toBe('unmatched');
  });
});
