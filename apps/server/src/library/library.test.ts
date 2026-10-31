import { describe, expect, it, vi } from 'vitest';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb, mezzanine } from '../catalog/testFixtures.ts';
import type { CatalogSource } from '../catalog/types.ts';
import { Library, stripAlbum } from './library.ts';

const log = { info: () => {}, error: () => {} };
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
    const cached = vi.fn(() => ({ artists: [], albums: [], tracks: [], copies: [] }));
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
    expect((await library.albums()).map((x) => x.title)).toEqual(['Mezzanine']);
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
