import type { Account, CreatedAccount, SessionInfo, SetupCode } from '@playarr/shared';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { Accounts } from '../accounts/accounts.ts';
import { authHook } from '../accounts/auth.ts';
import { Sessions } from '../accounts/sessions.ts';
import { SetupCodes } from '../accounts/setupCodes.ts';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import { accountRoutes } from './accounts.ts';

async function setup({ claimed = true } = {}) {
  const db = freshDb();
  const store = new CatalogStore(db);
  const cc = store.addSource('folder', 'Creative Commons');
  const accounts = new Accounts(db);
  const sessions = new Sessions(db);
  const setupCodes = new SetupCodes(db);
  const app = Fastify();
  app.decorateRequest('auth', null);
  app.addHook('onRequest', authHook({ accounts, sessions }));
  accountRoutes(app, { accounts, sessions, setupCodes });
  const sam = accounts.create({ username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null });
  if (claimed) {
    await accounts.setPassword(1, 'correct horse');
    await accounts.setPassword(sam.id, 'sams password');
  }
  const admin = sessions.create(1, 'Mac', 'web').token;
  const member = sessions.create(sam.id, 'iPhone', 'ios').token;
  const as = (token: string) => ({ authorization: `Bearer ${token}`, host: 'nas:4000' });
  return { accounts, sessions, app, cc, sam, admin, member, as };
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
    expect((await app.inject({ url: '/api/accounts', headers: as(admin) })).json()).toHaveLength(3);
    expect((await app.inject({ url: '/api/accounts', headers: as(member) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/accounts', headers: as(member), payload: { username: 'x', name: 'X', role: 'admin', canRequest: true, sources: null } })).statusCode).toBe(403);
    const bad = await app.inject({ method: 'POST', url: '/api/accounts', headers: as(admin), payload: { username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null } });
    expect(bad.json()).toEqual({ error: 'That username is taken' });
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
    const own = (await app.inject({ url: `/api/accounts/${sam.id}/sessions`, headers: as(member) })).json() as SessionInfo[];
    expect(own).toEqual([expect.objectContaining({ device: 'iPhone', platform: 'ios', current: true })]);
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
});
