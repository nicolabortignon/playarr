import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AudioFeatures } from '../analysis/dsp.ts';
import { combinedDb, cutFor, levelRoutes } from './levels.ts';

const measured = (meanDb: number) => ({ raw: { meanDb } }) as AudioFeatures;

describe('levels', () => {
  it('turns loud songs down to the target and leaves quiet ones', () => {
    expect(cutFor(-8)).toBe(-6);
    expect(cutFor(-20)).toBe(0);
    expect(cutFor(10)).toBe(-12);
    expect(combinedDb([-10, -10])).toBeCloseTo(-10);
    expect(combinedDb([-10, -40])).toBeGreaterThan(-14); // the loud song dominates
  });

  it('answers what is measured, with album levels, and has the rest measured', async () => {
    const features = new Map([
      ['a1', measured(-8)],
      ['a2', measured(-12)],
      ['solo', measured(-6)],
    ]);
    const ensure = vi.fn();
    const app = Fastify();
    levelRoutes(app, {
      analyzer: { features: (ids) => new Map(ids.flatMap((id) => (features.has(id) ? [[id, features.get(id)!]] : []))), ensure },
      library: {
        trackByRecording: async (id) => ({ recordingId: id, albumId: id === 'solo' ? 2 : 1 }) as never,
        album: async (id) => ({ tracks: (id === 1 ? ['a1', 'a2', 'a3'] : ['solo']).map((recordingId) => ({ recordingId })) }) as never,
      },
    });
    const res = await app.inject({ method: 'POST', url: '/api/levels', payload: { ids: ['a1', 'solo', 'a3'] } });
    const body = res.json();
    expect(body.a1.track).toBe(-6);
    expect(body.a1.album).toBeLessThan(-3);
    expect(body.a1.album).toBeGreaterThan(-6);
    expect(body.solo).toEqual({ track: -8 });
    expect(body.a3).toBeUndefined();
    expect(ensure).toHaveBeenCalledWith(expect.arrayContaining(['a3']), { audio: true, urgent: true });
  });
});
