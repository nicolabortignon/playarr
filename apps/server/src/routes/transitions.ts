import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { parseRange } from '@playarr/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { libraryOf, sourcesOf } from '../accounts/rights.ts';
import type { Library } from '../library/library.ts';
import type { TransitionAnswer, Transitions } from '../transitions/transitions.ts';
import { pcmLengthFrom } from '../catalog/tags.ts';
import { STREAM_KBPS, type EncodedStreams, type StreamKbps } from '../media/encoded.ts';
import type { MediaSource } from '../media/index.ts';
import { STREAM_RATE } from '../media/mp4.ts';
import { sendEncoded } from './encodedResponse.ts';

/** Bumped when a transition's encoded bytes would change for the same file and arguments: new ETags. */
const ENCODED_VERSION = 1;

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
  deps: {
    transitions?: Pick<Transitions, 'request' | 'filePath'> & Partial<Pick<Transitions, 'recordingsOf'>>;
    /** The library, narrowed to each account's sources for planning and serving. */
    library?: Pick<Library, 'track' | 'trackByRecording'> & Partial<Pick<Library, 'view'>>;
    unavailableReason?: string;
    /** For transitions as AAC (`/transitions/:file/aac`): the encodes, and the source that reads the cache's files. */
    encoded?: EncodedStreams;
    media?: MediaSource;
    /** A file's exact length, from its header (tests stand in their own). */
    pcmLength?: typeof pcmLengthFrom;
  },
) {
  const { transitions } = deps;
  const pcmLength = deps.pcmLength ?? pcmLengthFrom;

  /** An account that hears only some sources hears a transition only when it may hear both its songs. */
  async function hearable(req: FastifyRequest, file: string): Promise<boolean> {
    if (sourcesOf(req) === null) return true;
    const pair = transitions?.recordingsOf?.(file);
    const view = pair && deps.library ? libraryOf(deps.library, req) : undefined;
    return !!view && !!pair && !!(await view.trackByRecording(pair[0])) && !!(await view.trackByRecording(pair[1]));
  }
  const unavailableReason = deps.unavailableReason ?? 'Mixed transitions need audio analysis';

  app.post('/api/transitions', async (req, reply): Promise<TransitionAnswer> => {
    const parsed = input.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    if (!transitions) return { status: 'unavailable', reason: unavailableReason };
    const { from, to, mode, position, fromFileId, toFileId, fade, albumQueue, levels } = parsed.data;
    // An account that hears only some sources plans from its own songs and files.
    const view = deps.library && sourcesOf(req) !== null ? libraryOf(deps.library, req) : undefined;
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
        ...(view ? { library: view } : {}),
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
      // Only when the account may hear both songs.
      if (!(await hearable(req, req.params.file))) return reply.code(404).send({ error: 'Unknown transition' });

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

  /**
   * A transition as the TV plays it (plan 9 §4): encoded like a song's stream (`/stream/:id/aac`), AAC at `kbps` in
   * fragmented MP4 from the file's sample `start` on, so one decoder plays song, transition and song, and a player
   * that starts it at A's AAC frame boundary joins it to the sample. The levels are already in the file.
   */
  app.route<{ Params: { file: string }; Querystring: { kbps?: string; start?: string } }>({
    method: ['GET', 'HEAD'],
    url: '/transitions/:file/aac',
    handler: async (req, reply) => {
      const kbps = Number(req.query.kbps ?? 256);
      if (!STREAM_KBPS.includes(kbps as StreamKbps)) return reply.code(400).send({ error: 'Invalid bitrate: 64, 128 or 256' });
      const start = Number(req.query.start ?? 0);
      if (!Number.isInteger(start) || start < 0) return reply.code(400).send({ error: 'Invalid start' });
      const { encoded, media } = deps;
      if (!encoded || !media?.encodedStream) return reply.code(404).send({ error: 'This server doesn’t encode transitions' });
      const path = transitions?.filePath(req.params.file);
      const info = path ? await media.stat(path).catch(() => undefined) : undefined;
      if (!path || !info) return reply.code(404).send({ error: 'Unknown transition' });
      if (!(await hearable(req, req.params.file))) return reply.code(404).send({ error: 'Unknown transition' });
      const header = await pcmLength(media, path, info.size).catch(() => null);
      if (!header?.frames || header.sampleRate !== STREAM_RATE) return reply.code(404).send({ error: 'This transition’s length can’t be read' });
      const length = header.frames;
      if (start >= length) return reply.code(400).send({ error: 'That’s past the transition’s end' });
      // The names are content keys: the same name is the same audio.
      const etag = `"t-aac${kbps}-${req.params.file}-${start.toString(36)}-${ENCODED_VERSION}"`;
      return sendEncoded(req, reply, {
        encoded,
        codec: 'aac',
        kbps: kbps as StreamKbps,
        length,
        start,
        seeksExactly: true,
        etag,
        key: `transition:${etag}`,
        encode: (input) => media.encodedStream!(path, { codec: 'aac', kbps, ...input, priority: 'normal' }),
        what: 'transition',
        path,
      });
    },
  });
}
