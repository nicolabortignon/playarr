import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../catalog/testFixtures.ts';
import type { TransitionAnswer } from '../transitions/transitions.ts';
import { transitionRoutes } from './transitions.ts';

const KEY = 'a'.repeat(40);

/** The routes over a fake service whose files live in a fresh folder; `names` it makes are served from there. */
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

async function setup() {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const request = vi.fn(async (): Promise<TransitionAnswer> => ({ status: 'pending', plan: { style: 'quick' } as never }));
  const filePath = (name: string) => (/^[0-9a-f]{40}(\.rest)?\.(flac|wav)$/.test(name) ? join(dir, name) : undefined);
  const app = Fastify();
  transitionRoutes(app, { transitions: { request, filePath } });
  return { app, dir, request };
}

describe('transition routes', () => {
  it('asks the service for the transition the player wants', async () => {
    const { app, request } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/transitions', payload: { from: 3, to: 4, mode: 'party', position: 61.5 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'pending', plan: { style: 'quick' } });
    expect(request).toHaveBeenCalledWith({ fromTrackId: 3, toTrackId: 4, mode: 'party', aPosition: 61.5 });
  });

  it('passes on the files the player has for the songs', async () => {
    const { app, request } = await setup();
    await app.inject({ method: 'POST', url: '/api/transitions', payload: { from: 3, to: 4, mode: 'auto', fromFileId: 13, toFileId: 14 } });
    expect(request).toHaveBeenCalledWith({ fromTrackId: 3, toTrackId: 4, mode: 'auto', fromFileId: 13, toFileId: 14 });
    expect((await app.inject({ method: 'POST', url: '/api/transitions', payload: { from: 3, to: 4, mode: 'auto', toFileId: 'x' } })).statusCode).toBe(400);
  });

  it('passes on the listener’s fade length, whether the queue plays the album, and the songs’ levels', async () => {
    const { app, request } = await setup();
    await app.inject({ method: 'POST', url: '/api/transitions', payload: { from: 3, to: 4, mode: 'auto', fade: 9, albumQueue: false, levels: { a: -4.5, b: 2 } } });
    expect(request).toHaveBeenCalledWith({ fromTrackId: 3, toTrackId: 4, mode: 'auto', fadeSeconds: 9, albumQueue: false, levels: { a: -4.5, b: 2 } });
    for (const payload of [{ fade: -1 }, { fade: 'long' }, { albumQueue: 'yes' }, { levels: { a: 40, b: 0 } }, { levels: { a: -1 } }]) {
      const res = await app.inject({ method: 'POST', url: '/api/transitions', payload: { from: 3, to: 4, mode: 'auto', ...payload } });
      expect(res.statusCode).toBe(400);
    }
  });

  it('leaves the position out when the player does', async () => {
    const { app, request } = await setup();
    await app.inject({ method: 'POST', url: '/api/transitions', payload: { from: 3, to: 4, mode: 'auto' } });
    expect(request).toHaveBeenCalledWith({ fromTrackId: 3, toTrackId: 4, mode: 'auto' });
  });

  it('turns away a request it can’t read', async () => {
    const { app, request } = await setup();
    for (const payload of [{ from: 3, to: 4, mode: 'loud' }, { from: '3', to: 4, mode: 'auto' }, { from: 3, mode: 'auto' }, { from: 3, to: 4, mode: 'auto', position: -1 }]) {
      expect((await app.inject({ method: 'POST', url: '/api/transitions', payload })).statusCode).toBe(400);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('answers “unavailable” when the service fails, so the player falls back', async () => {
    const { app, request } = await setup();
    request.mockRejectedValueOnce(new Error('library offline'));
    const res = await app.inject({ method: 'POST', url: '/api/transitions', payload: { from: 3, to: 4, mode: 'auto' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'unavailable' });
    // The detail goes to the log, not to whoever asked.
    expect(res.json().reason).not.toContain('library offline');
  });

  it('answers “unavailable” without the service (no audio analysis)', async () => {
    const app = Fastify();
    transitionRoutes(app, { unavailableReason: 'Audio analysis is off' });
    const res = await app.inject({ method: 'POST', url: '/api/transitions', payload: { from: 3, to: 4, mode: 'auto' } });
    expect(res.json()).toEqual({ status: 'unavailable', reason: 'Audio analysis is off' });
    expect((await app.inject({ method: 'GET', url: `/transitions/${KEY}.flac` })).statusCode).toBe(404);
  });

  it('serves a transition file whole, cached for good', async () => {
    const { app, dir } = await setup();
    await writeFile(join(dir, `${KEY}.flac`), Buffer.from('0123456789'));
    const res = await app.inject({ method: 'GET', url: `/transitions/${KEY}.flac` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/flac');
    expect(res.headers['content-length']).toBe('10');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(res.body).toBe('0123456789');
  });

  it('serves byte ranges, of continuations and WAV files too', async () => {
    const { app, dir } = await setup();
    await writeFile(join(dir, `${KEY}.rest.wav`), Buffer.from('0123456789'));
    const res = await app.inject({ method: 'GET', url: `/transitions/${KEY}.rest.wav`, headers: { range: 'bytes=2-5' } });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.body).toBe('2345');
    const outside = await app.inject({ method: 'GET', url: `/transitions/${KEY}.rest.wav`, headers: { range: 'bytes=20-' } });
    expect(outside.statusCode).toBe(416);
    expect(outside.headers['content-range']).toBe('bytes */10');
    // An error, not audio: nothing for the browser to keep or play.
    expect(outside.headers['content-type'] ?? '').not.toMatch(/^audio\//);
    expect(outside.headers['cache-control']).toBeUndefined();
  });

  it('answers HEAD without a body', async () => {
    const { app, dir } = await setup();
    await writeFile(join(dir, `${KEY}.flac`), Buffer.from('0123456789'));
    const res = await app.inject({ method: 'HEAD', url: `/transitions/${KEY}.flac` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe('10');
    expect(res.body).toBe('');
  });

  it('finds nothing for names the service doesn’t make, or files that are gone', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: `/transitions/${KEY}.flac` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/transitions/${KEY}.json` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/transitions/..%2Fsecret.flac' })).statusCode).toBe(404);
  });
});
