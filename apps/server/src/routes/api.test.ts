import type { Album, AlbumPage, Artist, ArtistPage } from '@playarr/shared';
import Fastify from 'fastify';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { account, actAs, asAccount, twoSources } from '../accounts/testAccess.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import type { Config } from '../config.ts';
import { CoverColorStore } from '../library/coverColorStore.ts';
import { LidarrClient } from '../lidarr/client.ts';
import type { MediaSource } from '../media/index.ts';
import { apiRoutes } from './api.ts';

/**
 * The library routes over two sources (Mezzanine from Lidarr, Royalty Free from a folder), as the owner (account 1)
 * and as a member who hears only the folder (account 2).
 */
async function setup(colors?: CoverColorStore) {
  const sources = await twoSources(colors);
  const app = Fastify();
  actAs(app, [account(1, { role: 'admin' }), account(2, { sources: [sources.cc] })]);
  apiRoutes(app, {
    config: { pathMap: [] } as unknown as Config,
    lidarr: new LidarrClient(),
    library: sources.library,
    media: { kind: 'local', check: async () => {} } as unknown as MediaSource,
    requestSettings: () => ({ enabled: false, searchOnAdd: true }),
  });
  const get = (url: string, as = 1, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers: { ...asAccount(as), ...headers } });
  return { ...sources, app, get };
}

const titles = (albums: Album[]) => albums.map((a) => a.title);

