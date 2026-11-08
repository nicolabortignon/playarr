import type { AuthProof, SignInResponse } from '@playarr/shared';
import Fastify from 'fastify';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Accounts } from '../accounts/accounts.ts';
import { authHook } from '../accounts/auth.ts';
import { hashToken, Sessions } from '../accounts/sessions.ts';
import { SetupCodes } from '../accounts/setupCodes.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import { recordFixture } from '../testing/recordFixture.ts';
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
  return { db, accounts, sessions, setupCodes, app, post };
}

/**
 * The home-address proof worked out by hand (node:crypto): a session's token, an app's nonce, the id the app names
 * the session by, and the server's answer. The iOS app's HomeAddressTests check the same four, so the two can't drift.
 */
const VECTOR = {
  token: 'q2vK8uWm0sZb4N3yRj7tLx5pAe1cDh9fGo6iUk2wQzE',
  nonce: 'Zm9yLXRoZS10ZXN0LXZlY3Rvci1vbmx5LTAwMDAwMDA',
  id: 'zMeUpoDAZIEdQYfetB3cfbWaBgpXvauknrcPSpZz80w',
  proof: '-HSL_2JeFGzqbuQ_mS3Woz6K3OzGVWUUm8WPkiUP1p4',
};
/** The app at the server's home address, on the home network. */
const AT_HOME = { headers: { host: '192.168.1.103:4000' }, remoteAddress: '192.168.1.30' };

/** A session with VECTOR's token, as signing in would have kept it (only its hash). */
function keepVectorSession(db: DatabaseSync) {
  const at = new Date().toISOString();
  db.prepare("INSERT INTO sessions (account_id, token_hash, device, platform, created_at, last_seen_at) VALUES (1, ?, 'iPhone', 'ios', ?, ?)").run(hashToken(VECTOR.token), at, at);
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
    expect(body.account).toEqual({ id: 1, username: 'nicola', name: 'Nicola', role: 'admin', canRequest: true, requestAccess: 'on', sources: null, hasPassword: true, locked: [] });
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
    const signedIn = await post('/api/auth/sign-in', { username: 'HOME', password: 'correct horse', ...device });
    const { token, account } = signedIn.json() as SignInResponse;
    expect(account.id).toBe(1);
    recordFixture('auth-sign-in', signedIn, (answer) => ({ ...answer, token: 'token' }));
    const switched = await post('/api/auth/switch', { token });
    expect(switched.json()).toMatchObject({ id: 1, username: 'home' });
    expect(switched.headers['set-cookie']).toEqual([
      `playarr_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000`,
      `playarr_kept_1=${token}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=34560000`,
    ]);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: `playarr_session=${token}` } })).json()).toMatchObject({ id: 1 });
    const me = await app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.json()).toMatchObject({ id: 1 });
    recordFixture('auth-me', me);
    expect((await post('/api/auth/switch', { token: 'nope' })).statusCode).toBe(401);
  });

  it('keeps each account signed in on the browser as a cookie no script reads, and switches to it by its id', async () => {
    const { app, accounts, sessions, post } = setup();
    await accounts.setPassword(1, 'correct horse');
    const sam = accounts.create({ username: 'sam', name: 'Sam', role: 'member' });
    const mine = sessions.create(1, 'Mac', 'web').token;
    const sams = sessions.create(sam.id, 'Mac', 'web').token;
    // A token an older web app kept in localStorage becomes a cookie, sent only to /api/auth.
    const kept = await post('/api/auth/keep', { token: sams });
    expect(kept.json()).toMatchObject({ id: sam.id });
    expect(kept.headers['set-cookie']).toBe(`playarr_kept_${sam.id}=${sams}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=34560000`);
    expect((await post('/api/auth/keep', { token: 'nope' })).statusCode).toBe(401);
    const cookie = `playarr_session=${mine}; playarr_kept_1=${mine}; playarr_kept_${sam.id}=${sams}`;
    const switched = await post('/api/auth/switch', { accountId: sam.id }, { headers: { cookie } });
    expect(switched.json()).toMatchObject({ id: sam.id });
    expect(switched.headers['set-cookie']).toContain(`playarr_session=${sams}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000`);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: `playarr_session=${sams}` } })).json()).toMatchObject({ id: sam.id });
    // Not kept here, or kept under another account's name: nothing to switch to.
    expect((await post('/api/auth/switch', { accountId: 9 }, { headers: { cookie } })).statusCode).toBe(401);
    const misfiled = await post('/api/auth/switch', { accountId: 1 }, { headers: { cookie: `playarr_kept_1=${sams}` } });
    expect(misfiled.statusCode).toBe(401);
    // A kept sign-in that has ended is forgotten.
    sessions.remove(sam.id, sessions.list(sam.id)[0]!.id);
    const ended = await post('/api/auth/switch', { accountId: sam.id }, { headers: { cookie } });
    expect(ended.statusCode).toBe(401);
    expect(ended.headers['set-cookie']).toBe(`playarr_kept_${sam.id}=; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=0`);
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
    expect(res.headers['set-cookie']).toEqual([expect.stringMatching(/; Secure$/), expect.stringMatching(/; Secure$/)]);
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
    expect(res.headers['set-cookie']).toEqual([
      'playarr_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      'playarr_kept_1=; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=0',
    ]);
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

