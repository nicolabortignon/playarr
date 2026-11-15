import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../catalog/testFixtures.ts';
import { Readable } from 'node:stream';
import { EncodedStreams, PRE_ROLL, streamLayout } from '../media/encoded.ts';
import type { EncodeOptions, MediaSource } from '../media/source.ts';
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

describe('transitions as AAC', () => {
  /** Three seconds of transition, as its FLAC header says. */
  const LENGTH = 3 * 44_100;

  /** A stand-in for ffmpeg's AAC encoder, as in stream.test.ts: ADTS frames for what it's fed. */
  function fakeAac(o: EncodeOptions): Readable {
    const count = Math.ceil((1024 + o.samples) / 1024);
    const frame = Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80, (107 >> 3) & 0xff, ((107 & 7) << 5) | 0x1f, 0xfc]), Buffer.alloc(100, 0xaa)]);
    return Readable.from([Buffer.concat(Array(count).fill(frame))]);
  }

  async function setupAac(opts: { encoder?: boolean; sampleRate?: number } = {}) {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const encodes: EncodeOptions[] = [];
    const media = {
      kind: 'local',
      stat: async (path: string) => stat(path).then((s) => ({ size: s.size, mtimeMs: s.mtimeMs })),
      ...(opts.encoder === false ? {} : { encodedStream: vi.fn((_path: string, o: EncodeOptions) => (encodes.push(o), fakeAac(o))) }),
    } as unknown as MediaSource;
    const filePath = (name: string) => (/^[0-9a-f]{40}(\.rest)?\.(flac|wav)$/.test(name) ? join(dir, name) : undefined);
    const pcmLength = vi.fn(async () => ({ frames: LENGTH, sampleRate: opts.sampleRate ?? 44_100, channels: 2, bits: 24 }));
    const encoded = new EncodedStreams({ maxRunning: 8, maxPerAccount: 4, cacheBytes: 1024 * 1024 });
    const app = Fastify();
    transitionRoutes(app, { transitions: { request: vi.fn(), filePath }, encoded, media, pcmLength });
    await writeFile(join(dir, `${KEY}.flac`), Buffer.from('flac'));
    return { app, encodes };
  }

  it('serves a transition encoded as AAC from the sample asked for, a file of a length known before it’s encoded', async () => {
    const { app, encodes } = await setupAac();
    const res = await app.inject({ url: `/transitions/${KEY}.flac/aac?kbps=256&start=44100` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mp4');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(Number(res.headers['content-length'])).toBe(streamLayout('aac', 256, LENGTH - 44_100).total);
    expect(res.rawPayload.toString('latin1', 4, 12)).toBe('ftypM4A ');
    // A FLAC seeks to the sample: decoded from 0.97 s (on the 10 ms grid), 235 samples dropped, no gain of its own.
    expect(encodes).toEqual([{ codec: 'aac', kbps: 256, seekSeconds: 0.97, skipSamples: 235, leadSamples: 0, samples: PRE_ROLL + LENGTH - 44_100, priority: 'normal' }]);
  });

  it('starts at the transition’s start, at High, unless asked otherwise, and answers ranges and HEAD', async () => {
    const { app } = await setupAac();
    const size = streamLayout('aac', 256, LENGTH).total;
    const head = await app.inject({ method: 'HEAD', url: `/transitions/${KEY}.flac/aac` });
    expect(head.statusCode).toBe(200);
    expect(Number(head.headers['content-length'])).toBe(size);
    expect(head.body).toBe('');
    const range = await app.inject({ url: `/transitions/${KEY}.flac/aac`, headers: { range: 'bytes=0-1' } });
    expect(range.statusCode).toBe(206);
    expect(range.headers['content-range']).toBe(`bytes 0-1/${size}`);
    expect(range.rawPayload.toString('latin1')).toBe('\0\0');
  });

  it('refuses names it doesn’t make, missing files, bad arguments and a start past the end', async () => {
    const { app } = await setupAac();
    expect((await app.inject({ url: `/transitions/${'b'.repeat(40)}.flac/aac` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/transitions/${KEY}.json/aac` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/transitions/${KEY}.flac/aac?kbps=320` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/transitions/${KEY}.flac/aac?start=-1` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/transitions/${KEY}.flac/aac?start=${LENGTH}` })).statusCode).toBe(400);
  });

  it('answers 404 on a server that can’t encode, or for a file not at the streams’ rate', async () => {
    expect((await (await setupAac({ encoder: false })).app.inject({ url: `/transitions/${KEY}.flac/aac` })).statusCode).toBe(404);
    expect((await (await setupAac({ sampleRate: 48_000 })).app.inject({ url: `/transitions/${KEY}.flac/aac` })).statusCode).toBe(404);
  });
});
