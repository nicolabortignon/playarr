import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Analyzer } from '../analysis/analyzer.ts';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import type { Library } from '../library/library.ts';
import { History } from '../mixes/history.ts';
import { Mixes } from '../mixes/mixes.ts';
import type { Playlists } from '../playlists.ts';
import { mixRoutes } from '../routes/mixes.ts';
import { profileRoutes } from '../routes/profiles.ts';
import { Profiles } from './profiles.ts';

const tracks = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  recordingId: `rec-${i + 1}`,
  artistId: (i % 8) + 1,
  albumId: (i % 8) + 1,
  title: `Song ${i + 1}`,
  artistName: `Artist ${(i % 8) + 1}`,
  albumTitle: 'Album',
  duration: 200,
}));
const library = {
  version: 1,
  allTracks: async () => tracks,
  albums: async () => [],
  artists: async () => [],
  album: async () => undefined,
  track: async (id: number) => tracks.find((t) => t.id === id),
  trackByRecording: async (r: string) => tracks.find((t) => t.recordingId === r),
  tracksByRecordings: async (ids: string[]) => tracks.filter((t) => ids.includes(t.recordingId)),
  tracksByIds: async (ids: number[]) => tracks.filter((t) => ids.includes(t.id)),
  trackByName: async () => undefined,
} as unknown as Library;

function setup() {
  const db = freshDb();
  const store = new CatalogStore(db);
  const profiles = new Profiles(db);
  const history = new History(db, library);
  const analyzer = { ensure: vi.fn(), features: () => new Map(), meta: () => new Map(), mixMaps: () => new Map(), progress: () => ({ features: 0, meta: 0, mixMaps: 0 }) } as unknown as Analyzer;
  const mixes = new Mixes({ db, store, library, analyzer, history, playlists: {} as Playlists, similar: async () => [], profiles: () => profiles.ids() });
  const app = Fastify();
  // Requests count as local from inject's 127.0.0.1.
  mixRoutes(app, { mixes, history, store, analysisAvailable: false, analyzeLibrary: vi.fn(), library, db, profiles });
  profileRoutes(app, { profiles });
  return { db, profiles, history, mixes, app };
}

const play = (id: number, at = '2026-11-01T10:00:00Z') => ({ trackId: id, recordingId: `rec-${id}`, at, hour: 10, weekday: 0, seconds: 180, skipped: false });

describe('profiles', () => {
  it('starts with one, holding the history so far; adds, renames and removes others', () => {
    const { profiles } = setup();
    expect(profiles.list()).toEqual([{ id: 1, name: 'Home' }]);
    const sam = profiles.create('  Sam  ');
    expect(sam.name).toBe('Sam');
    expect(() => profiles.create('sam')).toThrow(/already/);
    expect(() => profiles.create(' ')).toThrow(/needs a name/);
    expect(profiles.rename(1, 'Nicola')).toEqual({ id: 1, name: 'Nicola' });
    expect(profiles.of({ headers: { 'x-playarr-profile': String(sam.id) } })).toBe(sam.id);
    expect(profiles.of({ headers: { 'x-playarr-profile': '99' } })).toBe(1);
    expect(profiles.of({ headers: {} })).toBe(1);
    profiles.remove(sam.id);
    expect(() => profiles.remove(1)).toThrow(/one profile/);
  });

  it('keeps each one’s plays, mixes and stats apart', async () => {
    const { app, profiles, history, mixes, db } = setup();
    const sam = profiles.create('Sam');
    const asSam = { 'x-playarr-profile': String(sam.id), 'x-playarr': '1' };
    await app.inject({ method: 'POST', url: '/api/plays', headers: asSam, payload: { plays: tracks.slice(0, 20).flatMap((t) => [play(t.id), play(t.id, '2026-11-01T11:00:00Z')]) } });
    // Reports carry who was listening when they were played, whatever the device says now.
    await app.inject({ method: 'POST', url: '/api/plays', headers: asSam, payload: { plays: [{ ...play(30), profile: 1 }] } });
    expect(history.since(3650, Date.parse('2026-11-02'), sam.id)).toHaveLength(40);
    expect(history.since(3650, Date.parse('2026-11-02'), 1)).toHaveLength(1);

    const repeat = async (profile: number) => (await mixes.list('UTC', new Date('2026-11-01T12:00:00Z'), profile)).find((m) => m.key === 'repeat');
    expect(await repeat(sam.id)).toBeDefined(); // Sam played enough for On Repeat
    expect(await repeat(1)).toBeUndefined();

    const stats = await app.inject({ method: 'GET', url: '/api/stats?range=all', headers: asSam });
    expect(stats.json().plays).toBe(40);

    // Removing Sam takes Sam's history and mixes along.
    const removed = await app.inject({ method: 'DELETE', url: `/api/profiles/${sam.id}`, headers: { 'x-playarr': '1' } });
    expect(removed.json()).toEqual([{ id: 1, name: 'Home' }]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM plays WHERE profile_id = ?').get(sam.id) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM mixes WHERE profile_id = ?').get(sam.id) as { n: number }).n).toBe(0);
  });
});
