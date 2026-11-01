import type { AlbumDetail, Artist, Track } from '@playarr/shared';
import { describe, expect, it } from 'vitest';
import { freshDb } from '../catalog/testFixtures.ts';
import { History } from './history.ts';
import { listeningStats, longestStreak, rangeBounds } from './stats.ts';

const song = (id: number, artistId: number): Track =>
  ({ id, recordingId: `rec-${id}`, artistId, albumId: artistId * 10, title: `Song ${id}`, artistName: `Artist ${artistId}`, duration: 200 }) as Track;

describe('listening stats', () => {
  it('knows its periods and streaks', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    expect(rangeBounds('2025', now)).toEqual({ from: '2025-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' });
    expect(rangeBounds('month', now).from).toBe('2026-10-04T12:00:00.000Z');
    expect(rangeBounds('all', now).from).toBeUndefined();
    expect(longestStreak(['2026-01-01', '2026-01-02', '2026-01-02', '2026-01-03', '2026-01-05', '2026-01-06'])).toBe(3);
    expect(longestStreak([])).toBe(0);
  });

  it('adds up a year: top artists, albums and songs, hours, months, new artists and the first song', async () => {
    const db = freshDb();
    const tracks = [song(1, 1), song(2, 1), song(3, 2), song(4, 3)];
    const library = {
      track: async (id: number) => tracks.find((t) => t.id === id),
      trackByRecording: async (r: string) => tracks.find((t) => t.recordingId === r),
      tracksByRecordings: async (ids: string[]) => tracks.filter((t) => ids.includes(t.recordingId)),
      artists: async () => [1, 2, 3].map((id) => ({ id, name: `Artist ${id}` }) as Artist),
      album: async (id: number) => ({ id, title: `Album ${id}`, genres: id === 10 ? ['rock'] : ['jazz'], tracks: [] }) as unknown as AlbumDetail,
    };
    const history = new History(db, library);
    const play = (trackId: number, at: string, seconds = 180, hour = 21, skipped = false) =>
      history.record([{ trackId, recordingId: `rec-${trackId}`, at, hour, weekday: 5, seconds, skipped }]);
    await play(4, '2025-12-31T10:00:00Z'); // last year: artist 3 isn't new in 2026
    await play(1, '2026-01-02T08:00:00Z', 120, 8);
    await play(1, '2026-01-03T21:00:00Z');
    await play(2, '2026-01-04T21:00:00Z');
    await play(3, '2026-03-10T21:00:00Z', 200);
    await play(4, '2026-03-11T21:00:00Z');
    await play(3, '2026-03-12T21:00:00Z', 10, 21, true); // skipped: doesn't count

    const stats = await listeningStats(db, library, '2026');
    expect(stats).toMatchObject({ plays: 5, songs: 4, artists: 3, days: 5, longestStreak: 3, newArtists: 2, minutes: 14 });
    expect(stats.topArtists.map((a) => [a.artist.name, a.plays])).toEqual([
      ['Artist 1', 3],
      ['Artist 2', 1],
      ['Artist 3', 1],
    ]);
    expect(stats.topTracks[0]).toMatchObject({ track: { id: 1 }, plays: 2 });
    expect(stats.topAlbums[0]!.album.id).toBe(10);
    expect(stats.topGenres[0]).toEqual({ genre: 'rock', minutes: 8 });
    expect(stats.hours[21]).toBe(12);
    expect(stats.hours[8]).toBe(2);
    expect(stats.months![0]).toBe(8);
    expect(stats.months![2]).toBe(6);
    expect(stats.firstSong).toMatchObject({ track: { id: 1 }, at: '2026-01-02T08:00:00.000Z' });
    expect(stats.years).toEqual([2026, 2025]);
    expect((await listeningStats(db, library, 'all')).plays).toBe(6);
  });
});
