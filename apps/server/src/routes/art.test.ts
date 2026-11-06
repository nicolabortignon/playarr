import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import Fastify from 'fastify';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileResolver } from '../catalog/files.ts';
import { LocalFolderFs } from '../catalog/folderFs.ts';
import { FLAC, flacBytes, freshDb, tempDir } from '../catalog/testFixtures.ts';
import { coverArtArchive } from '../discover/art.ts';
import { CoverColorStore, type CoverImage } from '../library/coverColorStore.ts';
import type { LidarrClient } from '../lidarr/client.ts';
import { artRoutes, coverReader, LocalArt, trimArtCache } from './art.ts';

let cleanup = () => {};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const log = { info: () => {} };
const cacheKey = (path: string) => createHash('sha1').update(`orig/${path}`).digest('hex');
const png = (color: string) => sharp({ create: { width: 64, height: 64, channels: 3, background: color } }).png().toBuffer();
/** A remote host answering every image request with `image`. */
const remoteHost = (image: Buffer) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new Uint8Array(image), { headers: { 'content-type': 'image/png' } }));
/** A library album's MusicBrainz cover (catalog/build.ts), as the fill reads it. */
const remote = (releaseGroup: string): Extract<CoverImage, { kind: 'remote' }> => {
  const url = coverArtArchive(releaseGroup, 500);
  return { key: `remote/${url}`, kind: 'remote', url };
};
/** The art route's cache name for a remote image at a size, cropped square. */
const remoteVariant = (url: string, size: number) => createHash('sha1').update(`remote/${url}/${size}/false`).digest('hex');
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
      library: { file: async () => undefined, hasArtwork: async () => true, hasCover: () => false },
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
      library: { file: async (id: number) => (id === song.id ? song : undefined), hasArtwork: async () => true, hasCover: () => false },
      files: { resolve: () => ({ path: song.path }) } as unknown as FileResolver,
      folders: { get: () => new LocalFolderFs() },
      colors: { offer },
    });
    expect((await app.inject({ method: 'GET', url: '/art/copy/9100?size=96' })).statusCode).toBe(200);
    expect(offer).toHaveBeenCalledWith(`copy/9100/${song.size}`, picture);
  });

  it('hands a remote cover to the colors when it’s a library album’s, never when it’s one Discover shows', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const original = await png('#0000ff');
    const fetch = remoteHost(original);
    const library = remote('rg-1');
    const discover = coverArtArchive('rg-2');
    const offer = vi.fn(async () => {});
    const app = Fastify();
    artRoutes(app, {
      art: {} as LocalArt,
      cacheDir: t.dir,
      library: { file: async () => undefined, hasArtwork: async () => true, hasCover: (key: string) => key === library.key },
      files: {} as FileResolver,
      folders: { get: () => undefined },
      colors: { offer },
    });
    const get = (url: string) => app.inject({ method: 'GET', url: `/art/remote?url=${encodeURIComponent(url)}&size=96` });
    expect((await get(library.url)).statusCode).toBe(200);
    expect(offer).toHaveBeenCalledWith(library.key, original);
    expect((await get(discover)).statusCode).toBe(200);
    expect((await get(discover)).statusCode).toBe(200); // from the cache this time
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(offer).toHaveBeenCalledTimes(1);
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

  it('reads a remote cover from the art cache when a page had it drawn, else fetches it', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const fetched = await png('#ff0000');
    const fetch = remoteHost(fetched);
    const read = coverReader({ art: {} as LocalArt, cacheDir: t.dir, files: {} as FileResolver, folders: { get: () => undefined } });
    const drawn = remote('rg-1');
    mkdirSync(join(t.dir, 'art'));
    writeFileSync(join(t.dir, 'art', remoteVariant(drawn.url, 240)), 'drawn');
    expect(await read(drawn)).toEqual(Buffer.from('drawn'));
    expect(fetch).not.toHaveBeenCalled();
    const other = remote('rg-2');
    expect(await read(other)).toEqual(fetched);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([other.url]);
  });

  it('fetches remote covers one at a time, spaced, and takes a missing one for a cover without a picture', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const image = await png('#00ff00');
    const starts: number[] = [];
    let fetching = 0;
    let most = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      starts.push(Date.now());
      most = Math.max(most, ++fetching);
      await new Promise((resolve) => setTimeout(resolve, 10));
      fetching--;
      if (String(url).includes('/rg-3/')) return new Response('Not found', { status: 404 });
      return new Response(new Uint8Array(image), { headers: { 'content-type': 'image/png' } });
    });
    const read = coverReader({ art: {} as LocalArt, cacheDir: t.dir, files: {} as FileResolver, folders: { get: () => undefined }, remoteGapMs: 100 });
    const [first, second, missing] = await Promise.all([read(remote('rg-1')), read(remote('rg-2')), read(remote('rg-3'))]);
    expect([first, second]).toEqual([image, image]);
    expect(missing).toBeNull();
    expect(most).toBe(1);
    // Timers may fire a millisecond or two early by the wall clock.
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(95);
  });

  it('lets the background fill read a library album’s remote cover from the art cache, and fetch the next', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const fetch = remoteHost(await png('#ff0000'));
    const drawn = remote('rg-1');
    const notDrawn = remote('rg-2');
    mkdirSync(join(t.dir, 'art'));
    writeFileSync(join(t.dir, 'art', remoteVariant(drawn.url, 96)), await png('#0000ff'));
    const colors = new CoverColorStore(freshDb());
    await colors.fill([drawn, notDrawn], coverReader({ art: {} as LocalArt, cacheDir: t.dir, files: {} as FileResolver, folders: { get: () => undefined } }));
    expect(colors.get(drawn.key)).toEqual({ color: '#0000ff', accent: '#6e6ef7' });
    expect(colors.get(notDrawn.key)).toEqual({ color: '#ff0000', accent: '#f42a2a' });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([notDrawn.url]);
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
