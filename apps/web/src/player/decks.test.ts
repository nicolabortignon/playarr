import type { Track } from '@playarr/shared';
import { describe, expect, it } from 'vitest';
import { continues, fadeCurve, fadeSeconds, levelGain, upNext } from './decks';

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

  it('turns songs down by their own level, or by the album’s within an album', () => {
    const queue = [song(1), song(2), song(7, { albumId: 2 })];
    const s = { queue, order: [0, 1, 2], pos: 0, repeat: 'off' as const };
    const level = { track: -6, album: -3 };
    expect(levelGain(song(1), level, s)).toBeCloseTo(10 ** (-3 / 20));
    expect(levelGain(queue[2]!, level, s)).toBeCloseTo(10 ** (-6 / 20));
    expect(levelGain(song(1), undefined, s)).toBe(1);
  });
});
