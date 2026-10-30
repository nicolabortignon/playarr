import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import type { FileResolver } from '../catalog/files.ts';
import { copyCover } from '../catalog/folderArt.ts';
import { fetchRemoteImage, isAllowedRemote } from '../discover/art.ts';
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

  constructor(
    private readonly lidarr: LidarrClient,
    private readonly dir: string,
  ) {}

  static parse(url: string): ArtKey | undefined {
    const m = url.match(/^\/art\/(artist|album)\/(\d+)\/(\w+)(?:\?v=(\d+))?/);
    if (!m || !TYPES[`${m[1]}/${m[3]}`]) return undefined;
    return { kind: m[1] as ArtKey['kind'], id: Number(m[2]), type: m[3]!, version: m[4] ?? '0' };
  }

  original({ kind, id, type, version }: ArtKey): Promise<{ body: Buffer; mime: string }> {
    const key = createHash('sha1').update(`orig/${kind}/${id}/${type}/${version}`).digest('hex');
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

  /** Fetch originals in the background, gently (Lidarr is shared with everything else). */
  async warm(urls: string[], log: { info: (m: string) => void }) {
    const keys = urls.flatMap((u) => LocalArt.parse(u) ?? []);
    let fetched = 0;
    const started = Date.now();
    for (let i = 0; i < keys.length; i += 2) {
      await Promise.all(
        keys.slice(i, i + 2).map((k) =>
          this.original(k).then(
            () => fetched++,
            () => {},
          ),
        ),
      );
    }
    log.info(`Artwork cache warm: ${fetched}/${keys.length} images in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
}

/** Serves Lidarr artwork (resized to WebP, cached), folder files' artwork and allowlisted remote artwork. */
export function artRoutes(
  app: FastifyInstance,
  deps: { art: LocalArt; cacheDir: string; library: Pick<Library, 'file'>; files: FileResolver },
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
      await mkdir(dir, { recursive: true });
      await writeFile(`${file}.tmp`, out.body);
      await writeFile(`${file}.mime`, out.mime);
      await rename(`${file}.tmp`, file);
      return reply.header('Cache-Control', 'public, max-age=2592000').type(out.mime).send(out.body);
    } catch (err) {
      req.log.warn({ err, url: target.href }, 'remote artwork failed');
      return reply.code(502).header('Cache-Control', 'no-store').send({ error: 'Artwork unavailable' });
    }
  });

  // Artwork drawn from a folder file (embedded picture or an image beside it).
  app.get<{ Params: { id: string }; Querystring: { size?: string } }>('/art/copy/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const file = Number.isInteger(id) ? await deps.library.file(id) : undefined;
    if (!file) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'Unknown file' });
    let path: string;
    try {
      const resolved = deps.files.resolve(file);
      if (resolved.media.kind !== 'local') throw new Error('not local');
      path = resolved.path;
    } catch {
      return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'No artwork' });
    }
    const requested = Number(req.query.size);
    const size = requested > 0 ? (SIZES.find((s) => s >= requested) ?? SIZES.at(-1)) : undefined;
    const key = createHash('sha1').update(`copy/${id}/${file.size}/${size ?? 'orig'}`).digest('hex');
    const cached = join(dir, key);
    try {
      const body = await readFile(cached);
      const mime = (await readFile(`${cached}.mime`, 'utf8').catch(() => null)) ?? 'image/webp';
      return reply.header('Cache-Control', 'public, max-age=86400').type(mime).send(body);
    } catch {
      // cache miss
    }
    const original = await copyCover(path);
    if (!original) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'No artwork' });
    const out = size
      ? {
          body: await sharp(original.body).resize(size, size, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(),
          mime: 'image/webp',
        }
      : original;
    await mkdir(dir, { recursive: true });
    await writeFile(`${cached}.tmp`, out.body);
    await writeFile(`${cached}.mime`, out.mime);
    await rename(`${cached}.tmp`, cached);
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
      const requested = Number(req.query.size);
      // Snap to a fixed set of sizes to bound the number of cached variants.
      const size = requested > 0 ? (SIZES.find((s) => s >= requested) ?? SIZES.at(-1)) : undefined;
      const version = req.query.v ?? '0';
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
        await mkdir(dir, { recursive: true });
        await writeFile(`${file}.tmp`, body);
        await writeFile(`${file}.mime`, mime);
        await rename(`${file}.tmp`, file);
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
