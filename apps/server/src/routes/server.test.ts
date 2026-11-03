import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { ServerInfo } from '@playarr/shared';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import { loadConfig } from '../config.ts';
import { recordFixture } from '../testing/recordFixture.ts';
import { VERSION } from '../version.ts';
import { MIN_APP_VERSION, serverId, serverInfo, serverRoutes } from './server.ts';

describe('server identity', () => {
  it('keeps one id for good, made the first time it’s asked for', () => {
    const store = new CatalogStore(freshDb());
    const id = serverId(store);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(serverId(store)).toBe(id);
    expect(serverId(new CatalogStore(freshDb()))).not.toBe(id);
  });

  it('answers who it is, by SERVER_NAME or the machine’s name, and whether it’s set up', async () => {
    const store = new CatalogStore(freshDb());
    let setup = true;
    const app = Fastify();
    serverRoutes(app, { info: () => serverInfo({ store, name: undefined, setupMode: () => setup, ownerUsername: () => 'home' }) });
    const body = (await app.inject({ url: '/api/server' })).json() as ServerInfo;
    // While nobody has set it up, the setup page pre-fills the owner's current username.
    expect(body).toEqual({ id: serverId(store), name: hostname(), version: VERSION, minAppVersion: MIN_APP_VERSION, setup: true, ownerUsername: 'home' });
    setup = false;
    expect((await app.inject({ url: '/api/server' })).json()).toEqual({ ...body, setup: false, ownerUsername: undefined });
    expect(serverInfo({ store, name: ' Living room ', setupMode: () => false, ownerUsername: () => 'home' }).name).toBe('Living room');
  });

  it('tells clients its public address (PUBLIC_URL) in and out of setup mode', async () => {
    const store = new CatalogStore(freshDb());
    let setup = true;
    const app = Fastify();
    const info = () => serverInfo({ store, name: 'Playarr', setupMode: () => setup, ownerUsername: () => 'home', publicUrl: 'https://playarr.example' });
    serverRoutes(app, { info });
    expect((await app.inject({ url: '/api/server' })).json()).toMatchObject({ setup: true, publicUrl: 'https://playarr.example' });
    setup = false;
    const res = await app.inject({ url: '/api/server' });
    expect(res.json()).toMatchObject({ setup: false, publicUrl: 'https://playarr.example' });
    expect(res.json()).not.toHaveProperty('ownerUsername');
    // Without PUBLIC_URL there's no publicUrl at all (not null).
    expect(serverInfo({ store, name: undefined, setupMode: () => false, ownerUsername: () => 'home' })).not.toHaveProperty('publicUrl');
    // Pinned so the fixture is the same on every machine and at every version.
    recordFixture('server-info', res, (body) => ({ ...body, id: '8d1e6f0a-0000-4000-8000-000000000001', name: 'Playarr', version: '0.7.0' }));
  });

  it('knows its version from the repository’s package.json', () => {
    const root = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(root.version);
  });

  it('reads SERVER_NAME and BONJOUR from the environment', () => {
    expect(loadConfig({ SERVER_NAME: 'NAS', BONJOUR: 'off' })).toMatchObject({ SERVER_NAME: 'NAS', BONJOUR: 'off' });
    expect(loadConfig({}).BONJOUR).toBe('on');
  });
});
