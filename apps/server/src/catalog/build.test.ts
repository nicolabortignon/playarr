import { describe, expect, it } from 'vitest';
import { buildCatalog, compareCopies, looksIncomplete } from './build.ts';
import { CatalogStore } from './store.ts';
import { FLAC, FLAC_24, MP3, freshDb, mezzanine } from './testFixtures.ts';

function lidarrOnly() {
  const db = freshDb();
  const store = new CatalogStore(db);
  store.applySync(store.ensureSource('lidarr', 'Lidarr'), mezzanine());
  return { db, store };
}

describe('buildCatalog', () => {
  it('builds albums and tracks the way the API returns them', () => {
    const c = buildCatalog(lidarrOnly().store.load());
    const album = c.albums.get(70)!;
    expect(album).toMatchObject({
      id: 70,
      title: 'Mezzanine',
      artistId: 7,
      artistName: 'Massive Attack',
      year: 1998,
      genres: ['trip hop'], // album has none: falls back to the artist's
      duration: 379 + 298,
      trackCount: 2,
      totalTrackCount: 11,
      discCount: 1,
      addedAt: '2026-10-02T10:00:00.000Z', // when the album last got a song: its newest file
      format: FLAC,
      missingTracks: [],
    });
    expect(album.tracks.map((t) => t.title)).toEqual(['Angel', 'Risingson']); // sorted by number
    expect(album.tracks[0]).toEqual({
      id: 700,
      recordingId: 'rec-1',
      fileId: 9000,
      albumId: 70,
      artistId: 7,
      title: 'Angel',
      artistName: 'Massive Attack',
      albumTitle: 'Mezzanine',
      trackNumber: 1,
      discNumber: 1,
      duration: 379,
      explicit: false,
      format: FLAC,
      size: 40_000_000,
      streamUrl: '/stream/9000',
      // No artwork from Lidarr: the release group's own cover.
      // No cover in Lidarr: the picture in its first song, else its MusicBrainz cover (catalog/build.ts embeddedCoverUrl).
      coverUrl: '/art/copy/9000?embedded=1&mbid=rg-1',
    });
    expect(c.artists.get(7)).toMatchObject({ name: 'Massive Attack', albumCount: 1, trackCount: 2 });
    expect(c.tracks.map((t) => t.id)).toEqual([700, 701]);
    expect(c.files.get(9000)).toMatchObject({ path: '/music/Massive Attack/Mezzanine/01.flac', sourceId: 1 });
    expect(c.stats).toMatchObject({ artists: 1, albums: 1, tracks: 2, durationSeconds: 677, sizeBytes: 70_000_000 });
  });

  it('maps release groups to Lidarr albums and to playable library albums', () => {
    const c = buildCatalog(lidarrOnly().store.load());
    // The fixture has 2 of Mezzanine's 11 songs: playable, and partial.
    expect(c.albumsByMbid.get('rg-1')).toEqual({ lidarrId: 70, monitored: true, albumId: 70, have: 2, total: 11 });
    expect(c.albumsByMbid.get('rg-2')).toEqual({ lidarrId: 71, monitored: true, albumId: undefined });
    expect(c.artistIdByMbid.get('art-1')).toBe(7);
  });

  it('leaves out songs, albums and artists without copies', () => {
    const { store } = lidarrOnly();
    const sync = mezzanine();
    sync.copies = [];
    store.applySync(1, sync);
    const c = buildCatalog(store.load());
    expect([c.artists.size, c.albums.size, c.tracks.length]).toEqual([0, 0, 0]);
  });

  it('lists the songs a source reports without a file', () => {
    const { store } = lidarrOnly();
    const sync = mezzanine();
    sync.tracks.push({ ...sync.tracks[1]!, key: 'mb:rg-1#rec-3', preferredId: 702, recordingId: 'rec-3', title: 'Teardrop', trackNumber: 3, duration: 330 });
    store.applySync(1, sync);
    const album = buildCatalog(store.load()).albums.get(70)!;
    expect(album.missingTracks).toEqual([{ recordingId: 'rec-3', title: 'Teardrop', trackNumber: 3, discNumber: 1, duration: 330 }]);
    expect(album.trackCount).toBe(2);
    // No longer reported: no longer missing.
    store.applySync(1, mezzanine());
    expect(buildCatalog(store.load()).albums.get(70)!.missingTracks).toEqual([]);
  });

  it('draws folder albums without artwork from their files', () => {
    const db = freshDb();
    const store = new CatalogStore(db);
    const folder = store.addSource('folder', 'Music');
    const sync = mezzanine();
    sync.copies = sync.copies.map((c) => ({ ...c, preferredId: undefined }));
    store.applySync(folder, sync);
    const album = buildCatalog(store.load()).albums.get(70)!;
    const first = album.tracks[0]!;
    expect(album.coverUrl).toBe(`/art/copy/${first.fileId}`);
    expect(first.coverUrl).toBe(album.coverUrl);
  });

  it('draws a folder album’s cover from a folder that holds the album; from a folder of mixed songs, only a song’s own picture', () => {
    const store = new CatalogStore(freshDb());
    const singles = store.addSource('folder', 'One song each');
    const albums = store.addSource('folder', 'Albums');
    const album = (key: string, title: string, mbid?: string) => ({ key, artistKey: 'a', title, albumType: 'Album', secondaryTypes: [], genres: [], ...(mbid ? { mbid } : {}) });
    const track = (key: string, albumKey: string, trackNumber: number) => ({ key, albumKey, recordingId: key, title: key, trackNumber, discNumber: 1, duration: 200, explicit: false });
    const copy = (ref: string, trackKey: string, path: string) => ({ ref, trackKey, path, size: 1, format: FLAC });
    const artists = [{ key: 'a', name: 'Coldplay', sortName: 'Coldplay', genres: [] }];
    // A folder of songs from many albums: Parachutes' song 1, and two others'.
    store.applySync(singles, {
      artists,
      albums: [album('parachutes', 'Parachutes', 'rg-p'), album('x', 'X&Y', 'rg-x'), album('demo', 'Demo')],
      tracks: [track('yellow', 'parachutes', 1), track('fix', 'x', 1), track('demo1', 'demo', 1)],
      copies: [copy('y', 'yellow', '/one/Yellow.mp3'), copy('f', 'fix', '/one/Fix You.mp3'), copy('d', 'demo1', '/one/Demo.mp3')],
    });
    const cover = (title: string) => [...buildCatalog(store.load()).albums.values()].find((a) => a.title === title)!.coverUrl;
    // Nothing from that folder's images: the picture in the album's own song, and when it has none, the release
    // group's cover if the album is identified.
    const parachutesAlone = [...buildCatalog(store.load()).albums.values()].find((a) => a.title === 'Parachutes')!;
    expect(cover('Parachutes')).toBe(`/art/copy/${parachutesAlone.tracks[0]!.fileId}?embedded=1&mbid=rg-p`);
    const demo = [...buildCatalog(store.load()).albums.values()].find((a) => a.title === 'Demo')!;
    expect(cover('Demo')).toBe(`/art/copy/${demo.tracks[0]!.fileId}?embedded=1`);
    // Parachutes' own folder, with another of its songs: its cover comes from there, whatever song comes first.
    store.applySync(albums, {
      artists,
      albums: [album('parachutes', 'Parachutes', 'rg-p')],
      tracks: [track('trouble', 'parachutes', 6)],
      copies: [copy('t', 'trouble', '/albums/Coldplay/Parachutes/06 Trouble.flac')],
    });
    const parachutes = [...buildCatalog(store.load()).albums.values()].find((a) => a.title === 'Parachutes')!;
    const trouble = parachutes.tracks.find((t) => t.title === 'trouble')!;
    expect(parachutes.tracks[0]!.title).toBe('yellow');
    expect(parachutes.coverUrl).toBe(`/art/copy/${trouble.fileId}`);
  });

  describe('best copy', () => {
    function twoSources(lidarrFormat: typeof FLAC, folderFormat: typeof FLAC) {
      const { db, store } = lidarrOnly();
      const lidarr = mezzanine();
      lidarr.copies[0]!.format = lidarrFormat;
      store.applySync(1, lidarr);
      const folder = mezzanine();
      folder.copies = [{ ...folder.copies[0]!, ref: 'Mezzanine/01.flac', preferredId: undefined, format: folderFormat }];
      store.applySync(store.addSource('folder', 'Music'), folder);
      return { db, store, folderCopyId: Math.max(...store.load().copies.map((c) => c.id)) };
    }

    it('plays the better quality, whatever the source order', () => {
      const { store, folderCopyId } = twoSources(MP3, FLAC);
      const c = buildCatalog(store.load());
      expect(c.albums.get(70)!.tracks[0]!.fileId).toBe(folderCopyId);
      expect(c.files.has(9000)).toBe(true); // other copies stay streamable (saved queues)
    });

    it('breaks ties with the source order', () => {
      const { store } = twoSources(FLAC, FLAC);
      expect(buildCatalog(store.load()).albums.get(70)!.tracks[0]!.fileId).toBe(9000);
    });

    it('skips disabled sources', () => {
      const { db, store, folderCopyId } = twoSources(MP3, FLAC);
      db.prepare('UPDATE sources SET enabled = 0 WHERE kind = ?').run('folder');
      const c = buildCatalog(store.load());
      expect(c.albums.get(70)!.tracks[0]!.fileId).toBe(9000);
      expect(c.files.has(folderCopyId)).toBe(false);
    });

    it('keeps each song’s copies, best first, for when one can’t be read', () => {
      const { store, folderCopyId } = twoSources(MP3, FLAC);
      const c = buildCatalog(store.load());
      const song = c.albums.get(70)!.tracks[0]!;
      expect(c.copies.get(song.id)!.map((f) => f.id)).toEqual([folderCopyId, 9000]);
      expect(c.files.get(9000)!.trackId).toBe(song.id);
      // A song with one copy needs no list.
      expect(c.copies.has(c.albums.get(70)!.tracks[1]!.id)).toBe(false);
    });

    it('plays a copy on a source that answers while the better one’s source doesn’t, and only then', () => {
      const { store, folderCopyId } = twoSources(MP3, FLAC);
      const folder = store.load().copies.find((c) => c.id === folderCopyId)!.sourceId;
      const away = buildCatalog(store.load(), new Set([folder]));
      const song = away.albums.get(70)!.tracks[0]!;
      expect(song.fileId).toBe(9000);
      expect(song.format).toEqual(MP3);
      expect(song.streamUrl).toBe('/stream/9000');
      expect(away.copies.get(song.id)!.map((f) => f.id)).toEqual([9000, folderCopyId]);
      // Still in the library, still streamable: a saved queue's copy is tried in case it's back.
      expect(away.files.has(folderCopyId)).toBe(true);
      expect(buildCatalog(store.load()).albums.get(70)!.tracks[0]!.fileId).toBe(folderCopyId);
    });

    it('keeps the songs whose only copies are on a source that doesn’t answer', () => {
      const { store } = lidarrOnly();
      const c = buildCatalog(store.load(), new Set([1]));
      expect(c.albums.get(70)!.tracks[0]!.fileId).toBe(9000);
    });

    it('keeps an album’s embedded cover while the source of its first song’s best copy is away', () => {
      const store = new CatalogStore(freshDb());
      const first = store.addSource('folder', 'Lossless');
      const second = store.addSource('folder', 'Phone copies');
      // A folder of songs from several albums, so no folder's pictures are Demo's cover: its song's own picture is.
      const track = (key: string, albumKey: string) => ({ key, albumKey, recordingId: key, title: key, trackNumber: 1, discNumber: 1, duration: 200, explicit: false });
      const sync = (dir: string, format: typeof FLAC) => ({
        artists: [{ key: 'a', name: 'Coldplay', sortName: 'Coldplay', genres: [] }],
        albums: ['demo', 'x', 'y'].map((key) => ({ key, artistKey: 'a', title: key, albumType: 'Album', secondaryTypes: [], genres: [] })),
        tracks: [track('demo1', 'demo'), track('x1', 'x'), track('y1', 'y')],
        copies: ['demo1', 'x1', 'y1'].map((key) => ({ ref: `${dir}/${key}`, trackKey: key, path: `${dir}/${key}`, size: 1, format })),
      });
      store.applySync(first, sync('/lossless', FLAC));
      store.applySync(second, sync('/phone', MP3));
      const demo = (offline?: Set<number>) => [...buildCatalog(store.load(), offline).albums.values()].find((a) => a.title === 'demo')!;
      const here = demo();
      const away = demo(new Set([first]));
      expect(away.tracks[0]!.fileId).not.toBe(here.tracks[0]!.fileId);
      expect(away.coverUrl).toBe(here.coverUrl);
      expect(here.coverUrl).toBe(`/art/copy/${here.tracks[0]!.fileId}?embedded=1`);
    });
  });
});

