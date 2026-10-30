import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { statusRoutes } from './status.ts';

describe('status routes', () => {
  it('reports the MusicBrainz queue and matching progress', async () => {
    const app = Fastify();
    statusRoutes(app, { musicbrainz: { status: () => ({ queued: 4, background: 3, etaSeconds: 5 }) }, matching: () => 12 });
    const res = await app.inject({ method: 'GET', url: '/api/musicbrainz/status' });
    expect(res.json()).toEqual({ queued: 4, background: 3, etaSeconds: 5, matching: 12 });
  });
});
