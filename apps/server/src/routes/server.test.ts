import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { ServerInfo } from '@playarr/shared';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { authHook } from '../accounts/auth.ts';
import { account } from '../accounts/testAccess.ts';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import { loadConfig } from '../config.ts';
import { Reachability } from '../reachability/reachability.ts';
import { recordFixture } from '../testing/recordFixture.ts';
import { VERSION } from '../version.ts';
import { MIN_APP_VERSION, MIN_TV_VERSION, serverId, serverInfo, serverRoutes } from './server.ts';

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
    expect(body).toEqual({ id: serverId(store), name: hostname(), version: VERSION, minAppVersion: MIN_APP_VERSION, minTvVersion: MIN_TV_VERSION, setup: true, ownerUsername: 'home' });
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

describe('the reachability check’s token route', () => {
  /** The server's open routes on a server whose owner has set a password, behind the real auth hook. */
  function setUp(now = () => Date.now()) {
    let issued: string | undefined;
    const reachability = new Reachability({
      publicUrl: 'https://music.example.com',
      lookup: async () => [{ address: '203.0.113.7', family: 4 }],
      // Holds the check open on its own request, so the test can ask for the token meanwhile.
      fetch: async (url) => {
        issued = url.pathname.split('/').at(-1);
        return { status: 200, body: JSON.stringify({ answer: (await answered)!.json().answer }) };
      },
      now,
    });
    let answer!: (res: Awaited<ReturnType<typeof app.inject>>) => void;
    const answered = new Promise<Awaited<ReturnType<typeof app.inject>>>((resolve) => (answer = resolve));
    const app = Fastify();
    app.decorateRequest('auth', null);
    app.addHook('onRequest', authHook({ accounts: { get: () => undefined, owner: () => account(1, { role: 'admin' }), setupMode: () => false }, sessions: { resolve: () => undefined } }));
    serverRoutes(app, { info: () => ({ id: 'id', name: 'Playarr', version: '0', minAppVersion: MIN_APP_VERSION, setup: false }), reachability });
    return { app, reachability, issued: () => issued, answer };
  }

  it('answers this server’s own token, once, to anyone, signed in or not', async () => {
    const { app, reachability, issued, answer } = setUp();
    const check = reachability.check();
    await vi.waitFor(() => expect(issued()).toBeDefined());
    const res = await app.inject({ url: `/reachable/${issued()}` });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json())).toEqual(['answer']);
    expect(res.headers['cache-control']).toBe('no-store');
    answer(res);
    expect((await check).verdict).toBe('reachable');
    // Answered: gone.
    expect((await app.inject({ url: `/reachable/${issued()}` })).statusCode).toBe(404);
  });

  it('says nothing about tokens it never made, answered or forgot: the same 404 for each', async () => {
    const { app } = setUp();
    const unknown = await app.inject({ url: '/reachable/made-up' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'Not found' });
    // Open only outside /api/: the check itself stays behind sign-in.
    expect((await app.inject({ url: '/api/settings/reachability/check', method: 'POST', headers: { 'x-playarr': '1' } })).statusCode).toBe(401);
  });

  it('turns away a visitor asking more than 30 times a minute', async () => {
    const { app } = setUp(() => 0);
    for (let i = 0; i < 30; i++) expect((await app.inject({ url: `/reachable/guess-${i}`, remoteAddress: '198.51.100.9' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/reachable/guess', remoteAddress: '198.51.100.9' })).statusCode).toBe(429);
    expect((await app.inject({ url: '/reachable/guess', remoteAddress: '198.51.100.10' })).statusCode).toBe(404);
  });
});
