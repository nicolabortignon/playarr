import type { CuePoints, MixMap } from '@playarr/mix';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { mixMapRoutes } from './mixMaps.ts';

const SONG = '0b6a2c1e-1111-4222-8333-944455556666';
const OTHER = '0b6a2c1e-1111-4222-8333-944455557777';

const map = (duration: number) => ({ version: 1, duration, bpm: 120 }) as MixMap;

/** The routes over an in-memory analyzer: `maps` and `cues` by recording, `durations` the library's. */
function setup(opts: { maps?: Record<string, MixMap>; cues?: Record<string, CuePoints>; durations?: Record<string, number>; available?: boolean } = {}) {
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
  };
  const durations = opts.durations ?? {};
  const library = {
    trackByRecording: async (id: string) => (id in durations ? ({ recordingId: id, duration: durations[id] } as never) : undefined),
  };
  const forget = vi.fn(async () => {});
  const app = Fastify();
  mixMapRoutes(app, { analyzer, library, onCuesChanged: forget });
  return { app, analyzer, forget, cues };
}

describe('mix map routes', () => {
  it('answers the measured maps with their cue points, and has the missing ones measured', async () => {
    const { app, analyzer } = setup({ maps: { [SONG]: map(200) }, cues: { [SONG]: { mixOut: 180 } } });
    const res = await app.inject({ method: 'POST', url: '/api/mix-maps', payload: { ids: [SONG, OTHER, SONG] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ [SONG]: { ...map(200), cues: { mixOut: 180 } } });
    expect(analyzer.ensure).toHaveBeenCalledWith([OTHER], { audio: true, urgent: true });
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

  it('answers a song’s cue points, or none', async () => {
    const { app } = setup({ cues: { [SONG]: { mixIn: 12.5 } } });
    expect((await app.inject({ method: 'GET', url: `/api/recordings/${SONG}/cues` })).json()).toEqual({ mixIn: 12.5 });
    expect((await app.inject({ method: 'GET', url: `/api/recordings/${OTHER}/cues` })).json()).toEqual({});
    expect((await app.inject({ method: 'GET', url: '/api/recordings/not%20an%20id/cues' })).statusCode).toBe(400);
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
