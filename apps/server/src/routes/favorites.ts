import type { FastifyInstance } from 'fastify';
import { accountId, libraryOf } from '../accounts/rights.ts';
import type { Favorites } from '../favorites.ts';
import type { Library } from '../library/library.ts';
import { RECORDING_ID } from './recordingId.ts';

/** Each account's favorites, of songs it may hear. */
export function favoriteRoutes(app: FastifyInstance, deps: { favorites: Favorites; library: Library }) {
  const { favorites, library } = deps;

  app.get('/api/favorites', (req) => favorites.list(accountId(req), libraryOf(library, req)));

  app.put<{ Params: { recordingId: string } }>('/api/favorites/:recordingId', async (req, reply) => {
    const { recordingId } = req.params;
    if (!RECORDING_ID.test(recordingId)) return reply.code(400).send({ error: 'Invalid recording id' });
    const track = await libraryOf(library, req).trackByRecording(recordingId);
    if (!track) return reply.code(404).send({ error: 'Song not found in the library' });
    favorites.add(accountId(req), track);
    return reply.code(204).send();
  });

  app.delete<{ Params: { recordingId: string } }>('/api/favorites/:recordingId', async (req, reply) => {
    if (!RECORDING_ID.test(req.params.recordingId)) return reply.code(400).send({ error: 'Invalid recording id' });
    favorites.remove(accountId(req), req.params.recordingId);
    return reply.code(204).send();
  });
}
