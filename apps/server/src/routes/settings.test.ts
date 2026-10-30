import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { Organizer } from '../catalog/organizer.ts';
import { SourceManager } from '../catalog/sources.ts';
import { CatalogStore } from '../catalog/store.ts';
import { flacBytes, freshDb, mezzanine, tempDir } from '../catalog/testFixtures.ts';
import { LidarrClient } from '../lidarr/client.ts';
import { readRequestSettings, REQUESTS_KEY, settingsRoutes } from './settings.ts';

const HOME = '192.168.1.20';
const AWAY = '203.0.113.5';
const lidarr = { kind: 'lidarr', name: 'Lidarr', settings: { url: 'http://lidarr:8686', apiKey: 'secret-key' } };

function setup(matcher = fakeMatcher(), lidarrClient = fakeLidarr()) {
  const store = new CatalogStore(freshDb());
  const sources = new SourceManager(store, new LidarrClient(), { info: () => {} });
  const library = { refresh: vi.fn(async () => {}), reload: vi.fn(), refreshing: false };
  const app = Fastify();
  settingsRoutes(app, {
    sources,
    library,
    matcher,
    store,
    organizer: new Organizer(store),
    fingerprints: true,
    shares: false,
    lidarr: lidarrClient,
  });
  return { app, store, library, matcher, lidarr: lidarrClient };
}

function fakeLidarr(configured = true) {
  return {
    configured,
    rootFolders: vi.fn(async () => [
      { id: 1, path: '/music', accessible: true, freeSpace: 1000, defaultQualityProfileId: 1, defaultMetadataProfileId: 1 },
    ]),
    qualityProfiles: vi.fn(async () => [{ id: 1, name: 'Lossless', items: [] }]),
    metadataProfiles: vi.fn(async () => [{ id: 1, name: 'Standard' }]),
  };
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

  it('says which folder locations work, to the home network only', async () => {
    const { app } = setup();
    const home = await app.inject({ method: 'GET', url: '/api/settings/folders/access', remoteAddress: HOME });
    expect(home.json()).toEqual({ smb: false });
    const away = await app.inject({ method: 'GET', url: '/api/settings/folders/access', remoteAddress: AWAY });
    expect(away.statusCode).toBe(403);
  });

  it('validates SMB connection fields', async () => {
    const { app } = setup();
    const badPort = await app.inject({
      method: 'POST',
      url: '/api/settings/sources',
      payload: { kind: 'folder', settings: { access: 'smb', host: 'nas', user: 'me', port: 0, path: '/music' } },
      remoteAddress: HOME,
    });
    expect(badPort.statusCode).toBe(400);
    expect(badPort.json().error).toMatch(/port/);
    const badDomain = await app.inject({
      method: 'POST',
      url: '/api/settings/folders/browse',
      payload: { connection: { access: 'smb', host: 'nas', user: 'me', domain: 'x'.repeat(101) } },
      remoteAddress: HOME,
    });
    expect(badDomain.statusCode).toBe(400);
    expect(badDomain.json().error).toMatch(/domain/);
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

  describe('requests', () => {
    const url = '/api/settings/requests';
    const options = {
      rootFolders: [{ path: '/music', freeSpace: 1000 }],
      qualityProfiles: [{ id: 1, name: 'Lossless' }],
      metadataProfiles: [{ id: 1, name: 'Standard' }],
    };

    it('starts with requests on and searching right away, with Lidarr’s choices', async () => {
      const res = await setup().app.inject({ method: 'GET', url, remoteAddress: HOME });
      expect(res.json()).toEqual({ enabled: true, searchOnAdd: true, lidarr: true, options });
    });

    it('saves, reads back and clears choices', async () => {
      const { app, store } = setup();
      const put = await app.inject({
        method: 'PUT',
        url,
        payload: { enabled: false, searchOnAdd: false, rootFolderPath: '/music', qualityProfileId: 1, metadataProfileId: 1 },
        remoteAddress: HOME,
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({ enabled: false, searchOnAdd: false, rootFolderPath: '/music', qualityProfileId: 1 });
      expect(readRequestSettings(store)).toEqual({
        enabled: false,
        searchOnAdd: false,
        rootFolderPath: '/music',
        qualityProfileId: 1,
        metadataProfileId: 1,
      });
      // A partial change leaves the rest; null clears a choice.
      const cleared = await app.inject({ method: 'PUT', url, payload: { qualityProfileId: null, enabled: true }, remoteAddress: HOME });
      expect(cleared.json()).toMatchObject({ enabled: true, searchOnAdd: false, rootFolderPath: '/music' });
      expect(cleared.json().qualityProfileId).toBeUndefined();
      expect((await app.inject({ method: 'GET', url, remoteAddress: HOME })).json().qualityProfileId).toBeUndefined();
    });

    it('is for the home network only', async () => {
      const { app, store } = setup();
      expect((await app.inject({ method: 'GET', url, remoteAddress: AWAY })).statusCode).toBe(403);
      const put = await app.inject({ method: 'PUT', url, payload: { enabled: false }, remoteAddress: AWAY });
      expect(put.statusCode).toBe(403);
      expect(readRequestSettings(store).enabled).toBe(true);
    });

    it('validates input', async () => {
      const { app } = setup();
      for (const payload of [{ enabled: 'yes' }, { qualityProfileId: 0 }, { metadataProfileId: 1.5 }, { rootFolderPath: 'x'.repeat(4097) }]) {
        expect((await app.inject({ method: 'PUT', url, payload, remoteAddress: HOME })).statusCode).toBe(400);
      }
    });

    it('says why Lidarr’s choices are missing', async () => {
      const lidarr = fakeLidarr();
      lidarr.qualityProfiles.mockRejectedValue(new Error('Cannot reach Lidarr'));
      const res = await setup(fakeMatcher(), lidarr).app.inject({ method: 'GET', url, remoteAddress: HOME });
      expect(res.json()).toEqual({ enabled: true, searchOnAdd: true, lidarr: true, error: 'Cannot reach Lidarr' });
    });

    it('asks nothing of Lidarr when there is none', async () => {
      const lidarr = fakeLidarr(false);
      const res = await setup(fakeMatcher(), lidarr).app.inject({ method: 'GET', url, remoteAddress: HOME });
      expect(res.json()).toEqual({ enabled: true, searchOnAdd: true, lidarr: false });
      expect(lidarr.rootFolders).not.toHaveBeenCalled();
    });

    it('ignores a damaged stored value', () => {
      const { store } = setup();
      store.setAppSetting(REQUESTS_KEY, '{not json');
      expect(readRequestSettings(store)).toEqual({ enabled: true, searchOnAdd: true });
      store.setAppSetting(REQUESTS_KEY, JSON.stringify({ enabled: 'no', qualityProfileId: -1, rootFolderPath: 5 }));
      expect(readRequestSettings(store)).toEqual({ enabled: true, searchOnAdd: true });
    });
  });
});
