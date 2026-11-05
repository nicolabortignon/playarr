import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestSettings } from '@playarr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshDb, tempDir } from '../catalog/testFixtures.ts';
import type { LidarrClient } from '../lidarr/client.ts';
import type { LidarrLookupAlbum } from '../lidarr/types.ts';
import type { Library, LidarrAlbumRef } from '../library/library.ts';
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
    queue: vi.fn(async () => []),
    albumsByIds: vi.fn(async (): Promise<unknown[]> => [
      { id: 42, monitored: true, statistics: { trackFileCount: 0, trackCount: 12, totalTrackCount: 12, sizeOnDisk: 0, percentOfTracks: 0 } },
    ]),
    commandStatus: vi.fn(async () => ({ id: 7, name: 'AlbumSearch', status: 'started' })),
    monitorAlbums: vi.fn(async () => ({})),
    command: vi.fn(async () => ({ id: 7, name: 'AlbumSearch', status: 'queued' })),
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function setup(
  settings: Partial<RequestSettings> = {},
  env: RequestDefaults = {},
  mb: Partial<MusicBrainz> = {},
  db = freshDb(),
  legacyFile?: string,
) {
  const lidarr = fakeLidarr();
  const library = {
    albumByMbid: vi.fn(async (): Promise<LidarrAlbumRef | undefined> => undefined),
    albumIdByName: vi.fn(async (): Promise<number | undefined> => undefined),
    album: vi.fn(async (): Promise<unknown> => undefined),
    refreshSoon: vi.fn(),
  };
  const current: RequestSettings = { enabled: true, searchOnAdd: true, ...settings };
  const requests = new Requests(
    lidarr as unknown as LidarrClient,
    mb as MusicBrainz,
    library as unknown as Library,
    { db, legacyFile },
    () => current,
    env,
  );
  return { requests, lidarr, current, library, db };
}

const ref = { mbid: MBID, artistName: '', albumTitle: '' };
const addedArtist = (lidarr: ReturnType<typeof fakeLidarr>) => lidarr.addAlbum.mock.calls[0]![0].artist;

