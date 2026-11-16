import { parseRange, wavFallbackOf } from '@playarr/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import type { Analyzer } from '../analysis/analyzer.ts';
import { LOUDNESS_RATE } from '../analysis/loudness.ts';
import { FileAccessError, type FileResolver } from '../catalog/files.ts';
import type { FileRecord } from '../catalog/build.ts';
import type { SourceHealth } from '../catalog/health.ts';
import { pcmLengthFrom } from '../catalog/tags.ts';
import type { Library } from '../library/library.ts';
import { libraryOf } from '../accounts/rights.ts';
import { mimeForPath } from '../library/format.ts';
import { MediaUnavailableError, type MediaSource } from '../media/index.ts';
import { seeksInexactly } from '../media/source.ts';
import { bytesPerFrame, LEVELLED, WAV_HEADER_BYTES, wavRange, type PcmShape } from '../media/levelled.ts';
import { STREAM_KBPS, type EncodedStreams, type StreamCodec, type StreamKbps } from '../media/encoded.ts';
import { sendEncoded } from './encodedResponse.ts';
import { STREAM_RATE } from '../media/mp4.ts';

/** The most a levelled stream turns a song up or down (dB): the levels route never asks for more. */
const MAX_GAIN_DB = 20;
/** Files whose exact length is remembered (see wavLength): a few hundred bytes each. */
const LENGTHS_KEPT = 2000;
/** Bumped when an encoded stream's bytes would change for the same song and arguments (its layout): new ETags. */
const ENCODED_VERSION = 1;
/** How long a copy standing in for one that can't be read keeps doing so after it was last asked for (see open). */
const STAND_IN_MS = 15 * 60_000;
/** Stand-ins remembered at most. */
const STAND_INS_KEPT = 2000;

/** A copy opened to be streamed: the copy, where it lives, and its size and time. */
interface Opened {
  file: FileRecord;
  media: MediaSource;
  path: string;
  size: number;
  mtimeMs: number;
}

