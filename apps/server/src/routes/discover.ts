import type { AlbumRef, RequestsSeen } from '@playarr/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Discover } from '../discover/discover.ts';
import { accountId, requireAdmin, requireCanRequest, requestsWaitForApproval, seesEveryRequest } from '../accounts/rights.ts';
import { RequestError, type Requests, type RequestViewer } from '../discover/requests.ts';

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

  app.get<{ Params: { mbid: string } }>('/api/discover/artists/:mbid/similar', async (req, reply) => {
    if (!MBID.test(req.params.mbid)) return reply.code(400).send({ error: 'Invalid MusicBrainz id' });
    try {
      return await discover.similarArtists(req.params.mbid, abortOnDisconnect(reply));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Querystring: { name?: string } }>('/api/discover/artist-lookup', async (req, reply) => {
    const name = req.query.name?.trim();
    if (!name) return reply.code(400).send({ error: 'name is required' });
    try {
      const match = await discover.findArtist(name, abortOnDisconnect(reply));
      return match ?? reply.code(404).send({ error: `Couldn’t find “${name}” on MusicBrainz` });
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** A member's own requests; an admin's every request. */
  const viewer = (req: FastifyRequest): RequestViewer => ({ accountId: accountId(req), everyone: seesEveryRequest(req) });

  app.get('/api/requests', (req) => requests.list(viewer(req)));

  app.post<{ Body: Partial<AlbumRef> }>('/api/requests', { onRequest: requireCanRequest }, async (req, reply) => {
    const { mbid, releaseMbid, artistName, albumTitle } = req.body ?? {};
    if ((mbid !== undefined && !MBID.test(mbid)) || (releaseMbid !== undefined && !MBID.test(releaseMbid))) {
      return reply.code(400).send({ error: 'Invalid MusicBrainz id' });
    }
    if (!mbid && (!artistName?.trim() || !albumTitle?.trim())) {
      return reply.code(400).send({ error: 'Provide mbid, or artistName and albumTitle' });
    }
    try {
      return await requests.request(
        { mbid, releaseMbid, artistName: artistName ?? '', albumTitle: albumTitle ?? '' },
        req.auth?.account.id,
        { askFirst: requestsWaitForApproval(req) },
      );
    } catch (err) {
      req.log.warn({ err, mbid, artistName, albumTitle }, 'album request failed');
      return fail(reply, err);
    }
  });

  // The account has looked at Requests: what arrived or was declined is no longer news (the badge on Requests).
  app.post<{ Body: RequestsSeen | undefined }>('/api/requests/seen', async (req, reply) => {
    const mbids: unknown = req.body?.mbids;
    if (mbids !== undefined && (!Array.isArray(mbids) || mbids.length > 1000 || mbids.some((m) => typeof m !== 'string'))) {
      return reply.code(400).send({ error: 'mbids is a list of MusicBrainz ids' });
    }
    requests.markSeen(accountId(req), mbids as string[] | undefined);
    return reply.code(204).send();
  });

  // An admin's answer to a request waiting for approval: yes sends it to Lidarr, no tells whoever asked.
  app.post<{ Params: { mbid: string } }>('/api/requests/:mbid/approve', { onRequest: requireAdmin }, async (req, reply) => {
    try {
      return await requests.approve(req.params.mbid, viewer(req));
    } catch (err) {
      req.log.warn({ err, mbid: req.params.mbid }, 'approving a request failed');
      return fail(reply, err);
    }
  });

  app.post<{ Params: { mbid: string } }>('/api/requests/:mbid/decline', { onRequest: requireAdmin }, async (req, reply) => {
    try {
      return await requests.decline(req.params.mbid, viewer(req));
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Off the asker's list (an admin's: off everyone's). Whether there was one to take off, the answer is the same.
  app.delete<{ Params: { mbid: string } }>('/api/requests/:mbid', { onRequest: requireCanRequest }, async (req, reply) => {
    await requests.remove(req.params.mbid, viewer(req));
    return reply.code(204).send();
  });
}
