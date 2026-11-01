import type { TrackLevel } from '@playarr/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Analyzer } from '../analysis/analyzer.ts';
import type { Library } from '../library/library.ts';

/** Songs are turned down to about this loudness (gated RMS, dBFS); quieter songs are left as they are. */
export const TARGET_DB = -14;
/** Never turn a song down by more than this. */
const MAX_CUT_DB = -12;

const input = z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(50) });

/** The cut for a loudness: louder than the target comes down to it. */
export function cutFor(meanDb: number): number {
  return Math.round(Math.max(MAX_CUT_DB, Math.min(0, TARGET_DB - meanDb)) * 10) / 10;
}

/** The loudness of songs heard together: the average of their power, not of their decibels. */
export function combinedDb(levels: number[]): number {
  return 10 * Math.log10(levels.reduce((sum, db) => sum + 10 ** (db / 10), 0) / levels.length);
}

/**
 * Even volume: what to turn each song down by, from its measured loudness. Songs not measured yet are
 * measured in the background (with the rest of their album), so they're levelled from the next play.
 */
export function levelRoutes(app: FastifyInstance, deps: { analyzer: Pick<Analyzer, 'features' | 'ensure'>; library: Pick<Library, 'trackByRecording' | 'album'> }) {
  app.post('/api/levels', async (req, reply) => {
    const parsed = input.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    const out: Record<string, TrackLevel> = {};
    const measure: string[] = [];
    for (const id of new Set(parsed.data.ids)) {
      const track = await deps.library.trackByRecording(id);
      const album = track && (await deps.library.album(track.albumId));
      const albumIds = album?.tracks.map((t) => t.recordingId) ?? [id];
      const features = deps.analyzer.features([...new Set([id, ...albumIds])]);
      measure.push(id, ...albumIds);
      const own = features.get(id)?.raw.meanDb;
      if (own === undefined || own < -100) continue;
      const measured = albumIds.flatMap((r) => {
        const db = features.get(r)?.raw.meanDb;
        return db !== undefined && db > -100 ? [db] : [];
      });
      out[id] = { track: cutFor(own), ...(measured.length > 1 ? { album: cutFor(combinedDb(measured)) } : {}) };
    }
    deps.analyzer.ensure(measure, { audio: true });
    return out;
  });
}
