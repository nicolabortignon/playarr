import { afterEach, describe, expect, it, vi } from 'vitest';
import { LidarrClient } from '../lidarr/client.ts';
import { SourceError, SourceManager } from './sources.ts';
import { CatalogStore } from './store.ts';
import { freshDb } from './testFixtures.ts';

const ENV = { url: 'http://lidarr:8686', apiKey: 'secret-key' };

function setup() {
  const store = new CatalogStore(freshDb());
  const lidarr = new LidarrClient();
  return { store, lidarr, manager: new SourceManager(store, lidarr, { info: () => {} }) };
}

afterEach(() => vi.restoreAllMocks());

describe('SourceManager', () => {
  it('seeds a Lidarr source from .env, once', () => {
    const { store, manager } = setup();
    manager.seedFromEnv(ENV);
    const [source] = store.listSources();
    expect(source).toMatchObject({ kind: 'lidarr', settings: ENV });
    store.removeSource(source!.id);
    manager.seedFromEnv(ENV); // a restart after the user removed it
    expect(store.listSources()).toEqual([]);
  });

  it('fills the Lidarr row Phase 1 created, keeping its id', () => {
    const { store, manager } = setup();
    const id = store.ensureSource('lidarr', 'Lidarr');
    manager.seedFromEnv(ENV);
    expect(store.listSources().map((s) => [s.id, s.settings])).toEqual([[id, ENV]]);
  });

  it('adds no source when .env has no Lidarr', () => {
    const { store, manager } = setup();
    manager.seedFromEnv({});
    expect(store.listSources()).toEqual([]);
  });

  it('points the shared Lidarr client at the enabled Lidarr source', () => {
    const { store, lidarr, manager } = setup();
    manager.seedFromEnv(ENV);
    expect(manager.active()).toHaveLength(1);
    expect(lidarr.configured).toBe(true);
    store.updateSource(store.listSources()[0]!.id, { enabled: false });
    expect(manager.active()).toEqual([]);
    expect(lidarr.configured).toBe(false);
  });

  it('never sends secrets, and hides settings from remote visitors', () => {
    const { manager } = setup();
    manager.seedFromEnv(ENV);
    const [local] = manager.list({ includeSettings: true, syncing: false });
    expect(local).toMatchObject({ settings: { url: ENV.url }, secrets: ['apiKey'] });
    expect(JSON.stringify(local)).not.toContain(ENV.apiKey);
    const [remote] = manager.list({ includeSettings: false, syncing: false });
    expect(remote!.settings).toBeUndefined();
  });

  it('keeps the saved API key when an update leaves it out', () => {
    const { store, manager } = setup();
    manager.seedFromEnv(ENV);
    const id = store.listSources()[0]!.id;
    manager.update(id, { name: 'Home Lidarr', settings: { url: 'http://nas:8686/' } });
    expect(store.source(id)).toMatchObject({
      name: 'Home Lidarr',
      settings: { url: 'http://nas:8686', apiKey: ENV.apiKey },
    });
  });

  it('unsets the Lidarr client when its source is removed', () => {
    const { store, lidarr, manager } = setup();
    manager.seedFromEnv(ENV);
    manager.active();
    manager.remove(store.listSources()[0]!.id);
    expect(lidarr.configured).toBe(false);
  });

  it('allows one Lidarr source, with a URL and a key', () => {
    const { manager } = setup();
    expect(() => manager.add({ settings: { url: ENV.url } })).toThrow(/URL and an API key/);
    manager.add({ kind: 'lidarr', settings: ENV });
    expect(() => manager.add({ kind: 'lidarr', settings: ENV })).toThrow(SourceError);
  });

  it('only accepts Lidarr sources for now', () => {
    expect(() => setup().manager.add({ kind: 'folder' })).toThrow(/Only Lidarr/);
  });

  it('rejects an order that misses a source', () => {
    const { manager } = setup();
    manager.seedFromEnv(ENV);
    expect(() => manager.reorder([])).toThrow(SourceError);
  });

  it('tests a connection with the saved key', async () => {
    const { store, manager } = setup();
    manager.seedFromEnv(ENV);
    const id = store.listSources()[0]!.id;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ version: '3.1.6' }), { status: 200 }));
    await expect(manager.test({ id, url: 'http://nas:8686' })).resolves.toEqual({ ok: true, version: '3.1.6' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://nas:8686/api/v1/system/status');
    expect((init!.headers as Record<string, string>)['X-Api-Key']).toBe(ENV.apiKey);
  });

  it('reports a failed connection test', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(setup().manager.test({ url: ENV.url, apiKey: 'wrong' })).resolves.toEqual({
      ok: false,
      error: 'Lidarr rejected the API key',
    });
  });
});
