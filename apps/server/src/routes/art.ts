import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { trimCacheDir } from '../cacheDir.ts';
import type { FileRecord } from '../catalog/build.ts';
import type { FileResolver } from '../catalog/files.ts';
import { copyCover } from '../catalog/folderArt.ts';
import type { FolderFs } from '../catalog/folderFs.ts';
import { pictureFrom } from '../catalog/tags.ts';
import { coverArtArchive, fetchRemoteImage, imageBody, isAllowedRemote } from '../discover/art.ts';
import { libraryOf, sourcesOf } from '../accounts/rights.ts';
import { copyCoverKey, lidarrCoverKey, remoteCoverKey, type CoverColorStore, type CoverReader } from '../library/coverColorStore.ts';
import type { Library } from '../library/library.ts';
import { LidarrError, type LidarrClient } from '../lidarr/client.ts';
import type { MediaSource } from '../media/index.ts';

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

  /** The original if it's on disk already, without asking Lidarr; null if it isn't. */
  async onDisk(art: ArtKey): Promise<{ body: Buffer; mime: string } | null> {
    const file = join(this.dir, LocalArt.cacheKey(art));
    try {
      const [body, mime] = await Promise.all([readFile(file), readFile(`${file}.mime`, 'utf8')]);
      return { body, mime };
    } catch {
      return null;
    }
  }

  original(art: ArtKey): Promise<{ body: Buffer; mime: string }> {
    const { kind, id, type } = art;
    const key = LocalArt.cacheKey(art);
    let job = this.inflight.get(key);
    if (job) return job;
    job = (async () => {
      const file = join(this.dir, key);
      const kept = await this.onDisk(art);
      if (kept) return kept;
      const spec = TYPES[`${kind}/${type}`]!;
      const res = await this.lidarr.mediaCover(kind, id, spec.file);
      const body = await imageBody(res);
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

/**
 * Serves Lidarr artwork (resized to WebP, cached), folder files' artwork and allowlisted remote artwork. Library albums'
 * covers in hand (an original fetched, or a variant from the cache) go to `colors` to be read, after the answer's on its
 * way; Discover's and search's remote covers don't.
 */
export function artRoutes(
  app: FastifyInstance,
  deps: {
    art: LocalArt;
    cacheDir: string;
    library: Pick<Library, 'album' | 'file' | 'hasArtwork' | 'hasCover'> & Partial<Pick<Library, 'view'>>;
    files: FileResolver;
    folders: { get(sourceId: number): FolderFs | undefined };
    colors?: Pick<CoverColorStore, 'offer'>;
  },
) {
  const dir = join(deps.cacheDir, 'art');
  const inflight = new Map<string, Promise<{ body: Buffer; mime: string }>>();
  const offerCover = (key: string, image: Buffer) => void deps.colors?.offer(key, image);

  async function produce(key: ArtKey, size?: number) {
    const original = await deps.art.original(key);
    if (key.kind === 'album' && key.type === 'cover') offerCover(lidarrCoverKey(key.id, key.version), original.body);
    if (!size) return original;
    const spec = TYPES[`${key.kind}/${key.type}`]!;
    const body = await sharp(original.body)
      .resize(size, spec.square ? size : undefined, { fit: 'cover', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    return { body, mime: 'image/webp' };
  }

  // Artwork for music that isn't in the library (Cover Art Archive, Lidarr's image cache, fanart.tv), and the
  // MusicBrainz cover of a library album that has no other.
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
    const file = join(dir, remoteArtFile(target.href, size, wide));
    // Only a library album's cover is read for its colors.
    const colorKey = remoteCoverKey(target.href);
    const offerLibraryCover = (image: Buffer) => {
      if (deps.library.hasCover(colorKey)) offerCover(colorKey, image);
    };

    try {
      const cached = await readFile(file);
      const mime = (await readFile(`${file}.mime`, 'utf8').catch(() => null)) ?? 'image/webp';
      offerLibraryCover(cached);
      return reply.header('Cache-Control', 'public, max-age=2592000').type(mime).send(cached);
    } catch {
      // cache miss
    }
    try {
      const original = await fetchRemoteImage(target.href);
      if (!original) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'No artwork' });
      offerLibraryCover(original.body);
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

  /**
   * A song file's cover at `size` (undefined: as it is), from the art cache or made and kept there: the picture
   * embedded in it, from any source (Lidarr's files too), or for a folder file without `embeddedOnly` a cover image
   * beside it; and when there's none, the Cover Art Archive front of `mbid`, the album's release group. null: none.
   */
  async function copyArt(file: FileRecord, size: number | undefined, embeddedOnly: boolean, mbid?: string): Promise<{ body: Buffer; mime: string } | null> {
    const colorKey = copyCoverKey(file.id, file.size, embeddedOnly);
    const cached = join(dir, copyArtFile(file.id, file.size, size, embeddedOnly));
    try {
      const body = await readFile(cached);
      const mime = (await readFile(`${cached}.mime`, 'utf8').catch(() => null)) ?? 'image/webp';
      offerCover(colorKey, body);
      return { body, mime };
    } catch {
      // cache miss
    }
    const original = (await filePicture(deps, file, embeddedOnly)) ?? (mbid ? await musicBrainzCover(mbid) : null);
    if (!original) return null;
    offerCover(colorKey, original.body);
    const out = size
      ? {
          body: await sharp(original.body).resize(size, size, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(),
          mime: 'image/webp',
        }
      : original;
    await saveCached(dir, cached, out.body, out.mime);
    return out;
  }

  // Artwork drawn from a song file (embedded picture, or an image beside a folder file), wherever it's kept.
  // `?embedded=1`: only the picture in the file (see catalog/build.ts embeddedCoverUrl), and `&mbid=`: the album's
  // Cover Art Archive front when the file has none.
  app.get<{ Params: { id: string }; Querystring: { size?: string; embedded?: string; mbid?: string } }>('/art/copy/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const file = Number.isInteger(id) ? await libraryOf(deps.library, req).file(id) : undefined;
    if (!file) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'Unknown file' });
    const requested = Number(req.query.size);
    const size = requested > 0 ? (SIZES.find((s) => s >= requested) ?? SIZES.at(-1)) : undefined;
    const embeddedOnly = req.query.embedded === '1';
    const mbid = embeddedOnly && MBID.test(req.query.mbid ?? '') ? req.query.mbid : undefined;
    const art = await copyArt(file, size, embeddedOnly, mbid).catch(() => null);
    if (!art) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'No artwork' });
    return reply.header('Cache-Control', 'public, max-age=86400').type(art.mime).send(art.body);
  });

  /** An album whose Lidarr cover isn't there: the picture embedded in its first song, else its MusicBrainz cover. */
  async function albumFallback(req: FastifyRequest, albumId: number, size: number | undefined) {
    const library = libraryOf(deps.library, req);
    const album = await library.album(albumId);
    const first = album?.tracks[0];
    const file = first && (await library.file(first.fileId));
    if (!album || !file) return null;
    return copyArt(file, size, true, album.mbid).catch(() => null);
  }

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
        if (kind === 'album' && type === 'cover') offerCover(lidarrCoverKey(id, version), cached);
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
        // Lidarr lists a cover it can't give (never downloaded, or gone): the album's own songs may have one.
        if (kind === 'album' && type === 'cover') {
          const fallback = await albumFallback(req, id, size);
          if (fallback) return reply.header('Cache-Control', 'public, max-age=86400').type(fallback.mime).send(fallback.body);
        }
        if (err instanceof LidarrError && err.status === 404) {
          return reply.code(404).send({ error: 'No artwork' });
        }
        req.log.warn({ err }, 'artwork fetch failed');
        return reply.code(502).send({ error: 'Artwork unavailable' });
      }
    },
  );
}

