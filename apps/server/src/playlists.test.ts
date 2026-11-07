import type { PlaylistDetail, PlaylistSummary } from '@playarr/shared';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { Accounts } from './accounts/accounts.ts';
import { actAs, asAccount, twoSources } from './accounts/testAccess.ts';
import { CC_REC } from './catalog/testFixtures.ts';
import type { PlaylistCovers } from './cover/index.ts';
import type { Recommendations } from './discover/recommendations.ts';
import { Playlists } from './playlists.ts';
import { playlistRoutes } from './routes/playlists.ts';

async function setup() {
  const s = await twoSources();
  const accounts = new Accounts(s.db);
  const sam = accounts.create({ username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: [s.lidarr] });
  // Alex hears every source, the Creative Commons song included.
  const alex = accounts.create({ username: 'alex', name: 'Alex', role: 'member', canRequest: false, sources: null });
  const covers = {
    describe: vi.fn(async () => ({ info: { url: '/art/playlist/1' } as never, art: {} as never, version: 'v1' })),
    liveDna: vi.fn(async () => ({}) as never),
    snapshot: vi.fn(() => ({}) as never),
    svg: vi.fn(async () => '<svg/>'),
    image: vi.fn(async () => Buffer.from('webp')),
  } as unknown as PlaylistCovers;
  const playlists = new Playlists(s.db, s.library, covers);
  const app = Fastify();
  actAs(app, accounts.list());
  playlistRoutes(app, { playlists, recommendations: {} as Recommendations, covers, library: s.library });
  const as = (id: number, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: asAccount(id), ...(payload ? { payload } : {}) });
  return { ...s, accounts, sam, alex, covers, playlists, app, as };
}

