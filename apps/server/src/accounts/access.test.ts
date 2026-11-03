import type { Album, Artist, Track } from '@playarr/shared';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Analyzer } from '../analysis/analyzer.ts';
import { CatalogStore } from '../catalog/store.ts';
import { CC_REC, freshDb, mezzanine, MP3 } from '../catalog/testFixtures.ts';
import type { Config } from '../config.ts';
import type { LidarrClient } from '../lidarr/client.ts';
import { Library } from '../library/library.ts';
import type { MediaSource } from '../media/index.ts';
import { apiRoutes } from '../routes/api.ts';
import { levelRoutes } from '../routes/levels.ts';
import { lyricsRoutes } from '../routes/lyrics.ts';
import { metadataRoutes } from '../routes/metadata.ts';
import { mixMapRoutes } from '../routes/mixMaps.ts';
import { account, actAs, asAccount, twoSources } from './testAccess.ts';

/** Account 1 is an admin hearing everything; 2 hears only the Creative Commons folder; 3 only Lidarr. */
async function setup() {
  const lib = await twoSources();
  const app = Fastify();
  actAs(app, [account(1, { role: 'admin', canRequest: true }), account(2, { sources: [lib.cc] }), account(3, { sources: [lib.lidarr] })]);
  const get = (url: string, id: number) => app.inject({ url, headers: asAccount(id) });
  const post = (url: string, id: number, payload: object) => app.inject({ method: 'POST', url, headers: asAccount(id), payload });
  return { ...lib, app, get, post };
}

