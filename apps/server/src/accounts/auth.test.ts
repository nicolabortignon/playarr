import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { freshDb } from '../catalog/testFixtures.ts';
import { Accounts } from './accounts.ts';
import { authHook, readCookie } from './auth.ts';
import { Sessions } from './sessions.ts';

function setup() {
  const db = freshDb();
  const accounts = new Accounts(db);
  const sessions = new Sessions(db);
  const app = Fastify();
  app.decorateRequest('auth', null);
  app.addHook('onRequest', authHook({ accounts, sessions }));
  const who = (req: { auth?: { account: { id: number }; setup: boolean; session: { via: string } | null } | null }) => ({
    id: req.auth?.account.id ?? null,
    setup: req.auth?.setup ?? null,
    via: req.auth?.session?.via ?? null,
  });
  app.get('/api/whoami', (req) => who(req));
  app.post('/api/change', (req) => who(req));
  for (const url of ['/stream/1', '/art/album/1/cover', '/transitions/x.flac', '/api/server', '/api/health', '/']) app.get(url, () => 'ok');
  for (const url of ['/api/auth/sign-in', '/api/auth/redeem', '/api/auth/setup', '/api/auth/switch']) app.post(url, () => 'ok');
  return { accounts, sessions, app };
}

describe('authHook', () => {
  it('acts as the owner for everyone while no account has a password (setup mode)', async () => {
    const { app } = setup();
    expect((await app.inject({ url: '/api/whoami' })).json()).toEqual({ id: 1, setup: true, via: null });
    expect((await app.inject({ url: '/stream/1' })).statusCode).toBe(200);
  });

  it('once a password exists, wants a session on the API, streams, art and transitions', async () => {
    const { app, accounts } = setup();
    await accounts.setPassword(1, 'correct horse');
    for (const url of ['/api/whoami', '/stream/1', '/art/album/1/cover', '/transitions/x.flac']) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Sign in to Playarr', setup: false });
    }
  });

  it('leaves open what an app needs to find the server and sign in, and the web pages', async () => {
    const { app, accounts } = setup();
    await accounts.setPassword(1, 'correct horse');
    for (const url of ['/api/server', '/api/health', '/']) expect((await app.inject({ url })).statusCode).toBe(200);
    for (const url of ['/api/auth/sign-in', '/api/auth/redeem', '/api/auth/setup', '/api/auth/switch']) {
      expect((await app.inject({ method: 'POST', url, headers: { 'x-playarr': '1' } })).statusCode).toBe(200);
    }
  });

  it('takes the session from a Bearer token or the session cookie', async () => {
    const { app, accounts, sessions } = setup();
    await accounts.setPassword(1, 'correct horse');
    const { token } = sessions.create(1, 'iPhone', 'ios');
    expect((await app.inject({ url: '/api/whoami', headers: { authorization: `Bearer ${token}` } })).json()).toEqual({ id: 1, setup: false, via: 'bearer' });
    expect((await app.inject({ url: '/api/whoami', headers: { cookie: `theme=dark; playarr_session=${token}` } })).json()).toEqual({ id: 1, setup: false, via: 'cookie' });
    expect((await app.inject({ url: '/api/whoami', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
  });

  it('wants the X-Playarr header on changes from browsers, not from Bearer tokens', async () => {
    const { app, accounts, sessions } = setup();
    await accounts.setPassword(1, 'correct horse');
    const { token } = sessions.create(1, 'Mac', 'web');
    const cookie = { cookie: `playarr_session=${token}` };
    expect((await app.inject({ method: 'POST', url: '/api/change', headers: cookie })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/change', headers: { ...cookie, 'x-playarr': '1' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/change', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
  });

  it('reads one cookie out of the header', () => {
    expect(readCookie('a=1; playarr_session=abc-_; b=2', 'playarr_session')).toBe('abc-_');
    expect(readCookie('a=1', 'playarr_session')).toBeUndefined();
    expect(readCookie(undefined, 'playarr_session')).toBeUndefined();
  });
});
