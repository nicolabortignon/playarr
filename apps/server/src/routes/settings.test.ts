import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { SourceManager } from '../catalog/sources.ts';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import { LidarrClient } from '../lidarr/client.ts';
import { settingsRoutes } from './settings.ts';

const HOME = '192.168.1.20';
const AWAY = '203.0.113.5';
const lidarr = { kind: 'lidarr', name: 'Lidarr', settings: { url: 'http://lidarr:8686', apiKey: 'secret-key' } };

function setup() {
  const store = new CatalogStore(freshDb());
  const sources = new SourceManager(store, new LidarrClient(), { info: () => {} });
  const library = { refresh: vi.fn(async () => {}), reload: vi.fn(), refreshing: false };
  const app = Fastify();
  settingsRoutes(app, { sources, library });
  return { app, store, library };
}

describe('settings routes', () => {
  it('browses folders from the home network only', async () => {
    const { app } = setup();
    const away = await app.inject({ method: 'GET', url: '/api/settings/folders', remoteAddress: AWAY });
    expect(away.statusCode).toBe(403);
    const home = await app.inject({ method: 'GET', url: '/api/settings/folders', remoteAddress: HOME });
    expect(home.json()).toMatchObject({ path: null, folders: [{ path: '/' }] });
  });

  it('accepts a folder path', async () => {
    const res = await setup().app.inject({
      method: 'POST',
      url: '/api/settings/sources',
      payload: { kind: 'folder', settings: { path: '/definitely/not/here' } },
      remoteAddress: HOME,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/doesn’t exist/);
  });

  it('adds a source from the home network and starts a sync', async () => {
    const { app, library } = setup();
    const res = await app.inject({ method: 'POST', url: '/api/settings/sources', payload: lidarr, remoteAddress: HOME });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: 'lidarr', secrets: ['apiKey'], settings: { url: 'http://lidarr:8686' } });
    expect(res.body).not.toContain('secret-key');
    expect(library.refresh).toHaveBeenCalled();
  });

  it('refuses changes from outside the home network', async () => {
    const { app, store } = setup();
    const res = await app.inject({ method: 'POST', url: '/api/settings/sources', payload: lidarr, remoteAddress: AWAY });
    expect(res.statusCode).toBe(403);
    expect(store.listSources()).toEqual([]);
  });

  it('shows sources read-only, without settings, to remote visitors', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/api/settings/sources', payload: lidarr, remoteAddress: HOME });
    const res = await app.inject({ method: 'GET', url: '/api/settings/sources', remoteAddress: AWAY });
    expect(res.json()).toMatchObject({ canEdit: false, sources: [{ name: 'Lidarr' }] });
    expect(res.json().sources[0].settings).toBeUndefined();
  });

  it('validates input', async () => {
    const res = await setup().app.inject({
      method: 'POST',
      url: '/api/settings/sources',
      payload: { settings: { url: 'not a url' } },
      remoteAddress: HOME,
    });
    expect(res.statusCode).toBe(400);
  });

  it('removes a source and rebuilds without syncing', async () => {
    const { app, store, library } = setup();
    const { id } = (
      await app.inject({ method: 'POST', url: '/api/settings/sources', payload: lidarr, remoteAddress: HOME })
    ).json();
    library.refresh.mockClear();
    const res = await app.inject({ method: 'DELETE', url: `/api/settings/sources/${id}`, remoteAddress: HOME });
    expect(res.statusCode).toBe(204);
    expect(store.listSources()).toEqual([]);
    expect(library.reload).toHaveBeenCalled();
    expect(library.refresh).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown source', async () => {
    const res = await setup().app.inject({
      method: 'PATCH',
      url: '/api/settings/sources/99',
      payload: { name: 'x' },
      remoteAddress: HOME,
    });
    expect(res.statusCode).toBe(404);
  });
});
