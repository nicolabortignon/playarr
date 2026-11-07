import type { HealthStatus } from '@playarr/shared';
import Fastify from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb, mezzanine } from '../catalog/testFixtures.ts';
import type { Config } from '../config.ts';
import type { LidarrClient } from '../lidarr/client.ts';
import { Library } from '../library/library.ts';
import type { MediaSource } from '../media/index.ts';
import { apiRoutes } from './api.ts';

const quiet = { info: () => {}, error: () => {} };

/** /api/health with Lidarr up or down, a library that loads or can't, and a database that answers or doesn't. */
async function health({ lidarrUp = true, libraryLoads = true, db = freshDb() as Pick<DatabaseSync, 'prepare'> } = {}) {
  const store = new CatalogStore(freshDb());
  const source = store.addSource('lidarr', 'Lidarr');
  const sync = async () => {
    if (!libraryLoads) throw new Error('Lidarr is not answering');
    return mezzanine();
  };
  const library = new Library(store, () => [{ id: source, source: { kind: 'lidarr', sync } }], quiet);
  const app = Fastify();
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
    media: { kind: 'local', check: async () => {} } as unknown as MediaSource,
    requestSettings: () => ({ enabled: true, searchOnAdd: true }),
    db,
  });
  return app.inject({ url: '/api/health' });
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
});
