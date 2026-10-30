import type { MusicBrainzStatus } from '@playarr/shared';
import type { FastifyInstance } from 'fastify';
import type { MusicBrainz } from '../discover/musicbrainz.ts';

/** How busy MusicBrainz is, so the app can explain slow lookups instead of just spinning. */
export function statusRoutes(app: FastifyInstance, deps: { musicbrainz: Pick<MusicBrainz, 'status'>; matching: () => number }) {
  app.get('/api/musicbrainz/status', (): MusicBrainzStatus => ({ ...deps.musicbrainz.status(), matching: deps.matching() }));
}