describe('compareCopies', () => {
  const at = (format: typeof FLAC, position = 0) => ({ format, position });
  it('ranks lossless, then bit depth, then source order', () => {
    expect(compareCopies(at(FLAC), at(MP3))).toBeLessThan(0);
    expect(compareCopies(at(FLAC_24), at(FLAC))).toBeLessThan(0);
    expect(compareCopies(at(FLAC, 0), at(FLAC, 1))).toBeLessThan(0);
    expect(compareCopies(at(MP3, 0), at(FLAC, 1))).toBeGreaterThan(0);
  });

  it('ranks a copy on a source that answers above any on one that doesn’t', () => {
    expect(compareCopies(at(MP3, 1), { ...at(FLAC_24, 0), offline: true })).toBeLessThan(0);
    expect(compareCopies({ ...at(FLAC, 0), offline: true }, { ...at(MP3, 1), offline: true })).toBeLessThan(0);
  });
});

describe('looksIncomplete', () => {
  const t = (...numbers: number[]) => numbers.map((trackNumber) => ({ trackNumber, discNumber: 1 }));
  it('takes one song, or songs with gaps in their numbers, for part of an album', () => {
    expect(looksIncomplete(t(3))).toBe(true);
    expect(looksIncomplete(t(1))).toBe(true);
    expect(looksIncomplete(t(1, 2, 5))).toBe(true);
    expect(looksIncomplete(t(2, 3))).toBe(true);
  });
  it('takes songs numbered 1, 2, 3… on each disc for a whole album', () => {
    expect(looksIncomplete(t(1, 2, 3))).toBe(false);
    expect(looksIncomplete([...t(1, 2), { trackNumber: 1, discNumber: 2 }, { trackNumber: 2, discNumber: 2 }])).toBe(false);
  });
});
