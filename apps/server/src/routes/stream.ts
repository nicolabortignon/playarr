import { parseRange, wavFallbackOf } from '@playarr/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PassThrough, type Readable } from 'node:stream';
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
import { EncodeBusyError, encodeInput, STREAM_KBPS, streamLayout, type EncodedStreams, type EncodeJob, type StreamCodec, type StreamKbps } from '../media/encoded.ts';
import { STREAM_RATE } from '../media/mp4.ts';

/** The most a levelled stream turns a song up or down (dB): the levels route never asks for more. */
const MAX_GAIN_DB = 20;
/** Files whose exact length is remembered (see wavLength): a few hundred bytes each. */
const LENGTHS_KEPT = 2000;
/** Bumped when an encoded stream's bytes would change for the same song and arguments (its layout): new ETags. */
const ENCODED_VERSION = 1;
/** How long a request waits for an encode's first fragment before giving up on it. */
const FIRST_FRAGMENT_MS = 20_000;

export function streamRoutes(
  app: FastifyInstance,
  deps: {
    library: Pick<Library, 'file'> & Partial<Pick<Library, 'view'>>;
    files: FileResolver;
    loudness?: Pick<Analyzer, 'loudnessOfFile' | 'remeasureLoudness'>;
    /** A file's exact length and format, from its header (tests stand in their own). */
    pcmLength?: typeof pcmLengthFrom;
    /** The encodes behind the encoded streams (media/encoded.ts); without it they answer 404. */
    encoded?: EncodedStreams;
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

  /**
   * A song's length in samples at the encoded streams' rate: as loudness analysis counted it, when it measured
   * this very file, else from the file's header. Undefined when neither knows.
   */
  async function streamLength(opened: { file: FileRecord; media: MediaSource; path: string; size: number; mtimeMs: number }): Promise<number | undefined> {
    const measured = deps.loudness?.loudnessOfFile(opened.file.id);
    if (measured?.samples && measured.size === opened.size && measured.mtimeMs === opened.mtimeMs) return measured.samples;
    // Measured from an older version of the file: measured again, and its header says meanwhile.
    if (measured?.samples) deps.loudness!.remeasureLoudness(measured.recordingId);
    const length = await wavLength(opened.media, opened.path, opened.size, opened.mtimeMs);
    return length?.frames && length.sampleRate ? Math.round((length.frames * STREAM_RATE) / length.sampleRate) : undefined;
  }

  /**
   * Encoded streams (media/encoded.ts): the song as AAC or Opus in fragmented MP4, from the sample `start` on
   * (44.1 kHz; 0, its start, unless said), at `kbps` (128 or 256), and for the levelled ones at `gain` dB. A
   * file of a known length that answers byte ranges like any other: what isn't encoded yet is waited for.
   */
  function encodedRoute(codec: StreamCodec, levelled: boolean) {
    return async (req: FastifyRequest<{ Params: { fileId: string }; Querystring: { kbps?: string; start?: string; gain?: string } }>, reply: FastifyReply) => {
      const kbps = Number(req.query.kbps ?? 128);
      if (!STREAM_KBPS.includes(kbps as StreamKbps)) return reply.code(400).send({ error: 'Invalid bitrate: 128 or 256' });
      const start = Number(req.query.start ?? 0);
      if (!Number.isInteger(start) || start < 0) return reply.code(400).send({ error: 'Invalid start' });
      const gain = levelled ? Number(req.query.gain ?? 0) : 0;
      if (!Number.isFinite(gain) || Math.abs(gain) > MAX_GAIN_DB) return reply.code(400).send({ error: 'Invalid gain' });
      if (!deps.encoded) return reply.code(404).send({ error: 'This server doesn’t encode songs' });

      const opened = await open(req, reply);
      if (!opened) return reply;
      const { file, media, path, size, mtimeMs } = opened;
      const encode = media.encodedStream?.bind(media);
      if (!encode) return reply.code(404).send({ error: 'This source can’t encode songs' });
      let length: number | undefined;
      try {
        length = await streamLength(opened);
      } catch (err) {
        req.log.warn({ err, path }, 'could not read the length of a song to encode');
        return reply.code(502).send({ error: `Cannot read audio file: ${(err as Error).message}` });
      }
      if (!length) return reply.code(404).send({ error: 'This song’s length can’t be read: play its own file' });
      if (start >= length) return reply.code(400).send({ error: 'That’s past the song’s end' });

      const layout = streamLayout(codec, kbps as StreamKbps, length - start);
      const total = layout.total;
      // The song's length is in it: a length counted by analysis after one read from the header is another stream.
      const etag = `"${codec}${kbps}-${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}-${length.toString(36)}-${start.toString(36)}-${gain}-${ENCODED_VERSION}"`;
      // The stream's headers, on everything but an error (which is JSON).
      const streamHeaders = () => reply.header('Accept-Ranges', 'bytes').header('Content-Type', 'audio/mp4').header('ETag', etag).header('Cache-Control', 'private, max-age=86400');
      if (req.headers['if-none-match'] === etag) return streamHeaders().code(304).send();
      const range = parseRange(req.headers.range, total);
      if (range === null) return streamHeaders().code(416).header('Content-Range', `bytes */${total}`).send();
      const from = range?.start ?? 0;
      const to = range?.end ?? total - 1;
      if (req.method === 'HEAD') {
        streamHeaders();
        if (range) reply.code(206).header('Content-Range', `bytes ${from}-${to}/${total}`);
        return reply.header('Content-Length', to - from + 1).send();
      }

      // One encode per stream, whoever asks (an <audio> element's ranges, the device keeping it).
      const account = req.auth?.account?.id ?? null;
      let job: EncodeJob;
      try {
        job = deps.encoded.job(`${file.id}:${etag}`, account, layout, () =>
          encode(path, { codec, kbps, ...encodeInput(layout, start, !seeksInexactly(file.format)), ...(gain ? { gainDb: gain } : {}), priority: 'normal' }),
        );
      } catch (err) {
        if (!(err instanceof EncodeBusyError)) throw err;
        return reply.code(503).header('Retry-After', '5').send({ error: err.message });
      }
      job.attach();
      // The first fragment, or the encode's failure, before answering: a file that can't be encoded gets an error,
      // not a stream that stops. A range within the init segment (a player's first look) needs neither.
      if (to >= layout.init.length) {
        const ready = await Promise.race([job.started.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), FIRST_FRAGMENT_MS).unref())]);
        if (!ready || (job.state === 'failed' && job.produced === layout.init.length)) {
          job.detach();
          req.log.warn({ err: job.error, path }, 'a song couldn’t be encoded');
          return reply.code(502).send({ error: ready ? `This song couldn’t be encoded: ${job.error?.message ?? 'unknown error'}` : 'Encoding this song took too long' });
        }
      }
      streamHeaders();
      if (range) reply.code(206).header('Content-Range', `bytes ${from}-${to}/${total}`);
      reply.header('Content-Length', to - from + 1);
      const stop = new AbortController();
      const out = new PassThrough();
      // Stop reading as soon as the player drops the connection (seek, skip): the encode goes on only while someone reads.
      reply.raw.once('close', () => stop.abort());
      out.once('close', () => stop.abort());
      /** Until the response has room for more, or is gone. */
      const drained = () =>
        new Promise<void>((resolve) => {
          const done = () => {
            out.off('drain', done);
            out.off('close', done);
            resolve();
          };
          out.on('drain', done);
          out.on('close', done);
        });
      void (async () => {
        try {
          for await (const piece of job.read(from, to, stop.signal)) {
            if (out.destroyed) return;
            if (!out.write(piece)) await drained();
          }
          out.end();
        } catch (err) {
          if (!stop.signal.aborted) req.log.warn({ err, path }, 'an encoded stream broke off');
          out.destroy(err as Error);
        } finally {
          job.detach();
        }
      })();
      return reply.send(out);
    };
  }

  for (const codec of ['aac', 'opus'] as const) {
    app.route({ method: ['GET', 'HEAD'], url: `/stream/:fileId/${codec}`, handler: encodedRoute(codec, false) });
    app.route({ method: ['GET', 'HEAD'], url: `/stream/:fileId/levelled.${codec}`, handler: encodedRoute(codec, true) });
  }
}
