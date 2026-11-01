import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../catalog/testFixtures.ts';
import type { LidarrClient } from '../lidarr/client.ts';
import { LocalArt, trimArtCache } from './art.ts';

let cleanup = () => {};
afterEach(() => cleanup());

const log = { info: () => {} };
const cacheKey = (path: string) => createHash('sha1').update(`orig/${path}`).digest('hex');

describe('LocalArt.warm', () => {
  it('fetches only missing artwork, and on later refreshes looks at nothing it already has', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    mkdirSync(t.dir, { recursive: true });
    writeFileSync(join(t.dir, cacheKey('album/1/cover/0')), 'cached');
    const mediaCover = vi.fn(async () => new Response('image', { headers: { 'content-type': 'image/jpeg' } }));
    const art = new LocalArt({ mediaCover } as unknown as LidarrClient, t.dir);
    const urls = ['/art/album/1/cover', '/art/album/2/cover'];
    await art.warm(urls, log);
    expect(mediaCover).toHaveBeenCalledTimes(1);
    expect(mediaCover).toHaveBeenCalledWith('album', 2, 'cover.jpg');
    await art.warm(urls, log);
    expect(mediaCover).toHaveBeenCalledTimes(1);
  });
});

describe('trimArtCache', () => {
  it('removes the images used least recently, with their type, until the cache fits', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    mkdirSync(t.dir, { recursive: true });
    const now = Date.now() / 1000;
    ['old', 'middle', 'recent'].forEach((name, i) => {
      writeFileSync(join(t.dir, name), Buffer.alloc(100));
      writeFileSync(join(t.dir, `${name}.mime`), 'image/webp');
      for (const f of [name, `${name}.mime`]) utimesSync(join(t.dir, f), now - 3000 + i * 1000, now - 3000 + i * 1000);
    });
    const result = await trimArtCache(t.dir, 150);
    expect(result.removed).toBe(2);
    expect(existsSync(join(t.dir, 'old'))).toBe(false);
    expect(existsSync(join(t.dir, 'old.mime'))).toBe(false);
    expect(existsSync(join(t.dir, 'middle'))).toBe(false);
    expect(existsSync(join(t.dir, 'recent'))).toBe(true);
    expect(await trimArtCache(join(t.dir, 'missing'), 1)).toEqual({ removed: 0, bytes: 0 });
  });
});
