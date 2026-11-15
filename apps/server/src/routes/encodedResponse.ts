import { parseRange } from '@playarr/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PassThrough, type Readable } from 'node:stream';
import { EncodeBusyError, encodeInput, streamLayout, type EncodedStreams, type EncodeInput, type EncodeJob, type StreamCodec, type StreamKbps } from '../media/encoded.ts';

/** How long a request waits for an encode's first fragment before giving up on it. */
const FIRST_FRAGMENT_MS = 20_000;

/** One encoded stream to answer with: what it is, and how to make it. */
export interface EncodedAnswer {
  encoded: EncodedStreams;
  codec: StreamCodec;
  kbps: StreamKbps;
  /** The audio's length in samples at the stream rate (44.1 kHz), and the sample the stream starts from. */
  length: number;
  start: number;
  /** The file seeks to the sample (not an MP3): the encode starts near `start` rather than decoding from the top. */
  seeksExactly: boolean;
  /** Changes whenever the bytes would: the song or file, its length, the start, the gain, the layout's version. */
  etag: string;
  /** The encode's key, the same for everyone asking for this stream (one encode, however many read it). */
  key: string;
  /** Starts the encode (ffmpeg through the file's source). */
  encode: (input: EncodeInput) => Readable;
  /** "song" or "transition", for errors and the log. */
  what: string;
  /** Where the audio is, for the log. */
  path: string;
}

/**
 * Answers with an encoded stream (media/encoded.ts): AAC or Opus in fragmented MP4, a file of a known length that
 * answers byte ranges like any other, what isn't encoded yet waited for. The song routes (`/stream/:id/aac`) and
 * transitions (`/transitions/:file/aac`) both answer through it.
 */
export async function sendEncoded(req: FastifyRequest, reply: FastifyReply, s: EncodedAnswer) {
  const layout = streamLayout(s.codec, s.kbps, s.length - s.start);
  const total = layout.total;
  // The stream's headers, on everything but an error (which is JSON).
  const streamHeaders = () => reply.header('Accept-Ranges', 'bytes').header('Content-Type', 'audio/mp4').header('ETag', s.etag).header('Cache-Control', 'private, max-age=86400');
  if (req.headers['if-none-match'] === s.etag) return streamHeaders().code(304).send();
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
    job = s.encoded.job(s.key, account, layout, () => s.encode(encodeInput(layout, s.start, s.seeksExactly)), { from, to });
  } catch (err) {
    if (!(err instanceof EncodeBusyError)) throw err;
    return reply.code(503).header('Retry-After', '5').send({ error: err.message });
  }
  // Attached at once: what this request reads from is kept for it from here on.
  const reader = job.attach(from);
  // The first fragment, or the encode's failure, before answering: a file that can't be encoded gets an error,
  // not a stream that stops. A range within the init segment (a player's first look) needs neither.
  if (to >= layout.init.length) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = await Promise.race([
      job.started.then(() => true),
      new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), FIRST_FRAGMENT_MS).unref())),
    ]).finally(() => clearTimeout(timer));
    if (!ready || (job.state === 'failed' && job.produced === layout.init.length)) {
      job.detach(reader);
      req.log.warn({ err: job.error, path: s.path }, `a ${s.what} couldn’t be encoded`);
      return reply.code(502).send({ error: ready ? `This ${s.what} couldn’t be encoded: ${job.error?.message ?? 'unknown error'}` : `Encoding this ${s.what} took too long` });
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
      for await (const piece of job.read(from, to, stop.signal, reader)) {
        if (out.destroyed) return;
        if (!out.write(piece)) await drained();
      }
      out.end();
    } catch (err) {
      if (!stop.signal.aborted) req.log.warn({ err, path: s.path }, 'an encoded stream broke off');
      out.destroy(err as Error);
    } finally {
      job.detach(reader);
    }
  })();
  return reply.send(out);
}