/** The art cache's name for a folder file's picture at a size (undefined: as it is). */
function copyArtFile(fileId: number, fileSize: number, size: number | undefined, embedded: boolean): string {
  return createHash('sha1').update(`copy/${fileId}/${fileSize}/${size ?? 'orig'}${embedded ? '/embedded' : ''}`).digest('hex');
}

/** A MusicBrainz id as the art routes take one: anything else isn't put into a URL. */
const MBID = /^[\w-]{1,64}$/;

/**
 * The picture in a song file, wherever it's kept: a folder file's through its source (with a cover image beside it
 * unless `embeddedOnly`), a Lidarr file's through MEDIA_SOURCE (only what's embedded: its folder is Lidarr's to keep).
 * null when there's none, or the file can't be read.
 */
async function filePicture(
  deps: { files: Pick<FileResolver, 'resolve'>; folders: { get(sourceId: number): FolderFs | undefined } },
  file: FileRecord,
  embeddedOnly: boolean,
): Promise<{ body: Buffer; mime: string } | null> {
  let resolved: { media: MediaSource; path: string };
  try {
    resolved = deps.files.resolve(file);
  } catch {
    return null; // its source was removed, or the file isn't in its folder
  }
  const fs = deps.folders.get(file.sourceId);
  if (fs) return copyCover(fs, resolved.path, file.size, embeddedOnly).catch(() => null);
  return pictureFrom(resolved.media, resolved.path, file.size).catch(() => null);
}

