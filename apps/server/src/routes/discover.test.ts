import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { account, actAs, asAccount } from '../accounts/testAccess.ts';
import type { Discover } from '../discover/discover.ts';
import type { Requests } from '../discover/requests.ts';
import { discoverRoutes } from './discover.ts';

const MBID = '11111111-1111-1111-1111-111111111111';

describe('requests', () => {
  it('are made and withdrawn only by accounts with the right', async () => {
    const requests = { list: () => [], request: vi.fn(async () => ({ mbid: MBID })), remove: vi.fn(async () => {}) } as unknown as Requests;
    const app = Fastify();
    actAs(app, [account(1, { canRequest: true }), account(2, { canRequest: false })]);
    discoverRoutes(app, { discover: {} as Discover, requests });
    const body = { artistName: 'Massive Attack', albumTitle: 'Mezzanine' };
    expect((await app.inject({ method: 'POST', url: '/api/requests', headers: asAccount(2), payload: body })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/requests/${MBID}`, headers: asAccount(2) })).statusCode).toBe(403);
    expect(requests.request).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url: '/api/requests', headers: asAccount(1), payload: body })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/requests', headers: asAccount(2) })).statusCode).toBe(200);
  });
});