describe('playlists per account', () => {
  it('keeps a new playlist to its owner until it’s shared', async () => {
    const { sam, as } = await setup();
    const made = await as(1, 'POST', '/api/playlists', { name: 'Mine', recordingIds: [CC_REC] });
    expect(made.statusCode).toBe(201);
    const { id } = made.json() as PlaylistDetail;
    expect(made.json()).toMatchObject({ owner: 'Home', shared: false, mine: true, trackCount: 1 });
    expect((await as(sam.id, 'GET', '/api/playlists')).json()).toEqual([]);
    expect((await as(sam.id, 'GET', `/api/playlists/${id}`)).statusCode).toBe(404);
    expect((await as(sam.id, 'GET', `/art/playlist/${id}`)).statusCode).toBe(404);
    await as(1, 'PATCH', `/api/playlists/${id}`, { shared: true });
    expect((await as(sam.id, 'GET', '/api/playlists')).json() as PlaylistSummary[]).toEqual([expect.objectContaining({ id, owner: 'Home', shared: true, mine: false })]);
    expect((await as(sam.id, 'GET', `/art/playlist/${id}`)).statusCode).toBe(200);
  });

  it('lets only the owner change a shared playlist', async () => {
    const { sam, as } = await setup();
    const { id } = (await as(1, 'POST', '/api/playlists', { name: 'Ours', shared: true })).json() as PlaylistDetail;
    expect((await as(sam.id, 'PATCH', `/api/playlists/${id}`, { name: 'Mine now' })).statusCode).toBe(403);
    expect((await as(sam.id, 'POST', `/api/playlists/${id}/items`, { recordingIds: ['track:701'] })).statusCode).toBe(403);
    expect((await as(sam.id, 'PUT', `/api/playlists/${id}/order`, { itemIds: [] })).statusCode).toBe(403);
    expect((await as(sam.id, 'PUT', `/api/playlists/${id}/cover`, { layout: 'currents', variant: 0 })).statusCode).toBe(403);
    expect((await as(sam.id, 'DELETE', `/api/playlists/${id}`)).statusCode).toBe(403);
    expect((await as(1, 'DELETE', `/api/playlists/${id}`)).statusCode).toBe(204);
  });

  it('lists songs outside the viewer’s sources as unavailable, and draws the cover from all of them', async () => {
    const { sam, covers, as } = await setup();
    const { id } = (await as(1, 'POST', '/api/playlists', { name: 'Mixed', recordingIds: [CC_REC], shared: true })).json() as PlaylistDetail;
    const seen = (await as(sam.id, 'GET', `/api/playlists/${id}`)).json() as PlaylistDetail;
    expect(seen.items).toEqual([expect.objectContaining({ recordingId: CC_REC, title: 'Sneaky Snitch' })]);
    expect(seen.items[0]!.track).toBeUndefined();
    expect(seen.duration).toBe(0);
    const drawn = vi.mocked(covers.describe).mock.calls.at(-1)![0] as { items: { track?: object }[] };
    expect(drawn.items[0]!.track).toBeDefined();
  });

  it('adds only songs the owner may hear', async () => {
    const { sam, as } = await setup();
    const { id } = (await as(sam.id, 'POST', '/api/playlists', { name: 'Sam’s' })).json() as PlaylistDetail;
    expect((await as(sam.id, 'POST', `/api/playlists/${id}/items`, { recordingIds: [CC_REC] })).statusCode).toBe(404);
    expect((await as(sam.id, 'POST', '/api/playlists', { name: 'Again', recordingIds: [CC_REC] })).statusCode).toBe(404);
  });

  it('says which of the asker’s own playlists already hold songs, and how many of them', async () => {
    const { sam, playlists, library, lidarr } = await setup();
    const home = { account: 1, library };
    const both = await playlists.create(home, 'Both', '', ['rec-1', 'rec-2', 'rec-2']);
    const one = await playlists.create(home, 'One', '', ['rec-2'], true);
    await playlists.create(home, 'Other', '', [CC_REC]);
    const sams = await playlists.create({ account: sam.id, library: library.view([lidarr]) }, 'Sam’s', '', ['rec-1']);

    expect(playlists.holding(['rec-1', 'rec-2'], home)).toEqual({ [both.id]: 2, [one.id]: 1 });
    // Sam can see the shared playlist but not add to it: only Sam's own counts.
    expect(playlists.holding(['rec-1', 'rec-2'], { account: sam.id, library })).toEqual({ [sams.id]: 1 });
  });

  it('answers Add to playlist’s question over the API', async () => {
    const { as } = await setup();
    const { id } = (await as(1, 'POST', '/api/playlists', { name: 'Mine', recordingIds: [CC_REC] })).json() as PlaylistDetail;
    expect((await as(1, 'POST', '/api/playlists/holding', { recordingIds: [CC_REC] })).json()).toEqual({ holding: { [id]: 1 } });
    expect((await as(1, 'POST', '/api/playlists/holding', { recordingIds: 'nope' })).statusCode).toBe(400);
  });
});

