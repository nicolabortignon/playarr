import type { Account, CreatedAccount, ListedAccount, SessionInfo, SetupCode } from '@playarr/shared';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { Accounts } from '../accounts/accounts.ts';
import { authHook } from '../accounts/auth.ts';
import { Sessions } from '../accounts/sessions.ts';
import { SetupCodes } from '../accounts/setupCodes.ts';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import { recordFixture } from '../testing/recordFixture.ts';
import { accountRoutes } from './accounts.ts';

/** Setup codes are random: the fixtures get a fixed one. */
const CODE = 'K7PQ2MXA';
const pinCode = (code: SetupCode): SetupCode => ({ ...code, code: CODE, link: code.link.replace(code.code, CODE) });

async function setup({ claimed = true, trustProxy = false, publicUrl = undefined as string | undefined } = {}) {
  const db = freshDb();
  const store = new CatalogStore(db);
  const cc = store.addSource('folder', 'Creative Commons');
  const accounts = new Accounts(db);
  const sessions = new Sessions(db);
  const setupCodes = new SetupCodes(db);
  const app = Fastify({ trustProxy });
  app.decorateRequest('auth', null);
  app.addHook('onRequest', authHook({ accounts, sessions }));
  accountRoutes(app, { accounts, sessions, setupCodes, publicUrl });
  const sam = accounts.create({ username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null });
  if (claimed) {
    await accounts.setPassword(1, 'correct horse');
    await accounts.setPassword(sam.id, 'sams password');
  }
  const admin = sessions.create(1, 'Mac', 'web').token;
  const member = sessions.create(sam.id, 'iPhone', 'ios').token;
  const as = (token: string) => ({ authorization: `Bearer ${token}`, host: 'nas:4000' });
  return { db, accounts, sessions, app, cc, sam, admin, member, as };
}

