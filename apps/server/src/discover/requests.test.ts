import { join } from 'node:path';
import type { RequestSettings } from '@playarr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../catalog/testFixtures.ts';
import type { LidarrClient } from '../lidarr/client.ts';
import type { LidarrLookupAlbum } from '../lidarr/types.ts';
import type { Library } from '../library/library.ts';
import type { MusicBrainz } from './musicbrainz.ts';
import { type RequestDefaults, Requests } from './requests.ts';

const MBID = '11111111-2222-3333-4444-555555555555';

const lookup = (): LidarrLookupAlbum => ({
  title: 'Mezzanine',
  foreignAlbumId: MBID,
  albumType: 'Album',
  secondaryTypes: [],
  images: [],
  artist: { artistName: 'Massive Attack', foreignArtistId: 'artist-mbid' } as LidarrLookupAlbum['artist'],
});

function fakeLidarr() {
  return {
    configured: true,
    albumByMbid: vi.fn(async () => lookup()),
    rootFolders: vi.fn(async () => [
      { id: 1, path: '/music', accessible: true, defaultQualityProfileId: 2, defaultMetadataProfileId: 3 },
      { id: 2, path: '/more', accessible: true, defaultQualityProfileId: 4, defaultMetadataProfileId: 5 },
    ]),
    addAlbum: vi.fn(async (album: LidarrLookupAlbum) => ({ ...album, id: 42 })),
    monitorAlbums: vi.fn(async () => ({})),
    command: vi.fn(async () => ({ id: 7, name: 'AlbumSearch', status: 'queued' })),
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function setup(settings: Partial<RequestSettings> = {}, env: RequestDefaults = {}) {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const lidarr = fakeLidarr();
  const library = { albumByMbid: vi.fn(async () => undefined), refreshSoon: vi.fn() };
  const current: RequestSettings = { enabled: true, searchOnAdd: true, ...settings };
  const requests = new Requests(
    lidarr as unknown as LidarrClient,
    {} as MusicBrainz,
    library as unknown as Library,
    join(t.dir, 'requests.json'),
    () => current,
    env,
  );
  return { requests, lidarr, current };
}

const ref = { mbid: MBID, artistName: '', albumTitle: '' };
const addedArtist = (lidarr: ReturnType<typeof fakeLidarr>) => lidarr.addAlbum.mock.calls[0]![0].artist;

describe('Requests', () => {
  it('refuses requests when they are turned off, without asking Lidarr', async () => {
    const { requests, lidarr } = setup({ enabled: false });
    await expect(requests.request(ref)).rejects.toMatchObject({ status: 403, message: 'Requests are turned off in Settings' });
    expect(lidarr.albumByMbid).not.toHaveBeenCalled();
    expect(lidarr.addAlbum).not.toHaveBeenCalled();
    expect(lidarr.command).not.toHaveBeenCalled();
  });

  it('reads the settings on every request', async () => {
    const { requests, current } = setup();
    current.enabled = false;
    await expect(requests.request(ref)).rejects.toMatchObject({ status: 403 });
  });

  it('searches right away by default', async () => {
    const { requests, lidarr } = setup();
    const result = await requests.request(ref);
    expect(lidarr.command).toHaveBeenCalledWith('AlbumSearch', { albumIds: [42] });
    expect(result.availability.state).toBe('searching');
  });

  it('only adds and monitors when searching right away is off', async () => {
    const { requests, lidarr } = setup({ searchOnAdd: false });
    const result = await requests.request(ref);
    expect(lidarr.addAlbum).toHaveBeenCalled();
    expect(lidarr.command).not.toHaveBeenCalled();
    expect(result.availability).toEqual({ state: 'waiting', message: 'Added to Lidarr; it will search on its schedule' });
  });

  it('uses the root folder defaults when nothing is chosen', async () => {
    const { requests, lidarr } = setup();
    await requests.request(ref);
    expect(addedArtist(lidarr)).toMatchObject({ rootFolderPath: '/music', qualityProfileId: 2, metadataProfileId: 3 });
  });

  it('prefers Settings, then .env, then the root folder defaults', async () => {
    const { requests, lidarr } = setup(
      { qualityProfileId: 9 },
      { rootFolderPath: '/more', qualityProfileId: 8, metadataProfileId: 6 },
    );
    await requests.request(ref);
    expect(addedArtist(lidarr)).toMatchObject({ rootFolderPath: '/more', qualityProfileId: 9, metadataProfileId: 6 });
  });

  it('falls back to the .env root folder, then the first one, when the chosen one is gone', async () => {
    const withEnv = setup({ rootFolderPath: '/gone' }, { rootFolderPath: '/more' });
    await withEnv.requests.request(ref);
    expect(addedArtist(withEnv.lidarr)).toMatchObject({ rootFolderPath: '/more', qualityProfileId: 4 });
    const without = setup({ rootFolderPath: '/gone' });
    await without.requests.request(ref);
    expect(addedArtist(without.lidarr)).toMatchObject({ rootFolderPath: '/music', qualityProfileId: 2 });
  });
});
