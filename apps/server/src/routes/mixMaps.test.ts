import type { CuePoints, MixMap } from '@playarr/mix';
import { MIX_MAP_VERSION } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { Analyzer } from '../analysis/analyzer.ts';
import { ANALYSIS_VERSION } from '../analysis/dsp.ts';
import type { FileResolver } from '../catalog/files.ts';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import type { Library } from '../library/library.ts';
import { MIXES_KEY } from '../mixes/settings.ts';
import { mixMapRoutes } from './mixMaps.ts';

const SONG = '0b6a2c1e-1111-4222-8333-944455556666';
const OTHER = '0b6a2c1e-1111-4222-8333-944455557777';

const map = (duration: number) => ({ version: 1, duration, bpm: 120 }) as MixMap;

/** The routes over an in-memory analyzer: `maps` and `cues` by recording, `durations` the library's. */
function setup(opts: { maps?: Record<string, MixMap>; cues?: Record<string, CuePoints>; durations?: Record<string, number>; available?: boolean; libraryScan?: boolean } = {}) {
  const maps = new Map(Object.entries(opts.maps ?? {}));
  const cues = new Map(Object.entries(opts.cues ?? {}));
  const pick = <T>(all: Map<string, T>, ids: string[]) => new Map(ids.flatMap((id) => (all.has(id) ? [[id, all.get(id)!] as const] : [])));
  const analyzer = {
    canAnalyzeAudio: opts.available ?? true,
    mixMaps: (ids: string[]) => pick(maps, ids),
    cues: (ids: string[]) => pick(cues, ids),
    setCues: vi.fn((id: string, set: { mixIn?: number | null; mixOut?: number | null }) => {
      const kept: CuePoints = { ...(set.mixIn != null ? { mixIn: set.mixIn } : {}), ...(set.mixOut != null ? { mixOut: set.mixOut } : {}) };
      if (Object.keys(kept).length) cues.set(id, kept);
      else cues.delete(id);
    }),
    ensure: vi.fn(),
    mixMapProgress: () => ({ songs: 5678, ready: 1234, beatModel: 1200, failed: 3, waiting: 4400, working: 1 }),
    analyzeLibrary: vi.fn(async () => 4400),
    reanalyzeLibrary: vi.fn(async () => 5678),
  };
  const durations = opts.durations ?? {};
  const library = {
    trackByRecording: async (id: string) => (id in durations ? ({ recordingId: id, duration: durations[id] } as never) : undefined),
  };
  const forget = vi.fn(async () => {});
  const app = Fastify();
  mixMapRoutes(app, { analyzer, library, onCuesChanged: forget, libraryScan: () => opts.libraryScan ?? true });
  return { app, analyzer, forget, cues };
}

