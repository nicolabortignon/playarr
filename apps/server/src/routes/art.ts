import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { trimCacheDir } from '../cacheDir.ts';
import type { FileResolver } from '../catalog/files.ts';
import { copyCover } from '../catalog/folderArt.ts';
import type { FolderFs } from '../catalog/folderFs.ts';
import { fetchRemoteImage, isAllowedRemote } from '../discover/art.ts';
import { libraryOf, sourcesOf } from '../accounts/rights.ts';
import type { Library } from '../library/library.ts';
import { LidarrError, type LidarrClient } from '../lidarr/client.ts';

const SIZES = [96, 160, 240, 320, 480, 640, 960, 1200];
const TYPES: Record<string, { file: string; square: boolean; mime: string }> = {
  'album/cover': { file: 'cover.jpg', square: true, mime: 'image/jpeg' },
  'artist/poster': { file: 'poster.jpg', square: true, mime: 'image/jpeg' },
  'artist/fanart': { file: 'fanart.jpg', square: false, mime: 'image/jpeg' },
  'artist/banner': { file: 'banner.jpg', square: false, mime: 'image/jpeg' },
  'artist/clearlogo': { file: 'clearlogo.png', square: false, mime: 'image/png' },
};

interface ArtKey {
  kind: 'artist' | 'album';
  id: number;
  type: string;
  version: string;
}

/**
 * Original Lidarr artwork, cached on disk so each image is fetched from Lidarr once.
 * Lidarr can be slow (seconds per image under load); resized variants are made locally.
 */
export class LocalArt {
  private inflight = new Map<string, Promise<{ body: Buffer; mime: string }>>();
  /** Originals known to be on disk, so warming doesn't look at them again. */
  private readonly cached = new Set<string>();
  private warming = false;
  /** Artwork from a refresh that came in while warming: warmed next. */
  private nextWarm: string[] | null = null;

  constructor(
    private readonly lidarr: LidarrClient,
    private readonly dir: string,
  ) {}

  static parse(url: string): ArtKey | undefined {
    const m = url.match(/^\/art\/(artist|album)\/(\d+)\/(\w+)(?:\?v=(\d+))?/);
    if (!m || !TYPES[`${m[1]}/${m[3]}`]) return undefined;
    return { kind: m[1] as ArtKey['kind'], id: Number(m[2]), type: m[3]!, version: m[4] ?? '0' };
  }

  private static cacheKey({ kind, id, type, version }: ArtKey): string {
    return createHash('sha1').update(`orig/${kind}/${id}/${type}/${version}`).digest('hex');
  }

