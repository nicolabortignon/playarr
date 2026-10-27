import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { fetchRemoteImage, isAllowedRemote } from '../discover/art.ts';
import { LidarrError, type LidarrClient } from '../lidarr/client.ts';

const SIZES = [96, 160, 240, 320, 480, 640, 960, 1200];
const TYPES: Record<string, { file: string; square: boolean; mime: string }> = {
  'album/cover': { file: 'cover.jpg', square: true, mime: 'image/jpeg' },
  'artist/poster': { file: 'poster.jpg', square: true, mime: 'image/jpeg' },
  'artist/fanart': { file: 'fanart.jpg', square: false, mime: 'image/jpeg' },
  'artist/banner': { file: 'banner.jpg', square: false, mime: 'image/jpeg' },
  'artist/clearlogo': { file: 'clearlogo.png', square: false, mime: 'image/png' },
};

/** Proxies Lidarr artwork, resizing to WebP and caching on disk. */
export function artRoutes(app: FastifyInstance, deps: { lidarr: LidarrClient; cacheDir: string }) {
  const dir = join(deps.cacheDir, 'art');
  const inflight = new Map<string, Promise<{ body: Buffer; mime: string }>>();

  async function produce(kind: 'artist' | 'album', id: number, type: string, size?: number) {
    const spec = TYPES[`${kind}/${type}`]!;
    const res = await deps.lidarr.mediaCover(kind, id, spec.file);
    const original = Buffer.from(await res.arrayBuffer());
    if (!size) return { body: original, mime: res.headers.get('content-type') ?? spec.mime };
    const body = await sharp(original)
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
        job = produce(kind, id, type, size).finally(() => inflight.delete(key));
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
