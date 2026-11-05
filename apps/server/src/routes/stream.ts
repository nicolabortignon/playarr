import { parseRange, wavFallbackOf } from '@playarr/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import type { Analyzer } from '../analysis/analyzer.ts';
import { LOUDNESS_RATE } from '../analysis/loudness.ts';
import { FileAccessError, type FileResolver } from '../catalog/files.ts';
import type { FileRecord } from '../catalog/build.ts';
import { pcmLengthFrom } from '../catalog/tags.ts';
import type { Library } from '../library/library.ts';
import { libraryOf } from '../accounts/rights.ts';
import { mimeForPath } from '../library/format.ts';
import { MediaUnavailableError, type MediaSource } from '../media/index.ts';
import { seeksInexactly } from '../media/source.ts';
import { bytesPerFrame, LEVELLED, WAV_HEADER_BYTES, wavRange, type PcmShape } from '../media/levelled.ts';

/** The most a levelled stream turns a song up or down (dB): the levels route never asks for more. */
const MAX_GAIN_DB = 20;
/** Files whose exact length is remembered (see wavLength): a few hundred bytes each. */
const LENGTHS_KEPT = 2000;

export function streamRoutes(
  app: FastifyInstance,
  deps: {
    library: Pick<Library, 'file'> & Partial<Pick<Library, 'view'>>;
    files: FileResolver;
    loudness?: Pick<Analyzer, 'loudnessOfFile' | 'remeasureLoudness'>;
    /** A file's exact length and format, from its header (tests stand in their own). */
    pcmLength?: typeof pcmLengthFrom;
  },
) {
  const { library } = deps;
  const pcmLength = deps.pcmLength ?? pcmLengthFrom;
  const lengths = new Map<string, Awaited<ReturnType<typeof pcmLengthFrom>>>();

  /** A file's exact length, read from its header once per version of the file. */
  async function wavLength(media: MediaSource, path: string, size: number, mtimeMs: number) {
    const key = `${path}\0${size}\0${mtimeMs}`;
    if (!lengths.has(key)) {
      if (lengths.size >= LENGTHS_KEPT) lengths.delete(lengths.keys().next().value!);
      lengths.set(key, await pcmLength(media, path, size));
    }
    return lengths.get(key);
  }

  /**
   * A WAV file `frames` long, made as it's asked for (see media/levelled.ts): its length is known before a byte is
   * decoded, so a range from anywhere in it is decoded from that very sample, and a player seeks in it as in a file.
   */
  function sendWav(
    req: FastifyRequest,
    reply: FastifyReply,
    wav: { frames: number; shape: PcmShape; etag: string; decode: (from: number, count: number) => Readable },
  ) {
    const total = WAV_HEADER_BYTES + wav.frames * bytesPerFrame(wav.shape);
    reply.header('Accept-Ranges', 'bytes').header('Content-Type', 'audio/wav').header('ETag', wav.etag).header('Cache-Control', 'private, max-age=86400');
    if (req.headers['if-none-match'] === wav.etag) return reply.code(304).send();
    const range = parseRange(req.headers.range, total);
    if (range === null) return reply.code(416).header('Content-Range', `bytes */${total}`).send();
    if (range) reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${total}`);
    reply.header('Content-Length', range ? range.end - range.start + 1 : total);
    if (req.method === 'HEAD') return reply.send();
    const stream = wavRange({ frames: wav.frames, start: range?.start ?? 0, end: range?.end ?? total - 1, decode: wav.decode, shape: wav.shape });
    // Stop decoding as soon as the player drops the connection (seek, skip).
    reply.raw.once('close', () => stream.destroy());
    return reply.send(stream);
  }

  /** The library file asked for, where it lives, and its size and time; or the error already sent. */
  async function open(req: FastifyRequest<{ Params: { fileId: string } }>, reply: FastifyReply) {
    const fileId = Number(req.params.fileId);
    // Only files of songs the account may hear, as the catalog knows them: the client never supplies a path.
    const file = Number.isInteger(fileId) ? await libraryOf(library, req).file(fileId) : undefined;
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

  // Apple Lossless and AIFF for browsers that can't play them (Chrome, Firefox): the song as a WAV at its own rate
  // and depth, still lossless. Its own address, so a copy of the file kept on the device never stands in for it.
  app.route<{ Params: { fileId: string } }>({
    method: ['GET', 'HEAD'],
    url: '/stream/:fileId/lossless.wav',
    handler: async (req, reply) => {
      const opened = await open(req, reply);
      if (!opened) return reply;
      const { file, media, path, size, mtimeMs } = opened;
      const decode = media.pcmStream?.bind(media);
      if (!wavFallbackOf(file.format) || !decode) return reply.code(404).send({ error: 'This song plays as it is' });
      let length: Awaited<ReturnType<typeof wavLength>>;
      try {
        length = await wavLength(media, path, size, mtimeMs);
      } catch (err) {
        req.log.warn({ err, path }, 'could not read the length of a song to stream as WAV');
        return reply.code(502).send({ error: `Cannot read audio file: ${(err as Error).message}` });
      }
      if (!length) return reply.code(422).send({ error: 'This song’s length can’t be read' });
      const { frames, sampleRate } = length;
      const shape: PcmShape = { sampleRate, channels: length.channels === 1 ? 1 : 2, bits: length.bits > 16 ? 24 : 16 };
      const exactSeek = seeksInexactly(file.format);
      return sendWav(req, reply, {
        frames,
        shape,
        etag: `"wav-${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`,
        decode: (from, count) =>
          decode(path, {
            ...shape,
            priority: 'normal',
            maxSeconds: count / sampleRate + 1,
            ...(from > 0 ? { startSeconds: from / sampleRate, ...(exactSeek ? { exactSeek } : {}) } : {}),
          }),
      });
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

      // From the sample asked for: exactly (by decoding from the start) where a seek would only land near it.
      const exactSeek = seeksInexactly(file.format);
      return sendWav(req, reply, {
        frames: measured.samples,
        shape: LEVELLED,
        etag: `"lv-${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}-${gain}"`,
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
    },
  });
}