  original(art: ArtKey): Promise<{ body: Buffer; mime: string }> {
    const { kind, id, type } = art;
    const key = LocalArt.cacheKey(art);
    let job = this.inflight.get(key);
    if (job) return job;
    job = (async () => {
      const file = join(this.dir, key);
      try {
        const [body, mime] = await Promise.all([readFile(file), readFile(`${file}.mime`, 'utf8')]);
        return { body, mime };
      } catch {
        // not cached yet
      }
      const spec = TYPES[`${kind}/${type}`]!;
      const res = await this.lidarr.mediaCover(kind, id, spec.file);
      const body = Buffer.from(await res.arrayBuffer());
      const mime = res.headers.get('content-type') ?? spec.mime;
      await mkdir(this.dir, { recursive: true });
      await writeFile(`${file}.tmp`, body);
      await writeFile(`${file}.mime`, mime);
      await rename(`${file}.tmp`, file);
      return { body, mime };
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  /**
   * Fetch missing originals in the background, gently (Lidarr is shared with everything else). Runs after
   * every refresh, so it only checks that a file exists (never reads it) and remembers what's on disk.
   */
  async warm(urls: string[], log: { info: (m: string) => void }) {
    if (this.warming) {
      this.nextWarm = urls;
      return;
    }
    this.warming = true;
    try {
      const keys = urls.flatMap((u) => LocalArt.parse(u) ?? []).filter((k) => !this.cached.has(LocalArt.cacheKey(k)));
      const missing: ArtKey[] = [];
      for (const k of keys) {
        const key = LocalArt.cacheKey(k);
        if (await access(join(this.dir, key)).then(() => true, () => false)) this.cached.add(key);
        else missing.push(k);
      }
      if (!missing.length) return;
      let fetched = 0;
      const started = Date.now();
      for (let i = 0; i < missing.length; i += 2) {
        await Promise.all(
          missing.slice(i, i + 2).map((k) =>
            this.original(k).then(
              () => {
                fetched++;
                this.cached.add(LocalArt.cacheKey(k));
              },
              () => {},
            ),
          ),
        );
      }
      log.info(`Artwork cache warm: ${fetched}/${missing.length} images in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } finally {
      this.warming = false;
      const next = this.nextWarm;
      this.nextWarm = null;
      if (next) void this.warm(next, log);
    }
  }
}

/** Serves Lidarr artwork (resized to WebP, cached), folder files' artwork and allowlisted remote artwork. */
export function artRoutes(
  app: FastifyInstance,
  deps: {
    art: LocalArt;
    cacheDir: string;
    library: Pick<Library, 'file' | 'hasArtwork'> & Partial<Pick<Library, 'view'>>;
    files: FileResolver;
    folders: { get(sourceId: number): FolderFs | undefined };
  },
) {
  const dir = join(deps.cacheDir, 'art');
  const inflight = new Map<string, Promise<{ body: Buffer; mime: string }>>();

  async function produce(key: ArtKey, size?: number) {
    const original = await deps.art.original(key);
    if (!size) return original;
    const spec = TYPES[`${key.kind}/${key.type}`]!;
    const body = await sharp(original.body)
      .resize(size, spec.square ? size : undefined, { fit: 'cover', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    return { body, mime: 'image/webp' };
  }

  // Artwork for music that isn't in the library (Cover Art Archive, Lidarr's image cache, fanart.tv).
  app.get<{ Querystring: { url?: string; size?: string; wide?: string } }>('/art/remote', async (req, reply) => {
    let target: URL;
    try {
      target = new URL(req.query.url ?? '');
    } catch {
      return reply.code(400).send({ error: 'Invalid url' });
    }
    if (!isAllowedRemote(target)) return reply.code(400).send({ error: 'Host not allowed' });
    const requested = Number(req.query.size);
    const size = requested > 0 ? (SIZES.find((s) => s >= requested) ?? SIZES.at(-1)) : undefined;
    const wide = req.query.wide === '1';
    const key = createHash('sha1').update(`remote/${target.href}/${size ?? 'orig'}/${wide}`).digest('hex');
    const file = join(dir, key);

    try {
      const cached = await readFile(file);
      const mime = (await readFile(`${file}.mime`, 'utf8').catch(() => null)) ?? 'image/webp';
      return reply.header('Cache-Control', 'public, max-age=2592000').type(mime).send(cached);
    } catch {
      // cache miss
    }
    try {
      const original = await fetchRemoteImage(target.href);
      if (!original) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'No artwork' });
      const out = size
        ? {
            body: await sharp(original.body)
              .resize(size, wide ? undefined : size, { fit: 'cover', withoutEnlargement: true })
              .webp({ quality: 82 })
              .toBuffer(),
            mime: 'image/webp',
          }
        : original;
      await saveCached(dir, file, out.body, out.mime);
      return reply.header('Cache-Control', 'public, max-age=2592000').type(out.mime).send(out.body);
    } catch (err) {
      req.log.warn({ err, url: target.href }, 'remote artwork failed');
      return reply.code(502).header('Cache-Control', 'no-store').send({ error: 'Artwork unavailable' });
    }
  });

  // Artwork drawn from a folder file (embedded picture or an image beside it), wherever the folder is.
  // `?embedded=1`: only the picture in the file (see catalog/build.ts folderCovers).
  app.get<{ Params: { id: string }; Querystring: { size?: string; embedded?: string } }>('/art/copy/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const file = Number.isInteger(id) ? await libraryOf(deps.library, req).file(id) : undefined;
    if (!file) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'Unknown file' });
    let path: string;
    try {
      path = deps.files.resolve(file).path;
    } catch {
      return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'No artwork' });
    }
    const fs = deps.folders.get(file.sourceId);
    if (!fs) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'No artwork' });
    const requested = Number(req.query.size);
    const size = requested > 0 ? (SIZES.find((s) => s >= requested) ?? SIZES.at(-1)) : undefined;
    const embeddedOnly = req.query.embedded === '1';
    const key = createHash('sha1').update(`copy/${id}/${file.size}/${size ?? 'orig'}${embeddedOnly ? '/embedded' : ''}`).digest('hex');
    const cached = join(dir, key);
    try {
      const body = await readFile(cached);
      const mime = (await readFile(`${cached}.mime`, 'utf8').catch(() => null)) ?? 'image/webp';
      return reply.header('Cache-Control', 'public, max-age=86400').type(mime).send(body);
    } catch {
      // cache miss
    }
    const original = await copyCover(fs, path, file.size, embeddedOnly).catch(() => null);
    if (!original) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'No artwork' });
    const out = size
      ? {
          body: await sharp(original.body).resize(size, size, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(),
          mime: 'image/webp',
        }
      : original;
    await saveCached(dir, cached, out.body, out.mime);
    return reply.header('Cache-Control', 'public, max-age=86400').type(out.mime).send(out.body);
  });

  app.get<{ Params: { kind: string; id: string; type: string }; Querystring: { size?: string; v?: string } }>(
    '/art/:kind/:id/:type',
    async (req, reply) => {
      const { kind, type } = req.params;
      const id = Number(req.params.id);
      if ((kind !== 'artist' && kind !== 'album') || !TYPES[`${kind}/${type}`] || !Number.isInteger(id)) {
        return reply.code(404).send({ error: 'Unknown artwork' });
      }
      // Artwork of albums and artists outside the account's sources isn't there for it.
      if (sourcesOf(req) !== null && !(await libraryOf(deps.library, req).hasArtwork(kind, id))) {
        return reply.code(404).send({ error: 'Unknown artwork' });
      }
      const requested = Number(req.query.size);
      // Snap to a fixed set of sizes to bound the number of cached variants.
      const size = requested > 0 ? (SIZES.find((s) => s >= requested) ?? SIZES.at(-1)) : undefined;
      // Lidarr's image versions are numbers; anything else would be one more fetch and file per value.
      const version = /^\d{1,20}$/.test(req.query.v ?? '') ? req.query.v! : '0';
      const key = createHash('sha1').update(`${kind}/${id}/${type}/${size ?? 'orig'}/${version}`).digest('hex');
      const file = join(dir, key);

      // Only successful responses get long-lived caching; errors must not stick in browser caches.
      const cacheOk = req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=86400';

      try {
        const cached = await readFile(file);
        const mime = (await readFile(`${file}.mime`, 'utf8').catch(() => null)) ?? 'image/webp';
        return reply.header('Cache-Control', cacheOk).type(mime).send(cached);
      } catch {
        // cache miss
      }

      let job = inflight.get(key);
      if (!job) {
        job = produce({ kind, id, type, version }, size).finally(() => inflight.delete(key));
        inflight.set(key, job);
      }
      try {
        const { body, mime } = await job;
        await saveCached(dir, file, body, mime);
        return reply.header('Cache-Control', cacheOk).type(mime).send(body);
      } catch (err) {
        reply.header('Cache-Control', 'no-store');
        if (err instanceof LidarrError && err.status === 404) {
          return reply.code(404).send({ error: 'No artwork' });
        }
        req.log.warn({ err }, 'artwork fetch failed');
        return reply.code(502).send({ error: 'Artwork unavailable' });
      }
    },
  );
}

/**
 * Keep a rendered image. Each write has its own temporary name (two requests for the same image can
 * finish together), and a failed write only means it's made again next time.
 */
async function saveCached(dir: string, file: string, body: Buffer, mime: string) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, body);
    await writeFile(`${file}.mime`, mime);
    await rename(tmp, file);
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * Keep the artwork cache under `maxBytes`: what was used least recently goes first (an image is made
 * again if it's needed). Pages of music outside the library would otherwise grow it forever.
 */
export function trimArtCache(dir: string, maxBytes: number): Promise<{ removed: number; bytes: number }> {
  return trimCacheDir(dir, maxBytes);
}