/** The Cover Art Archive front of a release group, through the same allowlisted fetch as other remote covers. */
async function musicBrainzCover(mbid: string): Promise<{ body: Buffer; mime: string } | null> {
  return fetchRemoteImage(coverArtArchive(mbid, 500)).catch(() => null);
}

/** The art cache's name for a remote image at a size (undefined: as it is), cropped square or kept `wide`. */
function remoteArtFile(url: string, size: number | undefined, wide: boolean): string {
  return createHash('sha1').update(`remote/${url}/${size ?? 'orig'}/${wide}`).digest('hex');
}

/**
 * Remote covers the background fill fetches start at least this far apart, one at a time: the Cover Art Archive is
 * someone else's service, and nothing else here limits how often it's asked (the MusicBrainz queue is for its API).
 */
const REMOTE_GAP_MS = 1000;

/**
 * Reads album covers for CoverColorStore's background fill, asking as little as it can: Lidarr's original only if
 * it's on disk (`LocalArt.warm` fetches them; a cover not there yet waits for a later fill); a folder file's picture
 * or a remote cover from the art cache when a page had it drawn, else from the file, wherever its folder is, or from
 * the remote host, gently (`remoteGapMs`).
 */
export function coverReader(deps: {
  art: Pick<LocalArt, 'onDisk'>;
  cacheDir: string;
  files: Pick<FileResolver, 'resolve'>;
  folders: { get(sourceId: number): FolderFs | undefined };
  remoteGapMs?: number;
}): CoverReader {
  const dir = join(deps.cacheDir, 'art');
  const sizes = [...SIZES, undefined];
  const fromCache = async (names: string[]) => {
    for (const name of names) {
      const body = await readFile(join(dir, name)).catch(() => null);
      if (body) return body;
    }
    return null;
  };
  const gap = deps.remoteGapMs ?? REMOTE_GAP_MS;
  let lastFetch = -Infinity;
  let turn: Promise<unknown> = Promise.resolve();
  const fetchGently = (url: string) => {
    const fetched = turn.then(async () => {
      const wait = lastFetch + gap - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastFetch = Date.now();
      return fetchRemoteImage(url);
    });
    turn = fetched.catch(() => {});
    return fetched;
  };
  return async (image) => {
    if (image.kind === 'lidarr') {
      return (await deps.art.onDisk({ kind: 'album', id: image.albumId, type: 'cover', version: image.version }))?.body;
    }
    if (image.kind === 'remote') {
      const cached = await fromCache(sizes.map((size) => remoteArtFile(image.url, size, false)));
      // A remote host's 404 is a cover without a picture (null), looked at again after a day.
      return cached ?? (await fetchGently(image.url))?.body ?? null;
    }
    const { file, embedded, mbid } = image;
    const cached = await fromCache(sizes.map((size) => copyArtFile(file.id, file.size, size, embedded)));
    if (cached) return cached;
    let resolved: { media: MediaSource; path: string };
    try {
      resolved = deps.files.resolve(file);
    } catch {
      return undefined; // its source was removed, or the file isn't in its folder: no cover to read
    }
    const fs = deps.folders.get(file.sourceId);
    const picture = fs ? await copyCover(fs, resolved.path, file.size, embedded) : await pictureFrom(resolved.media, resolved.path, file.size).catch(() => null);
    if (picture) return picture.body;
    // A file without a picture from a folder that's away can't be told apart: only a file that's there has none.
    if (fs && !(await fs.stat(resolved.path).catch(() => null))) throw new Error('The file can’t be reached');
    if (mbid && MBID.test(mbid)) return (await fetchGently(coverArtArchive(mbid, 500)))?.body ?? null;
    return null;
  };
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
