import type { ServerDiagnostics } from '@playarr/shared';
import Fastify from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Accounts } from '../accounts/accounts.ts';
import { authHook } from '../accounts/auth.ts';
import { Sessions } from '../accounts/sessions.ts';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import { LATEST_SCHEMA } from '../db.ts';
import { EncodedStreams } from '../media/encoded.ts';
import { logRequests, requestIdOptions } from '../requestLog.ts';
import { recordFixture } from '../testing/recordFixture.ts';
import { VERSION } from '../version.ts';
import { diagnosticsRoutes } from './diagnostics.ts';

const SYNCED_AT = '2026-11-07T09:30:00.000Z';

/**
 * A set-up server (the owner has a password, so the auth hook wants a session) with an admin and a member signed in,
 * a Lidarr source that synced and an SSH folder whose last sync failed.
 */
async function setup(opts: { db?: Pick<DatabaseSync, 'prepare'>; store?: Pick<CatalogStore, 'listSources'> } = {}) {
  const db = freshDb();
  const accounts = new Accounts(db);
  const sessions = new Sessions(db);
  await accounts.setPassword(1, 'correct horse');
  const member = accounts.create({ username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null });
  const store = new CatalogStore(db);
  const lidarr = store.addSource('lidarr', 'Lidarr', { url: 'http://192.168.1.103:8686', apiKey: 'lidarr-key-123' });
  db.prepare('UPDATE sources SET last_sync_at = ? WHERE id = ?').run(SYNCED_AT, lidarr);
  const nas = store.addSource('folder', 'NAS', { path: '/volume2/Music', access: 'ssh', host: '192.168.1.103', user: 'nicola', password: 'hunter2' });
  store.setSyncError(nas, 'connect ECONNREFUSED 192.168.1.103:22');

  const app = Fastify(requestIdOptions);
  const requestLog = logRequests(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', authHook({ accounts, sessions }));
  diagnosticsRoutes(app, {
    db: opts.db ?? db,
    store: opts.store ?? store,
    analyzer: { queues: () => ({ waiting: 1200, working: 2, loudnessWaiting: 40, loudnessWorking: 1, tagsWaiting: 25 }) },
    transitions: { renders: () => ({ waiting: 2, working: 1 }) },
    encoded: new EncodedStreams({ maxRunning: 8, maxPerAccount: 4, cacheBytes: 1024 * 1024 }),
    responses: requestLog.counts,
    stalls: () => ({ count: 3, longestMs: 1840, lastAt: '2026-11-07T10:02:00.000Z' }),
  });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  return {
    app,
    admin: bearer(sessions.create(1, 'Mac', 'web').token),
    member: bearer(sessions.create(member.id, 'iPhone', 'ios').token),
  };
}

describe('GET /api/diagnostics', () => {
  it('tells an admin the versions, the sources, the queues, the answers so far and the stalls', async () => {
    const { app, admin, member } = await setup();
    await app.inject({ url: '/api/diagnostics' });
    await app.inject({ url: '/api/diagnostics', headers: member });
    const res = await app.inject({ url: '/api/diagnostics', headers: admin });
    expect(res.statusCode).toBe(200);
    const body = res.json<ServerDiagnostics>();
    expect(body).toEqual({
      version: VERSION,
      schema: { version: LATEST_SCHEMA, latest: LATEST_SCHEMA },
      node: { version: process.version, uptimeSeconds: expect.any(Number), rssBytes: expect.any(Number), heapUsedBytes: expect.any(Number), heapTotalBytes: expect.any(Number) },
      sources: [
        { id: 1, kind: 'lidarr', enabled: true, lastSyncAt: SYNCED_AT },
        { id: 2, kind: 'folder', access: 'ssh', enabled: true, lastError: 'connect ECONNREFUSED 192.168.1.103:22' },
      ],
      queues: {
        analysis: { waiting: 1200, working: 2, loudnessWaiting: 40, loudnessWorking: 1, tagsWaiting: 25 },
        transitions: { waiting: 2, working: 1 },
        encodes: { working: 0 },
      },
      // The stranger's 401 and the member's 403 so far; this answer is counted once it's sent.
      responses: { status2xx: 0, status3xx: 0, status4xx: 2, status5xx: 0 },
      stalls: { count: 3, longestMs: 1840, lastAt: '2026-11-07T10:02:00.000Z' },
    });
    expect(body.node.rssBytes).toBeGreaterThan(0);
    // Nothing of the sources' settings: no address, path, user or secret (the error says what it says).
    for (const secret of ['8686', 'lidarr-key-123', '/volume2', 'nicola', 'hunter2']) expect(res.body).not.toContain(secret);
    // Pinned so the fixture is the same on every machine, at every version and schema.
    recordFixture('diagnostics', res, (d: ServerDiagnostics) => ({
      ...d,
      version: '0.7.0',
      schema: { version: 40, latest: 40 },
      node: { version: 'v24.11.0', uptimeSeconds: 86_400, rssBytes: 180_000_000, heapUsedBytes: 60_000_000, heapTotalBytes: 90_000_000 },
    }));
  });

  it('is for admins only: a member is refused, and nobody without signing in', async () => {
    const { app, member } = await setup();
    const refused = await app.inject({ url: '/api/diagnostics', headers: member });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'Only an admin can see this' });
    const stranger = await app.inject({ url: '/api/diagnostics' });
    expect(stranger.statusCode).toBe(401);
  });

  it('still answers when the database can’t be read, without what it would have read there', async () => {
    const fails = () => {
      throw new Error('database disk image is malformed');
    };
    const { app, admin } = await setup({ db: { prepare: fails } as unknown as Pick<DatabaseSync, 'prepare'>, store: { listSources: fails } });
    const res = await app.inject({ url: '/api/diagnostics', headers: admin });
    expect(res.statusCode).toBe(200);
    const body = res.json<ServerDiagnostics>();
    expect(body).not.toHaveProperty('schema');
    expect(body).not.toHaveProperty('sources');
    expect(body).toMatchObject({ version: VERSION, queues: { encodes: { working: 0 } } });
  });
});
