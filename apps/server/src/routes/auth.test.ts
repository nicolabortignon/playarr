import type { SignInResponse } from '@playarr/shared';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { Accounts } from '../accounts/accounts.ts';
import { authHook } from '../accounts/auth.ts';
import { Sessions } from '../accounts/sessions.ts';
import { SetupCodes } from '../accounts/setupCodes.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import { authRoutes } from './auth.ts';

const AWAY = '203.0.113.5';
const H = { 'x-playarr': '1' };
const device = { device: 'Safari on Mac', platform: 'web' };

function setup(options: { trustProxy?: boolean } = {}) {
  const db = freshDb();
  const accounts = new Accounts(db);
  const sessions = new Sessions(db);
  const setupCodes = new SetupCodes(db);
  const app = Fastify(options);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', authHook({ accounts, sessions }));
  authRoutes(app, { accounts, sessions, setupCodes });
  const post = (url: string, payload: object, extra: { headers?: Record<string, string>; remoteAddress?: string } = {}) =>
    app.inject({ method: 'POST', url, payload, headers: { ...H, ...extra.headers }, remoteAddress: extra.remoteAddress });
  return { accounts, sessions, setupCodes, app, post };
}

const owner = { username: 'nicola', name: 'Nicola', password: 'correct horse', ...device };

