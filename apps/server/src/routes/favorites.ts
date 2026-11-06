import type { FastifyInstance } from 'fastify';
import { accountId, libraryOf } from '../accounts/rights.ts';
import type { Favorites } from '../favorites.ts';
import type { Library } from '../library/library.ts';
import { RECORDING_ID } from './recordingId.ts';

/** A time a favorite can be put back at: a real date, not in the future (a minute's leeway for a fast clock). */
const pastDate = (at: unknown): at is string => typeof at === 'string' && Date.parse(at) <= Date.now() + 60_000;

/** Each account's favorites, of songs it may hear. */
export function favoriteRoutes(app: FastifyInstance, deps: { favorites: Favorites; library: Library }) {
  const { favorites, library } = deps;

  app.get('/api/favorites', (req) => favorites.list(accountId(req), libraryOf(library, req)));

  app.put<{ Params: { recordingId: string }; Body: { favoritedAt?: unknown } | undefined }>('/api/favorites/:recordingId', async (req, reply) => {
    const { recordingId } = req.params;
    if (!RECORDING_ID.test(recordingId)) return reply.code(400).send({ error: 'Invalid recording id' });
    // Taken back (Undo, or hearted again): the time it was first favorited, so it goes back where it was in the list.
    const at = req.body?.favoritedAt;
    if (at !== undefined && !pastDate(at)) return reply.code(400).send({ error: 'Invalid favoritedAt' });
    const track = await libraryOf(library, req).trackByRecording(recordingId);
    if (!track) return reply.code(404).send({ error: 'Song not found in the library' });
    favorites.add(accountId(req), track, at === undefined ? undefined : new Date(at).toISOString());
    return reply.code(204).send();
  });

  app.delete<{ Params: { recordingId: string } }>('/api/favorites/:recordingId', async (req, reply) => {
    if (!RECORDING_ID.test(req.params.recordingId)) return reply.code(400).send({ error: 'Invalid recording id' });
    favorites.remove(accountId(req), req.params.recordingId);
    return reply.code(204).send();
  });
}
