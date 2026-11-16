import type { AlbumFilters, AlbumSort, Fidelity, HealthStatus, RequestSettings } from '@playarr/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import type { LidarrClient } from '../lidarr/client.ts';
import type { Library } from '../library/library.ts';
import { mapPath, type MediaSource } from '../media/index.ts';
import { canRequest, isAdmin, libraryOf, requireAdmin } from '../accounts/rights.ts';

const ALBUM_SORTS: AlbumSort[] = ['title', 'artist', 'year', 'added'];
const FIDELITIES: Fidelity[] = ['hi-res', 'lossless', 'lossy'];

function clampInt(raw: string | undefined, fallback: number, max: number) {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

const notFound = (reply: FastifyReply, what: string) => reply.code(404).send({ error: `${what} not found` });

/** A page of a list: 100 at a time unless asked otherwise, at most 500. */
const PAGE = { limit: 100, max: 500 };

/**
 * The page a list's query asks for: `offset` (from 0; a bad one is the first page) and `limit`. Null without an
 * `offset`, for the whole list as the routes always answered, which the apps already out there read.
 */
function pageOf(query: { offset?: string; limit?: string }): { offset: number; limit: number } | null {
  if (query.offset === undefined) return null;
  const offset = Number.parseInt(query.offset, 10);
  return { offset: Number.isFinite(offset) && offset > 0 ? offset : 0, limit: clampInt(query.limit, PAGE.limit, PAGE.max) };
}

/**
 * Tags an answer with a weak ETag, to be asked about every time (`private, no-cache`: it's one account's library), and
 * says whether the client already has it: its If-None-Match names this tag, weakly compared, or is `*`.
 */
function fresh(req: FastifyRequest, reply: FastifyReply, tag: string): boolean {
  const etag = `W/"${tag}"`;
  reply.header('etag', etag).header('cache-control', 'private, no-cache');
  const held = req.headers['if-none-match'];
  if (!held) return false;
  return held.split(',').some((each) => {
    const t = each.trim();
    return t === '*' || t === etag || `W/${t}` === etag;
  });
}

export function apiRoutes(
  app: FastifyInstance,
  deps: {
    config: Config;
    lidarr: LidarrClient;
    library: Library;
    media: MediaSource;
    requestSettings: () => RequestSettings;
    /** For health's `database`: absent, health leaves it out. */
    db?: Pick<DatabaseSync, 'prepare'>;
  },
) {
  const { config, lidarr, library, media } = deps;

  // Every open app asks every minute: the slow part (Lidarr, the music files) is shared for a little while.
  const PROBE_TTL_MS = 20_000;
  let probe: { at: number; result: Promise<[PromiseSettledResult<{ version?: string } | undefined>, PromiseSettledResult<void>]> } | null = null;
  const probes = () => {
    if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.result;
    const result = Promise.allSettled([
      lidarr.configured ? lidarr.systemStatus() : Promise.resolve(undefined),
      (async () => {
        // Probe a real file so a bad PATH_MAP shows up here, not on first play.
        const track = (await library.allTracks())[0];
        const file = track && (await library.file(track.fileId));
        await media.check(file ? mapPath(file.path, config.pathMap) : undefined);
      })(),
    ]);
    probe = { at: Date.now(), result };
    return result;
  };

  // The database answering a trivial query: what an update waits for (docker/update.sh looks for "database":{"ok":true),
  // where `ok` also needs Lidarr and the music, which can be away for reasons of their own.
  const database = (): HealthStatus['database'] => {
    if (!deps.db) return undefined;
    try {
      deps.db.prepare('PRAGMA user_version').get();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };

  app.get('/api/health', async (req): Promise<HealthStatus> => {
    const [lidarrResult, mediaResult] = await probes();
    const lidarrOk = lidarrResult.status === 'fulfilled';
    const mediaOk = mediaResult.status === 'fulfilled';
    // Everyone hears whether things are fine, in the same shape; why not, and Lidarr's version, only admins: the
    // errors can name Lidarr's address, the music's path or the host it's read from.
    const details = isAdmin(req);
    return {
      ok: lidarrOk && mediaOk,
      lidarr: !lidarr.configured
        ? undefined
        : lidarrOk
          ? { ok: true, ...(details ? { version: lidarrResult.value?.version } : {}) }
          : { ok: false, ...(details ? { error: (lidarrResult.reason as Error).message } : {}) },
      media: mediaOk
        ? { source: media.kind, ok: true }
        : { source: media.kind, ok: false, ...(details ? { error: (mediaResult.reason as Error).message } : {}) },
      // What the asker may hear; nothing before signing in.
      library: req.auth === null ? undefined : await libraryOf(library, req).stats(),
      // Request buttons show only to accounts that may use them.
      requests: lidarr.configured && deps.requestSettings().enabled && canRequest(req),
      database: database(),
    };
  });

  // A full rescan is heavy (every folder and Lidarr): for admins, like settings.
  app.post('/api/library/refresh', { onRequest: requireAdmin }, async () => {
    await library.refresh();
    return library.stats();
  });

  // The albums and artists lists, whole as always, or a page at a time with `offset` (AlbumPage, ArtistPage). Both are
  // tagged with the library they were read from, so a client asking again with If-None-Match gets a 304, not 5 MB
  // of a collector's albums again. The tag is read before the list, so a list can only be newer than its tag, never
  // older: at worst a client fetches it once more.
  app.get<{ Querystring: { offset?: string; limit?: string } }>('/api/artists', async (req, reply) => {
    const view = libraryOf(library, req);
    const page = pageOf(req.query);
    if (fresh(req, reply, `${await view.listTag('artists')}${page ? `-${page.offset}.${page.limit}` : ''}`)) return reply.code(304).send();
    return page ? view.artistPage(page.offset, page.limit) : view.artists();
  });

  app.get<{ Params: { id: string } }>('/api/artists/:id', async (req, reply) => {
    return (await libraryOf(library, req).artist(Number(req.params.id))) ?? notFound(reply, 'Artist');
  });

  app.get<{ Params: { id: string } }>('/api/artists/:id/tracks', (req) =>
    libraryOf(library, req).artistTracks(Number(req.params.id)),
  );

  app.get<{ Querystring: { sort?: string; limit?: string; offset?: string; genre?: string; fidelity?: string } }>('/api/albums', async (req, reply) => {
    const view = libraryOf(library, req);
    const sort = ALBUM_SORTS.includes(req.query.sort as AlbumSort) ? (req.query.sort as AlbumSort) : 'artist';
    const page = pageOf(req.query);
    // Without an offset, `limit` is the first so many, as it always was.
    const limit = !page && req.query.limit ? clampInt(req.query.limit, 50, 10_000) : undefined;
    // Those with this genre and of this fidelity; a filter that isn't one is left out.
    const genre = req.query.genre?.trim().slice(0, 200) || undefined;
    const fidelity = FIDELITIES.includes(req.query.fidelity as Fidelity) ? (req.query.fidelity as Fidelity) : undefined;
    const filter = { ...(genre ? { genre } : {}), ...(fidelity ? { fidelity } : {}) };
    const filtered = genre || fidelity ? `-${encodeURIComponent(genre?.toLowerCase() ?? '')}.${fidelity ?? ''}` : '';
    const tag = `${await view.listTag('albums')}-${sort}${filtered}${page ? `-${page.offset}.${page.limit}` : limit ? `-${limit}` : ''}`;
    if (fresh(req, reply, tag)) return reply.code(304).send();
    return page ? view.albumPage(sort, page.offset, page.limit, filter) : view.albums(sort, limit, filter);
  });

  app.get('/api/albums/filters', async (req, reply): Promise<AlbumFilters | undefined> => {
    const view = libraryOf(library, req);
    if (fresh(req, reply, `${await view.listTag('albums')}-filters`)) return void reply.code(304).send();
    return view.albumFilters();
  });

  app.get<{ Querystring: { limit?: string } }>('/api/albums/random', (req) =>
    libraryOf(library, req).randomAlbums(clampInt(req.query.limit, 12, 100)),
  );

  app.get<{ Params: { id: string } }>('/api/albums/:id', async (req, reply) => {
    return (await libraryOf(library, req).album(Number(req.params.id))) ?? notFound(reply, 'Album');
  });

  app.get<{ Querystring: { limit?: string } }>('/api/tracks/random', (req) =>
    libraryOf(library, req).randomTracks(clampInt(req.query.limit, 50, 500)),
  );

  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/search', (req) =>
    libraryOf(library, req).search(req.query.q ?? '', clampInt(req.query.limit, 20, 100)),
  );
}
