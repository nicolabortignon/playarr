import type { Track } from '@playarr/shared';
import { describe, expect, it, vi } from 'vitest';

const track = (codec: string, container: string) => ({ streamUrl: '/stream/7', format: { codec, container, lossless: true } }) as Track;

async function inBrowser(canPlayType: (type: string) => CanPlayTypeResult) {
  vi.resetModules();
  const { playableUrl, unplayableFormats } = await import('./playable');
  unplayableFormats({ canPlayType });
  return playableUrl;
}

describe('playableUrl', () => {
  it('asks for the WAV of a song in a lossless format the browser can’t play', async () => {
    const playableUrl = await inBrowser(() => '');
    expect(playableUrl(track('ALAC', 'm4a'))).toBe('/stream/7/lossless.wav');
    expect(playableUrl(track('PCM', 'aiff'))).toBe('/stream/7/lossless.wav');
    expect(playableUrl(track('FLAC', 'flac'))).toBe('/stream/7');
    expect(playableUrl({ streamUrl: '/transitions/abc.flac' })).toBe('/transitions/abc.flac');
  });

  it('keeps the file itself in a browser that plays it', async () => {
    const playableUrl = await inBrowser((type) => (type.includes('alac') ? 'maybe' : ''));
    expect(playableUrl(track('ALAC', 'm4a'))).toBe('/stream/7');
    expect(playableUrl(track('PCM', 'aiff'))).toBe('/stream/7/lossless.wav');
  });
});
