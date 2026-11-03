import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { CC_REC, freshDb } from '../catalog/testFixtures.ts';
import { Accounts } from './accounts.ts';
import { accountId, libraryOf, requireAdmin, requireCanRequest, requireLocalSetup, requireOwn, visibleRecordings } from './rights.ts';
import { account, actAs, asAccount, twoSources } from './testAccess.ts';

const HOME = '192.168.1.20';
const AWAY = '203.0.113.5';

function routes(app: FastifyInstance) {
  app.get('/admin', { onRequest: requireAdmin }, () => 'ok');
  app.put('/admin', { onRequest: requireAdmin }, () => 'ok');
  app.get('/own', { onRequest: requireOwn }, () => 'ok');
  app.get('/request', { onRequest: requireCanRequest }, () => 'ok');
  app.get('/who', (req) => ({ id: accountId(req) }));
  return app;
}

describe('rights', () => {
  it('lets admins in, members only to their own settings, and nobody unsigned', async () => {
    const app = Fastify();
    actAs(app, [account(1, { role: 'admin' }), account(2)]);
    routes(app);
    expect((await app.inject({ url: '/admin', headers: asAccount(1), remoteAddress: AWAY })).statusCode).toBe(200);
    const member = await app.inject({ url: '/admin', headers: asAccount(2), remoteAddress: HOME });
    expect(member.statusCode).toBe(403);
    // A read is "seen", a change "changed".
    expect(member.json()).toEqual({ error: 'Only an admin can see this' });
    const change = await app.inject({ method: 'PUT', url: '/admin', headers: asAccount(2), remoteAddress: HOME });
    expect(change.statusCode).toBe(403);
    expect(change.json()).toEqual({ error: 'Only an admin can change this' });
    expect((await app.inject({ url: '/own', headers: asAccount(2), remoteAddress: AWAY })).statusCode).toBe(200);
    expect((await app.inject({ url: '/own', remoteAddress: HOME })).statusCode).toBe(403);
    expect((await app.inject({ url: '/who', headers: asAccount(2) })).json()).toEqual({ id: 2 });
  });

  it('goes by the home network in setup mode and for routes run without accounts, as before', async () => {
    for (const app of [routes(Fastify()), setupMode()]) {
      expect((await app.inject({ url: '/admin', remoteAddress: HOME })).statusCode).toBe(200);
      const away = await app.inject({ url: '/admin', remoteAddress: AWAY });
      expect(away.statusCode).toBe(403);
      expect(away.json()).toEqual({ error: 'Settings can only be changed from your home network' });
      expect((await app.inject({ url: '/own', remoteAddress: AWAY })).statusCode).toBe(403);
      expect((await app.inject({ url: '/request', remoteAddress: AWAY })).statusCode).toBe(200);
      expect((await app.inject({ url: '/who' })).json()).toEqual({ id: 1 });
    }
  });

  it('lets only accounts with the right request albums', async () => {
    const app = Fastify();
    actAs(app, [account(1, { canRequest: true }), account(2, { canRequest: false })]);
    routes(app);
    expect((await app.inject({ url: '/request', headers: asAccount(1) })).statusCode).toBe(200);
    expect((await app.inject({ url: '/request', headers: asAccount(2) })).json()).toEqual({ error: 'Your account can’t request albums' });
    expect((await app.inject({ url: '/request' })).statusCode).toBe(403);
  });

  it('lets the server be claimed only in setup mode, from the home network', async () => {
    const accounts = new Accounts(freshDb());
    const app = Fastify();
    app.post('/claim', { onRequest: requireLocalSetup(accounts) }, () => 'ok');
    expect((await app.inject({ method: 'POST', url: '/claim', remoteAddress: AWAY })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/claim', remoteAddress: HOME })).statusCode).toBe(200);
    await accounts.setPassword(1, 'correct horse');
    expect((await app.inject({ method: 'POST', url: '/claim', remoteAddress: HOME })).statusCode).toBe(409);
  });
});

/** An app whose requests all act as the owner in setup mode, as the auth hook makes them. */
function setupMode() {
  const app = Fastify();
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    req.auth = { setup: true, account: account(1, { role: 'admin', canRequest: true }), session: null };
  });
  return routes(app);
}

describe('libraryOf', () => {
  it('narrows the library to the account’s sources, and leaves it whole otherwise', async () => {
    const { library, cc } = await twoSources();
    const as = (sources: number[] | null) => ({ auth: { setup: false, account: account(2, { sources }), session: null } }) as unknown as FastifyRequest;
    expect(libraryOf(library, as(null))).toBe(library);
    expect(libraryOf(library, {} as FastifyRequest)).toBe(library);
    expect(libraryOf(library, as([cc])).sources).toEqual([cc]);
    expect(await visibleRecordings(library, as([cc]), ['rec-1', CC_REC])).toEqual([CC_REC]);
    expect(await visibleRecordings(library, as(null), ['rec-1', 'gone'])).toEqual(['rec-1', 'gone']);
    expect(() => libraryOf({ track: async () => undefined }, as([cc]))).toThrow(/narrowed/);
  });
});
