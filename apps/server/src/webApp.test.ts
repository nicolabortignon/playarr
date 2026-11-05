import Fastify from 'fastify';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from './catalog/testFixtures.ts';
import { serveWebApp } from './webApp.ts';

let cleanup = () => {};
afterEach(() => cleanup());

async function app() {
  const t = tempDir();
  cleanup = t.cleanup;
  writeFileSync(join(t.dir, 'index.html'), '<!doctype html><title>Playarr</title>');
  mkdirSync(join(t.dir, 'assets'));
  writeFileSync(join(t.dir, 'assets', 'Queue-new.js'), 'export const Queue = 1;');
  const server = Fastify();
  await serveWebApp(server, t.dir);
  return server;
}

describe('serveWebApp', () => {
  it('serves the app’s files, and index.html for its pages', async () => {
    const server = await app();
    expect((await server.inject({ url: '/assets/Queue-new.js' })).body).toContain('Queue');
    const page = await server.inject({ url: '/albums/12?from=home' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>Playarr</title>');
  });

  it('answers a file that isn’t there with a 404, so a stale tab’s chunk fails rather than loading a page as code', async () => {
    const server = await app();
    expect((await server.inject({ url: '/assets/Queue-old.js' })).statusCode).toBe(404);
    expect((await server.inject({ url: '/missing.png' })).statusCode).toBe(404);
    expect((await server.inject({ url: '/api/nothing' })).statusCode).toBe(404);
  });
});