describe('the home-address proof', () => {
  const ask = (app: ReturnType<typeof setup>['app'], id: string, at: { headers?: Record<string, string>; remoteAddress?: string } = AT_HOME) =>
    app.inject({ url: `/api/auth/proof?id=${id}&nonce=${VECTOR.nonce}`, headers: { ...H, ...at.headers }, remoteAddress: at.remoteAddress });

  it('proves at the home address that it holds the session, asked without the token', async () => {
    const { app, accounts, db } = setup();
    await accounts.setPassword(1, 'correct horse'); // set up: every other /api route now wants a session
    keepVectorSession(db);
    const res = await ask(app, VECTOR.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ proof: VECTOR.proof });
    recordFixture('auth-proof', res);
  });

  it('answers an id that is no session’s just as it answers one it holds', async () => {
    const { app, accounts, db } = setup();
    await accounts.setPassword(1, 'correct horse');
    keepVectorSession(db);
    const res = await ask(app, randomBytes(32).toString('base64url'));
    expect(res.statusCode).toBe(200);
    const { proof } = res.json() as AuthProof;
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(proof).not.toBe(VECTOR.proof);
  });

  it('proves nothing to a question that didn’t come straight from the home network', async () => {
    // An impostor at the home address on a café's network passes the app's question on to the public address: it
    // reaches the server through the proxy, or from outside.
    const { app, accounts, db } = setup();
    await accounts.setPassword(1, 'correct horse');
    keepVectorSession(db);
    const proxied = await ask(app, VECTOR.id, { headers: { ...AT_HOME.headers, 'x-forwarded-for': AWAY }, remoteAddress: '127.0.0.1' });
    const outside = await ask(app, VECTOR.id, { headers: { host: 'music.example.com' }, remoteAddress: AWAY });
    for (const res of [proxied, outside]) {
      expect(res.statusCode).toBe(200);
      const { proof } = res.json() as AuthProof;
      expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(proof).not.toBe(VECTOR.proof);
    }
  });

  it('counts every proof asked from an address, answered or not', async () => {
    const { app, db } = setup();
    keepVectorSession(db);
    for (let i = 0; i < 30; i++) expect((await ask(app, VECTOR.id)).statusCode).toBe(200);
    const res = await ask(app, randomBytes(32).toString('base64url'));
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'Too many tries. Wait a few minutes and try again.' });
    expect((await ask(app, VECTOR.id, { ...AT_HOME, remoteAddress: '192.168.1.31' })).statusCode).toBe(200);
  });

  it('wants an id and a nonce', async () => {
    const { app } = setup();
    expect((await app.inject({ url: `/api/auth/proof?nonce=${VECTOR.nonce}`, headers: H })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/auth/proof?id=${VECTOR.id}&nonce=short`, headers: H })).statusCode).toBe(400);
  });

  it('answers only the app, so a web page open at home can’t spend its questions', async () => {
    const { app, db } = setup();
    keepVectorSession(db);
    for (let i = 0; i < 40; i++) {
      const res = await app.inject({ url: `/api/auth/proof?id=${VECTOR.id}&nonce=${VECTOR.nonce}`, ...AT_HOME });
      expect(res.statusCode).toBe(403);
    }
    expect((await ask(app, VECTOR.id)).json()).toEqual({ proof: VECTOR.proof });
  });
});
