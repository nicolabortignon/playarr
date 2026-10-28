import type { FastifyInstance } from 'fastify';
import type { Favorites } from '../favorites.ts';
import type { Library } from '../library/library.ts';

const RECORDING_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|track:\d+)$/i;

export function favoriteRoutes(app: FastifyInstance, deps: { favorites: Favorites; library: Library }) {
  const { favorites, library } = deps;

  app.get('/api/favorites', () => favorites.list());

  app.put<{ Params: { recordingId: string } }>('/api/favorites/:recordingId', async (req, reply) => {
    const { recordingId } = req.params;
    if (!RECORDING_ID.test(recordingId)) return reply.code(400).send({ error: 'Invalid recording id' });
    const track = await library.trackByRecording(recordingId);
    if (!track) return reply.code(404).send({ error: 'Song not found in the library' });
    favorites.add(track);
    return reply.code(204).send();
  });

  app.delete<{ Params: { recordingId: string } }>('/api/favorites/:recordingId', async (req, reply) => {
    if (!RECORDING_ID.test(req.params.recordingId)) return reply.code(400).send({ error: 'Invalid recording id' });
    favorites.remove(req.params.recordingId);
    return reply.code(204).send();
  });
}
