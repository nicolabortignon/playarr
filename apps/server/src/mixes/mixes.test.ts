import type { Album, Artist, Track } from '@playarr/shared';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Analyzer } from '../analysis/analyzer.ts';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import type { Library } from '../library/library.ts';
import type { Playlists } from '../playlists.ts';
import { mixRoutes } from '../routes/mixes.ts';
import { History } from './history.ts';
import { Mixes } from './mixes.ts';

const HOME = '192.168.1.20';
const AWAY = '203.0.113.5';

/** 12 artists × 6 songs, tagged rock (half) or jazz, from the 90s. */
function fakeLibrary() {
  const tracks: Track[] = [];
  for (let artist = 1; artist <= 12; artist++) {
    for (let n = 0; n < 6; n++) {
      const id = artist * 100 + n;
      tracks.push({
        id,
        recordingId: `rec-${id}`,
        fileId: id,
        albumId: artist,
        artistId: artist,
        title: `Song ${id}`,
        artistName: `Artist ${artist}`,
        albumTitle: `Album ${artist}`,
        trackNumber: n + 1,
        discNumber: 1,
        duration: 180,
        explicit: false,
        streamUrl: `/stream/${id}`,
        coverUrl: `/art/album/${artist}/cover`,
      } as Track);
    }
  }
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const albums = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, year: 1995, addedAt: '2020-01-01T00:00:00Z' }) as Album);
  const artists = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, genres: [i % 2 ? 'jazz' : 'rock'] }) as unknown as Artist);
  return {
    tracks,
    library: {
      allTracks: async () => tracks,
      albums: async () => albums,
      artists: async () => artists,
      tracksByIds: async (ids: number[]) => ids.flatMap((id) => byId.get(id) ?? []),
      track: async (id: number) => byId.get(id),
      trackByRecording: async (rid: string) => tracks.find((t) => t.recordingId === rid),
      trackByName: async () => undefined,
    } as unknown as Library,
  };
}

function setup() {
  const db = freshDb();
  const store = new CatalogStore(db);
  const { library, tracks } = fakeLibrary();
  const analyzer = { ensure: vi.fn(), features: () => new Map(), meta: () => new Map() } as unknown as Analyzer;
  const history = new History(db, library);
  const playlists = { create: vi.fn(async (name: string) => ({ id: 1, name })) } as unknown as Playlists;
  const mixes = new Mixes({ db, store, library, analyzer, history, playlists, similar: async () => [] });
  const app = Fastify();
  mixRoutes(app, { mixes, history, store, analysisAvailable: false, analyzeLibrary: vi.fn() });
  return { db, store, tracks, history, mixes, playlists, analyzer, app };
}

const at = (iso: string) => new Date(iso);