describe('auth routes', () => {
  it('claims the owner account from the home network, once', async () => {
    const { accounts, post } = setup();
    expect((await post('/api/auth/setup', owner, { remoteAddress: AWAY })).statusCode).toBe(403);
    expect((await post('/api/auth/setup', { ...owner, password: 'short' })).statusCode).toBe(400);
    expect(accounts.get(1)!.username).toBe('home'); // a refused try changes nothing
    const res = await post('/api/auth/setup', owner);
    expect(res.statusCode).toBe(200);
    const body = res.json() as SignInResponse;
    expect(body.account).toEqual({ id: 1, username: 'nicola', name: 'Nicola', role: 'admin', canRequest: true, sources: null, hasPassword: true });
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(accounts.setupMode()).toBe(false);
    expect((await post('/api/auth/setup', owner)).statusCode).toBe(409);
  });

  it('signs in with the right password, and makes the session the cookie on switch', async () => {
    const { app, accounts, post } = setup();
    await accounts.setPassword(1, 'correct horse');
    const wrong = await post('/api/auth/sign-in', { username: 'home', password: 'wrong horse', ...device });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: 'Wrong username or password', setup: false });
    const { token, account } = (await post('/api/auth/sign-in', { username: 'HOME', password: 'correct horse', ...device })).json() as SignInResponse;
    expect(account.id).toBe(1);
    const switched = await post('/api/auth/switch', { token });
    expect(switched.json()).toMatchObject({ id: 1, username: 'home' });
    expect(switched.headers['set-cookie']).toBe(`playarr_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000`);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: `playarr_session=${token}` } })).json()).toMatchObject({ id: 1 });
    expect((await app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } })).json()).toMatchObject({ id: 1 });
    expect((await post('/api/auth/switch', { token: 'nope' })).statusCode).toBe(401);
  });

  it('signs in without a device or platform, recording the defaults', async () => {
    const { accounts, sessions, post } = setup();
    await accounts.setPassword(1, 'correct horse');
    const res = await post('/api/auth/sign-in', { username: 'home', password: 'correct horse' });
    expect(res.statusCode).toBe(200);
    expect(sessions.list(1)).toEqual([expect.objectContaining({ device: 'Unknown device', platform: 'web' })]);
  });

  it('marks the cookie Secure when Playarr is reached over HTTPS', async () => {
    const { accounts, sessions, post } = setup();
    await accounts.setPassword(1, 'correct horse');
    const { token } = sessions.create(1, 'Mac', 'web');
    const res = await post('/api/auth/switch', { token }, { headers: { 'x-forwarded-proto': 'https' } });
    expect(res.headers['set-cookie']).toMatch(/; Secure$/);
  });

  it('turns sign-ins away after 10 failures from an address, and only from that address', async () => {
    const { accounts, post } = setup();
    await accounts.setPassword(1, 'correct horse');
    const right = { username: 'home', password: 'correct horse', ...device };
    for (let i = 0; i < 10; i++) await post('/api/auth/sign-in', { ...right, password: 'wrong horse' }, { remoteAddress: '192.168.1.30' });
    expect((await post('/api/auth/sign-in', right, { remoteAddress: '192.168.1.30' })).statusCode).toBe(429);
    // The username isn't locked: someone guessing it from elsewhere can't keep its owner out.
    expect((await post('/api/auth/sign-in', right, { remoteAddress: '192.168.1.31' })).statusCode).toBe(200);
  });

  it('counts redeem failures per address too', async () => {
    const { post } = setup();
    for (let i = 0; i < 10; i++) await post('/api/auth/redeem', { code: 'WRONGONE', password: 'sams password' }, { remoteAddress: '192.168.1.30' });
    expect((await post('/api/auth/redeem', { code: 'WRONGONE', password: 'sams password' }, { remoteAddress: '192.168.1.30' })).statusCode).toBe(429);
    expect((await post('/api/auth/redeem', { code: 'WRONGONE', password: 'sams password' }, { remoteAddress: '192.168.1.31' })).statusCode).toBe(400);
  });

  it('behind a trusted proxy, counts failures per visitor (X-Forwarded-For), not per proxy', async () => {
    const { accounts, post } = setup({ trustProxy: true });
    await accounts.setPassword(1, 'correct horse');
    const right = { username: 'home', password: 'correct horse', ...device };
    const from = (visitor: string) => ({ headers: { 'x-forwarded-for': visitor } });
    for (let i = 0; i < 10; i++) await post('/api/auth/sign-in', { ...right, password: 'wrong horse' }, from('198.51.100.7'));
    expect((await post('/api/auth/sign-in', right, from('198.51.100.7'))).statusCode).toBe(429);
    expect((await post('/api/auth/sign-in', right, from('198.51.100.8'))).statusCode).toBe(200);
  });

  it('says whose username it is when the owner picks one another account has', async () => {
    const { accounts, post } = setup();
    accounts.create({ username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null });
    const res = await post('/api/auth/setup', { ...owner, username: 'Sam' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'That username belongs to Sam. Pick another; you can rename them later.' });
    expect(accounts.setupMode()).toBe(true);
    expect((await post('/api/auth/setup', { ...owner, username: 'home' })).statusCode).toBe(200); // the owner's own is fine
  });

  it('redeems a setup code once, for the account’s first password', async () => {
    const { accounts, setupCodes, post } = setup();
    await accounts.setPassword(1, 'correct horse');
    const sam = accounts.create({ username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null });
    const { code } = setupCodes.issue(sam.id, 'http://nas:4000');
    expect((await post('/api/auth/redeem', { code, password: 'short', ...device })).statusCode).toBe(400);
    const res = await post('/api/auth/redeem', { code: code.toLowerCase(), password: 'sams password', ...device });
    expect((res.json() as SignInResponse).account).toMatchObject({ id: sam.id, hasPassword: true });
    const again = await post('/api/auth/redeem', { code, password: 'sams password', ...device });
    expect(again.json()).toEqual({ error: 'That code is wrong, used or expired. Ask for a new one.' });
    expect(await accounts.verify('sam', 'sams password')).toMatchObject({ id: sam.id });
  });

  it('signs out this device only, and clears the cookie', async () => {
    const { app, accounts, sessions, post } = setup();
    await accounts.setPassword(1, 'correct horse');
    const here = sessions.create(1, 'Mac', 'web').token;
    const phone = sessions.create(1, 'iPhone', 'ios').token;
    const res = await post('/api/auth/sign-out', {}, { headers: { cookie: `playarr_session=${here}` } });
    expect(res.statusCode).toBe(204);
    expect(res.headers['set-cookie']).toBe('playarr_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: `playarr_session=${here}` } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${phone}` } })).statusCode).toBe(200);
  });

  it('says nobody is signed in, and that the server needs setting up, before anyone can be', async () => {
    const { app } = setup();
    const res = await app.inject({ url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Nobody is signed in', setup: true });
  });
});
