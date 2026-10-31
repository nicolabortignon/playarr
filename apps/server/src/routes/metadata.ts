import type { FastifyInstance } from 'fastify';
import type { AudioFeatures } from '../analysis/dsp.ts';
import type { CatalogStore } from '../catalog/store.ts';
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
  },
) {
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
