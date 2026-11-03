import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { SongLoudness } from '../analysis/loudnessJobs.ts';
import { recordFixture } from '../testing/recordFixture.ts';
import { combinedLufs, gainFor, levelRoutes } from './levels.ts';

const song = (lufs: number | null, peak: number | null = -0.5, fileId = 1, samples = 1000): SongLoudness => ({
  recordingId: 'r',
  fileId,
  lufs,
  peak,
  samples,
  size: 1,
  mtimeMs: 1,
});

describe('gainFor', () => {
  it('turns loud songs down to −14 LUFS', () => {
    expect(gainFor(-8, -0.1)).toBe(-6);
    expect(gainFor(-14, 0)).toBe(0);
    expect(gainFor(10, 0)).toBe(-20); // never more than 20 dB down
  });

  it('turns quiet songs up as far as their peak leaves room', () => {
    expect(gainFor(-20, -10)).toBe(6); // all the way: the peak ends at −4 dBFS
    expect(gainFor(-20, -4)).toBe(3); // the peak stops it at −1 dBFS
    expect(gainFor(-20, -0.3)).toBe(0); // no room at all
    expect(gainFor(-40, -30)).toBe(12); // never more than 12 dB up
  });
});

describe('combinedLufs', () => {
  it('averages power, a long song weighing more', () => {
    expect(combinedLufs([{ lufs: -10, samples: 1 }, { lufs: -10, samples: 3 }])).toBeCloseTo(-10);
    expect(combinedLufs([{ lufs: -10, samples: 1 }, { lufs: -40, samples: 1 }])).toBeGreaterThan(-14); // the loud song dominates
    expect(combinedLufs([{ lufs: -10, samples: 1 }, { lufs: -20, samples: 9 }])).toBeLessThan(combinedLufs([{ lufs: -10, samples: 9 }, { lufs: -20, samples: 1 }]));
  });
});

describe('levels route', () => {
  function setup(measured: Record<string, SongLoudness>) {
    const ensure = vi.fn();
    const remeasureLoudness = vi.fn();
    const app = Fastify();
    levelRoutes(app, {
      analyzer: {
        loudness: (ids) => new Map(ids.flatMap((id) => (measured[id] ? [[id, measured[id]!]] : []))),
        ensure,
        remeasureLoudness,
      },
      library: {
        trackByRecording: async (id) => (id === 'gone' ? undefined : ({ recordingId: id, fileId: id === 'replaced' ? 2 : 1, albumId: id === 'solo' ? 2 : 1 }) as never),
        album: async (id) => ({ tracks: (id === 1 ? ['a1', 'a2', 'a3', 'replaced'] : ['solo']).map((recordingId) => ({ recordingId })) }) as never,
      },
    });
    return { app, ensure, remeasureLoudness };
  }

  it('answers each measured song’s gain, alone and within its album, and has the rest measured', async () => {
    const { app, ensure } = setup({ a1: song(-8), a2: song(-12), solo: song(-6), replaced: song(-9, -1, 1) });
    const res = await app.inject({ method: 'POST', url: '/api/levels', payload: { ids: ['a1', 'solo', 'a3', 'gone'] } });
    recordFixture('levels', res);
    const body = res.json();
    expect(body.a1.track).toBe(-6);
    // The album as a whole is quieter than its loudest song: a smaller cut, the same for every song of it.
    expect(body.a1.album).toBeLessThan(-3);
    expect(body.a1.album).toBeGreaterThan(-6);
    expect(body.solo).toEqual({ track: -8, lufs: -6, peak: -0.5 });
    expect(body.a3).toBeUndefined();
    expect(body.gone).toBeUndefined();
    // Loudness only (beat and sound analysis are for other things), the songs asked about first.
    expect(ensure).toHaveBeenCalledWith(['a1', 'solo', 'a3', 'gone'], { beats: false, sound: false, tags: false, urgent: true });
    expect(ensure).toHaveBeenCalledWith(expect.arrayContaining(['a2', 'a3', 'replaced']), { beats: false, sound: false, tags: false });
  });

  it('measures again a song whose file changed, rather than level it by another file', async () => {
    const { app, remeasureLoudness } = setup({ replaced: song(-9, -1, 1) });
    const body = (await app.inject({ method: 'POST', url: '/api/levels', payload: { ids: ['replaced'] } })).json();
    expect(body).toEqual({});
    expect(remeasureLoudness).toHaveBeenCalledWith('replaced');
  });

  it('leaves silent songs as they are', async () => {
    const { app } = setup({ a1: song(null, null) });
    expect((await app.inject({ method: 'POST', url: '/api/levels', payload: { ids: ['a1'] } })).json()).toEqual({});
  });
});
