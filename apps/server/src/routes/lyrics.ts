import type { FastifyInstance } from 'fastify';
import { libraryOf, sourcesOf } from '../accounts/rights.ts';
import type { Library } from '../library/library.ts';
import type { LyricsService } from '../lyrics/lyrics.ts';

/** Now Playing → Lyrics, for songs the account may hear. */
export function lyricsRoutes(
  app: FastifyInstance,
  deps: { lyrics: Pick<LyricsService, 'forTrack'>; library?: Pick<Library, 'track'> & Partial<Pick<Library, 'view'>> },
) {
  app.get<{ Params: { id: string } }>('/api/tracks/:id/lyrics', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(404).send({ error: 'Unknown song' });
    if (deps.library && sourcesOf(req) !== null && !(await libraryOf(deps.library, req).track(id))) {
      return reply.code(404).send({ error: 'Unknown song' });
    }
    try {
      const found = await deps.lyrics.forTrack(id);
      if (found === undefined) return reply.code(404).send({ error: 'Unknown song' });
      return reply.header('Cache-Control', 'private, max-age=3600').send({ lyrics: found });
    } catch (err) {
      req.log.warn({ err }, 'lyrics lookup failed');
      return reply.code(502).send({ error: 'Lyrics are unavailable right now' });
    }
  });
}
