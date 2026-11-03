import type { ServerInfo } from '@playarr/shared';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { CatalogStore } from '../catalog/store.ts';
import { VERSION } from '../version.ts';

/** The oldest iOS app this server works with: raised when an API change would break older apps. */
export const MIN_APP_VERSION = '1.0.0';
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
    setup,
    // Only while nobody has a password: afterwards usernames aren't anyone's business before signing in.
    ...(setup ? { ownerUsername: deps.ownerUsername() } : {}),
    ...(deps.publicUrl ? { publicUrl: deps.publicUrl } : {}),
  };
}

/** Open to anyone: how an app recognises a server before signing in. */
export function serverRoutes(app: FastifyInstance, deps: { info: () => ServerInfo }) {
  app.get('/api/server', (): ServerInfo => deps.info());
}
