import type { HealthStatus } from '@playarr/shared';
import Fastify from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { account, actAs, asAccount } from '../accounts/testAccess.ts';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb, mezzanine } from '../catalog/testFixtures.ts';
import type { Config } from '../config.ts';
import type { LidarrClient } from '../lidarr/client.ts';
import { Library } from '../library/library.ts';
import type { MediaSource } from '../media/index.ts';
import { apiRoutes } from './api.ts';

const quiet = { info: () => {}, error: () => {} };

/**
 * /api/health with Lidarr up or down, a library that loads or can't, music that can be read or not, and a database that
 * answers or doesn't; asked as `as` (an admin's or a member's account id, or null for nobody signed in) on a server with
 * accounts, or without accounts (the home network decides, as in setup mode) when `as` is left out.
 */
async function health({
  lidarrUp = true,
  libraryLoads = true,
  mediaUp = true,
  db = freshDb() as Pick<DatabaseSync, 'prepare'>,
  as = undefined as number | null | undefined,
} = {}) {
  const store = new CatalogStore(freshDb());
  const source = store.addSource('lidarr', 'Lidarr');
  const sync = async () => {
    if (!libraryLoads) throw new Error('Lidarr is not answering');
    return mezzanine();
  };
  const library = new Library(store, () => [{ id: source, source: { kind: 'lidarr', sync } }], quiet);
  const app = Fastify();
  if (as !== undefined) actAs(app, [account(1, { role: 'admin' }), account(2)]);
  apiRoutes(app, {
    config: { pathMap: [] } as unknown as Config,
    lidarr: {
      configured: true,
      systemStatus: async () => {
        if (!lidarrUp) throw new Error('connect ECONNREFUSED');
        return { version: '2.9' };
      },
    } as unknown as LidarrClient,
    library,
    media: {
      kind: 'ssh',
      check: async () => {
        if (!mediaUp) throw new Error('ssh: connect ECONNREFUSED 192.168.1.103:22 reading /volume2/Music/Massive Attack');
      },
    } as unknown as MediaSource,
    requestSettings: () => ({ enabled: true, searchOnAdd: true }),
    db,
  });
  return app.inject({ url: '/api/health', headers: typeof as === 'number' ? asAccount(as) : {} });
}

describe('GET /api/health', () => {
  it('says the database answers, in the form docker/update.sh looks for', async () => {
    const res = await health();
    expect(res.statusCode).toBe(200);
    expect(res.json<HealthStatus>()).toMatchObject({ ok: true, database: { ok: true } });
    // update.sh matches this text in the answer: a change here rolls every update back.
    expect(res.body).toContain('"database":{"ok":true');
  });

  it('says so when the database fails', async () => {
    const broken = {
      prepare: () => {
        throw new Error('database is locked');
      },
    } as unknown as Pick<DatabaseSync, 'prepare'>;
    expect((await health({ db: broken })).json<HealthStatus>().database).toEqual({ ok: false, error: 'database is locked' });
  });

  it('answers with the database working while Lidarr is down and the library can’t load: only `ok` says so', async () => {
    const res = await health({ lidarrUp: false, libraryLoads: false });
    expect(res.statusCode).toBe(200);
    expect(res.json<HealthStatus>()).toMatchObject({ ok: false, lidarr: { ok: false, error: 'connect ECONNREFUSED' }, database: { ok: true } });
  });

  it('tells only admins why Lidarr or the music can’t be reached, and Lidarr’s version', async () => {
    const admin = (await health({ as: 1, lidarrUp: false, mediaUp: false })).json<HealthStatus>();
    expect(admin).toMatchObject({
      ok: false,
      lidarr: { ok: false, error: 'connect ECONNREFUSED' },
      media: { source: 'ssh', ok: false, error: expect.stringContaining('/volume2/Music') },
    });
    expect((await health({ as: 1 })).json<HealthStatus>().lidarr).toEqual({ ok: true, version: '2.9' });
  });

  it('tells members and strangers whether things are fine, in the same shape, without the details', async () => {
    for (const as of [2, null]) {
      const down = await health({ as, lidarrUp: false, mediaUp: false });
      expect(down.json<HealthStatus>()).toEqual({
        ok: false,
        lidarr: { ok: false },
        media: { source: 'ssh', ok: false },
        requests: false,
        database: { ok: true },
        // What the asker may hear, once signed in.
        ...(as === 2 ? { library: expect.objectContaining({ tracks: 2 }) } : {}),
      });
      for (const detail of ['ECONNREFUSED', '192.168.1.103', '/volume2']) expect(down.body).not.toContain(detail);
      const up = await health({ as });
      expect(up.json<HealthStatus>()).toMatchObject({ ok: true, lidarr: { ok: true }, media: { source: 'ssh', ok: true } });
      expect(up.json<HealthStatus>().lidarr).not.toHaveProperty('version');
      // The updater asks without signing in, and looks for exactly this.
      expect(up.body).toContain('"database":{"ok":true');
    }
  });
});
