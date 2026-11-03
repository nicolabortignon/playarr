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
  return { ...s, sam, covers, app, as };
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
});