describe('Requests', () => {
  it('keeps requests in the database, with who asked first, across restarts', async () => {
    const db = freshDb();
    db.prepare("INSERT INTO accounts (id, username, name, role, created_at) VALUES (2, 'sam', 'Sam', 'member', '2026-11-05')").run();
    const first = setup({}, {}, {}, db);
    await first.requests.request(ref, 2);
    await first.requests.request(ref, 1);
    const again = setup({}, {}, {}, db);
    expect(await again.requests.list()).toHaveLength(1);
    expect(db.prepare('SELECT requested_by FROM album_requests').get()).toEqual({ requested_by: 2 });
    await again.requests.remove(MBID);
    expect(await setup({}, {}, {}, db).requests.list()).toEqual([]);
  });

  it('moves the cache folder’s requests.json of before into the database, once', async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const file = join(t.dir, 'requests.json');
    const old = { mbid: MBID, keys: ['a|b'], lidarrAlbumId: 7, title: 'Mezzanine', artistName: 'Massive Attack', requestedAt: '2026-11-01T00:00:00.000Z' };
    writeFileSync(file, JSON.stringify([old]));
    const db = freshDb();
    expect(await setup({}, {}, {}, db, file).requests.list()).toMatchObject([{ mbid: MBID, title: 'Mezzanine' }]);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.imported`)).toBe(true);
    expect(await setup({}, {}, {}, db, file).requests.list()).toHaveLength(1);
  });

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

  it('searches when asked again for an album already requested, even when searching right away is off', async () => {
    const { requests, lidarr } = setup({ searchOnAdd: false });
    await requests.request(ref);
    lidarr.albumByMbid.mockResolvedValue({ ...lookup(), id: 42 });
    const again = await requests.request(ref);
    expect(lidarr.monitorAlbums).toHaveBeenCalledWith([42], true);
    expect(lidarr.command).toHaveBeenCalledWith('AlbumSearch', { albumIds: [42] });
    expect(again.availability.state).toBe('searching');
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

  it('refreshes the library when files land, once for each batch rather than at every look', async () => {
    const { requests, library, lidarr } = setup();
    await requests.request(ref);
    library.refreshSoon.mockClear();
    const withFiles = (trackFileCount: number) => [
      { id: 42, monitored: true, statistics: { trackFileCount, trackCount: 12, totalTrackCount: 12, sizeOnDisk: 1, percentOfTracks: 0 } },
    ];
    const now = vi.spyOn(Date, 'now');
    const look = async (minute: number) => {
      now.mockReturnValue(minute * 60_000);
      return (await requests.availability(MBID)).state;
    };
    lidarr.albumsByIds.mockResolvedValue(withFiles(3));
    expect(await look(1)).toBe('importing');
    expect(await look(2)).toBe('importing');
    expect(library.refreshSoon).toHaveBeenCalledTimes(1);
    lidarr.albumsByIds.mockResolvedValue(withFiles(5));
    await look(3);
    expect(library.refreshSoon).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  describe('albums with only some of their songs in the library', () => {
    const partial: LidarrAlbumRef = { monitored: false, albumId: 5, have: 1, total: 12 };

    it('can still be requested, and say how many songs are already here', async () => {
      const { requests, library, lidarr } = setup();
      library.albumByMbid.mockResolvedValue(partial);
      expect(await requests.availability(MBID)).toEqual({ state: 'partial', albumId: 5, have: 1, total: 12 });
      await requests.request(ref);
      expect(lidarr.addAlbum).toHaveBeenCalled();
      expect(lidarr.command).toHaveBeenCalledWith('AlbumSearch', { albumIds: [42] });
    });

    it('asks Lidarr to monitor and search when it already knows the album', async () => {
      const { requests, library, lidarr } = setup();
      library.albumByMbid.mockResolvedValue({ ...partial, lidarrId: 9 });
      await requests.request(ref);
      expect(lidarr.monitorAlbums).toHaveBeenCalledWith([9], true);
      expect(lidarr.addAlbum).not.toHaveBeenCalled();
    });

    it('show the request’s progress, with the album still reachable, until Lidarr has every track', async () => {
      const { requests, library, lidarr } = setup();
      library.albumByMbid.mockResolvedValue(partial);
      await requests.request(ref);
      expect(await requests.availability(MBID)).toMatchObject({ state: 'searching', albumId: 5, have: 1, total: 12 });
      lidarr.albumsByIds.mockResolvedValue([
        { id: 42, monitored: true, statistics: { trackFileCount: 12, trackCount: 12, totalTrackCount: 12, sizeOnDisk: 1, percentOfTracks: 100 } },
      ]);
      // A fresh Requests instance reads the saved request and has no status cache.
      const again = setup();
      again.library.albumByMbid.mockResolvedValue(partial);
      again.lidarr.albumsByIds.mockImplementation(lidarr.albumsByIds);
      await again.requests.request(ref);
      expect((await again.requests.availability(MBID)).state).toBe('available');
    });

    it('wait for the rest once the library has the songs Lidarr found, without refreshing the library again', async () => {
      const { requests, library, lidarr } = setup();
      library.albumByMbid.mockResolvedValue(partial);
      await requests.request(ref);
      library.refreshSoon.mockClear();
      lidarr.commandStatus.mockResolvedValue({ id: 7, name: 'AlbumSearch', status: 'completed' });
      lidarr.albumsByIds.mockResolvedValue([
        { id: 42, monitored: true, statistics: { trackFileCount: 1, trackCount: 12, totalTrackCount: 12, sizeOnDisk: 1, percentOfTracks: 8 } },
      ]);
      const now = vi.spyOn(Date, 'now');
      for (let look = 1; look <= 3; look++) {
        now.mockReturnValue(look * 60_000);
        expect(await requests.availability(MBID)).toMatchObject({ state: 'waiting', albumId: 5, have: 1, total: 12 });
      }
      expect(library.refreshSoon).not.toHaveBeenCalled();
      now.mockRestore();
    });

    it('still refuse an album that is complete', async () => {
      const { requests, library } = setup();
      library.albumByMbid.mockResolvedValue({ monitored: false, albumId: 5 });
      expect(await requests.availability(MBID)).toEqual({ state: 'available', albumId: 5 });
      await expect(requests.request(ref)).rejects.toMatchObject({ status: 409 });
    });

    it('are found by name too', async () => {
      const { requests, library } = setup();
      library.albumIdByName.mockResolvedValue(5);
      library.album.mockResolvedValue({ trackCount: 3, totalTrackCount: 10 });
      expect(await requests.availabilityByName('Massive Attack', 'Mezzanine')).toEqual({ state: 'partial', albumId: 5, have: 3, total: 10 });
      library.album.mockResolvedValue({ trackCount: 10, totalTrackCount: 10 });
      expect(await requests.availabilityByName('Massive Attack', 'Mezzanine')).toEqual({ state: 'available', albumId: 5 });
    });
  });

  it('finds an album whose files call the artist by another name MusicBrainz knows them by', async () => {
    const mb = {
      searchReleaseGroups: vi.fn(async () => []),
      searchArtists: vi.fn(async () => [{ id: 'nsync', name: '*NSYNC', score: 100 }]),
      artistReleaseGroups: vi.fn(async () => [
        { id: 'other', title: 'Celebrity', 'primary-type': 'Album' },
        { id: MBID, title: 'No Strings Attached', 'primary-type': 'Album' },
      ]),
    } as unknown as Partial<MusicBrainz>;
    const { requests, lidarr } = setup({}, {}, mb);
    await requests.request({ artistName: 'N Sync', albumTitle: 'No Strings Attached' });
    expect(mb.searchArtists).toHaveBeenCalledWith('N Sync');
    expect(lidarr.albumByMbid).toHaveBeenCalledWith(MBID);
  });
});
