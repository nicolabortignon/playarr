import { parseRange } from '@playarr/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Analyzer } from '../analysis/analyzer.ts';
import { LOUDNESS_RATE } from '../analysis/loudness.ts';
import { FileAccessError, type FileResolver } from '../catalog/files.ts';
import type { FileRecord } from '../catalog/build.ts';
import type { Library } from '../library/library.ts';
import { mimeForPath } from '../library/format.ts';
import { MediaUnavailableError, type MediaSource } from '../media/index.ts';
import { seeksInexactly } from '../media/source.ts';
import { WAV_HEADER_BYTES, wavRange } from '../media/levelled.ts';

/** The most a levelled stream turns a song up or down (dB): the levels route never asks for more. */
const MAX_GAIN_DB = 20;

export function streamRoutes(
  app: FastifyInstance,
  deps: { library: Library; files: FileResolver; loudness?: Pick<Analyzer, 'loudnessOfFile' | 'remeasureLoudness'> },
) {
  const { library } = deps;

  /** The library file asked for, where it lives, and its size and time; or the error already sent. */
  async function open(req: FastifyRequest<{ Params: { fileId: string } }>, reply: FastifyReply) {
    const fileId = Number(req.params.fileId);
    // Only serve files Lidarr knows about: the client never supplies a path.
    const file = Number.isInteger(fileId) ? await library.file(fileId) : undefined;
    if (!file) return void reply.code(404).send({ error: 'Unknown track file' });

    // Defense in depth: never read outside the source's folder or the configured roots.
    let media: MediaSource;
    let path: string;
    try {
      ({ media, path } = deps.files.resolve(file));
    } catch (err) {
      if (!(err instanceof FileAccessError)) throw err;
      req.log.warn({ path: file.path }, err.message);
      return void reply.code(err.status).send({ error: err.message });
    }
    try {
      const { size, mtimeMs } = await media.stat(path);
      return { file, media, path, size, mtimeMs } as { file: FileRecord; media: MediaSource; path: string; size: number; mtimeMs: number };
    } catch (err) {
      if (err instanceof MediaUnavailableError) return void reply.code(503).send({ error: err.message });
      req.log.warn({ err, path }, 'stat failed');
      return void reply.code(502).send({ error: `Cannot read audio file: ${(err as Error).message}` });
    }
  }

  app.route<{ Params: { fileId: string } }>({
    method: ['GET', 'HEAD'],
    url: '/stream/:fileId',
    handler: async (req, reply) => {
      const opened = await open(req, reply);
      if (!opened) return reply;
      const { media, path, size, mtimeMs } = opened;

      const etag = `"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`;
      reply
        .header('Accept-Ranges', 'bytes')
        .header('Content-Type', mimeForPath(path))
        .header('ETag', etag)
        .header('Cache-Control', 'private, max-age=86400');

      if (req.headers['if-none-match'] === etag) return reply.code(304).send();

      const range = parseRange(req.headers.range, size);
      if (range === null) {
        return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      }
      if (range) {
        reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      }
      reply.header('Content-Length', range ? range.end - range.start + 1 : size);
      if (req.method === 'HEAD') return reply.send();

      const stream = await media.open(path, range);
      // Stop reading from disk/SSH as soon as the browser drops the connection (seek, skip).
      // (The response's close event: the request's fires once its body has been read.)
      reply.raw.once('close', () => stream.destroy());
      return reply.send(stream);
    },
  });

  // Even volume: the song at its level, as a WAV file made as it's asked for (see media/levelled.ts).
  // Only for songs whose loudness was measured from this very file: that gives the file's length.
  app.route<{ Params: { fileId: string }; Querystring: { gain?: string } }>({
    method: ['GET', 'HEAD'],
    url: '/stream/:fileId/levelled.wav',
    handler: async (req, reply) => {
      const gain = Number(req.query.gain ?? 0);
      if (!Number.isFinite(gain) || Math.abs(gain) > MAX_GAIN_DB) return reply.code(400).send({ error: 'Invalid gain' });
      const measured = deps.loudness?.loudnessOfFile(Number(req.params.fileId));
      if (!measured?.samples) return reply.code(404).send({ error: 'This song’s loudness isn’t measured yet' });
      const opened = await open(req, reply);
      if (!opened) return reply;
      const { file, media, path, size, mtimeMs } = opened;
      // The file changed since it was measured: its length may have too. Measured again; until then, its own file.
      if (size !== measured.size || mtimeMs !== measured.mtimeMs) {
        deps.loudness!.remeasureLoudness(measured.recordingId);
        return reply.code(404).send({ error: 'This song changed: its loudness is being measured again' });
      }
      const decode = media.pcmStream?.bind(media);
      if (!decode) return reply.code(404).send({ error: 'This source can’t level songs' });

      const total = WAV_HEADER_BYTES + measured.samples * 4;
      const etag = `"lv-${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}-${gain}"`;
      reply.header('Accept-Ranges', 'bytes').header('Content-Type', 'audio/wav').header('ETag', etag).header('Cache-Control', 'private, max-age=86400');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      const range = parseRange(req.headers.range, total);
      if (range === null) return reply.code(416).header('Content-Range', `bytes */${total}`).send();
      if (range) reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${total}`);
      reply.header('Content-Length', range ? range.end - range.start + 1 : total);
      if (req.method === 'HEAD') return reply.send();

      // From the sample asked for: exactly (by decoding from the start) where a seek would only land near it.
      const exactSeek = seeksInexactly(file.format);
      const stream = wavRange({
        frames: measured.samples,
        start: range?.start ?? 0,
        end: range?.end ?? total - 1,
        decode: (from, count) =>
          decode(path, {
            sampleRate: LOUDNESS_RATE,
            channels: 2,
            gainDb: gain,
            priority: 'normal',
            maxSeconds: count / LOUDNESS_RATE + 1,
            ...(from > 0 ? { startSeconds: from / LOUDNESS_RATE, ...(exactSeek ? { exactSeek } : {}) } : {}),
          }),
      });
      // Stop decoding as soon as the player drops the connection (seek, skip).
      reply.raw.once('close', () => stream.destroy());
      return reply.send(stream);
    },
  });
}
