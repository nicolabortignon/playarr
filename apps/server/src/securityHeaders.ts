import type { FastifyInstance } from 'fastify';

/**
 * Sent with every answer. `nosniff`: a browser takes an answer's content type as given rather than guessing, so a song,
 * a picture or an error never runs as a script. `frame-ancestors 'self'`: only Playarr's own pages may show it in a
 * frame, so another site can't lay it under a page of its own to trick a click; it does what X-Frame-Options did, in
 * every browser Playarr runs in. Only that directive for now: a full Content-Security-Policy waits until it can be
 * checked in a browser, since a wrong one blanks the app.
 */
export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "frame-ancestors 'self'",
} as const;

/**
 * Puts SECURITY_HEADERS on every answer: the web app's files, the API, streams (ranges too), art and transitions,
 * and the answers turned away before a route runs (sign in first, not found). A route that sets one of them itself
 * keeps its own.
 */
export function securityHeaders(app: FastifyInstance) {
  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!reply.hasHeader(name)) reply.header(name, value);
    return payload;
  });
}
