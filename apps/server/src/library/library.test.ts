import { describe, expect, it, vi } from 'vitest';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb, mezzanine } from '../catalog/testFixtures.ts';
import type { CatalogSource } from '../catalog/types.ts';
import { Library } from './library.ts';

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
});
