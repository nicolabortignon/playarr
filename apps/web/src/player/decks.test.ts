import type { Track } from '@playarr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { continues, fadeCurve, fadeSeconds, isDesktop, levelGain, playsAlbum, upNext } from './decks';

const song = (fileId: number, over: Partial<Track> = {}) =>
  ({ fileId, id: fileId, recordingId: `r${fileId}`, albumId: 1, discNumber: 1, trackNumber: fileId, duration: 200, ...over }) as Track;

describe('decks', () => {
  it('knows the song that plays next on its own', () => {
    const queue = [song(1), song(2), song(3)];
    const s = { queue, order: [0, 1, 2], pos: 1, repeat: 'off' as const };
    expect(upNext(s)?.fileId).toBe(3);
    expect(upNext({ ...s, pos: 2 })).toBeUndefined();
    expect(upNext({ ...s, pos: 2, repeat: 'all' })?.fileId).toBe(1);
    expect(upNext({ ...s, repeat: 'one' })).toBeUndefined();
  });

  it('never fades within an album played in order, nor for more than a third of a song', () => {
    expect(continues(song(1), song(2))).toBe(true);
    expect(continues(song(9, { discNumber: 1 }), song(1, { discNumber: 2 }))).toBe(true);
    expect(continues(song(1), song(3))).toBe(false);
    expect(fadeSeconds(song(1), song(2), 6)).toBe(0);
    expect(fadeSeconds(song(1), song(3), 6)).toBe(6);
    expect(fadeSeconds(song(1), song(3, { duration: 9 }), 6)).toBe(3);
    expect(fadeCurve(0)).toBe(0);
    expect(fadeCurve(1)).toBe(1);
  });

  it('knows a queue that plays the song’s album, or its artist’s albums, from one that doesn’t', () => {
    const a = song(1, { albumId: 5, artistId: 3 });
    expect(playsAlbum({ label: 'Album', href: '/albums/5' }, a)).toBe(true);
    expect(playsAlbum({ label: 'Artist', href: '/artists/3' }, a)).toBe(true);
    expect(playsAlbum({ label: 'Mine', href: '/playlists/7' }, a)).toBe(false);
    expect(playsAlbum({ label: 'Another', href: '/albums/6' }, a)).toBe(false);
    // Saved before sources were kept: as the album.
    expect(playsAlbum(undefined, a)).toBe(true);
  });

  it('turns songs down by their own level, or by the album’s within an album', () => {
    const queue = [song(1), song(2), song(7, { albumId: 2 })];
    const s = { queue, order: [0, 1, 2], pos: 0, repeat: 'off' as const };
    const level = { track: -6, album: -3 };
    expect(levelGain(song(1), level, s)).toBeCloseTo(10 ** (-3 / 20));
    expect(levelGain(queue[2]!, level, s)).toBeCloseTo(10 ** (-6 / 20));
    expect(levelGain(song(1), undefined, s)).toBe(1);
  });
});

describe('desktop or not (where Web Audio plays on with the screen locked)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const device = (userAgent: string, maxTouchPoints: number, fine: boolean) => {
    vi.stubGlobal('navigator', { userAgent, maxTouchPoints });
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: fine)' && fine }));
  };

  it('is a desktop browser with a mouse or trackpad', () => {
    device('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15', 0, true);
    expect(isDesktop()).toBe(true);
    device('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36', 0, true);
    expect(isDesktop()).toBe(true);
  });

  it('isn’t an iPhone, an iPad (even asking for desktop pages, with a trackpad), or an Android phone', () => {
    device('Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1', 5, false);
    expect(isDesktop()).toBe(false);
    device('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15', 5, true);
    expect(isDesktop()).toBe(false);
    device('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36', 5, false);
    expect(isDesktop()).toBe(false);
  });
});
