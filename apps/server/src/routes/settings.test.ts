import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { Organizer } from '../catalog/organizer.ts';
import { SourceManager } from '../catalog/sources.ts';
import { CatalogStore } from '../catalog/store.ts';
import { flacBytes, freshDb, mezzanine, tempDir } from '../catalog/testFixtures.ts';
import { LidarrClient } from '../lidarr/client.ts';
import { settingsRoutes } from './settings.ts';

const HOME = '192.168.1.20';
const AWAY = '203.0.113.5';
const lidarr = { kind: 'lidarr', name: 'Lidarr', settings: { url: 'http://lidarr:8686', apiKey: 'secret-key' } };

function setup(matcher = fakeMatcher()) {
  const store = new CatalogStore(freshDb());
  const sources = new SourceManager(store, new LidarrClient(), { info: () => {} });
  const library = { refresh: vi.fn(async () => {}), reload: vi.fn(), refreshing: false };
  const app = Fastify();
  settingsRoutes(app, { sources, library, matcher, store, organizer: new Organizer(store), fingerprints: true });
  return { app, store, library, matcher };
}

function fakeMatcher() {
  return {
    reviewGroups: vi.fn(() => [{ groupKey: 'g', artistName: 'A', files: [], candidates: [] }]),
    applyRelease: vi.fn(async () => {}),
    ignore: vi.fn(),
    search: vi.fn(async () => {}),
    enqueue: vi.fn(),
  };
}

describe('settings routes', () => {
  it('browses folders from the home network only', async () => {
    const { app } = setup();
    const away = await app.inject({ method: 'GET', url: '/api/settings/folders', remoteAddress: AWAY });
    expect(away.statusCode).toBe(403);
    const home = await app.inject({ method: 'GET', url: '/api/settings/folders', remoteAddress: HOME });
    expect(home.json()).toMatchObject({ path: null, folders: [{ path: '/' }] });
  });

  it('browses over a connection from the home network only', async () => {
    const { app } = setup();
    const away = await app.inject({ method: 'POST', url: '/api/settings/folders/browse', payload: {}, remoteAddress: AWAY });
    expect(away.statusCode).toBe(403);
    const home = await app.inject({ method: 'POST', url: '/api/settings/folders/browse', payload: {}, remoteAddress: HOME });
    expect(home.json()).toMatchObject({ path: null });
  });

  it('validates remote connection fields', async () => {
    const res = await setup().app.inject({
      method: 'POST',
      url: '/api/settings/sources',
      payload: { kind: 'folder', settings: { access: 'ssh', host: 'nas', user: 'me', port: 99999, path: '/m' } },
      remoteAddress: HOME,
    });
    expect(res.statusCode).toBe(400);
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

  it('lists and resolves review groups from the home network', async () => {
    const { app, matcher } = setup();
    expect((await app.inject({ method: 'GET', url: '/api/settings/sources/1/review', remoteAddress: AWAY })).statusCode).toBe(403);
    const list = await app.inject({ method: 'GET', url: '/api/settings/sources/1/review', remoteAddress: HOME });
    expect(list.json()).toEqual([{ groupKey: 'g', artistName: 'A', files: [], candidates: [] }]);
    const apply = await app.inject({ method: 'POST', url: '/api/settings/sources/1/review', payload: { groupKey: 'g', releaseId: 'rel-1' }, remoteAddress: HOME });
    expect(apply.statusCode).toBe(204);
    expect(matcher.applyRelease).toHaveBeenCalledWith(1, 'g', 'rel-1');
    await app.inject({ method: 'POST', url: '/api/settings/sources/1/review', payload: { groupKey: 'g', releaseId: null }, remoteAddress: HOME });
    expect(matcher.ignore).toHaveBeenCalledWith(1, 'g');
    await app.inject({ method: 'POST', url: '/api/settings/sources/1/review', payload: { groupKey: 'g', search: { artist: 'A', album: 'B' } }, remoteAddress: HOME });
    expect(matcher.search).toHaveBeenCalledWith(1, 'g', 'A', 'B');
  });

  it('matches a source again on request', async () => {
    const { app, matcher, store } = setup();
    const id = store.addSource('folder', 'Music', { path: '/m' });
    store.saveMatches(id, [{ rel: 'a', groupKey: 'g', state: 'auto', size: 1, mtimeMs: 1 }]);
    const res = await app.inject({ method: 'POST', url: `/api/settings/sources/${id}/rematch`, remoteAddress: HOME });
    expect(res.statusCode).toBe(202);
    expect(store.matches(id).size).toBe(0);
    expect(matcher.enqueue).toHaveBeenCalledWith(id);
  });

  it('saves the AcoustID key without ever sending it back', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: '/api/settings/matching', remoteAddress: HOME })).json()).toEqual({ acoustid: false, fingerprints: true });
    const put = await app.inject({ method: 'PUT', url: '/api/settings/matching', payload: { acoustidKey: 'secret' }, remoteAddress: HOME });
    expect(put.json()).toEqual({ acoustid: true, fingerprints: true });
    expect(put.body).not.toContain('secret');
    expect((await app.inject({ method: 'PUT', url: '/api/settings/matching', payload: { acoustidKey: 'x' }, remoteAddress: AWAY })).statusCode).toBe(403);
  });

  it('plans, applies and undoes organizing from the home network only', async () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.dir, 'misc'));
      writeFileSync(join(t.dir, 'misc/a.flac'), flacBytes());
      const { app, store, library } = setup();
      const id = store.addSource('folder', 'Music', { path: t.dir });
      const sync = mezzanine();
      sync.copies = [{ ...sync.copies[0]!, ref: 'misc/a.flac', path: join(t.dir, 'misc/a.flac'), preferredId: undefined }];
      store.applySync(id, sync);

      expect((await app.inject({ method: 'GET', url: `/api/settings/sources/${id}/organize`, remoteAddress: AWAY })).statusCode).toBe(403);
      const plan = (await app.inject({ method: 'GET', url: `/api/settings/sources/${id}/organize`, remoteAddress: HOME })).json();
      expect(plan.moves).toEqual([expect.objectContaining({ from: 'misc/a.flac', to: 'Massive Attack/Mezzanine/01 Angel.flac' })]);

      const applied = await app.inject({ method: 'POST', url: `/api/settings/sources/${id}/organize`, payload: { moves: ['misc/a.flac'] }, remoteAddress: HOME });
      expect(applied.json()).toMatchObject({ moved: 1 });
      expect(library.reload).toHaveBeenCalled();

      const undone = await app.inject({ method: 'POST', url: `/api/settings/sources/${id}/organize/undo`, payload: { batchId: applied.json().batchId }, remoteAddress: HOME });
      expect(undone.json()).toMatchObject({ restored: 1 });
    } finally {
      t.cleanup();
    }
  });

  it('organizes folder sources only, and not while a scan runs', async () => {
    const { app, store, library } = setup();
    const lidarrId = store.addSource('lidarr', 'Lidarr', { url: 'http://lidarr:8686', apiKey: 'k' });
    expect((await app.inject({ method: 'GET', url: `/api/settings/sources/${lidarrId}/organize`, remoteAddress: HOME })).statusCode).toBe(404);
    library.refreshing = true;
    const busy = await app.inject({ method: 'POST', url: `/api/settings/sources/${lidarrId}/organize`, payload: { moves: [] }, remoteAddress: HOME });
    expect(busy.statusCode).toBe(409);
  });
});