describe('account routes', () => {
  it('lets admins list and add accounts, each new one with a setup code and link', async () => {
    const { app, cc, admin, member, as } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/accounts', headers: as(admin), payload: { username: 'reviewer', name: 'App Review', role: 'member', canRequest: false, sources: [cc] } });
    expect(res.statusCode).toBe(201);
    const { account, setup: code } = res.json() as CreatedAccount;
    expect(account).toMatchObject({ username: 'reviewer', name: 'App Review', role: 'member', canRequest: false, sources: [cc], hasPassword: false });
    expect(code.code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(code.link).toBe(`http://nas:4000/redeem?code=${code.code}`);
    recordFixture('account-created', res, (answer: CreatedAccount) => ({ ...answer, setup: pinCode(answer.setup) }));
    const all = await app.inject({ url: '/api/accounts', headers: as(admin) });
    expect(all.json()).toHaveLength(3);
    recordFixture('accounts', all);
    const list = await app.inject({ url: '/api/accounts', headers: as(member) });
    expect(list.statusCode).toBe(403);
    expect(list.json()).toEqual({ error: 'Only an admin can see this' });
    expect((await app.inject({ method: 'POST', url: '/api/accounts', headers: as(member), payload: { username: 'x', name: 'X', role: 'admin', canRequest: true, sources: null } })).statusCode).toBe(403);
    const bad = await app.inject({ method: 'POST', url: '/api/accounts', headers: as(admin), payload: { username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null } });
    expect(bad.json()).toEqual({ error: 'That username is taken' });
  });

  it('lists how many songs each account has played and how many playlists it has made', async () => {
    const { db, app, sam, admin, as } = await setup();
    const play = db.prepare(
      `INSERT INTO plays (recording_id, played_at, hour, weekday, seconds, skipped, account_id) VALUES (?, ?, 20, 1, 200, ?, ?)`,
    );
    play.run('rec-1', '2026-11-04T20:00:00Z', 0, sam.id);
    play.run('rec-2', '2026-11-04T20:04:00Z', 0, sam.id);
    play.run('rec-3', '2026-11-04T20:08:00Z', 1, sam.id); // skipped: not counted, as in Your listening
    play.run('rec-1', '2026-11-04T21:00:00Z', 0, 1);
    db.prepare(`INSERT INTO playlists (name, created_at, updated_at, account_id) VALUES ('Road trip', '2026-11-04', '2026-11-04', ?)`).run(sam.id);
    const listed = (await app.inject({ url: '/api/accounts', headers: as(admin) })).json() as ListedAccount[];
    expect(listed.map(({ username, plays, playlists }) => ({ username, plays, playlists }))).toEqual([
      { username: 'home', plays: 1, playlists: 0 },
      { username: 'sam', plays: 2, playlists: 1 },
    ]);
  });

  it('lets only an admin lock what a member may change on their devices', async () => {
    const { app, sam, admin, member, as } = await setup();
    const locked = await app.inject({ method: 'PATCH', url: `/api/accounts/${sam.id}`, headers: as(admin), payload: { locked: ['playback'] } });
    expect((locked.json() as Account).locked).toEqual(['playback']);
    const me = await app.inject({ method: 'PATCH', url: `/api/accounts/${sam.id}`, headers: as(member), payload: { locked: [] } });
    expect(me.statusCode).toBe(403);
    const unknown = await app.inject({ method: 'PATCH', url: `/api/accounts/${sam.id}`, headers: as(admin), payload: { locked: ['volume'] } });
    expect(unknown.statusCode).toBe(400);
  });

  it('lets members change their own name, and nothing else', async () => {
    const { app, sam, member, as } = await setup();
    expect((await app.inject({ method: 'PATCH', url: `/api/accounts/${sam.id}`, headers: as(member), payload: { name: 'Samantha' } })).json()).toMatchObject({ name: 'Samantha' });
    expect((await app.inject({ method: 'PATCH', url: `/api/accounts/${sam.id}`, headers: as(member), payload: { role: 'admin' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: '/api/accounts/1', headers: as(member), payload: { name: 'Mine' } })).statusCode).toBe(403);
  });

  it('lets admins change rights and library access', async () => {
    const { app, cc, sam, admin, as } = await setup();
    const res = await app.inject({ method: 'PATCH', url: `/api/accounts/${sam.id}`, headers: as(admin), payload: { canRequest: true, sources: [cc] } });
    expect(res.json()).toMatchObject({ canRequest: true, sources: [cc] });
    expect((await app.inject({ method: 'PATCH', url: '/api/accounts/1', headers: as(admin), payload: { role: 'member' } })).statusCode).toBe(409);
  });

  it('resets an account: signed out everywhere, password gone, a new setup code', async () => {
    const { app, accounts, sam, admin, member, as } = await setup();
    const res = await app.inject({ method: 'POST', url: `/api/accounts/${sam.id}/reset`, headers: as(admin) });
    expect((res.json() as SetupCode).code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    recordFixture('setup-code', res, pinCode);
    expect(accounts.get(sam.id)!.hasPassword).toBe(false);
    expect((await app.inject({ url: `/api/accounts/${sam.id}/sessions`, headers: as(member) })).statusCode).toBe(401);
  });

  it('never deletes the last admin', async () => {
    const { app, sam, admin, as } = await setup();
    expect((await app.inject({ method: 'DELETE', url: '/api/accounts/1', headers: as(admin) })).statusCode).toBe(409);
    const left = await app.inject({ method: 'DELETE', url: `/api/accounts/${sam.id}`, headers: as(admin) });
    expect((left.json() as Account[]).map((a) => a.id)).toEqual([1]);
  });

  it('lists and ends sessions, for the account itself or an admin', async () => {
    const { app, sam, admin, member, as } = await setup();
    const listed = await app.inject({ url: `/api/accounts/${sam.id}/sessions`, headers: as(member) });
    const own = listed.json() as SessionInfo[];
    expect(own).toEqual([expect.objectContaining({ device: 'iPhone', platform: 'ios', current: true })]);
    recordFixture('sessions', listed);
    expect(((await app.inject({ url: `/api/accounts/${sam.id}/sessions`, headers: as(admin) })).json() as SessionInfo[])[0]!.current).toBe(false);
    expect((await app.inject({ url: '/api/accounts/1/sessions', headers: as(member) })).statusCode).toBe(403);
    const ended = await app.inject({ method: 'DELETE', url: `/api/accounts/${sam.id}/sessions/${own[0]!.id}`, headers: as(admin) });
    expect(ended.json()).toEqual([]);
    expect((await app.inject({ url: `/api/accounts/${sam.id}/sessions`, headers: as(member) })).statusCode).toBe(401);
  });

  it('makes no setup codes before the owner has set up the server', async () => {
    const { app } = await setup({ claimed: false });
    const headers = { 'x-playarr': '1' };
    expect((await app.inject({ url: '/api/accounts', headers })).statusCode).toBe(200); // the home network, as before
    expect((await app.inject({ method: 'POST', url: '/api/accounts', headers, payload: { username: 'x', name: 'X', role: 'member', canRequest: false, sources: null } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/accounts/2/reset', headers })).statusCode).toBe(409);
  });

  describe('setup links', () => {
    const forwarded = { 'x-forwarded-host': 'music.example.com', 'x-forwarded-proto': 'https' };
    const linkOf = async (options: Parameters<typeof setup>[0]) => {
      const { app, sam, admin, as } = await setup(options);
      const res = await app.inject({ method: 'POST', url: `/api/accounts/${sam.id}/reset`, headers: { ...as(admin), ...forwarded } });
      return (res.json() as SetupCode).link.replace(/\?code=.*$/, '');
    };

    it('use PUBLIC_URL when it’s set', async () => {
      expect(await linkOf({ publicUrl: 'https://playarr.example.org', trustProxy: true })).toBe('https://playarr.example.org/redeem');
    });

    it('follow the forwarded host and protocol only behind a trusted proxy', async () => {
      expect(await linkOf({ trustProxy: true })).toBe('https://music.example.com/redeem');
    });

    it('otherwise use the Host header and the connection’s own protocol', async () => {
      expect(await linkOf({})).toBe('http://nas:4000/redeem');
    });
  });
});