describe('mix map routes', () => {
  it('reports how many songs are ready for DJ mix, and whether the whole library is being analysed', async () => {
    const { app } = setup({ libraryScan: false });
    const res = await app.inject({ method: 'GET', url: '/api/mix-maps/progress' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, songs: 5678, ready: 1234, beatModel: 1200, failed: 3, waiting: 4400, working: 1, libraryScan: false });
  });

  it('says so when audio analysis is off', async () => {
    const { app } = setup({ available: false });
    const res = await app.inject({ method: 'GET', url: '/api/mix-maps/progress' });
    expect(res.json()).toMatchObject({ enabled: false, waiting: 0, working: 0 });
  });

  it('answers the measured maps with their cue points, and has the songs measured that need it', async () => {
    const { app, analyzer } = setup({ maps: { [SONG]: map(200) }, cues: { [SONG]: { mixOut: 180 } } });
    const res = await app.inject({ method: 'POST', url: '/api/mix-maps', payload: { ids: [SONG, OTHER, SONG] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ [SONG]: { ...map(200), cues: { mixOut: 180 } } });
    // All of them: the analyzer knows which are done, and which only have an older version's map.
    expect(analyzer.ensure).toHaveBeenCalledWith([SONG, OTHER], { audio: true, urgent: true });
  });

  it('leaves cues out for songs without any', async () => {
    const { app } = setup({ maps: { [SONG]: map(200) } });
    const res = await app.inject({ method: 'POST', url: '/api/mix-maps', payload: { ids: [SONG] } });
    expect(res.json()[SONG]).not.toHaveProperty('cues');
  });

  it('turns away a missing or too long list of ids', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'POST', url: '/api/mix-maps', payload: { ids: [] } })).statusCode).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    expect((await app.inject({ method: 'POST', url: '/api/mix-maps', payload: { ids: many } })).statusCode).toBe(400);
  });

  it('answers no maps, and measures nothing, without audio analysis', async () => {
    const { app, analyzer } = setup({ maps: { [SONG]: map(200) }, available: false });
    const res = await app.inject({ method: 'POST', url: '/api/mix-maps', payload: { ids: [SONG] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    expect(analyzer.ensure).not.toHaveBeenCalled();
  });

  it('queues the library for analysis on request, from the home network only', async () => {
    const { app, analyzer } = setup();
    const res = await app.inject({ method: 'POST', url: '/api/mix-maps/analyze' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ queued: 4400 });
    const away = await app.inject({ method: 'POST', url: '/api/mix-maps/analyze', remoteAddress: '203.0.113.9' });
    expect(away.statusCode).toBe(403);
    expect(analyzer.analyzeLibrary).toHaveBeenCalledTimes(1);
    expect(analyzer.reanalyzeLibrary).not.toHaveBeenCalled();
  });

  it('has every song analysed again when asked to, from the home network only', async () => {
    const { app, analyzer } = setup();
    const res = await app.inject({ method: 'POST', url: '/api/mix-maps/analyze', payload: { again: true } });
    expect(res.json()).toEqual({ queued: 5678 });
    const away = await app.inject({ method: 'POST', url: '/api/mix-maps/analyze', payload: { again: true }, remoteAddress: '203.0.113.9' });
    expect(away.statusCode).toBe(403);
    expect(analyzer.reanalyzeLibrary).toHaveBeenCalledTimes(1);
    expect(analyzer.analyzeLibrary).not.toHaveBeenCalled();
  });

  it('says why nothing can be analysed when audio analysis is off', async () => {
    const { app, analyzer } = setup({ available: false });
    const res = await app.inject({ method: 'POST', url: '/api/mix-maps/analyze' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/audio analysis is off/i);
    expect(analyzer.analyzeLibrary).not.toHaveBeenCalled();
  });

  it('queues only the songs still needing a mix map, once, and leaves the library setting alone', async () => {
    const db = freshDb();
    const store = new CatalogStore(db);
    store.setAppSetting(MIXES_KEY, JSON.stringify({ analyzeLibrary: false }));
    const now = new Date().toISOString();
    db.prepare('INSERT INTO track_features (recording_id, version, features, error, analyzed_at) VALUES (?, ?, ?, NULL, ?)').run('local:ready', ANALYSIS_VERSION, '{}', now);
    db.prepare('INSERT INTO mix_maps (recording_id, version, data, error, analyzed_at) VALUES (?, ?, ?, NULL, ?)').run('local:ready', MIX_MAP_VERSION, '{}', now);
    const library = {
      allTracks: async () => ['local:ready', 'local:a', 'local:b'].map((recordingId) => ({ recordingId }) as Track),
      trackByRecording: async () => ({ fileId: 1, duration: 200 }) as Track,
      file: async () => ({ id: 1 }),
    } as unknown as Library;
    // Decodes that never finish: queued songs stay queued.
    const files = { resolve: () => ({ media: { pcm: () => new Promise(() => {}) }, path: '/x.flac' }) } as unknown as FileResolver;
    const analyzer = new Analyzer(db, library, files, { enabled: true, log: { warn: () => {} }, dsp: { analyze: vi.fn(), mixMap: vi.fn() } });
    const app = Fastify();
    mixMapRoutes(app, { analyzer, library });
    try {
      const first = await app.inject({ method: 'POST', url: '/api/mix-maps/analyze' });
      expect(first.json()).toEqual({ queued: 2 });
      expect((await app.inject({ method: 'POST', url: '/api/mix-maps/analyze' })).json()).toEqual({ queued: 0 });
      expect(JSON.parse(store.appSetting(MIXES_KEY)!)).toEqual({ analyzeLibrary: false });
    } finally {
      analyzer.close();
    }
  });

  it('answers a song’s cue points, or none', async () => {
    const { app } = setup({ cues: { [SONG]: { mixIn: 12.5 } } });
    expect((await app.inject({ method: 'GET', url: `/api/recordings/${SONG}/cues` })).json()).toEqual({ mixIn: 12.5 });
    expect((await app.inject({ method: 'GET', url: `/api/recordings/${OTHER}/cues` })).json()).toEqual({});
    expect((await app.inject({ method: 'GET', url: '/api/recordings/not%20an%20id/cues' })).statusCode).toBe(400);
  });

  it('takes the ids of songs from a folder that aren’t matched on MusicBrainz', async () => {
    const folderSong = 'local:8e34783d37e7032b';
    const { app } = setup({ maps: { [folderSong]: map(200) }, cues: { [folderSong]: { mixIn: 12.5 } } });
    expect((await app.inject({ method: 'GET', url: `/api/recordings/${folderSong}/cues` })).json()).toEqual({ mixIn: 12.5 });
    const res = await app.inject({ method: 'PUT', url: `/api/recordings/${folderSong}/cues`, payload: { mixOut: 190 } });
    expect(res.statusCode).toBe(200);
  });

  it('saves cue points within the song, then forgets its transitions', async () => {
    const { app, analyzer, forget } = setup({ maps: { [SONG]: map(200) } });
    const res = await app.inject({ method: 'PUT', url: `/api/recordings/${SONG}/cues`, payload: { mixIn: 8, mixOut: 190 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mixIn: 8, mixOut: 190 });
    expect(analyzer.setCues).toHaveBeenCalledWith(SONG, { mixIn: 8, mixOut: 190 });
    expect(forget).toHaveBeenCalledWith(SONG);
  });

  it('clears a cue point given as null, and keeps one left out', async () => {
    const { app, cues, forget } = setup({ maps: { [SONG]: map(200) }, cues: { [SONG]: { mixIn: 8, mixOut: 190 } } });
    const put = (payload: object) => app.inject({ method: 'PUT', url: `/api/recordings/${SONG}/cues`, payload });
    expect((await put({ mixIn: null })).json()).toEqual({ mixOut: 190 });
    expect((await put({ mixIn: 20 })).json()).toEqual({ mixIn: 20, mixOut: 190 });
    expect((await put({})).json()).toEqual({ mixIn: 20, mixOut: 190 });
    expect((await put({ mixIn: null, mixOut: null })).json()).toEqual({});
    expect(cues.has(SONG)).toBe(false);
    expect(forget).toHaveBeenCalledWith(SONG);
  });

  it('checks a new cue point against the one already set', async () => {
    const { app, analyzer } = setup({ maps: { [SONG]: map(200) }, cues: { [SONG]: { mixOut: 50 } } });
    const res = await app.inject({ method: 'PUT', url: `/api/recordings/${SONG}/cues`, payload: { mixIn: 60 } });
    expect(res.statusCode).toBe(400);
    expect(analyzer.setCues).not.toHaveBeenCalled();
  });

  it('clears cue points even for a song that has left the library', async () => {
    const { app, cues } = setup({ cues: { [SONG]: { mixIn: 8 } } });
    const res = await app.inject({ method: 'PUT', url: `/api/recordings/${SONG}/cues`, payload: { mixIn: null } });
    expect(res.statusCode).toBe(200);
    expect(cues.has(SONG)).toBe(false);
  });

  it('turns away cue points for a song whose length isn’t known', async () => {
    const { app, analyzer } = setup({ durations: { [SONG]: 0 } });
    const res = await app.inject({ method: 'PUT', url: `/api/recordings/${SONG}/cues`, payload: { mixIn: 5 } });
    expect(res.statusCode).toBe(400);
    expect(analyzer.setCues).not.toHaveBeenCalled();
  });

  it('answers 400 when the analyzer refuses the cue points', async () => {
    const { app, analyzer, forget } = setup({ maps: { [SONG]: map(200) } });
    analyzer.setCues.mockImplementationOnce(() => {
      throw new RangeError('Invalid cue point');
    });
    const res = await app.inject({ method: 'PUT', url: `/api/recordings/${SONG}/cues`, payload: { mixIn: 5 } });
    expect(res.statusCode).toBe(400);
    expect(forget).not.toHaveBeenCalled();
  });

  it('checks cue points against the library’s length when the song has no map yet', async () => {
    const { app } = setup({ durations: { [SONG]: 100 } });
    const put = (payload: object) => app.inject({ method: 'PUT', url: `/api/recordings/${SONG}/cues`, payload });
    expect((await put({ mixOut: 99 })).statusCode).toBe(200);
    expect((await put({ mixOut: 101 })).statusCode).toBe(400);
  });

  it('turns away cue points outside the song, the wrong way round, or for an unknown song', async () => {
    const { app, analyzer, forget } = setup({ maps: { [SONG]: map(200) } });
    const put = (id: string, payload: object) => app.inject({ method: 'PUT', url: `/api/recordings/${id}/cues`, payload });
    expect((await put(SONG, { mixIn: -1 })).statusCode).toBe(400);
    expect((await put(SONG, { mixOut: 200.5 })).statusCode).toBe(400);
    expect((await put(SONG, { mixIn: 100, mixOut: 90 })).statusCode).toBe(400);
    expect((await put(SONG, { mixIn: 100, mixOut: 100 })).statusCode).toBe(400);
    expect((await put(SONG, { mixIn: 'soon' })).statusCode).toBe(400);
    expect((await put(OTHER, { mixIn: 5 })).statusCode).toBe(404);
    expect(analyzer.setCues).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
  });

  it('saves cue points even when forgetting the transitions fails', async () => {
    const { app, analyzer, forget } = setup({ maps: { [SONG]: map(200) } });
    forget.mockRejectedValueOnce(new Error('disk gone'));
    const res = await app.inject({ method: 'PUT', url: `/api/recordings/${SONG}/cues`, payload: { mixIn: 8 } });
    expect(res.statusCode).toBe(200);
    expect(analyzer.setCues).toHaveBeenCalled();
  });
});
