import type { ServerInfo } from '@playarr/shared';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { CatalogStore } from '../catalog/store.ts';
import { REACHABLE_PATH, type Reachability } from '../reachability/reachability.ts';
import { VERSION } from '../version.ts';

/** The oldest iOS app this server works with: raised when an API change would break older apps. */
export const MIN_APP_VERSION = '1.0.0';
/** The oldest TV app this server works with (plan 9), raised by the same rule (docs/ios/release.md). */
export const MIN_TV_VERSION = '1.0.0';
const SERVER_ID_KEY = 'server.id';

/** This server's id: made once and kept, so apps know it under any address. */
export function serverId(store: Pick<CatalogStore, 'appSetting' | 'setAppSetting'>): string {
  let id = store.appSetting(SERVER_ID_KEY);
  if (!id) {
    id = randomUUID();
    store.setAppSetting(SERVER_ID_KEY, id);
  }
  return id;
}

/** Which server this is (GET /api/server, and what Bonjour advertises). */
export function serverInfo(deps: {
  store: Pick<CatalogStore, 'appSetting' | 'setAppSetting'>;
  name: string | undefined;
  setupMode: () => boolean;
  /** The owner's current username (account 1's, from its profile), for the setup page to pre-fill. */
  ownerUsername: () => string;
  /** PUBLIC_URL: the address clients should use, whoever reached the server how. */
  publicUrl?: string;
}): ServerInfo {
  const setup = deps.setupMode();
  return {
    id: serverId(deps.store),
    name: deps.name?.trim() || hostname(),
    version: VERSION,
    minAppVersion: MIN_APP_VERSION,
    minTvVersion: MIN_TV_VERSION,
    setup,
    // Only while nobody has a password: afterwards usernames aren't anyone's business before signing in.
    ...(setup ? { ownerUsername: deps.ownerUsername() } : {}),
    ...(deps.publicUrl ? { publicUrl: deps.publicUrl } : {}),
  };
}

/**
 * Open to anyone: how an app recognizes a server before signing in, and how the server recognizes itself at its
 * public address (Settings → Away from home).
 */
export function serverRoutes(app: FastifyInstance, deps: { info: () => ServerInfo; reachability?: Pick<Reachability, 'answer' | 'allows'> }) {
  app.get('/api/server', (): ServerInfo => deps.info());

  // The reachability check's own request, through the proxy, without a session: the answer to a token this server
  // made for a check that's running, once. Anything else is a plain 404, the same for a token never made, already
  // answered or expired, so it tells nobody anything; and at most 30 a minute per visitor.
  const { reachability } = deps;
  if (reachability) {
    app.get<{ Params: { token: string } }>(`${REACHABLE_PATH}/:token`, (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (!reachability.allows(req.ip)) return reply.code(429).send({ error: 'Too many requests' });
      const answer = reachability.answer(req.params.token);
      return answer ? { answer } : reply.code(404).send({ error: 'Not found' });
    });
  }
}
