import type { FastifyInstance } from 'fastify';
import type { LyricsService } from '../lyrics/lyrics.ts';

/** Now Playing → Lyrics. */
export function lyricsRoutes(app: FastifyInstance, deps: { lyrics: Pick<LyricsService, 'forTrack'> }) {
  app.get<{ Params: { id: string } }>('/api/tracks/:id/lyrics', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(404).send({ error: 'Unknown song' });
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