describe('Mixes', () => {
  it('makes mixes once per period and keeps them, even as listening goes on', async () => {
    const { mixes, history, tracks } = setup();
    const first = await mixes.list('UTC', at('2026-11-01T10:05:00Z'));
    expect(first.map((m) => m.key)).toEqual(expect.arrayContaining(['vibes', 'discovery', 'genre-rock', 'decade-1990']));
    const vibes = first.find((m) => m.key === 'vibes')!;
    expect(vibes.refreshesAt).toBe('2026-11-01T11:00:00.000Z');
    expect(vibes.covers.length).toBeGreaterThan(1);

    await history.record(tracks.slice(0, 30).map((t) => ({ trackId: t.id, recordingId: t.recordingId, at: '2026-11-01T10:10:00Z', hour: 10, weekday: 0, seconds: 180, skipped: false })));
    const later = await mixes.get('discovery', 'UTC', at('2026-11-01T10:40:00Z'));
    expect(later.tracks.map((t) => t.id)).toEqual((await mixes.get('discovery', 'UTC', at('2026-11-01T10:05:00Z'))).tracks.map((t) => t.id));

    // A new hour brings a new Vibes of the hour; Discovery Weekly waits for Monday.
    const nextHour = await mixes.list('UTC', at('2026-11-01T11:01:00Z'));
    expect(nextHour.find((m) => m.key === 'vibes')!.generatedAt).not.toBe(vibes.generatedAt);
    expect(nextHour.find((m) => m.key === 'discovery')!.generatedAt).toBe(first.find((m) => m.key === 'discovery')!.generatedAt);
    const monday = await mixes.list('UTC', at('2026-11-02T08:00:00Z'));
    expect(monday.find((m) => m.key === 'discovery')!.generatedAt).not.toBe(first.find((m) => m.key === 'discovery')!.generatedAt);
  });

  it('draws a new mix on request, and saves a mix as a playlist', async () => {
    const { mixes, playlists } = setup();
    const now = at('2026-11-01T10:05:00Z');
    const before = await mixes.get('genre-rock', 'UTC', now);
    const after = await mixes.regenerate('genre-rock', 'UTC', now);
    expect(after.tracks.map((t) => t.id)).not.toEqual(before.tracks.map((t) => t.id));
    expect((await mixes.get('genre-rock', 'UTC', now)).tracks).toEqual(after.tracks);
    await mixes.saveAsPlaylist('genre-rock', 'UTC', now);
    expect(playlists.create).toHaveBeenCalledWith('Rock mix · 1 Nov', expect.any(String), after.tracks.map((t) => t.recordingId));
  });

  it('asks for tags of the whole library, and its sound only when Settings says so', async () => {
    const { mixes, analyzer, store } = setup();
    await mixes.list('UTC', at('2026-11-01T10:05:00Z'));
    expect(analyzer.ensure).toHaveBeenCalledWith(expect.any(Array), { audio: false });
    store.setAppSetting('mixes', JSON.stringify({ analyzeLibrary: true }));
    await mixes.list('UTC', at('2026-11-01T10:06:00Z'));
    expect(analyzer.ensure).toHaveBeenLastCalledWith(expect.any(Array), { audio: true });
  });
});

describe('mix routes', () => {
  const report = { trackId: 100, recordingId: 'rec-100', at: '2026-11-01T10:10:00.000Z', hour: 10, weekday: 0, seconds: 120, skipped: false };

  it('records plays, unless history is turned off', async () => {
    const { app, history } = setup();
    expect((await app.inject({ method: 'POST', url: '/api/plays', payload: { plays: [report] } })).json()).toEqual({ recorded: 1 });
    // The same report again (its answer was lost as the app closed): not counted twice.
    expect((await app.inject({ method: 'POST', url: '/api/plays', payload: { plays: [report] } })).json()).toEqual({ recorded: 0 });
    expect(history.stats().plays).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/api/plays', payload: { plays: [{ ...report, hour: 25 }] } })).statusCode).toBe(400);
    await app.inject({ method: 'PUT', url: '/api/settings/mixes', payload: { recordHistory: false }, remoteAddress: HOME });
    expect((await app.inject({ method: 'POST', url: '/api/plays', payload: { plays: [report] } })).statusCode).toBe(202);
    expect(history.stats().plays).toBe(1);
  });

  it('changes settings and clears history from the home network only', async () => {
    const { app, history } = setup();
    await app.inject({ method: 'POST', url: '/api/plays', payload: { plays: [report] } });
    expect((await app.inject({ method: 'PUT', url: '/api/settings/mixes', payload: { length: 75 }, remoteAddress: AWAY })).statusCode).toBe(403);
    const saved = await app.inject({ method: 'PUT', url: '/api/settings/mixes', payload: { length: 75, enabled: { focus: false } }, remoteAddress: HOME });
    expect(saved.json()).toMatchObject({ length: 75, enabled: { focus: false }, history: { plays: 1 } });
    expect((await app.inject({ method: 'PUT', url: '/api/settings/mixes', payload: { length: 60 }, remoteAddress: HOME })).statusCode).toBe(400);
    await app.inject({ method: 'DELETE', url: '/api/settings/mixes/history', remoteAddress: HOME });
    expect(history.stats().plays).toBe(0);
  });

  it('serves the mixes and 404s unknown ones', async () => {
    const { app } = setup();
    const list = (await app.inject({ method: 'GET', url: '/api/mixes?tz=Europe/Rome' })).json() as { key: string }[];
    expect(list.length).toBeGreaterThan(3);
    expect((await app.inject({ method: 'GET', url: `/api/mixes/${list[0]!.key}` })).json()).toHaveProperty('tracks');
    expect((await app.inject({ method: 'GET', url: '/api/mixes/nope-nope' })).statusCode).toBe(404);
  });
});
