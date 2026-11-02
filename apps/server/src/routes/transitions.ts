import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { parseRange } from '@playarr/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TransitionAnswer, Transitions } from '../transitions/transitions.ts';

const input = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  mode: z.enum(['auto', 'party', 'off']),
  position: z.number().min(0).optional(),
  /** The files the player has for the songs (older players don't send them). */
  fromFileId: z.number().int().nonnegative().optional(),
  toFileId: z.number().int().nonnegative().optional(),
  /** The listener's fade length, for plain fades (older players don't send it). */
  fade: z.number().min(0).max(60).optional(),
  /** The queue plays the songs' album (older players don't say). */
  albumQueue: z.boolean().optional(),
  /** Even volume: the gains (dB) the player plays the two songs at. */
  levels: z.object({ a: z.number().min(-24).max(24), b: z.number().min(-24).max(24) }).optional(),
});

/**
 * Mixed transitions: the player asks for A→B while A plays (and asks again until it's ready), then
 * plays the rendered file between the two songs. Without the service (no audio analysis) every
 * answer is "unavailable" and the player crossfades as before.
 */
export function transitionRoutes(
  app: FastifyInstance,
  deps: { transitions?: Pick<Transitions, 'request' | 'filePath'>; unavailableReason?: string },
) {
  const { transitions } = deps;
  const unavailableReason = deps.unavailableReason ?? 'Mixed transitions need audio analysis';

  app.post('/api/transitions', async (req, reply): Promise<TransitionAnswer> => {
    const parsed = input.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    if (!transitions) return { status: 'unavailable', reason: unavailableReason };
    const { from, to, mode, position, fromFileId, toFileId, fade, albumQueue, levels } = parsed.data;
    try {
      return await transitions.request({
        fromTrackId: from,
        toTrackId: to,
        mode,
        ...(position !== undefined ? { aPosition: position } : {}),
        ...(fromFileId !== undefined ? { fromFileId } : {}),
        ...(toFileId !== undefined ? { toFileId } : {}),
        ...(fade !== undefined ? { fadeSeconds: fade } : {}),
        ...(albumQueue !== undefined ? { albumQueue } : {}),
        ...(levels ? { levels } : {}),
      });
    } catch (err) {
      // The player has a fallback for every answer but an error page: never make it guess.
      req.log.warn({ err, from, to }, 'transition request failed');
      // The detail (paths, the library's internals) stays in the log.
      return { status: 'unavailable', reason: 'The transition couldn’t be planned' };
    }
  });

  // No header rules here: <audio> can't send them, just like /stream/. The names are content keys
  // (a different plan or file makes a different name), so a browser may keep a file for good.
  app.route<{ Params: { file: string } }>({
    method: ['GET', 'HEAD'],
    url: '/transitions/:file',
    handler: async (req, reply) => {
      // The service decides which names exist (transitions and B's remainder), never a path from the client.
      const path = transitions?.filePath(req.params.file);
      const size = path ? await stat(path).then((info) => (info.isFile() ? info.size : undefined), () => undefined) : undefined;
      if (!path || size === undefined) return reply.code(404).send({ error: 'Unknown transition' });

      reply.header('Accept-Ranges', 'bytes');
      const range = parseRange(req.headers.range, size);
      // An error, not audio: nothing a browser should play or keep for a year.
      if (range === null) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      reply
        .header('Content-Type', path.endsWith('.wav') ? 'audio/wav' : 'audio/flac')
        .header('Cache-Control', 'private, max-age=31536000, immutable');
      if (range) reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      reply.header('Content-Length', range ? range.end - range.start + 1 : size);
      if (req.method === 'HEAD') return reply.send();

      const stream = createReadStream(path, range ?? {});
      // Stop reading as soon as the browser drops the connection (seek, skip).
      reply.raw.once('close', () => stream.destroy());
      return reply.send(stream);
    },
  });
}
