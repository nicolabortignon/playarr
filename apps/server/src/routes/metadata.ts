import type { RematchResult } from '@playarr/shared';
import type { FastifyInstance } from 'fastify';
import type { AudioFeatures } from '../analysis/dsp.ts';
import type { Matcher } from '../catalog/matcher.ts';
import type { CatalogStore } from '../catalog/store.ts';
import type { LidarrClient } from '../lidarr/client.ts';
import type { Library } from '../library/library.ts';
import { trackMetadata } from '../library/trackMetadata.ts';
import { isLocalAddress } from '../net.ts';

/** Track menu → Show metadata. File paths and source locations only for the home network. */
export function metadataRoutes(
  app: FastifyInstance,
  deps: {
    store: CatalogStore;
    library: Library;
    pathMap: [string, string][];
    features: (ids: string[]) => Map<string, AudioFeatures>;
    matcher?: Pick<Matcher, 'rematchFile'>;
    lidarr?: Pick<LidarrClient, 'configured' | 'trackFile' | 'command'>;
  },
) {
  // Show metadata → Match again. Changes the catalog, so the home network only, like Settings.
  app.post<{ Params: { fileId: string } }>('/api/files/:fileId/rematch', async (req, reply): Promise<RematchResult | void> => {
    if (!isLocalAddress(req.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'Matching songs again works from your home network' });
    }
    const fileId = Number(req.params.fileId);
    const copy = Number.isInteger(fileId) && fileId > 0 ? deps.store.copy(fileId) : undefined;
    const source = copy && deps.store.source(copy.sourceId);
    if (!copy || !source) return reply.code(404).send({ error: 'File not found' });
    try {
      if (source.kind === 'folder') {
        if (!deps.matcher) return reply.code(409).send({ error: 'Matching isn’t available' });
        const state = await deps.matcher.rematchFile(copy.sourceId, copy.ref);
        // Rebuild now (from the last scan) so the file's song and its id reflect the new match before answering.
        await deps.library.rebuild();
        return { kind: 'folder', state, trackId: deps.store.copy(fileId)?.trackId };
      }
      // Lidarr's songs get their metadata from Lidarr: ask it to refresh the artist from MusicBrainz.
      if (!deps.lidarr?.configured) return reply.code(409).send({ error: 'Lidarr isn’t set up' });
      const file = await deps.lidarr.trackFile(Number(copy.ref));
      await deps.lidarr.command('RefreshArtist', { artistId: file.artistId });
      // Lidarr takes a while; pick its changes up after it has had time.
      setTimeout(() => deps.library.refreshSoon(0), 60_000).unref();
      return { kind: 'lidarr', message: 'Lidarr is refreshing this artist from MusicBrainz. Changes show up in a minute or two.' };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>('/api/tracks/:id/metadata', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'Bad track id' });
    const meta = await trackMetadata(
      {
        store: deps.store,
        library: deps.library,
        pathMap: deps.pathMap,
        features: (recordingId) => {
          const f = deps.features([recordingId]).get(recordingId);
          return f
            ? { bpm: f.bpm, pulse: f.pulse, loudness: f.loudness, dynamics: f.dynamics, brightness: f.brightness, busyness: f.busyness, bass: f.bass }
            : undefined;
        },
      },
      id,
      isLocalAddress(req.socket.remoteAddress),
    );
    return meta ?? reply.code(404).send({ error: 'Track not found' });
  });
}