export function streamRoutes(
  app: FastifyInstance,
  deps: {
    library: Pick<Library, 'file'> & Partial<Pick<Library, 'view' | 'copiesOf'>>;
    files: FileResolver;
    /** Which sources answer: a copy on one that doesn't is tried only when it's the one asked for. */
    health?: Pick<SourceHealth, 'isOffline' | 'check' | 'reached'>;
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

  /**
   * Copies standing in for ones that couldn't be read, by the copy asked for: a song keeps streaming from the copy it
   * started on (a player asks for the rest of it in ranges), even once the copy asked for answers again, until it
   * hasn't been asked for in a while.
   */
  const standIns = new Map<number, { fileId: number; usedAt: number }>();

  /** The copies to try for the copy asked for, in order (see open). */
  function candidates(file: FileRecord, copies: FileRecord[]): FileRecord[] {
    const others = copies.filter((c) => c.id !== file.id);
    const standIn = standIns.get(file.id);
    if (standIn && Date.now() - standIn.usedAt > STAND_IN_MS) standIns.delete(file.id);
    const first = standIns.has(file.id) ? others.find((c) => c.id === standIn!.fileId) : undefined;
    const ordered = first ? [first, file, ...others.filter((c) => c !== first)] : [file, ...others];
    // Copies on a source that doesn't answer would only keep the player waiting; the one asked for is still tried
    // last, as its source may be back.
    const reachable = ordered.filter((c) => !deps.health?.isOffline(c.sourceId));
    return reachable.includes(file) ? reachable : [...reachable, file];
  }

  /** A copy opened, or why it can't be. */
  async function read(req: FastifyRequest, file: FileRecord): Promise<Opened | { status: number; error: string }> {
    // Defense in depth: never read outside the source's folder or the configured roots.
    let media: MediaSource;
    let path: string;
    try {
      ({ media, path } = deps.files.resolve(file));
    } catch (err) {
      if (!(err instanceof FileAccessError)) throw err;
      req.log.warn({ path: file.path }, err.message);
      return { status: err.status, error: err.message };
    }
    try {
      const { size, mtimeMs } = await media.stat(path);
      deps.health?.reached(file.sourceId);
      return { file, media, path, size, mtimeMs };
    } catch (err) {
      if (err instanceof MediaUnavailableError) return { status: 503, error: err.message };
      req.log.warn({ err, path }, 'stat failed');
      // The file, or its whole source? Asked meanwhile: the next copy is tried either way.
      void deps.health?.check(file.sourceId);
      return { status: 502, error: `Cannot read audio file: ${(err as Error).message}` };
    }
  }

  /**
   * The library file asked for, where it lives, and its size and time; or the error already sent. When it can't be
   * read (its disk or host away, the file gone), another copy of the song stands in for it, best first, as long as
   * the account may hear it: what the copy asked for would have said goes only when none can be read.
   */
  async function open(req: FastifyRequest<{ Params: { fileId: string } }>, reply: FastifyReply): Promise<Opened | undefined> {
    const fileId = Number(req.params.fileId);
    // Only files of songs the account may hear, as the catalog knows them: the client never supplies a path.
    const lib = libraryOf(library, req);
    const file = Number.isInteger(fileId) ? await lib.file(fileId) : undefined;
    if (!file) return void reply.code(404).send({ error: 'Unknown track file' });
    const copies = (await lib.copiesOf?.(fileId)) ?? [file];

    let failed: { status: number; error: string } | undefined;
    for (const candidate of candidates(file, copies)) {
      const opened = await read(req, candidate);
      if (!('file' in opened)) {
        if (candidate === file) failed = opened;
        else failed ??= opened;
        continue;
      }
      if (candidate !== file) {
        if (standIns.get(file.id)?.fileId !== candidate.id) req.log.info({ fileId, standIn: candidate.id }, 'a copy stands in for one that can’t be read');
        standIns.delete(file.id);
        if (standIns.size >= STAND_INS_KEPT) standIns.delete(standIns.keys().next().value!);
        standIns.set(file.id, { fileId: candidate.id, usedAt: Date.now() });
      } else {
        standIns.delete(file.id);
      }
      return opened;
    }
    reply.code(failed!.status).send({ error: failed!.error });
    return undefined;
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
      let frames = measured.samples;
      if (file.id !== measured.fileId) {
        // Another copy stands in: as long as analysis counted it, else as its header says.
        const length = await streamLength(opened, LOUDNESS_RATE).catch(() => undefined);
        if (!length) return reply.code(404).send({ error: 'This song’s loudness isn’t measured yet' });
        frames = length;
      } else if (size !== measured.size || mtimeMs !== measured.mtimeMs) {
        // The file changed since it was measured: its length may have too. Measured again; until then, its own file.
        deps.loudness!.remeasureLoudness(measured.recordingId);
        return reply.code(404).send({ error: 'This song changed: its loudness is being measured again' });
      }
      const decode = media.pcmStream?.bind(media);
      if (!decode) return reply.code(404).send({ error: 'This source can’t level songs' });

      // From the sample asked for: exactly (by decoding from the start) where a seek would only land near it.
      const exactSeek = seeksInexactly(file.format);
      return sendWav(req, reply, {
        frames,
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
   * A song's length in samples at `rate` (the encoded streams', unless said): as loudness analysis counted it, when
   * it measured this very file, else from the file's header. Undefined when neither knows.
   */
  async function streamLength(opened: Opened, rate = STREAM_RATE): Promise<number | undefined> {
    const measured = deps.loudness?.loudnessOfFile(opened.file.id);
    // Analysis counts at LOUDNESS_RATE, the encoded streams' rate too.
    if (measured?.samples && measured.size === opened.size && measured.mtimeMs === opened.mtimeMs) return Math.round((measured.samples * rate) / LOUDNESS_RATE);
    // Measured from an older version of the file: measured again, and its header says meanwhile.
    if (measured?.samples) deps.loudness!.remeasureLoudness(measured.recordingId);
    const length = await wavLength(opened.media, opened.path, opened.size, opened.mtimeMs);
    return length?.frames && length.sampleRate ? Math.round((length.frames * rate) / length.sampleRate) : undefined;
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

      // The song's length is in it: a length counted by analysis after one read from the header is another stream.
      const etag = `"${codec}${kbps}-${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}-${length.toString(36)}-${start.toString(36)}-${gain}-${ENCODED_VERSION}"`;
      return sendEncoded(req, reply, {
        encoded: deps.encoded,
        codec,
        kbps: kbps as StreamKbps,
        length,
        start,
        seeksExactly: !seeksInexactly(file.format),
        etag,
        key: `${file.id}:${etag}`,
        encode: (input) => encode(path, { codec, kbps, ...input, ...(gain ? { gainDb: gain } : {}), priority: 'normal' }),
        what: 'song',
        path,
      });
    };
  }

  for (const codec of ['aac', 'opus'] as const) {
    app.route({ method: ['GET', 'HEAD'], url: `/stream/:fileId/${codec}`, handler: encodedRoute(codec, false) });
    app.route({ method: ['GET', 'HEAD'], url: `/stream/:fileId/levelled.${codec}`, handler: encodedRoute(codec, true) });
  }
}
