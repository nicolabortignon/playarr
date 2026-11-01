import type { AlbumSort, HealthStatus, RequestSettings } from '@playarr/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from '../config.ts';
import type { LidarrClient } from '../lidarr/client.ts';
import type { Library } from '../library/library.ts';
import { mapPath, type MediaSource } from '../media/index.ts';
import { requireLocal } from './settings.ts';

const ALBUM_SORTS: AlbumSort[] = ['title', 'artist', 'year', 'added'];

function clampInt(raw: string | undefined, fallback: number, max: number) {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

const notFound = (reply: FastifyReply, what: string) => reply.code(404).send({ error: `${what} not found` });

export function apiRoutes(
  app: FastifyInstance,
  deps: {
    config: Config;
    lidarr: LidarrClient;
    library: Library;
    media: MediaSource;
    requestSettings: () => RequestSettings;
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

  app.get('/api/health', async (): Promise<HealthStatus> => {
    const [lidarrResult, mediaResult] = await probes();
    const lidarrOk = lidarrResult.status === 'fulfilled';
    const mediaOk = mediaResult.status === 'fulfilled';
    return {
      ok: lidarrOk && mediaOk,
      lidarr: !lidarr.configured
        ? undefined
        : lidarrOk
          ? { ok: true, version: lidarrResult.value?.version }
          : { ok: false, error: (lidarrResult.reason as Error).message },
      media: mediaOk
        ? { source: media.kind, ok: true }
        : { source: media.kind, ok: false, error: (mediaResult.reason as Error).message },
      library: await library.stats(),
      requests: lidarr.configured && deps.requestSettings().enabled,
    };
  });

  // A full rescan is heavy (every folder and Lidarr): from the home network only, like settings.
  app.post('/api/library/refresh', { onRequest: requireLocal }, async () => {
    await library.refresh();
    return library.stats();
  });

  app.get('/api/artists', () => library.artists());

  app.get<{ Params: { id: string } }>('/api/artists/:id', async (req, reply) => {
    return (await library.artist(Number(req.params.id))) ?? notFound(reply, 'Artist');
  });

  app.get<{ Params: { id: string } }>('/api/artists/:id/tracks', (req) =>
    library.artistTracks(Number(req.params.id)),
  );

  app.get<{ Querystring: { sort?: string; limit?: string } }>('/api/albums', (req) => {
    const sort = ALBUM_SORTS.includes(req.query.sort as AlbumSort) ? (req.query.sort as AlbumSort) : 'artist';
    const limit = req.query.limit ? clampInt(req.query.limit, 50, 10_000) : undefined;
    return library.albums(sort, limit);
  });

  app.get<{ Querystring: { limit?: string } }>('/api/albums/random', (req) =>
    library.randomAlbums(clampInt(req.query.limit, 12, 100)),
  );

  app.get<{ Params: { id: string } }>('/api/albums/:id', async (req, reply) => {
    return (await library.album(Number(req.params.id))) ?? notFound(reply, 'Album');
  });

  app.get<{ Querystring: { limit?: string } }>('/api/tracks/random', (req) =>
    library.randomTracks(clampInt(req.query.limit, 50, 500)),
  );

  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/search', (req) =>
    library.search(req.query.q ?? '', clampInt(req.query.limit, 20, 100)),
  );
}
