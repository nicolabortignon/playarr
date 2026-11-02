import type { CuePoints, MixMap } from '@playarr/mix';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Analyzer } from '../analysis/analyzer.ts';
import type { Library } from '../library/library.ts';
import { RECORDING_ID } from './recordingId.ts';
import { requireLocal } from './settings.ts';

const input = z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(50) });
const analyzeInput = z.object({ again: z.boolean().optional() });
/** null: back to the detected point; left out: kept as it is. */
const cueInput = z.object({ mixIn: z.number().min(0).nullable().optional(), mixOut: z.number().min(0).nullable().optional() });

/**
 * Mix maps (beat grid, key, intro and outro) for the transition view and the desktop's live mixer,
 * and the mix points set by hand in Edit mix points. Cue points are kept by recording, so they stay
 * with the song when its file is matched again.
 */
export function mixMapRoutes(
  app: FastifyInstance,
  deps: {
    analyzer: Pick<Analyzer, 'canAnalyzeAudio' | 'mixMaps' | 'cues' | 'setCues' | 'ensure' | 'mixMapProgress' | 'analyzeLibrary' | 'reanalyzeLibrary'>;
    library: Pick<Library, 'trackByRecording'>;
    /** A song's cue points changed: its cached transitions are out of date (the transition service's forget). */
    onCuesChanged?: (recordingId: string) => Promise<void>;
    /**
     * Whether the whole library is analysed in the background (Settings → Mixes → analyse the
     * library); otherwise songs are only analysed as they're needed (played, queued, opened).
     */
    libraryScan?: () => boolean;
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
    // Songs not measured yet, or only by an older version (their map still serves meanwhile), are
    // measured in the background, so they mix better from a later play: ahead of the library's
    // backlog, since these are in someone's queue now. Songs already done are left as they are.
    analyzer.ensure(ids, { audio: true, urgent: true });
    return out;
  });

  // Settings → Playback: how many songs are ready for DJ mix, polled while work remains.
  app.get('/api/mix-maps/progress', () => {
    const libraryScan = deps.libraryScan?.() ?? false;
    // Nothing is analysed without audio analysis: no counts to make.
    if (!analyzer.canAnalyzeAudio) return { enabled: false, songs: 0, ready: 0, beatModel: 0, failed: 0, waiting: 0, working: 0, libraryScan };
    return { enabled: true, ...analyzer.mixMapProgress(), libraryScan };
  });

  // Settings → Playback → Analyse all songs now: the library's backlog queued once, like the
  // Settings → Mixes switch does when turned on (and from the home network, like that setting),
  // without turning that switch on. Pressed twice, the songs already waiting aren't queued again.
  // With `again`, Analyse all again: every song's mix map is made anew, ready ones included.
  app.post('/api/mix-maps/analyze', { onRequest: requireLocal }, async (req, reply) => {
    if (!analyzer.canAnalyzeAudio) return reply.code(409).send({ error: 'Audio analysis is off on this server (set ANALYSIS=on in its .env)' });
    const again = analyzeInput.safeParse(req.body ?? {}).data?.again === true;
    return { queued: await (again ? analyzer.reanalyzeLibrary() : analyzer.analyzeLibrary()) };
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
    const body = parsed.data;
    // A point left out stays as it was set: setting just the mix-out point mustn't lose the mix-in.
    const stored = analyzer.cues([id]).get(id) ?? {};
    const mixIn = body.mixIn === undefined ? (stored.mixIn ?? null) : body.mixIn;
    const mixOut = body.mixOut === undefined ? (stored.mixOut ?? null) : body.mixOut;
    // Only a new point needs checking: clearing one can't put the other out of place, and works
    // even for a song that has left the library.
    if (typeof body.mixIn === 'number' || typeof body.mixOut === 'number') {
      // The measured length where there's a map (the one the planner works with), else the library's.
      const map = analyzer.mixMaps([id]).get(id);
      const duration = map && map.duration > 0 ? map.duration : (await library.trackByRecording(id))?.duration;
      if (duration === undefined) return reply.code(404).send({ error: 'Song not found in the library' });
      if (!(duration > 0)) return reply.code(400).send({ error: 'The song’s length isn’t known yet, so mix points can’t be set' });
      for (const t of [mixIn, mixOut]) {
        if (t !== null && t > duration) return reply.code(400).send({ error: 'Mix points must be within the song' });
      }
      if (mixIn !== null && mixOut !== null && mixIn >= mixOut) {
        return reply.code(400).send({ error: 'The mix-in point must come before the mix-out point' });
      }
    }
    try {
      analyzer.setCues(id, { mixIn, mixOut });
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      return reply.code(400).send({ error: err.message });
    }
    // Saved either way: a stale transition is only unused, never played (its cache key holds the old points).
    await deps.onCuesChanged?.(id).catch((err: unknown) => req.log.warn({ err, recordingId: id }, 'forgetting transitions failed'));
    return analyzer.cues([id]).get(id) ?? {};
  });
}
