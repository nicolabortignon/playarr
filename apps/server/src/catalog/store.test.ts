import { describe, expect, it } from 'vitest';
import { CatalogStore } from './store.ts';
import { freshDb, mezzanine } from './testFixtures.ts';

function setup() {
  const store = new CatalogStore(freshDb());
  const sourceId = store.ensureSource('lidarr', 'Lidarr');
  return { store, sourceId };
}

describe('CatalogStore', () => {
  it('creates one source per kind with ensureSource', () => {
    const { store, sourceId } = setup();
    expect(store.ensureSource('lidarr', 'Lidarr')).toBe(sourceId);
    expect(store.addSource('folder', 'Music')).not.toBe(sourceId);
    expect(store.load().sources.map((s) => [s.kind, s.position])).toEqual([
      ['lidarr', 0],
      ['folder', 1],
    ]);
  });

  it('uses the preferred ids on first sight', () => {
    const { store, sourceId } = setup();
    store.applySync(sourceId, mezzanine());
    const rows = store.load();
    expect(rows.artists.map((a) => a.id)).toEqual([7]);
    expect(rows.albums.map((a) => [a.id, a.artistId])).toEqual([[70, 7]]);
    expect(rows.tracks.map((t) => t.id).sort()).toEqual([700, 701]);
    expect(rows.copies.map((c) => [c.id, c.trackId]).sort()).toEqual([
      [9000, 700],
      [9001, 701],
    ]);
    expect(store.hasData()).toBe(true);
  });

  it('keeps ids when the source later reports different ones', () => {
    const { store, sourceId } = setup();
    store.applySync(sourceId, mezzanine());
    const resync = mezzanine();
    resync.albums[0]!.preferredId = 99; // e.g. the album was removed and re-added in Lidarr
    resync.albums[0]!.title = 'Mezzanine (Remastered)';
    store.applySync(sourceId, resync);
    const [album] = store.load().albums;
    expect(album!.id).toBe(70);
    expect(album!.meta.title).toBe('Mezzanine (Remastered)');
  });

  it('allocates a fresh id when the preferred one is taken', () => {
    const { store, sourceId } = setup();
    store.applySync(sourceId, mezzanine());
    const more = mezzanine();
    more.albums.push({ ...more.albums[0]!, key: 'mb:rg-9', mbid: 'rg-9', title: 'Heligoland', preferredId: 70 });
    store.applySync(sourceId, more);
    expect(store.load().albums.find((a) => a.key === 'mb:rg-9')!.id).toBe(71);
  });

  it('removes copies the source no longer has, but keeps the song row', () => {
    const { store, sourceId } = setup();
    store.applySync(sourceId, mezzanine());
    const fewer = mezzanine();
    fewer.copies = fewer.copies.slice(0, 1);
    store.applySync(sourceId, fewer);
    const rows = store.load();
    expect(rows.copies.map((c) => c.id)).toEqual([9000]);
    expect(rows.tracks).toHaveLength(2);
  });

  it('never reuses a copy id', () => {
    const { store, sourceId } = setup();
    store.applySync(sourceId, mezzanine());
    const fewer = mezzanine();
    fewer.copies = fewer.copies.slice(0, 1);
    store.applySync(sourceId, fewer);
    const added = mezzanine();
    added.copies = [added.copies[0]!, { ...added.copies[1]!, ref: 'new-file', preferredId: undefined }];
    store.applySync(sourceId, added);
    expect(store.load().copies.map((c) => c.id).sort()).toEqual([9000, 9002]);
  });

  it("stores Lidarr's album list on the source", () => {
    const { store, sourceId } = setup();
    store.applySync(sourceId, mezzanine());
    const [source] = store.load().sources;
    expect(source!.state.lidarrAlbums).toHaveLength(2);
    expect(source!.lastSyncAt).toBeTruthy();
  });

  it('applies nothing when a sync refers to something unknown', () => {
    const { store, sourceId } = setup();
    const broken = mezzanine();
    broken.copies.push({ ...broken.copies[0]!, ref: 'x', preferredId: undefined, trackKey: 'mb:nope#nope' });
    expect(() => store.applySync(sourceId, broken)).toThrow(/unknown track/);
    expect(store.hasData()).toBe(false);
    expect(store.load().artists).toEqual([]);
  });
});

describe('CatalogStore: managing sources', () => {
  it('lists sources with their settings and sync errors', () => {
    const store = new CatalogStore(freshDb());
    const id = store.addSource('lidarr', 'Lidarr', { url: 'http://lidarr:8686', apiKey: 'k' });
    store.setSyncError(id, 'Cannot reach Lidarr');
    expect(store.source(id)).toMatchObject({
      kind: 'lidarr',
      enabled: true,
      settings: { url: 'http://lidarr:8686', apiKey: 'k' },
      lastError: 'Cannot reach Lidarr',
    });
    store.setSyncError(id, null);
    expect(store.source(id)!.lastError).toBeUndefined();
  });

  it('updates name, enabled and settings', () => {
    const store = new CatalogStore(freshDb());
    const id = store.addSource('lidarr', 'Lidarr');
    store.updateSource(id, { name: 'Home', enabled: false, settings: { url: 'http://nas:8686' } });
    expect(store.source(id)).toMatchObject({ name: 'Home', enabled: false, settings: { url: 'http://nas:8686' } });
  });

  it('removes a source with its copies, keeping catalog rows', () => {
    const store = new CatalogStore(freshDb());
    const id = store.ensureSource('lidarr', 'Lidarr');
    store.applySync(id, mezzanine());
    store.removeSource(id);
    const rows = store.load();
    expect(rows.sources).toEqual([]);
    expect(rows.copies).toEqual([]);
    expect(rows.tracks).toHaveLength(2);
  });

  it('reorders sources and rejects an incomplete order', () => {
    const store = new CatalogStore(freshDb());
    const a = store.addSource('lidarr', 'A');
    const b = store.addSource('folder', 'B');
    store.reorderSources([b, a]);
    expect(store.listSources().map((s) => s.id)).toEqual([b, a]);
    expect(() => store.reorderSources([a])).toThrow(/every source/);
  });

  it('counts the songs and albums each source has', () => {
    const store = new CatalogStore(freshDb());
    const id = store.ensureSource('lidarr', 'Lidarr');
    store.applySync(id, mezzanine());
    expect(store.sourceCounts().get(id)).toEqual({ songs: 2, albums: 1 });
  });

  it('keeps app settings', () => {
    const store = new CatalogStore(freshDb());
    expect(store.appSetting('x')).toBeUndefined();
    store.setAppSetting('x', '1');
    store.setAppSetting('x', '2');
    expect(store.appSetting('x')).toBe('2');
  });
});
