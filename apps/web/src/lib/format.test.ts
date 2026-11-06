import { describe, expect, it } from 'vitest';
import { releaseKind } from './format';

describe('releaseKind', () => {
  it('names a release by its primary type, qualified or replaced by its first secondary type', () => {
    expect(releaseKind('Album')).toBe('Album');
    expect(releaseKind('EP', [])).toBe('EP');
    expect(releaseKind('Album', ['Live'])).toBe('Live album');
    expect(releaseKind('EP', ['Live'])).toBe('Live EP');
    expect(releaseKind('Album', ['Compilation', 'Live'])).toBe('Compilation');
    expect(releaseKind('Album', ['DJ-mix'])).toBe('DJ mix');
    expect(releaseKind('Album', ['Mixtape/Street'])).toBe('Mixtape');
  });

  it('says something readable for Playarr’s loose songs and types it doesn’t know', () => {
    expect(releaseKind('Loose')).toBe('Loose songs');
    expect(releaseKind('Other')).toBe('Release');
    expect(releaseKind('')).toBe('Album');
    expect(releaseKind('Album', ['bonus'])).toBe('Bonus');
  });
});
