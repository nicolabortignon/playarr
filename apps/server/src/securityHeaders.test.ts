import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { Accounts } from './accounts/accounts.ts';
import { authHook } from './accounts/auth.ts';
import { Sessions } from './accounts/sessions.ts';
import type { FileResolver } from './catalog/files.ts';
import { freshDb, tempDir } from './catalog/testFixtures.ts';
import type { Library } from './library/library.ts';
import type { MediaSource } from './media/index.ts';
import { logRequests, requestIdOptions } from './requestLog.ts';
import { artRoutes, type LocalArt } from './routes/art.ts';
import { streamRoutes } from './routes/stream.ts';
import { transitionRoutes } from './routes/transitions.ts';
import { securityHeaders } from './securityHeaders.ts';
import { serveWebApp } from './webApp.ts';

let cleanup = () => {};
afterEach(() => cleanup());

/** An app with the headers and the request log, as index.ts adds them before anything else. */
function server(): FastifyInstance {
  const app = Fastify(requestIdOptions);
  securityHeaders(app);
  logRequests(app);
  return app;
}

/** The answer carries nosniff, frame-ancestors (and nothing standing in for it) and its request id. */
function expectHeaders(res: LightMyRequestResponse) {
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['content-security-policy']).toBe("frame-ancestors 'self'");
  expect(res.headers['x-frame-options']).toBeUndefined();
  expect(res.headers['x-request-id']).toEqual(expect.any(String));
}

const SONG = Buffer.from('0123456789abcdefghij');

describe('security headers', () => {
  it('go on the API’s answers, errors and not-found ones too', async () => {
    const app = server();
    app.get('/api/fine', () => ({ ok: true }));
    app.get('/api/broken', () => {
      throw new Error('broken');
    });
    for (const [url, status] of [['/api/fine', 200], ['/api/broken', 500], ['/api/nothing', 404]] as const) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(status);
      expectHeaders(res);
    }
  });

  it('go on answers the auth hook turns away before a route runs', async () => {
    const db = freshDb();
    const accounts = new Accounts(db);
    await accounts.setPassword(1, 'correct horse');
    const app = server();
    app.decorateRequest('auth', null);
    app.addHook('onRequest', authHook({ accounts, sessions: new Sessions(db) }));
    app.get('/api/albums', () => []);
    const res = await app.inject({ url: '/api/albums' });
    expect(res.statusCode).toBe(401);
    expectHeaders(res);
  });

  it('leave a route’s own policy as it is', async () => {
    const app = server();
    app.get('/api/own', (_req, reply) => reply.header('content-security-policy', "default-src 'none'").send({ ok: true }));
    const res = await app.inject({ url: '/api/own' });
    expect(res.headers['content-security-policy']).toBe("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('go on the web app’s files and pages, whose scripts keep a script’s type, ranges and all', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    writeFileSync(join(t.dir, 'index.html'), '<!doctype html><title>Playarr</title>');
    mkdirSync(join(t.dir, 'assets'));
    writeFileSync(join(t.dir, 'assets', 'Queue-new.js'), 'export const Queue = 1;');
    const app = server();
    await serveWebApp(app, t.dir);
    for (const url of ['/', '/albums/12', '/assets/Queue-new.js', '/assets/Queue-old.js']) expectHeaders(await app.inject({ url }));
    // nosniff makes a browser refuse a script served as anything else.
    expect((await app.inject({ url: '/assets/Queue-new.js' })).headers['content-type']).toMatch(/^(text|application)\/javascript/);
    const range = await app.inject({ url: '/assets/Queue-new.js', headers: { range: 'bytes=0-5' } });
    expect(range.statusCode).toBe(206);
    expect(range.body).toBe('export');
    expectHeaders(range);
  });

  it('go on streams, a range of one still answered as before', async () => {
    const media = {
      kind: 'local',
      stat: async () => ({ size: SONG.length, mtimeMs: 42 }),
      open: async (_path: string, range?: { start: number; end: number }) => Readable.from([SONG.subarray(range?.start ?? 0, (range?.end ?? SONG.length - 1) + 1)]),
    } as unknown as MediaSource;
    const library = { file: async (id: number) => (id === 7 ? { id: 7, sourceId: 1, path: '/music/a.flac', size: SONG.length, format: { codec: 'FLAC', container: 'flac' } } : undefined) } as unknown as Library;
    const files = { resolve: () => ({ media, path: '/music/a.flac' }) } as unknown as FileResolver;
    const app = server();
    streamRoutes(app, { library, files });
    const range = await app.inject({ url: '/stream/7', headers: { range: 'bytes=4-9' } });
    expect(range.statusCode).toBe(206);
    expect(range.headers['content-range']).toBe(`bytes 4-9/${SONG.length}`);
    expect(range.headers['content-length']).toBe('6');
    expect(range.headers['content-type']).toBe('audio/flac');
    expect(range.body).toBe('456789');
    expectHeaders(range);
    const whole = await app.inject({ url: '/stream/7' });
    expect([whole.statusCode, whole.body]).toEqual([200, SONG.toString()]);
    expectHeaders(whole);
    const head = await app.inject({ method: 'HEAD', url: '/stream/7', headers: { range: 'bytes=0-1' } });
    expect([head.statusCode, head.headers['content-length']]).toEqual([206, '2']);
    expectHeaders(head);
    expectHeaders(await app.inject({ url: '/stream/7', headers: { range: 'bytes=50-60' } }));
    expectHeaders(await app.inject({ url: '/stream/8' }));
  });

  it('go on transitions, ranges and all', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const file = join(t.dir, `${'a'.repeat(40)}.flac`);
    writeFileSync(file, SONG);
    const app = server();
    transitionRoutes(app, { transitions: { request: async () => ({ status: 'unavailable', reason: 'none' }), filePath: (name) => (name === `${'a'.repeat(40)}.flac` ? file : undefined) } });
    const range = await app.inject({ url: `/transitions/${'a'.repeat(40)}.flac`, headers: { range: 'bytes=10-' } });
    expect([range.statusCode, range.headers['content-range'], range.body]).toEqual([206, `bytes 10-19/${SONG.length}`, 'abcdefghij']);
    expectHeaders(range);
  });

  it('go on artwork', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const cover = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#2a4b8d' } }).png().toBuffer();
    const app = server();
    artRoutes(app, {
      art: { original: async () => ({ body: cover, mime: 'image/png' }) } as unknown as LocalArt,
      cacheDir: t.dir,
      library: { album: async () => undefined, file: async () => undefined, hasArtwork: async () => true, hasCover: () => false },
      files: {} as FileResolver,
      folders: { get: () => undefined },
      colors: { offer: async () => {} },
    });
    const res = await app.inject({ url: '/art/album/70/cover?v=1&size=96' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\//);
    expectHeaders(res);
  });
});
