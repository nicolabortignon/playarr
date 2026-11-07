import type { Recommendations } from '@playarr/shared';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { account, actAs, asAccount, twoSources } from '../accounts/testAccess.ts';
import type { Recommendations as RecommendationService } from '../discover/recommendations.ts';
import { Favorites } from '../favorites.ts';
import { favoriteRoutes } from './favorites.ts';

/** Account 1 hears every source; 2 only the Creative Commons folder. */
async function setup(forFavorites: RecommendationService['forFavorites']) {
  const lib = await twoSources();
  const app = Fastify();
  actAs(app, [account(1, { role: 'admin' }), account(2, { sources: [lib.cc] })]);
  favoriteRoutes(app, { favorites: new Favorites(lib.db), library: lib.library, recommendations: { forFavorites } });
  return { app, library: lib.library, cc: lib.cc };
}

describe('Songs like these under Favorites', () => {
  it('starts from the asking account’s favorites, in the library it may hear, with the variant asked for', async () => {
    const answer: Recommendations = { owned: [], missing: [], seedCount: 4 };
    const forFavorites = vi.fn<RecommendationService['forFavorites']>(async () => answer);
    const { app, library, cc } = await setup(forFavorites);

    const res = await app.inject({ url: '/api/favorites/recommendations?variant=3', headers: asAccount(2) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(answer);
    const [viewer, variant, signal] = forFavorites.mock.calls[0]!;
    expect(viewer.account).toBe(2);
    expect(viewer.library).toBe(library.view([cc]));
    expect(variant).toBe(3);
    expect(signal).toBeInstanceOf(AbortSignal);

    await app.inject({ url: '/api/favorites/recommendations', headers: asAccount(1) });
    const [everything, first] = forFavorites.mock.calls[1]!;
    expect(everything).toMatchObject({ account: 1, library });
    expect(first).toBe(0);
  });

  it('answers 502 with the reason when ListenBrainz can’t be reached', async () => {
    const { app } = await setup(async () => {
      throw new Error('ListenBrainz is unavailable: ListenBrainz HTTP 503');
    });
    const res = await app.inject({ url: '/api/favorites/recommendations', headers: asAccount(1) });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'ListenBrainz is unavailable: ListenBrainz HTTP 503' });
  });
});
