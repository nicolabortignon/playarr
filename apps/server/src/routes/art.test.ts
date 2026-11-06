import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import Fastify from 'fastify';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileResolver } from '../catalog/files.ts';
import { LocalFolderFs } from '../catalog/folderFs.ts';
import { FLAC, flacBytes, tempDir } from '../catalog/testFixtures.ts';
import type { CoverImage } from '../library/coverColorStore.ts';
import type { LidarrClient } from '../lidarr/client.ts';
import { artRoutes, coverReader, LocalArt, trimArtCache } from './art.ts';

let cleanup = () => {};
afterEach(() => cleanup());

const log = { info: () => {} };
const cacheKey = (path: string) => createHash('sha1').update(`orig/${path}`).digest('hex');
const png = (color: string) => sharp({ create: { width: 64, height: 64, channels: 3, background: color } }).png().toBuffer();
/** A song in a folder of its own, as the catalog knows it (file 9100). */
function folderSong(dir: string) {
  const path = join(dir, '01.flac');
  writeFileSync(path, flacBytes());
  return { id: 9100, sourceId: 2, path, size: statSync(path).size, format: FLAC };
}

describe('artRoutes and cover colors', () => {
  it('hands album covers in hand to the colors, never artists’ pictures, and answers without waiting for them', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const original = await png('#0000ff');
    const offer = vi.fn(() => new Promise<void>(() => {}));
    const app = Fastify();
    artRoutes(app, {
      art: { original: async () => ({ body: original, mime: 'image/png' }) } as unknown as LocalArt,
      cacheDir: t.dir,
      library: { file: async () => undefined, hasArtwork: async () => true },
      files: {} as FileResolver,
      folders: { get: () => undefined },
      colors: { offer },
    });
    expect((await app.inject({ method: 'GET', url: '/art/album/70/cover?v=5&size=96' })).statusCode).toBe(200);
    expect(offer).toHaveBeenCalledWith('album/70/5', original);
    // The variant made for that answer, from the cache this time.
    const cached = await app.inject({ method: 'GET', url: '/art/album/70/cover?v=5&size=96' });
    expect(offer).toHaveBeenLastCalledWith('album/70/5', cached.rawPayload);
    expect((await app.inject({ method: 'GET', url: '/art/artist/7/poster?size=96' })).statusCode).toBe(200);
    expect(offer).toHaveBeenCalledTimes(2);
  });

  it('hands a folder file’s picture to the colors, known by the file and its size', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const song = folderSong(t.dir);
    const picture = await png('#ff0000');
    writeFileSync(join(t.dir, 'cover.png'), picture);
    const offer = vi.fn(async () => {});
    const app = Fastify();
    artRoutes(app, {
      art: {} as LocalArt,
      cacheDir: join(t.dir, 'cache'),
      library: { file: async (id: number) => (id === song.id ? song : undefined), hasArtwork: async () => true },
      files: { resolve: () => ({ path: song.path }) } as unknown as FileResolver,
      folders: { get: () => new LocalFolderFs() },
      colors: { offer },
    });
    expect((await app.inject({ method: 'GET', url: '/art/copy/9100?size=96' })).statusCode).toBe(200);
    expect(offer).toHaveBeenCalledWith(`copy/9100/${song.size}`, picture);
  });
});

describe('coverReader', () => {
  it('reads Lidarr’s cover once it’s on disk, never asking Lidarr for it', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const mediaCover = vi.fn();
    const art = new LocalArt({ mediaCover } as unknown as LidarrClient, join(t.dir, 'art'));
    const read = coverReader({ art, cacheDir: t.dir, files: {} as FileResolver, folders: { get: () => undefined } });
    const image: CoverImage = { key: 'album/1/5', kind: 'lidarr', albumId: 1, version: '5' };
    expect(await read(image)).toBeUndefined();
    mkdirSync(join(t.dir, 'art'));
    writeFileSync(join(t.dir, 'art', cacheKey('album/1/cover/5')), 'jpeg');
    writeFileSync(join(t.dir, 'art', `${cacheKey('album/1/cover/5')}.mime`), 'image/jpeg');
    expect(await read(image)).toEqual(Buffer.from('jpeg'));
    expect(mediaCover).not.toHaveBeenCalled();
  });

  it('reads a folder file’s picture from the art cache when a page had it drawn, else from the folder', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const music = join(t.dir, 'music');
    mkdirSync(music);
    const song = folderSong(music);
    const fs = new LocalFolderFs();
    const picture = vi.spyOn(fs, 'picture');
    const read = coverReader({ art: {} as LocalArt, cacheDir: t.dir, files: { resolve: () => ({ path: song.path }) } as unknown as FileResolver, folders: { get: () => fs } });
    const image: CoverImage = { key: `copy/9100/${song.size}`, kind: 'copy', file: song, embedded: false };
    expect(await read(image)).toBeNull(); // no picture in the file or beside it
    writeFileSync(join(music, 'cover.jpg'), 'beside');
    expect(await read(image)).toEqual(Buffer.from('beside'));
    mkdirSync(join(t.dir, 'art'));
    writeFileSync(join(t.dir, 'art', createHash('sha1').update(`copy/9100/${song.size}/96`).digest('hex')), 'drawn');
    picture.mockClear();
    expect(await read(image)).toEqual(Buffer.from('drawn'));
    expect(picture).not.toHaveBeenCalled();
  });

  it('fails for a file it can’t reach, rather than calling it a cover without a picture', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const away = { id: 9100, sourceId: 2, path: join(t.dir, 'gone', '01.flac'), size: 10, format: FLAC };
    const read = coverReader({ art: {} as LocalArt, cacheDir: t.dir, files: { resolve: () => ({ path: away.path }) } as unknown as FileResolver, folders: { get: () => new LocalFolderFs() } });
    await expect(read({ key: 'copy/9100/10', kind: 'copy', file: away, embedded: false })).rejects.toThrow('can’t be reached');
  });
});

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