describe('the albums and artists lists', () => {
  it('answer as they always have without the paging parameters, for the apps already out there', async () => {
    const { get } = await setup();
    // Kevin MacLeod sorts by "MacLeod, Kevin", before Massive Attack.
    expect(titles((await get('/api/albums')).json())).toEqual(['Royalty Free', 'Mezzanine']);
    expect(titles((await get('/api/albums?sort=title')).json())).toEqual(['Mezzanine', 'Royalty Free']);
    expect(titles((await get('/api/albums?sort=added&limit=1')).json())).toEqual(['Royalty Free']);
    expect(((await get('/api/artists')).json() as Artist[]).map((a) => a.name)).toEqual(['Kevin MacLeod', 'Massive Attack']);
  });

  it('come a page at a time with `offset`, saying how many there are in all and the version they were read at', async () => {
    const { get } = await setup();
    const first = (await get('/api/albums?sort=artist&offset=0&limit=1')).json() as AlbumPage;
    expect(first).toEqual({ albums: [expect.objectContaining({ title: 'Royalty Free' })], total: 2, version: expect.any(String) });
    // Lists' albums leave out their songs and text.
    expect(first.albums[0]).not.toHaveProperty('tracks');
    const second = (await get('/api/albums?sort=artist&offset=1&limit=1')).json() as AlbumPage;
    expect(titles(second.albums)).toEqual(['Mezzanine']);
    expect(second.version).toBe(first.version);
    expect((await get('/api/albums?offset=5')).json()).toEqual({ albums: [], total: 2, version: first.version });
    const artists = (await get('/api/artists?offset=1&limit=10')).json() as ArtistPage;
    expect(artists).toEqual({ artists: [expect.objectContaining({ name: 'Massive Attack' })], total: 2, version: first.version });
    // A bad offset is the first page.
    expect(titles(((await get('/api/albums?offset=-3')).json() as AlbumPage).albums)).toEqual(['Royalty Free', 'Mezzanine']);
  });

  it('are filtered by fidelity and genre, and say what they can be filtered by', async () => {
    const { get } = await setup();
    expect((await get('/api/albums/filters')).json()).toEqual({
      // Mezzanine has its artist's.
      genres: [{ name: 'trip hop', count: 1 }],
      fidelities: [
        { value: 'lossless', count: 1 },
        { value: 'lossy', count: 1 },
      ],
    });
    expect(titles((await get('/api/albums?fidelity=lossy')).json())).toEqual(['Royalty Free']);
    expect((await get('/api/albums?fidelity=lossless&offset=0')).json()).toMatchObject({ albums: [{ title: 'Mezzanine' }], total: 1 });
    expect((await get('/api/albums?fidelity=hi-res&offset=0')).json()).toMatchObject({ albums: [], total: 0 });
    expect(titles((await get('/api/albums?genre=Trip%20Hop')).json())).toEqual(['Mezzanine']);
    expect((await get('/api/albums?genre=Polka&offset=0')).json()).toMatchObject({ albums: [], total: 0 });
    // A filter that isn't one is left out.
    expect(titles((await get('/api/albums?fidelity=loud')).json())).toEqual(['Royalty Free', 'Mezzanine']);
    // Each filter has its own ETag, and the filters theirs.
    const tags = await Promise.all(
      ['/api/albums?offset=0', '/api/albums?offset=0&fidelity=lossy', '/api/albums?offset=0&genre=Polka', '/api/albums/filters'].map(async (url) => (await get(url)).headers.etag),
    );
    expect(new Set(tags).size).toBe(tags.length);
    const filters = await get('/api/albums/filters');
    expect((await get('/api/albums/filters', 1, { 'if-none-match': filters.headers.etag as string })).statusCode).toBe(304);
    // An account's filters are its library's.
    expect((await get('/api/albums/filters', 2)).json()).toEqual({ genres: [], fidelities: [{ value: 'lossy', count: 1 }] });
    expect((await get('/api/albums?fidelity=lossless&offset=0', 2)).json()).toMatchObject({ total: 0 });
  });

  it('have the library of the account asking', async () => {
    const { get } = await setup();
    expect((await get('/api/albums?offset=0', 2)).json()).toMatchObject({ albums: [{ title: 'Royalty Free' }], total: 1 });
    expect(((await get('/api/artists', 2)).json() as Artist[]).map((a) => a.name)).toEqual(['Kevin MacLeod']);
  });

  it('carry an ETag, and answer 304 without a body to a client that has them as they are', async () => {
    const { get } = await setup();
    for (const url of ['/api/albums', '/api/albums?sort=year&offset=0&limit=1', '/api/artists', '/api/artists?offset=0']) {
      const first = await get(url);
      const etag = first.headers.etag as string;
      expect(etag, url).toMatch(/^W\/".+"$/);
      expect(first.headers['cache-control']).toBe('private, no-cache');
      const again = await get(url, 1, { 'if-none-match': etag });
      expect(again.statusCode, url).toBe(304);
      expect(again.body).toBe('');
      expect(again.headers.etag).toBe(etag);
      // Among others, or without its weak mark, it's still the one.
      expect((await get(url, 1, { 'if-none-match': `"other", ${etag.slice(2)}` })).statusCode).toBe(304);
      expect((await get(url, 1, { 'if-none-match': '"other"' })).statusCode).toBe(200);
    }
    // Each list and page has its own.
    const tags = await Promise.all(['/api/albums', '/api/albums?sort=title', '/api/albums?offset=0', '/api/albums?offset=1', '/api/artists'].map(async (url) => (await get(url)).headers.etag));
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('keep their ETags while the library stays as it is, and change them when it changes', async () => {
    const { get, library } = await setup();
    const tag = async (url: string) => (await get(url)).headers.etag;
    const albums = await tag('/api/albums');
    const artists = await tag('/api/artists');
    // A refresh that finds nothing new.
    await library.refresh();
    expect(await tag('/api/albums')).toBe(albums);
    expect(await tag('/api/artists')).toBe(artists);
    // A new snapshot (a source removed, say): new tags, and the old ones get the new lists.
    library.reload();
    expect(await tag('/api/albums')).not.toBe(albums);
    expect(await tag('/api/artists')).not.toBe(artists);
    expect((await get('/api/albums', 1, { 'if-none-match': albums! })).statusCode).toBe(200);
  });

  it('give each library its own ETags: one account’s never stands for another’s', async () => {
    const { get } = await setup();
    const owner = (await get('/api/albums')).headers.etag as string;
    const member = (await get('/api/albums', 2)).headers.etag as string;
    expect(member).not.toBe(owner);
    expect((await get('/api/albums', 2, { 'if-none-match': owner })).statusCode).toBe(200);
  });

  it('tag the albums anew as their covers’ colors are read, as albums carry them', async () => {
    const colors = new CoverColorStore(freshDb());
    const { get } = await setup(colors);
    const albums = (await get('/api/albums')).headers.etag;
    const artists = (await get('/api/artists')).headers.etag;
    await colors.offer('copy/9100/5000000', await sharp({ create: { width: 64, height: 64, channels: 3, background: '#2a4b8d' } }).png().toBuffer());
    const now = await get('/api/albums');
    expect(now.headers.etag).not.toBe(albums);
    expect((now.json() as Album[]).find((a) => a.title === 'Royalty Free')).toMatchObject({ coverColor: '#2a4b8d' });
    expect((await get('/api/artists')).headers.etag).toBe(artists);
  });
});