describe('collaborative playlists', () => {
  /** The owner's shared playlist with the Creative Commons song, which everyone it's shared with can add to. */
  async function ours(as: Awaited<ReturnType<typeof setup>>['as']) {
    const made = (await as(1, 'POST', '/api/playlists', { name: 'Ours', recordingIds: [CC_REC], shared: true })).json() as PlaylistDetail;
    const res = await as(1, 'PATCH', `/api/playlists/${made.id}`, { collaborative: true });
    expect(res.statusCode).toBe(200);
    return res.json() as PlaylistDetail;
  }

  it('can be made only of a shared playlist, and stops being one when it stops being shared', async () => {
    const { alex, as } = await setup();
    const { id } = (await as(1, 'POST', '/api/playlists', { name: 'Mine' })).json() as PlaylistDetail;
    expect((await as(1, 'GET', `/api/playlists/${id}`)).json()).toMatchObject({ collaborative: false, canEdit: true });
    expect((await as(1, 'PATCH', `/api/playlists/${id}`, { collaborative: true })).statusCode).toBe(400);
    expect((await as(1, 'PATCH', `/api/playlists/${id}`, { shared: true, collaborative: 'yes' })).statusCode).toBe(400);
    expect((await as(1, 'PATCH', `/api/playlists/${id}`, { shared: true, collaborative: true })).json()).toMatchObject({ shared: true, collaborative: true });
    expect((await as(alex.id, 'GET', '/api/playlists')).json()).toEqual([expect.objectContaining({ id, mine: false, collaborative: true, canEdit: true })]);
    expect((await as(1, 'PATCH', `/api/playlists/${id}`, { shared: false })).json()).toMatchObject({ shared: false, collaborative: false });
    // Shared again, it takes only its owner's songs until they say otherwise.
    await as(1, 'PATCH', `/api/playlists/${id}`, { shared: true });
    expect((await as(alex.id, 'GET', `/api/playlists/${id}`)).json()).toMatchObject({ collaborative: false, canEdit: false });
  });

  it('takes songs from everyone it’s shared with, who move and remove them too, but leaves the rest to its owner', async () => {
    const { alex, as } = await setup();
    const { id, items: [first] } = await ours(as);
    const added = await as(alex.id, 'POST', `/api/playlists/${id}/items`, { recordingIds: [CC_REC] });
    expect(added.statusCode).toBe(200);
    const { items } = added.json() as PlaylistDetail;
    expect(items).toHaveLength(2);
    const order = items.map((i) => i.itemId).reverse();
    expect((await as(alex.id, 'PUT', `/api/playlists/${id}/order`, { itemIds: order })).json()).toMatchObject({ items: order.map((itemId) => ({ itemId })) });
    expect((await as(alex.id, 'DELETE', `/api/playlists/${id}/items/${first!.itemId}`)).json()).toMatchObject({ trackCount: 1 });

    for (const [method, url, payload] of [
      ['PATCH', `/api/playlists/${id}`, { name: 'Alex’s now' }],
      ['PATCH', `/api/playlists/${id}`, { collaborative: false }],
      ['PATCH', `/api/playlists/${id}`, { shared: false }],
      ['PUT', `/api/playlists/${id}/cover`, { layout: 'currents', variant: 1 }],
      ['DELETE', `/api/playlists/${id}`, undefined],
    ] as const) {
      const res = await as(alex.id, method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json()).toEqual({ error: 'Only its owner can do that to this playlist' });
    }
  });

  it('takes only songs the one adding may hear', async () => {
    const { sam, as } = await setup();
    const { id } = await ours(as);
    expect((await as(sam.id, 'POST', `/api/playlists/${id}/items`, { recordingIds: [CC_REC] })).statusCode).toBe(404);
  });

  it('says who added a song to everyone but its owner and whoever added it, until their account goes', async () => {
    const { sam, alex, accounts, as } = await setup();
    const { id } = await ours(as);
    await as(alex.id, 'POST', `/api/playlists/${id}/items`, { recordingIds: [CC_REC] });
    const credits = async (account: number) =>
      ((await as(account, 'GET', `/api/playlists/${id}`)).json() as PlaylistDetail).items.map((i) => i.addedBy ?? null);
    // The first is the owner's own; the second Alex's.
    expect(await credits(1)).toEqual([null, 'Alex']);
    expect(await credits(sam.id)).toEqual([null, 'Alex']);
    expect(await credits(alex.id)).toEqual([null, null]);
    accounts.remove(alex.id);
    expect(await credits(1)).toEqual([null, null]);
  });

  it('counts in Add to playlist’s ticks for everyone it’s shared with, unlike a playlist only its owner adds to', async () => {
    const { alex, as } = await setup();
    const { id } = await ours(as);
    await as(1, 'POST', '/api/playlists', { name: 'Just shared', recordingIds: [CC_REC], shared: true });
    expect((await as(alex.id, 'POST', '/api/playlists/holding', { recordingIds: [CC_REC] })).json()).toEqual({ holding: { [id]: 1 } });
  });
});
