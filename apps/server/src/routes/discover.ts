import type { AlbumRef } from '@playarr/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Discover } from '../discover/discover.ts';
import { RequestError, type Requests } from '../discover/requests.ts';

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof RequestError) return reply.code(err.status).send({ error: err.message });
  if ((err as Error).name === 'AbortError') return reply.code(499).send();
  return reply.code(502).send({ error: (err as Error).message });
}

export function discoverRoutes(app: FastifyInstance, deps: { discover: Discover; requests: Requests }) {
  const { discover, requests } = deps;

  /**
   * Abort upstream work when the client gives up (e.g. typed a newer query).
   * Note: the *response* close event, since the request's fires as soon as its body is read.
   */
  const abortOnDisconnect = (reply: FastifyReply) => {
    const ctrl = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) ctrl.abort();
    });
    return ctrl.signal;
  };

  app.get<{ Querystring: { q?: string } }>('/api/discover/search', async (req, reply) => {
    try {
      return await discover.search(req.query.q ?? '', abortOnDisconnect(reply));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { mbid: string } }>('/api/discover/artists/:mbid', async (req, reply) => {
    if (!MBID.test(req.params.mbid)) return reply.code(400).send({ error: 'Invalid MusicBrainz id' });
    try {
      return await discover.artist(req.params.mbid, abortOnDisconnect(reply));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/requests', () => requests.list());

  app.post<{ Body: Partial<AlbumRef> }>('/api/requests', async (req, reply) => {
    const { mbid, releaseMbid, artistName, albumTitle } = req.body ?? {};
    if ((mbid !== undefined && !MBID.test(mbid)) || (releaseMbid !== undefined && !MBID.test(releaseMbid))) {
      return reply.code(400).send({ error: 'Invalid MusicBrainz id' });
    }
    if (!mbid && (!artistName?.trim() || !albumTitle?.trim())) {
      return reply.code(400).send({ error: 'Provide mbid, or artistName and albumTitle' });
    }
    try {
      return await requests.request({ mbid, releaseMbid, artistName: artistName ?? '', albumTitle: albumTitle ?? '' });
    } catch (err) {
      req.log.warn({ err, mbid, artistName, albumTitle }, 'album request failed');
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { mbid: string } }>('/api/requests/:mbid', async (req, reply) => {
    await requests.remove(req.params.mbid);
    return reply.code(204).send();
  });
}
