import type { Album, AlbumSort, Artist, SearchResults } from '@playarr/shared';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { buildCatalog, type Catalog } from '../catalog/build.ts';
import { CatalogStore } from '../catalog/store.ts';
import { twoSources } from '../accounts/testAccess.ts';
import { CC_REC, creativeCommons, freshDb, mezzanine, MP3 } from '../catalog/testFixtures.ts';
import type { CatalogSource, SourceSync } from '../catalog/types.ts';
import { coverArtArchive } from '../discover/art.ts';
import { syntheticLibrary } from '../testing/syntheticLibrary.ts';
import { CoverColorStore } from './coverColorStore.ts';
import { Library, stripAlbum } from './library.ts';
import { albumKey, normalize, scoreMatch, scoreNearMatch } from './search.ts';

const log = { info: () => {}, error: () => {} };
const png = (color: string) => sharp({ create: { width: 64, height: 64, channels: 3, background: color } }).png().toBuffer();
const ok: CatalogSource = { kind: 'lidarr', sync: async () => mezzanine() };
const broken: CatalogSource = {
  kind: 'folder',
  sync: async () => {
    throw new Error('Drive not mounted');
  },
};

describe('Library', () => {
  it('records a failing source and keeps the others', async () => {
    const store = new CatalogStore(freshDb());
    const a = store.addSource('lidarr', 'Lidarr');
    const b = store.addSource('folder', 'Drive');
    const library = new Library(store, () => [{ id: a, source: ok }, { id: b, source: broken }], log);
    await library.refresh();
    expect((await library.albums()).map((x) => x.title)).toEqual(['Mezzanine']);
    expect(store.source(b)!.lastError).toBe('Drive not mounted');
    expect(store.source(a)!.lastError).toBeUndefined();
  });

  it('fails the refresh when every source fails', async () => {
    const store = new CatalogStore(freshDb());
    const b = store.addSource('folder', 'Drive');
    const library = new Library(store, () => [{ id: b, source: broken }], log);
    await expect(library.refresh()).rejects.toThrow('Drive not mounted');
  });

  it('syncs a source in turn with the moving of its files (sourceLocks)', async () => {
    const store = new CatalogStore(freshDb());
    const a = store.addSource('lidarr', 'Lidarr');
    let listed!: () => void;
    const sync = vi.fn(async () => {
      await new Promise<void>((resolve) => (listed = resolve));
      return mezzanine();
    });
    const library = new Library(store, () => [{ id: a, source: { kind: 'lidarr', sync } }], log);
    const refreshed = library.refresh();
    await vi.waitFor(() => expect(sync).toHaveBeenCalled());
    let moved = false;
    const moving = library.sourceLocks.run(a, async () => {
      moved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(moved).toBe(false);
    listed();
    await refreshed;
    await moving;
    expect(moved).toBe(true);
  });

  it('reloads from the store without syncing', async () => {
    const store = new CatalogStore(freshDb());
    const a = store.addSource('lidarr', 'Lidarr');
    const sync = vi.fn(async () => mezzanine());
    const library = new Library(store, () => [{ id: a, source: { kind: 'lidarr', sync } }], log);
    await library.refresh();
    expect(library.refreshing).toBe(false);
    store.removeSource(a);
    library.reload();
    expect(await library.albums()).toEqual([]);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('rebuilds from the last scan without syncing any source', async () => {
    const store = new CatalogStore(freshDb());
    const a = store.addSource('lidarr', 'Lidarr');
    const b = store.addSource('folder', 'Drive');
    const lidarrSync = vi.fn(async () => mezzanine());
    const folderSync = vi.fn(async () => ({ artists: [], albums: [], tracks: [], copies: [] }));
    // Matches landed since: the folder's last scan now makes an album of its own.
    const cached = vi.fn(() => creativeCommons());
    const library = new Library(
      store,
      () => [
        { id: a, source: { kind: 'lidarr', sync: lidarrSync } },
        { id: b, source: { kind: 'folder', sync: folderSync, cached } },
      ],
      log,
    );
    const refreshed = vi.fn();
    library.onRefresh(refreshed);
    await library.refresh();
    await library.rebuild();
    expect(lidarrSync).toHaveBeenCalledTimes(1);
    expect(folderSync).toHaveBeenCalledTimes(1);
    expect(cached).toHaveBeenCalledTimes(1);
    expect(refreshed).toHaveBeenCalledTimes(2);
    expect((await library.albums()).map((x) => x.title).sort()).toEqual(['Mezzanine', 'Royalty Free']);
  });

  it('syncs sources in order, so later ones see what earlier ones reported', async () => {
    const store = new CatalogStore(freshDb());
    const a = store.addSource('lidarr', 'Lidarr');
    const b = store.addSource('folder', 'Drive');
    const seen: number[] = [];
    const later: CatalogSource = {
      kind: 'folder',
      sync: async () => {
        seen.push(store.load().copies.length);
        return { artists: [], albums: [], tracks: [], copies: [] };
      },
    };
    const library = new Library(store, () => [{ id: a, source: ok }, { id: b, source: later }], log);
    await library.refresh();
    expect(seen).toEqual([2]);
  });
});

describe('stripAlbum', () => {
  it('keeps album lists small: no tracks, overview or missing songs', () => {
    const detail = {
      id: 70,
      title: 'Mezzanine',
      artistId: 7,
      artistName: 'Massive Attack',
      albumType: 'Album',
      secondaryTypes: [],
      genres: [],
      duration: 677,
      trackCount: 2,
      totalTrackCount: 11,
      mbid: 'rg-1',
      overview: 'A long text',
      discCount: 1,
      tracks: [],
      missingTracks: [{ recordingId: 'rec-3', title: 'Teardrop', trackNumber: 3, discNumber: 1, duration: 330 }],
    };
    const listed = stripAlbum(detail);
    expect(listed).not.toHaveProperty('missingTracks');
    expect(listed).not.toHaveProperty('tracks');
    expect(listed).not.toHaveProperty('overview');
    // What cards need stays: how complete it is, and what to request.
    expect(listed).toMatchObject({ trackCount: 2, totalTrackCount: 11, mbid: 'rg-1' });
  });
});

describe('Library search', () => {
  const library = async () => {
    const store = new CatalogStore(freshDb());
    const a = store.addSource('lidarr', 'Lidarr');
    const lib = new Library(store, () => [{ id: a, source: ok }], log);
    await lib.refresh();
    return lib;
  };

  it('offers near matches, marked as such, when nothing matches as typed', async () => {
    const found = await (await library()).search('massive atack');
    expect(found.near).toBe(true);
    expect(found.artists.map((a) => a.name)).toEqual(['Massive Attack']);
    expect(found.albums.map((a) => a.title)).toEqual(['Mezzanine']);
  });

  it('keeps to what matches as typed when something does', async () => {
    const found = await (await library()).search('angel');
    expect(found.near).toBeUndefined();
    expect(found.tracks.map((t) => t.title)).toEqual(['Angel']);
  });
});

describe('library views', () => {
  it('shows only the songs with a copy in the view’s sources, and their albums and artists', async () => {
    const { library, lidarr, cc } = await twoSources();
    const ccOnly = library.view([cc]);
    expect((await ccOnly.artists()).map((a) => a.name)).toEqual(['Kevin MacLeod']);
    expect((await ccOnly.albums()).map((a) => a.title)).toEqual(['Royalty Free']);
    expect((await ccOnly.allTracks()).map((t) => t.recordingId)).toEqual([CC_REC]);
    expect(await ccOnly.album(70)).toBeUndefined();
    expect(await ccOnly.artist(7)).toBeUndefined();
    expect(await ccOnly.track(700)).toBeUndefined();
    expect(await ccOnly.trackByRecording('rec-1')).toBeUndefined();
    expect(await ccOnly.file(9000)).toBeUndefined();
    expect(await ccOnly.search('angel')).toEqual({ artists: [], albums: [], tracks: [] });
    expect((await ccOnly.stats())?.tracks).toBe(1);
    expect(await ccOnly.hasArtwork('album', 70)).toBe(false);
    expect(await library.hasArtwork('album', 70)).toBe(true);
    expect((await library.view([lidarr]).albums()).map((a) => a.title)).toEqual(['Mezzanine']);
    expect(library.view(null)).toBe(library);
    expect(await library.allTracks()).toHaveLength(3);
  });

  it('builds a view once per snapshot, shared by every account with the same sources', async () => {
    const { library, lidarr, cc } = await twoSources();
    expect(library.view([cc, lidarr])).toBe(library.view([lidarr, cc]));
    const view = library.view([cc]);
    const first = await view.allTracks();
    expect(await view.allTracks()).toBe(first);
    library.reload();
    expect(await view.allTracks()).not.toBe(first);
    expect(view.version).toBe(library.version);
    expect(view.sources).toEqual([cc]);
  });

  it('gives albums and their songs their cover’s colors: in lists, songs and views', async () => {
    const colors = new CoverColorStore(freshDb());
    await colors.offer('album/70/0', await png('#0000ff'));
    const { library, lidarr } = await twoSources(colors);
    const blue = { coverColor: '#0000ff', coverAccent: '#6e6ef7' };
    const album = (await library.album(70))!;
    expect(album).toMatchObject(blue);
    expect(album.tracks.map((t) => t.id)).toEqual([700, 701]);
    for (const track of album.tracks) expect(track).toMatchObject(blue);
    expect((await library.albums()).find((a) => a.id === 70)).toMatchObject(blue);
    expect(await library.track(701)).toMatchObject(blue);
    expect(await library.view([lidarr]).album(70)).toMatchObject(blue);
    // The folder album's cover hasn't been read yet.
    const unread = (await library.album(80))!;
    expect(unread.coverUrl).toBe('/art/copy/9100');
    expect(unread).not.toHaveProperty('coverColor');
  });

  it('colors albums as their covers are read, in the library and the views already built', async () => {
    const colors = new CoverColorStore(freshDb());
    const { library, cc } = await twoSources(colors);
    const view = library.view([cc]);
    expect(await view.album(80)).not.toHaveProperty('coverColor');
    await colors.offer('copy/9100/5000000', await png('#808080'));
    expect(await library.album(80)).toMatchObject({ coverColor: '#808080' });
    expect(await view.track(800)).toMatchObject({ coverColor: '#808080' });
    // A gray cover has no accent to give: answers leave it out.
    expect(JSON.parse(JSON.stringify(await view.album(80)))).not.toHaveProperty('coverAccent');
  });

  it('lists the covers whose colors can be read, once each, newest albums first', async () => {
    const { library } = await twoSources();
    expect(library.coverImages().map((image) => image.key)).toEqual(['copy/9100/5000000', 'album/70/0']);
  });

  it('colors an album without a cover of its own by its first song’s picture, its MusicBrainz cover standing in', async () => {
    const colors = new CoverColorStore(freshDb());
    const store = new CatalogStore(freshDb());
    const lidarr = store.addSource('lidarr', 'Lidarr');
    // Mezzanine has no picture in Lidarr: its cover is the one in its first song's file, else the Cover Art Archive's.
    const library = new Library(store, () => [{ id: lidarr, source: ok }], log, colors);
    await library.refresh();
    const file = (await library.file(9000))!;
    await colors.offer(`copy/9000/${file.size}/embedded`, await png('#0000ff'));
    await library.refresh();
    const album = (await library.album(70))!;
    expect(album.coverUrl).toBe('/art/copy/9000?embedded=1&mbid=rg-1');
    expect(album).toMatchObject({ coverColor: '#0000ff', coverAccent: '#6e6ef7' });
    expect(library.coverImages()).toEqual([{ key: `copy/9000/${file.size}/embedded`, kind: 'copy', file, embedded: true, mbid: 'rg-1' }]);
    expect(library.hasCover(`remote/${coverArtArchive('rg-1', 500)}`)).toBe(false);
  });

  it('plays the best copy the view’s sources have', async () => {
    const store = new CatalogStore(freshDb());
    const lidarr = store.addSource('lidarr', 'Lidarr');
    const cc = store.addSource('folder', 'Creative Commons');
    const mezz = mezzanine();
    const angel = mezz.tracks.find((t) => t.recordingId === 'rec-1')!;
    const alsoHere: SourceSync = {
      artists: mezz.artists,
      albums: mezz.albums,
      tracks: [angel],
      copies: [{ ref: 'angel.mp3', trackKey: angel.key, path: '/cc/angel.mp3', size: 9_000_000, format: MP3 }],
    };
    const library = new Library(
      store,
      () => [
        { id: lidarr, source: { kind: 'lidarr', sync: async () => mezz } },
        { id: cc, source: { kind: 'folder', sync: async () => alsoHere } },
      ],
      log,
    );
    await library.refresh();
    expect((await library.track(700))?.fileId).toBe(9000); // lossless wins
    const mp3 = (await library.view([cc]).track(700))!;
    expect(mp3.format.codec).toBe('MP3');
    expect(await library.view([cc]).file(9000)).toBeUndefined();
    expect(await library.view([cc]).file(mp3.fileId)).toMatchObject({ sourceId: cc });
  });

  /** Angel on Lidarr (FLAC, copy 9000) and in a Creative Commons folder (MP3). */
  async function angelTwice() {
    const store = new CatalogStore(freshDb());
    const lidarr = store.addSource('lidarr', 'Lidarr');
    const cc = store.addSource('folder', 'Creative Commons');
    const mezz = mezzanine();
    const angel = mezz.tracks.find((t) => t.recordingId === 'rec-1')!;
    const alsoHere: SourceSync = {
      artists: mezz.artists,
      albums: mezz.albums,
      tracks: [angel],
      copies: [{ ref: 'angel.mp3', trackKey: angel.key, path: '/cc/angel.mp3', size: 9_000_000, format: MP3 }],
    };
    const library = new Library(
      store,
      () => [
        { id: lidarr, source: { kind: 'lidarr', sync: async () => mezz } },
        { id: cc, source: { kind: 'folder', sync: async () => alsoHere } },
      ],
      log,
    );
    await library.refresh();
    const mp3 = (await library.view([cc]).track(700))!.fileId;
    return { library, lidarr, cc, mp3 };
  }

  it('lists a song’s copies, best first, for when one can’t be read: those the view’s sources have', async () => {
    const { library, cc, mp3 } = await angelTwice();
    expect((await library.copiesOf(9000)).map((f) => f.id)).toEqual([9000, mp3]);
    expect((await library.copiesOf(mp3)).map((f) => f.id)).toEqual([9000, mp3]);
    expect((await library.view([cc]).copiesOf(mp3)).map((f) => f.id)).toEqual([mp3]);
    expect(await library.view([cc]).copiesOf(9000)).toEqual([]);
    // A song with one copy.
    expect((await library.copiesOf(9001)).map((f) => f.id)).toEqual([9001]);
  });

  it('plays songs from a source that answers while another doesn’t, in the library and its views, until it’s back', async () => {
    const { library, lidarr, cc, mp3 } = await angelTwice();
    const both = library.view([lidarr, cc]);
    expect((await both.track(700))!.fileId).toBe(9000);
    const listened = vi.fn();
    library.onRefresh(listened);
    const version = library.version;

    library.setOffline(new Set([lidarr]));
    expect((await library.track(700))!.fileId).toBe(mp3);
    expect((await both.track(700))!.fileId).toBe(mp3);
    expect((await library.copiesOf(9000)).map((f) => f.id)).toEqual([mp3, 9000]);
    // Songs only Lidarr has are still there.
    expect((await library.track(701))!.fileId).toBe(9001);
    expect(library.version).toBe(version + 1);
    expect(listened).toHaveBeenCalledTimes(1);
    // Told again, nothing changes.
    library.setOffline(new Set([lidarr]));
    expect(library.version).toBe(version + 1);

    library.setOffline(new Set());
    expect((await library.track(700))!.fileId).toBe(9000);
    expect((await both.track(700))!.fileId).toBe(9000);
  });

  it('says how each source’s sync went', async () => {
    const store = new CatalogStore(freshDb());
    const a = store.addSource('lidarr', 'Lidarr');
    const b = store.addSource('folder', 'Drive');
    const library = new Library(store, () => [{ id: a, source: ok }, { id: b, source: broken }], log);
    const synced: [number, string | null][] = [];
    library.onSync((id, err) => synced.push([id, err?.message ?? null]));
    await library.refresh();
    expect(synced).toEqual([
      [a, null],
      [b, 'Drive not mounted'],
    ]);
  });
});

describe('Library: refreshes that find nothing new', () => {
  function twoSourcesOf(syncs: { lidarr: () => SourceSync; folder: () => SourceSync }) {
    const store = new CatalogStore(freshDb());
    const lidarr = store.addSource('lidarr', 'Lidarr');
    const folder = store.addSource('folder', 'Drive');
    const library = new Library(
      store,
      () =>
        store
          .listSources()
          .filter((s) => s.enabled)
          .map((s) => ({ id: s.id, source: { kind: s.kind, sync: async () => (s.id === lidarr ? syncs.lidarr() : syncs.folder()) } })),
      log,
    );
    return { store, library, lidarr, folder };
  }

  it('keeps its snapshot, and still tells its listeners (they try again what failed)', async () => {
    const { library } = twoSourcesOf({ lidarr: mezzanine, folder: creativeCommons });
    const refreshed = vi.fn();
    library.onRefresh(refreshed);
    await library.refresh();
    const version = library.version;
    const tracks = await library.allTracks();
    await library.refresh();
    expect(library.version).toBe(version);
    expect(await library.allTracks()).toBe(tracks);
    expect(refreshed).toHaveBeenCalledTimes(2);
  });

  it('rebuilds when a source has something new, is turned off, moved or removed', async () => {
    let title = 'Mezzanine';
    const { store, library, lidarr, folder } = twoSourcesOf({
      lidarr: () => {
        const sync = mezzanine();
        sync.albums[0]!.title = title;
        return sync;
      },
      folder: creativeCommons,
    });
    await library.refresh();
    let version = library.version;
    const rebuilt = async (change: () => void) => {
      change();
      await library.refresh();
      const moved = library.version > version;
      version = library.version;
      return moved;
    };
    expect(await rebuilt(() => (title = 'Mezzanine (Remastered)'))).toBe(true);
    expect((await library.albums()).map((a) => a.title)).toContain('Mezzanine (Remastered)');
    expect(await rebuilt(() => {})).toBe(false);
    expect(await rebuilt(() => store.updateSource(folder, { enabled: false }))).toBe(true);
    expect((await library.albums()).map((a) => a.title)).toEqual(['Mezzanine (Remastered)']);
    expect(await rebuilt(() => store.updateSource(folder, { enabled: true }))).toBe(true);
    expect(await rebuilt(() => store.reorderSources([folder, lidarr]))).toBe(true);
    expect(await rebuilt(() => store.removeSource(folder))).toBe(true);
    expect((await library.albums()).map((a) => a.title)).toEqual(['Mezzanine (Remastered)']);
  });

  it('says it was refreshed just now, as its sources were, and so do the views of some of them', async () => {
    const { library, lidarr, folder } = twoSourcesOf({ lidarr: mezzanine, folder: creativeCommons });
    await library.refresh();
    const first = (await library.stats())!.refreshedAt;
    // One view built before the refresh, one after it.
    expect((await library.view([folder]).stats())!.refreshedAt).toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await library.refresh();
    const now = (await library.stats())!.refreshedAt;
    expect(now > first).toBe(true);
    expect((await library.view([folder]).stats())!.refreshedAt).toBe(now);
    expect((await library.view([lidarr]).stats())!.refreshedAt > first).toBe(true);
  });

  it('leaves its snapshot after a rebuild from the last scan that changes nothing, and tells no one', async () => {
    const store = new CatalogStore(freshDb());
    const folder = store.addSource('folder', 'Drive');
    const library = new Library(store, () => [{ id: folder, source: { kind: 'folder', sync: async () => creativeCommons(), cached: () => creativeCommons() } }], log);
    const refreshed = vi.fn();
    library.onRefresh(refreshed);
    await library.refresh();
    const version = library.version;
    await library.rebuild();
    expect(library.version).toBe(version);
    expect(refreshed).toHaveBeenCalledTimes(1);
  });
});

/**
 * The library's indexes and sorted lists (plan 3 §1) against the plain ways they replaced, on a synthetic library
 * with the variety of real tags: names in several scripts, featured artists, compilations, editions.
 */
describe('Library at a collector’s size', () => {
  const setup = async () => {
    const lib = syntheticLibrary({ tracks: 1500 });
    const store = new CatalogStore(freshDb());
    const id = store.addSource('lidarr', 'Lidarr');
    /** What Lidarr reports: change it, and the next refresh finds the change. */
    const lidarr = { sync: lib.lidarr() };
    // Names of nothing but punctuation, which search sees as no text at all: the band !!!, an album "…", a song "?".
    lidarr.sync.artists[0]!.name = '!!!';
    lidarr.sync.albums[1]!.title = '…';
    lidarr.sync.tracks[2]!.title = '?';
    const library = new Library(store, () => [{ id, source: { kind: 'lidarr', sync: async () => lidarr.sync } }], log);
    await library.refresh();
    // The same rows build the same catalog, in the same order: what the library had before its indexes.
    return { lib, lidarr, library, catalog: buildCatalog(store.load()) };
  };

  /** Search as it was: every name normalized again on every search, each album and song's two texts joined first. */
  function searchedPlainly(catalog: Catalog, query: string, limit = 20): SearchResults {
    const q = normalize(query);
    if (!q) return { artists: [], albums: [], tracks: [] };
    const rank = <T>(items: Iterable<T>, fields: (item: T) => string[], score = scoreMatch) =>
      [...items]
        .map((item) => ({ item, score: Math.max(...fields(item).map((f) => score(q, f))) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((r) => r.item);
    const found: SearchResults = {
      artists: rank(catalog.artists.values(), (a) => [a.name]),
      albums: rank(catalog.albums.values(), (a) => [a.title, `${a.artistName} ${a.title}`]),
      tracks: rank(catalog.tracks, (t) => [t.title, `${t.artistName} ${t.title}`]),
    };
    if (found.artists.length || found.albums.length || found.tracks.length) return found;
    const near: SearchResults = {
      artists: rank(catalog.artists.values(), (a) => [a.name], scoreNearMatch),
      albums: rank(catalog.albums.values(), (a) => [`${a.artistName} ${a.title}`], scoreNearMatch),
      tracks: rank(catalog.tracks, (t) => [`${t.artistName} ${t.title}`], scoreNearMatch),
    };
    return near.artists.length || near.albums.length || near.tracks.length ? { ...near, near: true } : found;
  }

  const ids = (found: SearchResults) => ({
    artists: found.artists.map((a) => a.id),
    albums: found.albums.map((a) => a.id),
    tracks: found.tracks.map((t) => t.id),
    near: found.near,
  });

  it('finds what searching every name afresh found, in the same order', async () => {
    const { lib, library, catalog } = await setup();
    const queries = [
      ...lib.queries.map((x) => x.q),
      // Accents, other scripts, punctuation alone, a final sigma, numbers, several words in another order.
      'ÆGIR', 'sørensen', 'ελένη', 'ΝΎΧΤΑ', '東京', '!!!', '   ', '', '2011', 'remaster', 'deluxe edition', 'night love', 'a',
    ];
    for (const q of queries) {
      expect(ids(await library.search(q)), q).toEqual(ids(searchedPlainly(catalog, q)));
      expect(ids(await library.search(q, 5)), `${q}, 5`).toEqual(ids(searchedPlainly(catalog, q, 5)));
    }
    // Some found something, some something near, some nothing: each way was compared.
    const results = await Promise.all(queries.map((q) => library.search(q)));
    expect(results.some((r) => r.near)).toBe(true);
    expect(results.some((r) => !r.near && r.tracks.length)).toBe(true);
    expect(results.some((r) => !r.artists.length && !r.albums.length && !r.tracks.length)).toBe(true);
  });

  it('finds artists, albums and songs by name as looking through them all did', async () => {
    const { library, catalog } = await setup();
    // The first artist of each name, as looking through them in order found.
    const byName = (name: string) => {
      for (const [mbid, id] of catalog.artistIdByMbid) if (normalize(catalog.artists.get(id)?.name ?? '') === normalize(name)) return { id, mbid };
      return undefined;
    };
    for (const artist of [...catalog.artists.values()].slice(0, 200)) {
      expect(await library.artistByName(artist.name.toUpperCase()), artist.name).toEqual(byName(artist.name));
    }
    expect(await library.artistByName('Nobody At All')).toBeUndefined();
    // The last album of each artist and title (editions too), as a map of them all kept.
    const albumIds = new Map([...catalog.albums.values()].map((a) => [albumKey(a.artistName, a.title), a.id]));
    for (const album of [...catalog.albums.values()].slice(0, 300)) {
      expect(await library.albumIdByName(album.artistName, album.title), album.title).toBe(albumIds.get(albumKey(album.artistName, album.title)));
    }
    for (const track of catalog.tracks.slice(0, 300)) {
      expect((await library.trackByName(track.artistName, track.title))?.title, track.title).toBe(track.title);
    }
  });

  it('sorts the albums and artists as comparing names one pair at a time did', async () => {
    const { library, catalog } = await setup();
    const sortName = (a: Artist, b: Artist) => a.sortName.localeCompare(b.sortName, undefined, { sensitivity: 'base' });
    const plainly: Record<AlbumSort, (a: Album, b: Album) => number> = {
      title: (a, b) => a.title.localeCompare(b.title),
      artist: (a, b) => {
        const aa = catalog.artists.get(a.artistId);
        const ba = catalog.artists.get(b.artistId);
        return (aa && ba ? sortName(aa, ba) : 0) || (a.releaseDate ?? '').localeCompare(b.releaseDate ?? '');
      },
      year: (a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''),
      added: (a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? ''),
    };
    for (const sort of ['title', 'artist', 'year', 'added'] as const) {
      const expected = [...catalog.albums.values()].sort(plainly[sort]).map((a) => a.id);
      expect((await library.albums(sort)).map((a) => a.id), sort).toEqual(expected);
      expect((await library.albums(sort, 25)).map((a) => a.id), `${sort}, 25`).toEqual(expected.slice(0, 25));
    }
    expect((await library.artists()).map((a) => a.id)).toEqual([...catalog.artists.values()].sort(sortName).map((a) => a.id));
  });

  it('pages through the albums and artists, the pages together making the whole list', async () => {
    const { library } = await setup();
    for (const sort of ['title', 'artist', 'year', 'added'] as const) {
      const whole = await library.albums(sort);
      const pages = [];
      for (let offset = 0; offset < whole.length; offset += 37) pages.push(await library.albumPage(sort, offset, 37));
      expect(pages.flatMap((p) => p.albums)).toEqual(whole);
      expect(new Set(pages.map((p) => `${p.total} ${p.version}`))).toEqual(new Set([`${whole.length} ${library.listVersion}`]));
      expect((await library.albumPage(sort, whole.length, 37)).albums).toEqual([]);
    }
    const artists = await library.artists();
    const first = await library.artistPage(0, 100);
    expect(first).toEqual({ artists: artists.slice(0, 100), total: artists.length, version: library.listVersion });
    expect((await library.artistPage(100, 100)).artists).toEqual(artists.slice(100, 200));
  });

  it('sorts again for a new snapshot, under a new version', async () => {
    const { lib, lidarr, library } = await setup();
    const before = await library.albumPage('title', 0, 5);
    // Lidarr's first album is now called something that comes first.
    lidarr.sync = lib.lidarr();
    lidarr.sync.albums[0]!.title = '000 First of All';
    await library.refresh();
    const after = await library.albumPage('title', 0, 5);
    expect(after.albums[0]!.title).toBe('000 First of All');
    expect(after.version).not.toBe(before.version);
    expect(after.total).toBe(before.total);
  });
});
