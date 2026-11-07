import Fastify, { LogController } from 'fastify';
import { describe, expect, it } from 'vitest';
import { account, actAs, asAccount } from './accounts/testAccess.ts';
import { logRequests, requestIdOptions, routeOf } from './requestLog.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Line = Record<string, unknown> & { msg: string; level: number; reqId?: string };

/**
 * An app logging as index.ts sets it up (request ids, the request log, Fastify's own request lines off as without
 * LOG_REQUESTS), its log lines kept, with a route for each kind of answer.
 */
function setup() {
  const lines: Line[] = [];
  const app = Fastify({
    ...requestIdOptions,
    logger: { level: 'info', stream: { write: (line: string) => void lines.push(JSON.parse(line) as Line) } },
    logController: new LogController({ disableRequestLogging: true }),
  });
  const requestLog = logRequests(app);
  actAs(app, [account(2)]);
  // Turned away before the route runs, as the auth hook does.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/locked')) return reply.code(401).send({ error: 'Sign in to Playarr' });
  });
  app.get('/api/albums/:id', (_req, reply) => reply.code(404).send({ error: 'Album not found' }));
  app.post('/api/auth/sign-in', (_req, reply) => reply.code(400).send({ error: 'Wrong password for teardrop' }));
  app.get('/api/broken', () => {
    throw new Error('the database is locked');
  });
  app.get('/api/fine', () => ({ ok: true }));
  app.get('/api/moved', (_req, reply) => reply.redirect('/api/fine'));
  app.get('/api/locked', () => ({ ok: true }));
  /** The lines the request log wrote about answers. */
  const answered = () => lines.filter((l) => typeof l.statusCode === 'number' && typeof l.route === 'string');
  return { app, lines, answered, counts: requestLog.counts };
}

describe('the request log', () => {
  it('logs a 4xx with its request id, the account and the route, and nothing of the URL, query, body or token', async () => {
    const { app, lines, answered } = setup();
    const res = await app.inject({ url: '/api/albums/98765?q=Teardrop', headers: asAccount(2) });
    expect(res.statusCode).toBe(404);
    expect(answered()).toEqual([
      expect.objectContaining({
        level: 30,
        msg: 'GET /api/albums/:id answered 404',
        reqId: res.headers['x-request-id'],
        method: 'GET',
        route: '/api/albums/:id',
        statusCode: 404,
        account: 2,
        responseTime: expect.any(Number),
      }),
    ]);
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      headers: { authorization: 'Bearer tok-secret-123', cookie: 'playarr_session=cookie-secret-456' },
      payload: { username: 'sam', password: 'hunter2' },
    });
    expect(signIn.statusCode).toBe(400);
    expect(answered()[1]).toMatchObject({ method: 'POST', route: '/api/auth/sign-in', statusCode: 400 });
    // Nobody was signed in: no account.
    expect(answered()[1]).not.toHaveProperty('account');
    const all = JSON.stringify(lines);
    for (const secret of ['98765', 'Teardrop', 'teardrop', 'hunter2', 'tok-secret-123', 'cookie-secret-456', 'sam']) expect(all).not.toContain(secret);
  });

  it('logs a 5xx at error, with the error and its stack', async () => {
    const { app, answered } = setup();
    const res = await app.inject({ url: '/api/broken', headers: asAccount(2) });
    expect(res.statusCode).toBe(500);
    const [line] = answered();
    expect(line).toMatchObject({ level: 50, route: '/api/broken', statusCode: 500, account: 2, reqId: res.headers['x-request-id'] });
    expect(line!.err).toMatchObject({ type: 'Error', message: 'the database is locked', stack: expect.stringContaining('requestLog.test.ts') });
  });

  it('leaves answers that went well out, and counts every answer by its status class', async () => {
    const { app, answered, counts } = setup();
    expect(counts()).toEqual({ status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0 });
    for (const url of ['/api/fine', '/api/fine', '/api/moved', '/api/albums/1', '/api/locked', '/api/broken']) await app.inject({ url });
    expect(counts()).toEqual({ status2xx: 2, status3xx: 1, status4xx: 2, status5xx: 1 });
    expect(answered().map((l) => [l.route, l.statusCode])).toEqual([
      ['/api/albums/:id', 404],
      ['/api/locked', 401],
      ['/api/broken', 500],
    ]);
  });

  it('logs answers given before any route runs, and requests that match no route, by their first segment', async () => {
    const { app, answered } = setup();
    const locked = await app.inject({ url: '/api/locked?token=abc' });
    expect(locked.statusCode).toBe(401);
    expect(locked.headers['x-request-id']).toMatch(UUID);
    const missing = await app.inject({ url: '/api/nothing/12?q=x' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['x-request-id']).toMatch(UUID);
    expect(answered()).toEqual([
      expect.objectContaining({ route: '/api/locked', statusCode: 401, reqId: locked.headers['x-request-id'] }),
      expect.objectContaining({ route: '/api/*', statusCode: 404, reqId: missing.headers['x-request-id'] }),
    ]);
  });
});

describe('request ids', () => {
  it('takes the client’s x-request-id when it’s a sane token, and answers with it', async () => {
    const { app, answered } = setup();
    const id = 'ios-1A2b.3_c';
    const res = await app.inject({ url: '/api/albums/1', headers: { 'x-request-id': id } });
    expect(res.headers['x-request-id']).toBe(id);
    expect(answered()[0]).toMatchObject({ reqId: id });
    const longest = 'a'.repeat(64);
    expect((await app.inject({ url: '/api/fine', headers: { 'x-request-id': longest } })).headers['x-request-id']).toBe(longest);
  });

  it('makes its own for one that isn’t, and for a request without one', async () => {
    const { app, lines } = setup();
    const ids = new Set<string>();
    for (const given of ['a'.repeat(65), 'two words', 'line\nforged', 'café', 'a,b', '', undefined]) {
      const res = await app.inject({ url: '/api/albums/1', headers: given === undefined ? {} : { 'x-request-id': given } });
      const id = String(res.headers['x-request-id']);
      expect(id).toMatch(UUID);
      ids.add(id);
    }
    expect(ids.size).toBe(7);
    expect(JSON.stringify(lines)).not.toContain('forged');
  });

  it('answers every request with its id, those that went well too', async () => {
    const { app } = setup();
    const res = await app.inject({ url: '/api/fine' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toMatch(UUID);
  });
});

describe('routeOf', () => {
  const unmatched = (url: string) => routeOf({ url, routeOptions: { url: undefined } } as unknown as Parameters<typeof routeOf>[0]);

  it('names a request that matched no route by its first segment only', () => {
    expect(unmatched('/api/nothing/12?q=Teardrop')).toBe('/api/*');
    expect(unmatched('/assets/Queue-old.js')).toBe('/assets/*');
    expect(unmatched('/wp-login.php?user=x')).toBe('/wp-login.php');
    expect(unmatched('/')).toBe('/');
    expect(unmatched('/%E2%9C%93/x')).toBe('/*');
  });
});
