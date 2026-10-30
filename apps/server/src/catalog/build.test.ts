import { describe, expect, it } from 'vitest';
import { buildCatalog, compareCopies } from './build.ts';
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
      addedAt: '2026-10-02T10:00:00Z',
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
    });
    expect(c.artists.get(7)).toMatchObject({ name: 'Massive Attack', albumCount: 1, trackCount: 2 });
    expect(c.tracks.map((t) => t.id)).toEqual([700, 701]);
    expect(c.files.get(9000)).toMatchObject({ path: '/music/Massive Attack/Mezzanine/01.flac', sourceId: 1 });
    expect(c.stats).toMatchObject({ artists: 1, albums: 1, tracks: 2, durationSeconds: 677, sizeBytes: 70_000_000 });
  });

  it('maps release groups to Lidarr albums and to playable library albums', () => {
    const c = buildCatalog(lidarrOnly().store.load());
    expect(c.albumsByMbid.get('rg-1')).toEqual({ lidarrId: 70, monitored: true, albumId: 70 });
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
});
