import { describe, expect, it, vi } from 'vitest';
import type { LidarrClient } from '../lidarr/client.ts';
import type { Library } from '../library/library.ts';
import { Discover } from './discover.ts';
import type { MbReleaseGroup, MusicBrainz } from './musicbrainz.ts';
import type { Requests } from './requests.ts';

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const credit = (id: string, name: string, joinphrase?: string) => ({ name, artist: { id, name }, ...(joinphrase ? { joinphrase } : {}) });

describe('an artist page without Lidarr', () => {
  const discover = (groups: MbReleaseGroup[]) =>
    new Discover(
      { artistByMbid: vi.fn(async () => Promise.reject(new Error('No Lidarr'))) } as unknown as LidarrClient,
      { artistReleaseGroups: vi.fn(async () => groups) } as unknown as MusicBrainz,
      { artistIdByMbid: vi.fn(async () => undefined) } as unknown as Library,
      { availability: vi.fn(async () => 'missing') } as unknown as Requests,
    );

  it("takes the artist's name from MusicBrainz's credits, even when the first group it lists is a collaboration", async () => {
    const page = await discover([
      { id: 'collab', title: 'Together', 'primary-type': 'Album', 'first-release-date': '2020', 'artist-credit': [credit('other', 'Someone', ' & '), credit(RADIOHEAD, 'Radiohead')] },
      { id: 'okc', title: 'OK Computer', 'primary-type': 'Album', 'first-release-date': '1997', 'artist-credit': [credit(RADIOHEAD, 'Radiohead')] },
    ]).artist(RADIOHEAD);
    expect(page.name).toBe('Radiohead');
    expect(page.albums.map((a) => a.artistName)).toEqual(['Radiohead', 'Radiohead']);
  });
});
