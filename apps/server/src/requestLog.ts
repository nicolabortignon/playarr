import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { ServerDiagnostics } from '@playarr/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** The header a request's id comes in (from a client that chose one) and goes back in, on every answer. */
export const REQUEST_ID_HEADER = 'x-request-id';
/** An id a client may choose: up to 64 letters, digits, dots, underscores and dashes. Anything else is replaced. */
const CLIENT_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Each request's id: the client's x-request-id when it's a sane token, so the client's log and the server's name a
 * request alike, otherwise a new one. Fastify's logger puts it on every line logged for the request (`reqId`).
 */
export function requestId(req: { headers: IncomingHttpHeaders }): string {
  const given = req.headers[REQUEST_ID_HEADER];
  return typeof given === 'string' && CLIENT_ID.test(given) ? given : randomUUID();
}

/** Fastify's options for request ids: `requestId` reads the header, Fastify doesn't take it as it is. */
export const requestIdOptions = { genReqId: requestId, requestIdHeader: false } as const;

/** The answers given since the server started, by status class. */
export type ResponseCounts = ServerDiagnostics['responses'];

/**
 * The route a request matched, as registered (`/api/albums/:id`), never the URL with its ids and query. For one that
 * matched none, its first segment: `/api/*`, `/assets/*`, `/wp-login.php`.
 */
export function routeOf(req: Pick<FastifyRequest, 'routeOptions' | 'url'>): string {
  const route = req.routeOptions.url;
  if (route !== undefined) return route;
  const path = req.url.split('?')[0]!;
  if (path === '/') return '/';
  const first = /^\/([A-Za-z0-9._-]{1,40})(\/)?/.exec(path);
  return first ? `/${first[1]}${first[2] ? '/*' : ''}` : '/*';
}

/**
 * Every answer carries its request's id (x-request-id). Every 4xx and 5xx is logged with that id, the account when
 * someone is signed in, the route as registered and how long it took: 4xx at info, as Fastify logs client errors (a
 * coverless album's art is a 404 each time it shows), 5xx at error, with the error and its stack when there was one.
 * Nothing the request carried is logged: no URL, query, body, header or token. And the answers are counted by status
 * class, for GET /api/diagnostics.
 */
export function logRequests(app: FastifyInstance): { counts: () => ResponseCounts } {
  const counts: ResponseCounts = { status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0 };
  // The error behind a 5xx, from the route or a hook, until its answer is logged.
  const errors = new WeakMap<FastifyRequest, Error>();
  app.addHook('onError', async (req, _reply, error) => {
    errors.set(req, error);
  });
  // onSend, whichever hooks were added first: it sees the answers a hook gives before any route runs (sign in first)
  // and those cut short (a player seeking drops a stream mid-song), which onResponse doesn't.
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header(REQUEST_ID_HEADER, req.id);
    const status = reply.statusCode;
    const kind = status >= 500 ? 'status5xx' : status >= 400 ? 'status4xx' : status >= 300 ? 'status3xx' : status >= 200 ? 'status2xx' : undefined;
    if (kind) counts[kind] += 1;
    if (status < 400) return payload;
    const route = routeOf(req);
    const account = req.auth && !req.auth.setup ? req.auth.account.id : undefined;
    const line = { method: req.method, route, statusCode: status, responseTime: Math.round(reply.elapsedTime), ...(account !== undefined ? { account } : {}) };
    const message = `${req.method} ${route} answered ${status}`;
    if (status < 500) {
      req.log.info(line, message);
    } else {
      const err = errors.get(req);
      req.log.error(err ? { ...line, err } : line, message);
    }
    return payload;
  });
  return { counts: () => ({ ...counts }) };
}
