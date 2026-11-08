import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { account, actAs, asAccount } from '../accounts/testAccess.ts';
import type { Discover } from '../discover/discover.ts';
import type { Requests } from '../discover/requests.ts';
import type { Library, LibraryView } from '../library/library.ts';
import { discoverRoutes } from './discover.ts';

const MBID = '11111111-1111-1111-1111-111111111111';

/** A library whose views (an account's sources) are told apart by those sources. */
function fakeLibrary() {
  const views = new Map<string, LibraryView>();
  const view = (sources: readonly number[]) => {
    const key = sources.join(',');
    if (!views.has(key)) views.set(key, { sources } as unknown as LibraryView);
    return views.get(key)!;
  };
  return { sources: null, view: vi.fn(view) } as unknown as Library & { view: (sources: readonly number[]) => LibraryView };
}

/** Requests that remember what they were asked, answering nothing in particular. */
function fakeRequests() {
  return {
    list: vi.fn(async () => []),
    request: vi.fn(async () => ({ mbid: MBID })),
    remove: vi.fn(async () => {}),
    approve: vi.fn(async () => ({ mbid: MBID })),
    decline: vi.fn(async () => ({ mbid: MBID })),
    markSeen: vi.fn(),
  };
}

describe('requests', () => {
  it('are made and withdrawn only by accounts with the right', async () => {
    const requests = fakeRequests();
    const app = Fastify();
    actAs(app, [account(1, { canRequest: true }), account(2, { canRequest: false })]);
    discoverRoutes(app, { discover: {} as Discover, requests: requests as unknown as Requests, library: fakeLibrary() });
    const body = { artistName: 'Massive Attack', albumTitle: 'Mezzanine' };
    expect((await app.inject({ method: 'POST', url: '/api/requests', headers: asAccount(2), payload: body })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/requests/${MBID}`, headers: asAccount(2) })).statusCode).toBe(403);
    expect(requests.request).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url: '/api/requests', headers: asAccount(1), payload: body })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/requests', headers: asAccount(2) })).statusCode).toBe(200);
  });

  it('belong to whoever asked: members see and withdraw their own, admins every one', async () => {
    const requests = fakeRequests();
    const app = Fastify();
    actAs(app, [account(1, { role: 'admin', canRequest: true }), account(2, { canRequest: true })]);
    discoverRoutes(app, { discover: {} as Discover, requests: requests as unknown as Requests, library: fakeLibrary() });
    await app.inject({ url: '/api/requests', headers: asAccount(1) });
    await app.inject({ url: '/api/requests', headers: asAccount(2) });
    expect(requests.list.mock.calls).toEqual([[{ accountId: 1, everyone: true }], [{ accountId: 2, everyone: false }]]);
    expect((await app.inject({ method: 'DELETE', url: `/api/requests/${MBID}`, headers: asAccount(2) })).statusCode).toBe(204);
    expect(requests.remove).toHaveBeenCalledWith(MBID, { accountId: 2, everyone: false });
  });

  it('wait for an admin when the account asks first, and only admins answer them', async () => {
    const requests = fakeRequests();
    const app = Fastify();
    actAs(app, [account(1, { role: 'admin', canRequest: true, requestAccess: 'on' }), account(2, { canRequest: true, requestAccess: 'ask' })]);
    const library = fakeLibrary();
    discoverRoutes(app, { discover: {} as Discover, requests: requests as unknown as Requests, library });
    const body = { mbid: MBID, artistName: 'Massive Attack', albumTitle: 'Mezzanine' };
    await app.inject({ method: 'POST', url: '/api/requests', headers: asAccount(2), payload: body });
    await app.inject({ method: 'POST', url: '/api/requests', headers: asAccount(1), payload: body });
    expect(requests.request.mock.calls).toEqual([
      [{ mbid: MBID, artistName: 'Massive Attack', albumTitle: 'Mezzanine' }, 2, { askFirst: true, library }],
      [{ mbid: MBID, artistName: 'Massive Attack', albumTitle: 'Mezzanine' }, 1, { askFirst: false, library }],
    ]);
    for (const answer of ['approve', 'decline'] as const) {
      expect((await app.inject({ method: 'POST', url: `/api/requests/${MBID}/${answer}`, headers: asAccount(2) })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `/api/requests/${MBID}/${answer}`, headers: asAccount(1) })).statusCode).toBe(200);
      expect(requests[answer]).toHaveBeenCalledWith(MBID, { accountId: 1, everyone: true });
    }
  });

  it('say what the account has seen, all of its own or the ones named', async () => {
    const requests = fakeRequests();
    const app = Fastify();
    actAs(app, [account(2, { canRequest: false })]);
    discoverRoutes(app, { discover: {} as Discover, requests: requests as unknown as Requests, library: fakeLibrary() });
    expect((await app.inject({ method: 'POST', url: '/api/requests/seen', headers: asAccount(2), payload: { mbids: [MBID] } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/api/requests/seen', headers: asAccount(2) })).statusCode).toBe(204);
    expect(requests.markSeen.mock.calls).toEqual([[2, [MBID]], [2, undefined]]);
    expect((await app.inject({ method: 'POST', url: '/api/requests/seen', headers: asAccount(2), payload: { mbids: MBID } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/requests/seen', headers: asAccount(2), payload: { mbids: [7] } })).statusCode).toBe(400);
    expect(requests.markSeen).toHaveBeenCalledTimes(2);
  });
});

describe('an account that hears only some sources', () => {
  it('gets Discover’s links, and its requests’ albums, from the library as it sees it', async () => {
    const requests = fakeRequests();
    const discover = { search: vi.fn(async () => ({ artists: [], albums: [], tracks: [] })), artist: vi.fn(async () => ({})) };
    const library = fakeLibrary();
    const app = Fastify();
    actAs(app, [account(1, { role: 'admin', canRequest: true }), account(2, { canRequest: true, sources: [2] })]);
    discoverRoutes(app, { discover: discover as unknown as Discover, requests: requests as unknown as Requests, library });
    await app.inject({ url: '/api/discover/search?q=massive', headers: asAccount(1) });
    await app.inject({ url: '/api/discover/search?q=massive', headers: asAccount(2) });
    await app.inject({ url: `/api/discover/artists/${MBID}`, headers: asAccount(2) });
    const limited = library.view([2]);
    expect(discover.search.mock.calls.map((c) => (c as unknown[])[1])).toEqual([library, limited]);
    expect((discover.artist.mock.calls[0] as unknown[])[1]).toBe(limited);
    await app.inject({ url: '/api/requests', headers: asAccount(1) });
    await app.inject({ url: '/api/requests', headers: asAccount(2) });
    expect(requests.list.mock.calls).toEqual([[{ accountId: 1, everyone: true }], [{ accountId: 2, everyone: false, library: limited }]]);
  });
});
