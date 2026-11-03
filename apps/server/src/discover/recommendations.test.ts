import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryView } from '../library/library.ts';
import type { Playlists } from '../playlists.ts';
import { Recommendations } from './recommendations.ts';
import type { Requests } from './requests.ts';

afterEach(() => vi.unstubAllGlobals());

const KNOWN = '11111111-1111-1111-1111-111111111111';
const FOUND = '22222222-2222-2222-2222-222222222222';

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
    const recs = new Recommendations(playlists, {} as Requests, { searchRecordings });
    const viewer = { account: 1, library: {} as LibraryView };
    const result = await recs.forPlaylist(viewer, 76);
    expect(asked.sort()).toEqual([KNOWN, FOUND].sort());
    expect(result.seedCount).toBe(2);
    // Found once, remembered after.
    await recs.forPlaylist(viewer, 76, 0);
    expect(searchRecordings).toHaveBeenCalledTimes(2);
  });
});
