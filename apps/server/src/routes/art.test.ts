import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../catalog/testFixtures.ts';
import type { LidarrClient } from '../lidarr/client.ts';
import { LocalArt } from './art.ts';

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
