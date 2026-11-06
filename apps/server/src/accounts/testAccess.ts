import type { Account } from '@playarr/shared';
import type { FastifyInstance } from 'fastify';
import { CatalogStore } from '../catalog/store.ts';
import { creativeCommons, freshDb, mezzanine } from '../catalog/testFixtures.ts';
import { Library, type CoverColorSource } from '../library/library.ts';

/** Tests: requests on an app set up with actAs act as the account whose id this header names. */
export const TEST_ACCOUNT_HEADER = 'x-test-account';

/** A signed-in account for tests: a member who may hear every source, unless `patch` says otherwise. */
export function account(id: number, patch: Partial<Account> = {}): Account {
  return { id, username: `user${id}`, name: `User ${id}`, role: 'member', canRequest: false, sources: null, hasPassword: true, ...patch };
}

/**
 * Stand in for the auth hook: a request with the test header acts as that account (with a Bearer
 * session), one without is unsigned (req.auth null), as on a server whose owner has set a password.
 */
export function actAs(app: FastifyInstance, accounts: Account[]) {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    const found = accounts.find((a) => a.id === Number(req.headers[TEST_ACCOUNT_HEADER]));
    req.auth = found ? { setup: false, account: found, session: { id: found.id, via: 'bearer' } } : null;
  });
}

/** Headers for a request as this account (with Playarr's own header, for changes). */
export const asAccount = (id: number) => ({ [TEST_ACCOUNT_HEADER]: String(id), 'x-playarr': '1' });

/**
 * A library of two sources: Lidarr with Mezzanine (album 70, songs 700 and 701, files 9000 and 9001,
 * cover /art/album/70/cover) and a folder of Creative Commons music (album 80, one song, CC_REC, file 9100,
 * cover /art/copy/9100), with the cover colors of `colors` if given.
 */
export async function twoSources(colors?: CoverColorSource) {
  const db = freshDb();
  const store = new CatalogStore(db);
  const lidarr = store.addSource('lidarr', 'Lidarr');
  const cc = store.addSource('folder', 'Creative Commons');
  const mezz = mezzanine();
  const withCover = { ...mezz, albums: mezz.albums.map((a) => ({ ...a, coverUrl: '/art/album/70/cover' })) };
  const library = new Library(
    store,
    () => [
      { id: lidarr, source: { kind: 'lidarr', sync: async () => withCover } },
      { id: cc, source: { kind: 'folder', sync: async () => creativeCommons() } },
    ],
    { info: () => {}, error: () => {} },
    colors,
  );
  await library.refresh();
  return { db, store, library, lidarr, cc };
}