describe('library access: the catalog', () => {
  async function catalog() {
    const s = await setup();
    apiRoutes(s.app, {
      config: { pathMap: [] } as unknown as Config,
      lidarr: { configured: true, systemStatus: async () => ({ version: '2' }) } as unknown as LidarrClient,
      library: s.library,
      media: { kind: 'none', check: async () => {} } as unknown as MediaSource,
      requestSettings: () => ({ enabled: true, searchOnAdd: true }),
    });
    return s;
  }

  it('lists only the artists, albums and songs the account may hear', async () => {
    const { get } = await catalog();
    expect(((await get('/api/artists', 2)).json() as Artist[]).map((a) => a.name)).toEqual(['Kevin MacLeod']);
    expect((await get('/api/artists', 1)).json()).toHaveLength(2);
    expect(((await get('/api/albums', 2)).json() as Album[]).map((a) => a.title)).toEqual(['Royalty Free']);
    expect(((await get('/api/albums/random', 3)).json() as Album[]).map((a) => a.title)).toEqual(['Mezzanine']);
    expect(((await get('/api/tracks/random', 2)).json() as Track[]).map((t) => t.recordingId)).toEqual([CC_REC]);
  });

  it('answers 404 for an artist or album outside the account’s sources', async () => {
    const { get } = await catalog();
    expect((await get('/api/albums/70', 2)).statusCode).toBe(404);
    expect((await get('/api/albums/70', 3)).statusCode).toBe(200);
    expect((await get('/api/artists/7', 2)).statusCode).toBe(404);
    expect((await get('/api/artists/7/tracks', 2)).json()).toEqual([]);
  });

  it('searches only what the account may hear', async () => {
    const { get } = await catalog();
    expect((await get('/api/search?q=angel', 2)).json()).toEqual({ artists: [], albums: [], tracks: [] });
    expect(((await get('/api/search?q=angel', 3)).json().tracks as Track[]).map((t) => t.title)).toEqual(['Angel']);
  });

  it('counts the account’s own library in health, none before signing in, and shows Request buttons to those who may', async () => {
    const { app, get } = await catalog();
    expect((await get('/api/health', 2)).json()).toMatchObject({ library: { tracks: 1 }, requests: false });
    expect((await get('/api/health', 1)).json()).toMatchObject({ library: { tracks: 3 }, requests: true });
    expect((await app.inject({ url: '/api/health' })).json().library).toBeUndefined();
  });

  it('shows a song’s metadata only to accounts that may hear it, with only their copies', async () => {
    const store = new CatalogStore(freshDb());
    const lidarr = store.addSource('lidarr', 'Lidarr');
    const cc = store.addSource('folder', 'Creative Commons');
    const mezz = mezzanine();
    const angel = mezz.tracks.find((t) => t.recordingId === 'rec-1')!;
    const library = new Library(
      store,
      () => [
        { id: lidarr, source: { kind: 'lidarr', sync: async () => mezz } },
        { id: cc, source: { kind: 'folder', sync: async () => ({ artists: mezz.artists, albums: mezz.albums, tracks: [angel], copies: [{ ref: 'angel.mp3', trackKey: angel.key, path: '/cc/angel.mp3', size: 9_000_000, format: MP3 }] }) } },
      ],
      { info: () => {}, error: () => {} },
    );
    await library.refresh();
    const app = Fastify();
    actAs(app, [account(1), account(2, { sources: [cc] })]);
    metadataRoutes(app, { store, library, pathMap: [], features: () => new Map() });
    const all = (await app.inject({ url: '/api/tracks/700/metadata', headers: asAccount(1) })).json();
    expect(all.copies).toHaveLength(2);
    const theirs = (await app.inject({ url: '/api/tracks/700/metadata', headers: asAccount(2) })).json();
    expect(theirs.copies).toEqual([expect.objectContaining({ playing: true, source: expect.objectContaining({ id: cc }) })]);
    expect((await app.inject({ url: '/api/tracks/701/metadata', headers: asAccount(2) })).statusCode).toBe(404);
  });

  it('finds lyrics only for songs the account may hear', async () => {
    const s = await setup();
    const forTrack = vi.fn(async () => null);
    lyricsRoutes(s.app, { lyrics: { forTrack }, library: s.library });
    expect((await s.get('/api/tracks/700/lyrics', 2)).statusCode).toBe(404);
    expect(forTrack).not.toHaveBeenCalled();
    expect((await s.get('/api/tracks/700/lyrics', 3)).json()).toEqual({ lyrics: null });
  });

  it('levels only songs the account may hear, and measures nothing else for it', async () => {
    const s = await setup();
    const ensure = vi.fn();
    const measured = { recordingId: 'rec-1', fileId: 9000, lufs: -8, peak: -0.5, samples: 1, size: 1, mtimeMs: 1 };
    levelRoutes(s.app, { analyzer: { loudness: (ids) => new Map(ids.flatMap((id) => (id === 'rec-1' ? [[id, measured]] : []))), ensure, remeasureLoudness: vi.fn() }, library: s.library });
    expect((await s.post('/api/levels', 2, { ids: ['rec-1'] })).json()).toEqual({});
    expect(ensure).toHaveBeenCalledWith([], expect.objectContaining({ urgent: true }));
    expect((await s.post('/api/levels', 3, { ids: ['rec-1'] })).json()).toHaveProperty('rec-1');
  });

  it('gives mix maps and mix points only of songs the account may hear', async () => {
    const s = await setup();
    const ensure = vi.fn();
    const analyzer = {
      canAnalyzeAudio: true,
      mixMaps: (ids: string[]) => new Map(ids.map((id) => [id, { version: 1, duration: 200, bpm: 120 }])),
      cues: (ids: string[]) => new Map(ids.map((id) => [id, { mixIn: 1 }])),
      setCues: vi.fn(),
      ensure,
      analysisProgress: () => ({}),
      analyzeLibrary: vi.fn(),
      reanalyzeLibrary: vi.fn(),
    } as unknown as Analyzer;
    mixMapRoutes(s.app, { analyzer, library: s.library });
    expect(Object.keys((await s.post('/api/mix-maps', 2, { ids: ['rec-1', CC_REC] })).json())).toEqual([CC_REC]);
    expect(ensure).toHaveBeenCalledWith([CC_REC], expect.anything());
    // Account 3 hears only Lidarr: the Creative Commons song's mix points aren't there for it.
    const cues = `/api/recordings/${encodeURIComponent(CC_REC)}/cues`;
    expect((await s.get(cues, 3)).json()).toEqual({});
    expect((await s.get(cues, 2)).json()).toEqual({ mixIn: 1 });
    expect((await s.app.inject({ method: 'PUT', url: cues, headers: asAccount(3), payload: { mixIn: 2 } })).statusCode).toBe(404);
  });
});
