import type { Track } from '@playarr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshDb } from '../catalog/testFixtures.ts';
import { Favorites } from '../favorites.ts';
import { songKey, type LibraryView } from '../library/library.ts';
import type { Playlists } from '../playlists.ts';
import type { LbSimilarRecording } from './listenbrainz.ts';
import { Recommendations } from './recommendations.ts';
import type { Requests } from './requests.ts';

afterEach(() => vi.unstubAllGlobals());

const KNOWN = '11111111-1111-1111-1111-111111111111';
const FOUND = '22222222-2222-2222-2222-222222222222';
/** A MusicBrainz id of its own for each number. ListenBrainz's answers are kept per seed, so each test has its own. */
const mbid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const song = (recordingId: string, title: string, artistName: string): Track =>
  ({ id: Number.parseInt(recordingId.slice(-6), 10), recordingId, title, artistName, albumTitle: 'Album', artistId: 1, albumId: 1 }) as Track;

/** A library of these songs, found by recording or by name. */
const libraryOf = (tracks: Track[]) =>
  ({
    trackByRecording: async (id: string) => tracks.find((t) => t.recordingId === id),
    trackByName: async (artist: string, title: string) => tracks.find((t) => songKey(t.artistName, t.title) === songKey(artist, title)),
    artistIdByMbid: async () => undefined,
  }) as unknown as LibraryView;

const requests = { availability: async () => ({ state: 'none' }), availabilityByName: async () => ({ state: 'none' }) } as unknown as Requests;

/** ListenBrainz answering every seed with the same similar recordings; returns the seeds it's asked about, in order. */
function listenBrainz(similar: Partial<LbSimilarRecording>[]): string[] {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!url.includes('similar-recordings')) return new Response('{}');
      const seed = new URL(url).searchParams.get('recording_mbids')!;
      asked.push(seed);
      return new Response(JSON.stringify(similar.map((r) => ({ score: 100, reference_mbid: seed, ...r }))));
    }),
  );
  return asked;
}

describe('Recommendations', () => {
  it('looks up songs known only from their tags on MusicBrainz, and asks ListenBrainz about them', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const id = new URL(url).searchParams.get('recording_mbids');
        if (url.includes('similar-recordings')) asked.push(id!);
        return new Response(url.includes('similar-recordings') ? '[]' : '{}');
      }),
    );
    const playlists = {
      get: async () => ({
        items: [
          { recordingId: KNOWN, title: 'Angel', artistName: 'Massive Attack' },
          { recordingId: 'local:abc', title: 'Bye Bye Bye', artistName: 'NSYNC' },
          { recordingId: 'local:def', title: 'Unknown Song', artistName: 'Nobody' },
        ],
      }),
    } as unknown as Playlists;
    const searchRecordings = vi.fn(async (_artist: string, title: string) =>
      title === 'Bye Bye Bye' ? [{ id: FOUND, score: 100 }] : [{ id: 'weak', score: 40 }],
    );
    const recs = new Recommendations(playlists, {} as Favorites, {} as Requests, { searchRecordings });
    const viewer = { account: 1, library: {} as LibraryView };
    const result = await recs.forPlaylist(viewer, 76);
    expect(asked.sort()).toEqual([KNOWN, FOUND].sort());
    expect(result.seedCount).toBe(2);
    // Found once, remembered after.
    await recs.forPlaylist(viewer, 76, 0);
    expect(searchRecordings).toHaveBeenCalledTimes(2);
  });

  it('starts from songs spread evenly through a playlist, and suggests none of its songs', async () => {
    const items = Array.from({ length: 20 }, (_, i) => song(mbid(401 + i), `Song ${i + 1}`, `Artist ${i + 1}`));
    const gloryBox = song(mbid(600), 'Glory Box', 'Portishead');
    const asked = listenBrainz([
      { recording_mbid: mbid(402), recording_name: 'Song 2', artist_credit_name: 'Artist 2', release_name: 'Album' },
      { recording_mbid: mbid(500), recording_name: 'Song 5', artist_credit_name: 'Artist 5', release_name: 'Single' },
      { recording_mbid: gloryBox.recordingId, recording_name: 'Glory Box', artist_credit_name: 'Portishead', release_name: 'Dummy' },
    ]);
    const playlists = { get: async () => ({ items }) } as unknown as Playlists;
    const recs = new Recommendations(playlists, {} as Favorites, requests);
    const result = await recs.forPlaylist({ account: 1, library: libraryOf([...items, gloryBox]) }, 3);
    // Every other song: the 1st, 3rd, … 19th.
    expect(asked).toEqual(items.filter((_, i) => i % 2 === 0).map((t) => t.recordingId));
    expect(result.seedCount).toBe(10);
    expect(result.owned.map((r) => [r.title, r.because])).toEqual([['Glory Box', 'Song 1']]);
    expect(result.missing).toEqual([]);
  });

  it('starts Favorites from the songs favorited last, and suggests none of the favorites, playable or not', async () => {
    const db = freshDb();
    const favorites = new Favorites(db);
    const hearted = Array.from({ length: 12 }, (_, i) => song(mbid(101 + i), `Song ${i + 1}`, `Artist ${i + 1}`));
    hearted.forEach((t, i) => favorites.add(1, t, `2026-01-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`));
    // Hearted, but gone from the library since: not on Favorites, so not a seed, but not suggested either.
    favorites.add(1, song(mbid(150), 'Teardrop', 'Massive Attack'), '2026-02-01T12:00:00.000Z');
    // Another account's favorite is suggested as any other song.
    const gloryBox = song(mbid(200), 'Glory Box', 'Portishead');
    favorites.add(2, gloryBox);
    const asked = listenBrainz([
      { recording_mbid: mbid(101), recording_name: 'Song 1', artist_credit_name: 'Artist 1', release_name: 'Album' },
      { recording_mbid: mbid(302), recording_name: 'Song 2', artist_credit_name: 'Artist 2', release_name: 'Single' },
      { recording_mbid: mbid(150), recording_name: 'Teardrop', artist_credit_name: 'Massive Attack', release_name: 'Mezzanine' },
      { recording_mbid: mbid(351), recording_name: 'Teardrop', artist_credit_name: 'Massive Attack feat. Elizabeth Fraser', release_name: 'Mezzanine (Deluxe)' },
      { recording_mbid: gloryBox.recordingId, recording_name: 'Glory Box', artist_credit_name: 'Portishead', release_name: 'Dummy' },
      { recording_mbid: mbid(201), recording_name: 'Roads', artist_credit_name: 'Portishead', release_name: 'Dummy' },
    ]);
    const recs = new Recommendations({} as Playlists, favorites, requests);
    const result = await recs.forFavorites({ account: 1, library: libraryOf([...hearted, gloryBox]) });
    // The ten favorited last, newest first.
    expect(asked).toEqual(hearted.slice(2).reverse().map((t) => t.recordingId));
    expect(result.seedCount).toBe(10);
    expect(result.owned.map((r) => [r.title, r.because])).toEqual([['Glory Box', 'Song 12']]);
    expect(result.missing.map((r) => r.title)).toEqual(['Roads']);
  });

  it('has no seeds without favorites it can play', async () => {
    const favorites = new Favorites(freshDb());
    favorites.add(1, song(mbid(160), 'Teardrop', 'Massive Attack'));
    const asked = listenBrainz([]);
    const recs = new Recommendations({} as Playlists, favorites, requests);
    expect(await recs.forFavorites({ account: 1, library: libraryOf([]) })).toEqual({ owned: [], missing: [], seedCount: 0 });
    expect(asked).toEqual([]);
  });
});
