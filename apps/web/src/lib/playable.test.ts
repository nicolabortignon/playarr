import { afterEach, describe, expect, it } from 'vitest';
import { declareUnplayableFormats } from './playable';

afterEach(() => (document.cookie = 'playarr_pcm=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'));

describe('declareUnplayableFormats', () => {
  it('lists the lossless formats the browser can’t play', () => {
    declareUnplayableFormats({ canPlayType: (type: string) => (type === 'audio/aiff' ? '' : 'maybe') });
    expect(document.cookie).toContain('playarr_pcm=AIFF');
    declareUnplayableFormats({ canPlayType: () => '' });
    expect(document.cookie).toContain('playarr_pcm=ALAC.AIFF');
  });

  it('clears the list in a browser that plays them all', () => {
    declareUnplayableFormats({ canPlayType: () => '' });
    declareUnplayableFormats({ canPlayType: () => 'probably' });
    expect(document.cookie).not.toContain('playarr_pcm');
  });
});
