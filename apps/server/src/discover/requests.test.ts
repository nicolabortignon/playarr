import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestSettings } from '@playarr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshDb, tempDir } from '../catalog/testFixtures.ts';
import type { LidarrClient } from '../lidarr/client.ts';
import type { LidarrLookupAlbum } from '../lidarr/types.ts';
import type { Library, LidarrAlbumRef } from '../library/library.ts';
import type { MusicBrainz } from './musicbrainz.ts';
import { type RequestDefaults, Requests, type RequestViewer } from './requests.ts';

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

/** A household: Alex (the owner, an admin, account 1), and Sam (2) and Zoe (3), members. */
function household(db = freshDb()) {
  db.prepare("UPDATE accounts SET name = 'Alex' WHERE id = 1").run();
  const add = db.prepare("INSERT INTO accounts (id, username, name, role, created_at) VALUES (?, ?, ?, 'member', '2026-11-05')");
  add.run(2, 'sam', 'Sam');
  add.run(3, 'zoe', 'Zoe');
  return db;
}
const ALEX: RequestViewer = { accountId: 1, everyone: true };
const SAM: RequestViewer = { accountId: 2, everyone: false };
const ZOE: RequestViewer = { accountId: 3, everyone: false };

/** Dates (and Date.now, which the status cache goes by) from `at`, until the test ends. */
function clockAt(at: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at));
  cleanups.push(() => vi.useRealTimers());
  return (later: string) => vi.setSystemTime(new Date(later));
}

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

  describe('belonging to whoever asked', () => {
    it('keeps the request of an account that asks first waiting for an admin, without adding anything to Lidarr', async () => {
      const { requests, lidarr } = setup({}, {}, {}, household());
      const asked = await requests.request(ref, 2, { askFirst: true });
      expect(asked).toMatchObject({ mbid: MBID, title: 'Mezzanine', mine: true, approval: 'waiting', availability: { state: 'waiting', message: 'Waiting for approval' } });
      expect(lidarr.addAlbum).not.toHaveBeenCalled();
      expect(lidarr.monitorAlbums).not.toHaveBeenCalled();
      expect(lidarr.command).not.toHaveBeenCalled();
      expect(await requests.list(SAM)).toMatchObject([{ mbid: MBID, mine: true, approval: 'waiting', unseen: false }]);
      expect(await requests.list(ZOE)).toEqual([]);
      // The admin sees who asked; anyone searching sees the album as nobody's request yet.
      expect(await requests.list(ALEX)).toMatchObject([{ mbid: MBID, mine: false, askedBy: ['Sam'], approval: 'waiting' }]);
      expect(await requests.availability(MBID)).toEqual({ state: 'none' });
    });

    it('sends a request on to Lidarr once an admin approves it, as asked for when it was', async () => {
      const { requests, lidarr } = setup({}, {}, {}, household());
      const later = clockAt('2026-11-07T10:00:00Z');
      await requests.request(ref, 2, { askFirst: true });
      later('2026-11-07T11:00:00Z');
      const approved = await requests.approve(MBID, ALEX);
      expect(lidarr.addAlbum).toHaveBeenCalledTimes(1);
      expect(lidarr.command).toHaveBeenCalledWith('AlbumSearch', { albumIds: [42] });
      expect(approved).toMatchObject({ availability: { state: 'searching' }, mine: false, askedBy: ['Sam'], requestedAt: '2026-11-07T10:00:00.000Z' });
      expect(approved.approval).toBeUndefined();
      expect(await requests.list(SAM)).toMatchObject([{ mine: true, availability: { state: 'searching' } }]);
      expect(await requests.availability(MBID)).toMatchObject({ state: 'searching' });
      // Approved twice: Lidarr hears of it once.
      await requests.approve(MBID, ALEX);
      expect(lidarr.addAlbum).toHaveBeenCalledTimes(1);
      await expect(requests.decline(MBID, ALEX)).rejects.toMatchObject({ status: 409 });
    });

    it('tells whoever asked that an admin declined, until they look; asked again, it waits again', async () => {
      const { requests, lidarr } = setup({}, {}, {}, household());
      const later = clockAt('2026-11-07T10:00:00Z');
      await requests.request(ref, 2, { askFirst: true });
      later('2026-11-07T10:05:00Z');
      expect(await requests.decline(MBID, ALEX)).toMatchObject({ approval: 'declined', availability: { state: 'failed', message: 'Declined by you' } });
      expect(await requests.list(SAM)).toMatchObject([{ approval: 'declined', availability: { state: 'failed', message: 'Declined by Alex' }, unseen: true }]);
      expect(lidarr.addAlbum).not.toHaveBeenCalled();
      later('2026-11-07T10:06:00Z');
      requests.markSeen(2);
      expect(await requests.list(SAM)).toMatchObject([{ approval: 'declined', unseen: false }]);
      await requests.request(ref, 2, { askFirst: true });
      expect(await requests.list(SAM)).toMatchObject([{ approval: 'waiting', availability: { message: 'Waiting for approval' }, unseen: false }]);
      await expect(requests.decline('no-such-request', ALEX)).rejects.toMatchObject({ status: 404 });
      await expect(requests.approve('no-such-request', ALEX)).rejects.toMatchObject({ status: 404 });
    });

    it('belongs to everyone who asked, and goes once nobody is left asking', async () => {
      const { requests } = setup({}, {}, {}, household());
      await requests.request(ref, 2, { askFirst: true });
      await requests.request(ref, 3, { askFirst: true });
      expect(await requests.list(ALEX)).toMatchObject([{ askedBy: ['Sam', 'Zoe'], mine: false }]);
      expect(await requests.list(ZOE)).toMatchObject([{ mbid: MBID, mine: true }]);
      // Off Zoe's list, it stays Sam's.
      await requests.remove(MBID, ZOE);
      expect(await requests.list(ZOE)).toEqual([]);
      expect(await requests.list(ALEX)).toMatchObject([{ askedBy: ['Sam'] }]);
      // Someone who doesn't ask for it can't take it off anyone's list.
      await requests.remove(MBID, ZOE);
      expect(await requests.list(SAM)).toHaveLength(1);
      await requests.remove(MBID, SAM);
      expect(await requests.list(ALEX)).toEqual([]);
    });

    it('forgets a request an admin takes off the list, for everyone who asked', async () => {
      const { requests } = setup({}, {}, {}, household());
      await requests.request(ref, 2);
      await requests.remove(MBID, ALEX);
      expect(await requests.list(SAM)).toEqual([]);
      expect(await requests.list(ALEX)).toEqual([]);
    });

    it('lists the requests waiting for an answer first for an admin, and newest first for a member', async () => {
      const OTHER = '99999999-2222-3333-4444-555555555555';
      const { requests, lidarr } = setup({}, {}, {}, household());
      const later = clockAt('2026-11-07T10:00:00Z');
      await requests.request(ref, 2, { askFirst: true });
      later('2026-11-07T11:00:00Z');
      lidarr.albumByMbid.mockResolvedValue({ ...lookup(), foreignAlbumId: OTHER, title: 'Heligoland' });
      await requests.request({ mbid: OTHER, artistName: '', albumTitle: '' }, 2);
      expect((await requests.list(ALEX)).map((r) => r.mbid)).toEqual([MBID, OTHER]);
      expect((await requests.list(SAM)).map((r) => r.mbid)).toEqual([OTHER, MBID]);
    });

    it('sends a waiting request on when an account that may request asks for it too', async () => {
      const { requests, lidarr } = setup({ searchOnAdd: false }, {}, {}, household());
      await requests.request(ref, 2, { askFirst: true });
      const sent = await requests.request(ref, 3);
      expect(lidarr.addAlbum).toHaveBeenCalledTimes(1);
      // Its first time in Lidarr: "Search right away" decides, as for any new request.
      expect(lidarr.command).not.toHaveBeenCalled();
      expect(sent).toMatchObject({ mine: true, availability: { state: 'waiting', message: 'Added to Lidarr; it will search on its schedule' } });
      expect(sent.approval).toBeUndefined();
      expect(await requests.list(SAM)).toMatchObject([{ mine: true, availability: { state: 'waiting' } }]);
      expect((await requests.list(SAM))[0]!.approval).toBeUndefined();
      expect(await requests.list(ALEX)).toMatchObject([{ askedBy: ['Sam', 'Zoe'] }]);
    });

    it('searches again when an account that asks first asks for an album already gone to Lidarr', async () => {
      const { requests, lidarr } = setup({ searchOnAdd: false }, {}, {}, household());
      await requests.request(ref, 3);
      lidarr.albumByMbid.mockResolvedValue({ ...lookup(), id: 42, monitored: true });
      const again = await requests.request(ref, 2, { askFirst: true });
      expect(again.approval).toBeUndefined();
      expect(lidarr.command).toHaveBeenCalledWith('AlbumSearch', { albumIds: [42] });
      expect(await requests.list(SAM)).toMatchObject([{ mine: true }]);
    });

    it('has an admin approve adding back an album Lidarr no longer wants, when an account that asks first asks for it', async () => {
      const { requests, lidarr } = setup({}, {}, {}, household());
      const later = clockAt('2026-11-07T10:00:00Z');
      await requests.request(ref, 3);
      expect(lidarr.addAlbum).toHaveBeenCalledTimes(1);
      // Removed from Lidarr since: its lookup has no Lidarr id any more.
      later('2026-11-08T10:00:00Z');
      expect(await requests.request(ref, 2, { askFirst: true })).toMatchObject({ approval: 'waiting' });
      expect(lidarr.addAlbum).toHaveBeenCalledTimes(1);
      expect(await requests.list(ALEX)).toMatchObject([{ approval: 'waiting', askedBy: ['Zoe', 'Sam'] }]);
      await requests.approve(MBID, ALEX);
      expect(lidarr.addAlbum).toHaveBeenCalledTimes(2);
      // In Lidarr, but no longer monitored there: wanting it again waits too.
      lidarr.albumByMbid.mockResolvedValue({ ...lookup(), id: 42, monitored: false });
      expect(await requests.request(ref, 2, { askFirst: true })).toMatchObject({ approval: 'waiting' });
      expect(lidarr.monitorAlbums).not.toHaveBeenCalled();
    });

    it('doesn’t bring back a request its asker takes back while an admin approves it', async () => {
      const { requests, lidarr } = setup({}, {}, {}, household());
      await requests.request(ref, 2, { askFirst: true });
      let added!: () => void;
      lidarr.addAlbum.mockImplementationOnce(async (album: LidarrLookupAlbum) => {
        await new Promise<void>((resolve) => (added = resolve));
        return { ...album, id: 42 };
      });
      const approving = requests.approve(MBID, ALEX);
      await vi.waitFor(() => expect(lidarr.addAlbum).toHaveBeenCalled());
      await requests.remove(MBID, SAM);
      added();
      await expect(approving).rejects.toMatchObject({ status: 409 });
      expect(await requests.list(ALEX)).toEqual([]);
    });

    it('tells whoever asked when the album of a request waiting for an answer arrives anyway', async () => {
      const { requests, library } = setup({}, {}, {}, household());
      const later = clockAt('2026-11-07T10:00:00Z');
      await requests.request(ref, 2, { askFirst: true });
      // From a folder, say: complete in the library, nothing left to approve.
      library.albumByMbid.mockResolvedValue({ monitored: false, albumId: 5 });
      later('2026-11-07T10:20:00Z');
      expect(await requests.list(SAM)).toMatchObject([{ availability: { state: 'available', albumId: 5 }, unseen: true }]);
      const [forAlex] = await requests.list(ALEX);
      expect(forAlex!.approval).toBeUndefined();
      expect(forAlex!.availability.state).toBe('available');
    });

    it('tells whoever asked when the album arrives, until they look at Requests', async () => {
      const { requests, library } = setup({}, {}, {}, household());
      const later = clockAt('2026-11-07T10:00:00Z');
      await requests.request(ref, 2);
      expect(await requests.list(SAM)).toMatchObject([{ availability: { state: 'searching' }, unseen: false }]);
      library.albumByMbid.mockResolvedValue({ monitored: true, albumId: 5 });
      later('2026-11-07T10:20:00Z');
      expect(await requests.list(SAM)).toMatchObject([{ availability: { state: 'available', albumId: 5 }, unseen: true }]);
      // An admin who didn't ask isn't told.
      const [forAlex] = await requests.list(ALEX);
      expect(forAlex).toMatchObject({ mine: false, askedBy: ['Sam'] });
      expect(forAlex!.unseen).toBeUndefined();
      later('2026-11-07T10:21:00Z');
      requests.markSeen(2, [MBID]);
      expect(await requests.list(SAM)).toMatchObject([{ unseen: false }]);
    });

    it('counts a request of before as arrived unless it’s still on its way, so only new arrivals are news', async () => {
      const ON_ITS_WAY = '99999999-2222-3333-4444-555555555555';
      const db = household();
      // As the migration leaves them: arrived when asked, and seen at the upgrade.
      const add = db.prepare(
        `INSERT INTO album_requests (mbid, keys, lidarr_album_id, title, artist_name, requested_at, requested_by, arrived_at) VALUES (?, '[]', ?, ?, 'Massive Attack', ?, 2, ?)`,
      );
      const asked = db.prepare(`INSERT INTO album_request_askers (mbid, account_id, asked_at, seen_at) VALUES (?, 2, ?, '2026-11-06T00:00:00.000Z')`);
      for (const [mbid, albumId, title, at] of [
        [MBID, 41, 'Mezzanine', '2026-11-02T00:00:00.000Z'],
        [ON_ITS_WAY, 42, 'Heligoland', '2026-11-01T00:00:00.000Z'],
      ] as const) {
        add.run(mbid, albumId, title, at, at);
        asked.run(mbid, at);
      }
      const { requests, library } = setup({}, {}, {}, db);
      library.albumByMbid.mockImplementation(async (mbid?: string) => (mbid === MBID ? { monitored: true, albumId: 5 } : undefined));
      const later = clockAt('2026-11-07T10:00:00Z');
      expect(await requests.list(SAM)).toMatchObject([
        { mbid: MBID, availability: { state: 'available' }, unseen: false },
        { mbid: ON_ITS_WAY, availability: { state: 'waiting' }, unseen: false },
      ]);
      library.albumByMbid.mockResolvedValue({ monitored: true, albumId: 6 });
      later('2026-11-07T10:20:00Z');
      expect(await requests.list(SAM)).toMatchObject([
        { mbid: MBID, unseen: false },
        { mbid: ON_ITS_WAY, availability: { state: 'available' }, unseen: true },
      ]);
    });

    /** A request of before, as the migration leaves it: arrived when asked, and seen at the upgrade. */
    function requestOfBefore() {
      const db = household();
      db.prepare(
        `INSERT INTO album_requests (mbid, keys, lidarr_album_id, title, artist_name, requested_at, requested_by, arrived_at)
         VALUES (?, '[]', 42, 'Mezzanine', 'Massive Attack', '2026-11-01T00:00:00.000Z', 2, '2026-11-01T00:00:00.000Z')`,
      ).run(MBID);
      db.prepare(`INSERT INTO album_request_askers (mbid, account_id, asked_at, seen_at) VALUES (?, 2, '2026-11-01T00:00:00.000Z', '2026-11-06T00:00:00.000Z')`).run(MBID);
      return setup({}, {}, {}, db);
    }

    it('counts a request of before on its way as the server starts as news when it arrives, though nobody looked in between', async () => {
      const { requests, library } = requestOfBefore();
      const later = clockAt('2026-11-07T10:00:00Z');
      await requests.lookAtStart();
      library.albumByMbid.mockResolvedValue({ monitored: true, albumId: 5 });
      later('2026-11-07T10:20:00Z');
      expect(await requests.list(SAM)).toMatchObject([{ availability: { state: 'available' }, unseen: true }]);
    });

    it('counts a request of before that had failed as news when it arrives', async () => {
      const { requests, library, lidarr } = requestOfBefore();
      lidarr.albumsByIds.mockResolvedValue([]);
      const later = clockAt('2026-11-07T10:00:00Z');
      expect(await requests.list(SAM)).toMatchObject([{ availability: { state: 'failed' }, unseen: false }]);
      library.albumByMbid.mockResolvedValue({ monitored: true, albumId: 5 });
      later('2026-11-07T10:20:00Z');
      expect(await requests.list(SAM)).toMatchObject([{ availability: { state: 'available' }, unseen: true }]);
    });

    it('counts an album asked for again as news when it arrives again', async () => {
      const { requests, library, lidarr } = setup({}, {}, {}, household());
      const later = clockAt('2026-11-07T10:00:00Z');
      await requests.request(ref, 2);
      library.albumByMbid.mockResolvedValue({ monitored: true, albumId: 5 });
      later('2026-11-07T10:20:00Z');
      expect(await requests.list(SAM)).toMatchObject([{ unseen: true }]);
      requests.markSeen(2);
      // Its files went, it was asked for again, and it was back before anyone looked.
      library.albumByMbid.mockResolvedValue({ monitored: true, lidarrId: 42 });
      lidarr.albumByMbid.mockResolvedValue({ ...lookup(), id: 42, monitored: true });
      later('2026-11-08T10:00:00Z');
      await requests.request(ref, 2);
      library.albumByMbid.mockResolvedValue({ monitored: true, lidarrId: 42, albumId: 5 });
      later('2026-11-08T10:20:00Z');
      expect(await requests.list(SAM)).toMatchObject([{ availability: { state: 'available' }, unseen: true }]);
    });
  });
});
