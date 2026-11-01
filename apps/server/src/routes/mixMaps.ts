import type { CuePoints, MixMap } from '@playarr/mix';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Analyzer } from '../analysis/analyzer.ts';
import type { Library } from '../library/library.ts';

const RECORDING_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|track:\d+)$/i;

const input = z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(50) });
/** null or left out: back to the detected point. */
const cueInput = z.object({ mixIn: z.number().min(0).nullable().optional(), mixOut: z.number().min(0).nullable().optional() });

/**
 * Mix maps (beat grid, key, intro and outro) for the transition view and the desktop's live mixer,
 * and the mix points set by hand in Edit mix points. Cue points are kept by recording, so they stay
 * with the song when its file is matched again.
 */
export function mixMapRoutes(
  app: FastifyInstance,
  deps: {
    analyzer: Pick<Analyzer, 'canAnalyzeAudio' | 'mixMaps' | 'cues' | 'setCues' | 'ensure'>;
    library: Pick<Library, 'trackByRecording'>;
    /** A song's cue points changed: its cached transitions are out of date (the transition service's forget). */
    onCuesChanged?: (recordingId: string) => Promise<void>;
  },
) {
  const { analyzer, library } = deps;

  app.post('/api/mix-maps', async (req, reply) => {
    const parsed = input.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    // Without audio analysis there are no maps to make, and no mixed transitions to use them.
    if (!analyzer.canAnalyzeAudio) return {};
    const ids = [...new Set(parsed.data.ids)];
    const maps = analyzer.mixMaps(ids);
    const cues = analyzer.cues(ids);
    const out: Record<string, MixMap & { cues?: CuePoints }> = {};
    for (const [id, map] of maps) {
      const own = cues.get(id);
      out[id] = own ? { ...map, cues: own } : map;
    }
    // Songs not measured yet are measured in the background, so they mix from a later play.
    const missing = ids.filter((id) => !maps.has(id));
    if (missing.length) analyzer.ensure(missing, { audio: true });
    return out;
  });

  app.get<{ Params: { id: string } }>('/api/recordings/:id/cues', async (req, reply) => {
    if (!RECORDING_ID.test(req.params.id)) return reply.code(400).send({ error: 'Invalid recording id' });
    return analyzer.cues([req.params.id]).get(req.params.id) ?? {};
  });

  app.put<{ Params: { id: string } }>('/api/recordings/:id/cues', async (req, reply) => {
    const { id } = req.params;
    if (!RECORDING_ID.test(id)) return reply.code(400).send({ error: 'Invalid recording id' });
    const parsed = cueInput.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid cue points' });
    const { mixIn, mixOut } = parsed.data;
    if (typeof mixIn === 'number' || typeof mixOut === 'number') {
      // The measured length where there's a map (the one the planner works with), else the library's.
      const map = analyzer.mixMaps([id]).get(id);
      const duration = map && map.duration > 0 ? map.duration : (await library.trackByRecording(id))?.duration;
      if (duration === undefined) return reply.code(404).send({ error: 'Song not found in the library' });
      for (const t of [mixIn, mixOut]) {
        if (typeof t === 'number' && duration > 0 && t > duration) return reply.code(400).send({ error: 'Mix points must be within the song' });
      }
      if (typeof mixIn === 'number' && typeof mixOut === 'number' && mixIn >= mixOut) {
        return reply.code(400).send({ error: 'The mix-in point must come before the mix-out point' });
      }
    }
    analyzer.setCues(id, { mixIn, mixOut });
    // Saved either way: a stale transition is only unused, never played (its cache key holds the old points).
    await deps.onCuesChanged?.(id).catch((err: unknown) => req.log.warn({ err, recordingId: id }, 'forgetting transitions failed'));
    return analyzer.cues([id]).get(id) ?? {};
  });
}
