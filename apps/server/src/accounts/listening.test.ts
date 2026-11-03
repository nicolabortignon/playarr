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
import { Accounts } from './accounts.ts';
import { actAs, asAccount } from './testAccess.ts';

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
  const accounts = new Accounts(db);
  const sam = accounts.create({ username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null });
  const history = new History(db, library);
  const analyzer = { ensure: vi.fn(), features: () => new Map(), meta: () => new Map(), mixSummaries: () => new Map(), progress: () => ({ features: 0, meta: 0, mixMaps: 0 }) } as unknown as Analyzer;
  const mixes = new Mixes({ db, store, library, analyzer, history, playlists: {} as Playlists, similar: async () => [], accounts: () => accounts.ids() });
  const app = Fastify();
  actAs(app, accounts.list());
  mixRoutes(app, { mixes, history, store, analysisAvailable: false, analyzeLibrary: vi.fn(), library, db });
  return { db, accounts, sam, history, mixes, app };
}

const play = (id: number, at = '2026-11-01T10:00:00Z') => ({ trackId: id, recordingId: `rec-${id}`, at, hour: 10, weekday: 0, seconds: 180, skipped: false });

describe('listening per account', () => {
  it('keeps each account’s plays, mixes and stats apart; the session decides, not the report', async () => {
    const { app, sam, history, mixes } = setup();
    const asSam = asAccount(sam.id);
    await app.inject({ method: 'POST', url: '/api/plays', headers: asSam, payload: { plays: tracks.slice(0, 20).flatMap((t) => [play(t.id), play(t.id, '2026-11-01T11:00:00Z')]) } });
    // An older player still names a profile: ignored.
    await app.inject({ method: 'POST', url: '/api/plays', headers: asSam, payload: { plays: [{ ...play(30), profile: 1 }] } });
    expect(history.since(3650, Date.parse('2026-11-02'), sam.id)).toHaveLength(41);
    expect(history.since(3650, Date.parse('2026-11-02'), 1)).toHaveLength(0);

    const repeat = async (account: number) => (await mixes.list('UTC', new Date('2026-11-01T12:00:00Z'), account)).find((m) => m.key === 'repeat');
    expect(await repeat(sam.id)).toBeDefined();
    expect(await repeat(1)).toBeUndefined();

    expect((await app.inject({ url: '/api/stats?range=all', headers: asSam })).json().plays).toBe(41);
    expect((await app.inject({ url: '/api/stats?range=all', headers: asAccount(1) })).json().plays).toBe(0);
  });

  it('takes an account’s history and mixes along when it’s removed', async () => {
    const { app, db, accounts, sam } = setup();
    await app.inject({ method: 'POST', url: '/api/plays', headers: asAccount(sam.id), payload: { plays: tracks.slice(0, 20).map((t) => play(t.id)) } });
    await app.inject({ url: '/api/mixes?tz=UTC', headers: asAccount(sam.id) });
    accounts.remove(sam.id);
    expect((db.prepare('SELECT COUNT(*) AS n FROM plays WHERE account_id = ?').get(sam.id) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM mixes WHERE account_id = ?').get(sam.id) as { n: number }).n).toBe(0);
  });
});
