/**
 * Encoded streams: a song as AAC (or Opus) in fragmented MP4, encoded with ffmpeg as it's asked for, from any
 * sample of the song (`start`), at its even-volume level when asked. The layout (docs/server/streaming-and-art.md,
 * Encoded streams) is what lets every player place every sample exactly:
 *
 * - **AAC**: every stream begins PRIMING samples before its first sample of the song, and says so in iTunSMPB
 *   along with how many samples of the song follow and the padding after them. ffmpeg's AAC encoder delays its
 *   output by AAC_ENCODER_DELAY samples, so the stream is fed PRE_ROLL samples of the song from before `start`
 *   (silence before the song's first): a decoder that trims the priming is warmed up on the song itself, and its
 *   first sample is the song's sample `start`, exactly.
 * - **Opus**: no pre-roll; the encoder's lookahead is its pre-skip, in dOps and the edit list (media/mp4.ts).
 *
 * The stream's length is declared before it's encoded (players ask for byte ranges of a known length:
 * AVFoundation refuses a stream without one), as an upper bound; the free box after the last fragment fills it.
 * One encode serves everyone asking for the same stream at once (an <audio> element's ranges, the device
 * keeping it, a broken connection asking again), and finished streams stay in memory a while: the same URL is
 * always the same bytes.
 */
import type { Readable } from 'node:stream';
import { AAC_FRAME, FREE_HEADER, fragment, freeHeader, initSegment, moofSize, OPUS_PACKET, OPUS_RATE, STREAM_RATE, type StreamTrack } from './mp4.ts';

export type StreamCodec = 'aac' | 'opus';
/** The bitrates on offer (kbps): Normal and High. */
export const STREAM_KBPS = [128, 256] as const;
export type StreamKbps = (typeof STREAM_KBPS)[number];

/**
 * Samples before the song's first in every AAC stream: what AVFoundation takes off any AAC track it isn't told
 * about (Apple's own encoder's delay), so even a player that ignored iTunSMPB on Apple's side would agree.
 */
export const PRIMING = 2112;
/** ffmpeg's AAC encoder's delay (`initial_padding` in libavcodec/aacenc.c): its first decoded frame is padding. */
export const AAC_ENCODER_DELAY = 1024;
/** Samples of the song (or silence before it) fed to the AAC encoder ahead of the stream's first. */
export const PRE_ROLL = PRIMING - AAC_ENCODER_DELAY;
/** libopus's lookahead at 48 kHz, the pre-skip every Opus stream declares (checked against the encoder's own). */
export const OPUS_PRE_SKIP = 312;

/**
 * Samples (AAC frames, Opus packets) per fragment: the first about a second, so a request is answered almost at
 * once, the rest about ten. AVPlayer (Safari) reads every fragment's moof before it plays a stream, a request
 * each (docs/server/streaming-and-art.md, Encoded streams): ten-second fragments make that a few dozen
 * requests for a song, not hundreds.
 */
const FRAGMENTS = { aac: { first: 43, rest: 431 }, opus: { first: 50, rest: 500 } } as const;

/** How many samples each fragment of a stream of `count` holds, in order. */
export function fragmentLengths(codec: StreamCodec, count: number): number[] {
  const { first, rest } = FRAGMENTS[codec];
  const lengths = [Math.min(first, count)];
  for (let left = count - lengths[0]!; left > 0; left -= rest) lengths.push(Math.min(rest, left));
  return lengths;
}
/**
 * The stream's declared length allows the bitrate this many times over, and SLACK more: the encoder only keeps
 * to its bitrate on average. What it doesn't use is padding at the end.
 */
const MARGIN = 1.2;
const SLACK = 16 * 1024;
/**
 * The least the free box at the end ever is: its header and 64 zero bytes. The stream's last 64 bytes are
 * known before it's encoded (zeros), for a player that looks at the end of a file first.
 */
export const TAIL_ZEROS = 64;
const MIN_PAD = FREE_HEADER + TAIL_ZEROS;

/** What a stream holds, and what's known of it before a sample is encoded. */
export interface StreamLayout {
  codec: StreamCodec;
  kbps: StreamKbps;
  /** The track the init segment describes. */
  track: StreamTrack;
  init: Buffer;
  /** The declared length in bytes: init, fragments and the free box. */
  total: number;
  /** Samples or packets the stream should have (AAC frames; for Opus, an estimate). */
  samples: number;
  /** Samples (44.1 kHz) to feed the encoder: the pre-roll and the song from `start`. */
  feed: number;
  /** Samples (44.1 kHz) of the song before `start` fed as the pre-roll (0 for Opus). */
  preRoll: number;
}

/** The fragments' moofs and mdat headers for a stream of `count` samples. */
function overhead(codec: StreamCodec, count: number): number {
  return fragmentLengths(codec, count).reduce((sum, n) => sum + moofSize(n) + 8, 0);
}

/**
 * The layout of a stream of `valid` samples (44.1 kHz) of the song: its init segment and declared length. The
 * same arguments always give the same layout.
 */
export function streamLayout(codec: StreamCodec, kbps: StreamKbps, valid: number): StreamLayout {
  if (!Number.isInteger(valid) || valid <= 0) throw new RangeError(`Invalid stream length: ${valid}`);
  const bytesPerSecond = (kbps * 1000) / 8;
  if (codec === 'aac') {
    const frames = Math.ceil((PRIMING + valid) / AAC_FRAME);
    const track: StreamTrack = { codec, kbps, priming: PRIMING, valid, frames };
    const init = initSegment(track);
    const audio = Math.ceil(((frames * AAC_FRAME) / STREAM_RATE) * bytesPerSecond * MARGIN) + SLACK;
    return { codec, kbps, track, init, total: init.length + overhead(codec, frames) + audio + MIN_PAD, samples: frames, feed: PRE_ROLL + valid, preRoll: PRE_ROLL };
  }
  const valid48 = Math.round((valid * OPUS_RATE) / STREAM_RATE);
  // The encoder pads the end out to a packet, and may hand on one more as it flushes.
  const packets = Math.ceil((OPUS_PRE_SKIP + valid48) / OPUS_PACKET) + 1;
  const track: StreamTrack = { codec, kbps, preSkip: OPUS_PRE_SKIP, valid: valid48 };
  const init = initSegment(track);
  const audio = Math.ceil(((packets * OPUS_PACKET) / OPUS_RATE) * bytesPerSecond * MARGIN) + SLACK;
  return { codec, kbps, track, init, total: init.length + overhead(codec, packets) + audio + MIN_PAD, samples: packets, feed: valid, preRoll: 0 };
}

/** Where ffmpeg starts decoding and what it drops, for a stream from `start` (see EncodeOptions in source.ts). */
export interface EncodeInput {
  /** Seconds into the file to start decoding at: on a 10 ms grid, which the formats that seek exactly seek to exactly. */
  seekSeconds?: number;
  /** Samples (44.1 kHz) decoded and dropped before the first one fed to the encoder. */
  skipSamples: number;
  /** Samples of silence fed before the song's first, where the pre-roll reaches before it. */
  leadSamples: number;
  /** Samples fed to the encoder in all. */
  samples: number;
}

/** Samples in 10 ms at the stream's rate: a seek on this grid lands on a whole sample at every common rate. */
const GRID = STREAM_RATE / 100;

/**
 * How to feed the encoder for a stream from the song's sample `start`: the pre-roll before it, from the song
 * (or silence where it reaches before the song), then the song. A format that seeks only near a time (MP3, see
 * seeksInexactly) is decoded from its start and dropped up to there instead, so the first sample is exact.
 */
export function encodeInput(layout: Pick<StreamLayout, 'feed' | 'preRoll'>, start: number, seeksExactly: boolean): EncodeInput {
  const first = start - layout.preRoll;
  if (first < 0) return { skipSamples: 0, leadSamples: -first, samples: layout.feed };
  if (!seeksExactly) return { skipSamples: first, leadSamples: 0, samples: layout.feed };
  const grid = Math.floor(first / GRID) * GRID;
  return { ...(grid > 0 ? { seekSeconds: grid / STREAM_RATE } : {}), skipSamples: first - grid, leadSamples: 0, samples: layout.feed };
}

/**
 * The AAC frames of an ADTS stream (what ffmpeg hands on with `-f adts`), without their headers, as they come.
 * Fails on anything that isn't ADTS, or isn't what the init segment says the stream holds (AAC-LC, 44.1 kHz,
 * stereo, a frame per header): ffmpeg never writes anything else there.
 */
export class AdtsFrames {
  private pending: Buffer = Buffer.alloc(0);

  /** The whole frames in what's arrived so far. */
  push(chunk: Buffer): Buffer[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const frames: Buffer[] = [];
    let at = 0;
    while (this.pending.length - at >= 7) {
      const b = this.pending;
      if (b[at] !== 0xff || (b[at + 1]! & 0xf6) !== 0xf0) throw new Error('The encoder’s output isn’t ADTS');
      // Profile LC (1), rate index 4 (44.1 kHz), channel configuration 2, one raw data block.
      const profile = b[at + 2]! >> 6;
      const rate = (b[at + 2]! >> 2) & 0x0f;
      const channels = ((b[at + 2]! & 0x01) << 2) | (b[at + 3]! >> 6);
      if (profile !== 1 || rate !== 4 || channels !== 2 || (b[at + 6]! & 0x03) !== 0) throw new Error('The encoder’s output isn’t AAC-LC at 44.1 kHz in stereo');
      const length = ((b[at + 3]! & 0x03) << 11) | (b[at + 4]! << 3) | (b[at + 5]! >> 5);
      const header = b[at + 1]! & 0x01 ? 7 : 9;
      if (length < header) throw new Error('The encoder’s output isn’t ADTS');
      if (this.pending.length - at < length) break;
      frames.push(Buffer.from(b.subarray(at + header, at + length)));
      at += length;
    }
    this.pending = this.pending.subarray(at);
    return frames;
  }

  /** Bytes left over at the end, which no whole frame holds. */
  get leftover(): number {
    return this.pending.length;
  }
}

/**
 * The Opus packets of an Ogg stream (what ffmpeg hands on with `-f ogg`), as they come: OpusHead and OpusTags
 * are read (the pre-skip, for checking) rather than handed on.
 */
export class OggOpusPackets {
  private pending: Buffer = Buffer.alloc(0);
  private partial: Buffer[] = [];
  private headers = 0;
  /** OpusHead's pre-skip, once read. */
  preSkip?: number;

  push(chunk: Buffer): Buffer[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const packets: Buffer[] = [];
    let at = 0;
    while (this.pending.length - at >= 27) {
      const b = this.pending;
      if (b.toString('latin1', at, at + 4) !== 'OggS') throw new Error('The encoder’s output isn’t Ogg');
      const segments = b[at + 26]!;
      if (this.pending.length - at < 27 + segments) break;
      const lacing = b.subarray(at + 27, at + 27 + segments);
      const body = lacing.reduce((sum, n) => sum + n, 0);
      if (this.pending.length - at < 27 + segments + body) break;
      let p = at + 27 + segments;
      for (const n of lacing) {
        this.partial.push(b.subarray(p, p + n));
        p += n;
        // A lacing value under 255 ends a packet; 255 means it goes on (in this page or the next).
        if (n < 255) this.packet(Buffer.concat(this.partial), packets);
      }
      at = p;
    }
    this.pending = this.pending.subarray(at);
    return packets;
  }

  private packet(packet: Buffer, out: Buffer[]) {
    this.partial = [];
    if (this.headers === 0) {
      if (packet.toString('latin1', 0, 8) !== 'OpusHead') throw new Error('The encoder’s output isn’t Opus');
      this.preSkip = packet.readUInt16LE(10);
      this.headers++;
    } else if (this.headers === 1) {
      this.headers++; // OpusTags
    } else out.push(packet);
  }
}

/** Too many songs are being encoded right now (for this account, or for everyone): ask again in a moment. */
export class EncodeBusyError extends Error {}

/** Wakes a reader waiting for bytes not made yet: called when a fragment is made or the encode ends. */
type Wake = () => void;

/**
 * One stream being encoded, or encoded: its bytes so far, handed to everyone reading it, each from the byte
 * they ask for. Its encoder is paused once it's READ_AHEAD past where anyone is reading, so a stream listened to
 * over a slow connection is encoded as it's heard rather than all at once. Short of memory, it lets go of the
 * fragments all its readers are past (see trim).
 */
export class EncodeJob {
  /** Bytes made so far: the init segment, then a fragment at a time; null for a fragment let go (see trim). */
  private chunks: (Buffer | null)[];
  /** Where each chunk ends. */
  private ends: number[];
  produced: number;
  /** The first fragment still kept (1 while none has been let go), and where in the stream it starts. */
  private firstKept = 1;
  private keptFrom: number;
  /** Bytes kept in memory: the init segment and the fragments not let go. */
  private retained: number;
  state: 'running' | 'done' | 'failed' = 'running';
  error?: Error;
  /** The stream ended early: the declared length couldn't hold the rest. */
  truncated = false;
  /** Frames (or packets) in the stream so far. */
  made = 0;
  /** The first fragment is made (or the encode has failed): a request can be answered. */
  readonly started: Promise<void>;
  private markStarted!: () => void;
  private waiting = new Set<Wake>();
  /** The readers attached (see attach): the encoder runs while there are any. */
  private readers = new Set<symbol>();
  /** The byte each reader, and each read under way, needs next: what they're all past may be let go (see trim). */
  private positions = new Map<symbol, number>();
  /** The furthest byte anyone reading has got to. */
  private furthest = 0;
  private source?: Readable;
  private paused = false;
  private listeners: { idle?: () => void; busy?: () => void; done?: () => void; failed?: () => void; grew?: () => void } = {};
  /** When it was last read from: the least recently read finished streams go first. */
  usedAt = Date.now();

  constructor(
    readonly key: string,
    readonly layout: StreamLayout,
    /** The account it was started for (null before setup): its encodes count towards that account's limit. */
    readonly account: number | null,
    private readonly readAhead = READ_AHEAD,
  ) {
    this.chunks = [layout.init];
    this.ends = [layout.init.length];
    this.produced = this.keptFrom = this.retained = layout.init.length;
    this.started = new Promise((resolve) => (this.markStarted = resolve));
  }

  on(event: 'idle' | 'busy' | 'done' | 'failed' | 'grew', listener: () => void) {
    this.listeners[event] = listener;
  }

  /** Bytes of the stream kept in memory (the padding isn't). */
  get bytes(): number {
    return this.retained;
  }

  /** Every byte made is still kept: the stream can be kept for whoever asks next. */
  get whole(): boolean {
    return this.keptFrom === this.layout.init.length;
  }

  /** Bytes `from` to `to` are kept, or still to be made: a read of them can start here. */
  serves(from: number, to: number): boolean {
    return this.whole || to < this.layout.init.length || from >= this.keptFrom;
  }

  get idle(): boolean {
    return this.readers.size === 0;
  }

  /** Encode from `source` (ffmpeg's output), making fragments as its samples arrive. */
  run(source: Readable) {
    this.source = source;
    const layout = this.layout;
    const parser = layout.codec === 'aac' ? new AdtsFrames() : new OggOpusPackets();
    const { first, rest } = FRAGMENTS[layout.codec];
    const duration = layout.codec === 'aac' ? AAC_FRAME : OPUS_PACKET;
    let samples: Buffer[] = [];
    let sequence = 1;
    const flush = () => {
      if (!samples.length || this.state !== 'running') return;
      const bytes = fragment(sequence++, this.made * duration, duration, samples);
      // The declared length can't hold this fragment and the free box after it: the stream ends here.
      if (this.produced + bytes.length + MIN_PAD > layout.total) {
        this.truncated = true;
        samples = [];
        this.finish();
        return;
      }
      this.made += samples.length;
      samples = [];
      this.chunks.push(bytes);
      this.produced += bytes.length;
      this.retained += bytes.length;
      this.ends.push(this.produced);
      this.markStarted();
      this.wakeAll();
      this.pace();
      this.listeners.grew?.();
    };
    source.on('data', (chunk: Buffer) => {
      if (this.state !== 'running') return;
      let units: Buffer[];
      try {
        units = parser.push(chunk);
      } catch (err) {
        return this.fail(err as Error);
      }
      if (parser instanceof OggOpusPackets && parser.preSkip !== undefined && parser.preSkip !== OPUS_PRE_SKIP) {
        return this.fail(new Error(`The Opus encoder’s pre-skip is ${parser.preSkip}, not ${OPUS_PRE_SKIP}`));
      }
      for (const unit of units) {
        // AAC: the stream holds exactly the frames iTunSMPB counts (ffmpeg makes that many from what it's fed).
        if (layout.codec === 'aac' && this.made + samples.length >= layout.samples) break;
        samples.push(unit);
        if (samples.length === (sequence === 1 ? first : rest)) flush();
        if (this.state !== 'running') return;
      }
    });
    source.once('end', () => {
      flush();
      this.finish();
    });
    source.once('error', (err: Error) => this.fail(err));
  }

  /**
   * A reader starts, at byte `from`: the encoder runs while anyone reads (see detach), and what the reader still
   * needs is kept for it. Pass what this returns to read and detach.
   */
  attach(from = 0): symbol {
    const reader = Symbol('reader');
    this.readers.add(reader);
    this.positions.set(reader, from);
    this.usedAt = Date.now();
    if (this.readers.size === 1) this.listeners.busy?.();
    return reader;
  }

  detach(reader: symbol) {
    if (!this.readers.delete(reader)) return;
    this.positions.delete(reader);
    this.usedAt = Date.now();
    if (this.readers.size === 0) this.listeners.idle?.();
  }

  /**
   * Let go of the fragments every reader is past (memory is short); with nobody reading, of all of them. A reader
   * coming later for them needs another encode (see serves). The init segment stays: every player reads it first.
   */
  trim() {
    const needed = this.positions.size ? Math.min(...this.positions.values()) : this.produced;
    let i = this.firstKept;
    for (; i < this.chunks.length && this.ends[i]! <= needed; i++) {
      this.retained -= this.chunks[i]!.length;
      this.chunks[i] = null;
    }
    this.firstKept = i;
    this.keptFrom = this.ends[i - 1]!;
  }

  /** Stop encoding: nobody wants the rest. */
  stop() {
    if (this.state !== 'running') return;
    this.state = 'failed';
    this.error = new Error('The stream was stopped');
    this.source?.destroy();
    this.markStarted();
    this.wakeAll();
  }

  private finish() {
    if (this.state !== 'running') return;
    this.state = 'done';
    this.source?.destroy();
    this.markStarted();
    this.wakeAll();
    this.listeners.done?.();
  }

  private fail(err: Error) {
    if (this.state !== 'running') return;
    this.state = 'failed';
    this.error = err;
    this.source?.destroy();
    this.markStarted();
    this.wakeAll();
    this.listeners.failed?.();
  }

  private wakeAll() {
    const waiting = [...this.waiting];
    this.waiting.clear();
    for (const wake of waiting) wake();
  }

  /** Paused far enough ahead of every reader, and going again once a reader needs what's next. */
  private pace() {
    if (!this.source || this.state !== 'running') return;
    const ahead = this.produced - this.furthest > this.readAhead;
    if (ahead && !this.paused && !this.waiting.size) {
      this.paused = true;
      this.source.pause();
    } else if ((!ahead || this.waiting.size) && this.paused) {
      this.paused = false;
      this.source.resume();
    }
  }

  /** A reader has got to `at`. */
  private reached(at: number) {
    if (at > this.furthest) this.furthest = at;
    this.pace();
  }

  /** The made bytes in [from, to], at most up to what's made. */
  private slice(from: number, to: number): Buffer[] {
    const out: Buffer[] = [];
    let lo = 0;
    let hi = this.ends.length - 1;
    // The first chunk that ends past `from`.
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ends[mid]! > from) hi = mid;
      else lo = mid + 1;
    }
    for (let i = lo; i < this.chunks.length && from <= to; i++) {
      const chunk = this.chunks[i];
      // A reader attached at its first byte keeps it (see trim): this is a read nobody attached.
      if (!chunk) throw new Error('That part of the stream is no longer kept');
      const chunkStart = i === 0 ? 0 : this.ends[i - 1]!;
      const piece = chunk.subarray(from - chunkStart, Math.min(chunk.length, to - chunkStart + 1));
      out.push(piece);
      from += piece.length;
    }
    return out;
  }

  /** The free box's bytes in [from, to]: its header where the audio ends, then zeros to the declared length. */
  private padding(from: number, to: number): Buffer {
    const header = freeHeader(this.layout.total - this.produced);
    const out = Buffer.alloc(to - from + 1);
    for (let i = Math.max(from, this.produced); i <= to && i < this.produced + FREE_HEADER; i++) out[i - from] = header[i - this.produced]!;
    return out;
  }

  /**
   * Bytes `from` to `to` (inclusive) of the stream as they're made: the encoded audio, then the free box. Fails
   * if the encode does before they're made. `signal` stops the reading (the listener went away). `reader` is
   * the one attach returned: what it still needs is kept as it reads (a read without one keeps it while it runs).
   */
  async *read(from: number, to: number, signal?: AbortSignal, reader?: symbol): AsyncGenerator<Buffer> {
    const total = this.layout.total;
    to = Math.min(to, total - 1);
    const at = reader && this.readers.has(reader) ? reader : Symbol('read');
    try {
      while (from <= to) {
        this.positions.set(at, from);
        signal?.throwIfAborted();
        this.usedAt = Date.now();
        if (from < this.produced) {
          for (const piece of this.slice(from, Math.min(to, this.produced - 1))) {
            from += piece.length;
            yield piece;
          }
          this.reached(from);
          continue;
        }
        if (this.state === 'done') {
          // The free box, in pieces of a size a response is happy with.
          const end = Math.min(to, from + 64 * 1024 - 1);
          yield this.padding(from, end);
          from = end + 1;
          continue;
        }
        if (this.state === 'failed') throw this.error ?? new Error('The encode failed');
        // The last bytes are zeros whatever the stream holds: a look at the end of the file needn't wait.
        if (from >= total - TAIL_ZEROS) {
          yield Buffer.alloc(to - from + 1);
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const wake = () => {
            signal?.removeEventListener('abort', abort);
            resolve();
          };
          const abort = () => {
            this.waiting.delete(wake);
            reject(signal!.reason);
          };
          this.waiting.add(wake);
          signal?.addEventListener('abort', abort, { once: true });
          this.reached(from);
        });
      }
    } finally {
      if (at === reader) {
        if (this.readers.has(at)) this.positions.set(at, from);
      } else this.positions.delete(at);
    }
  }
}

/** How far the encoder runs ahead of the furthest reader before it's paused: a minute or so of a Normal stream. */
const READ_AHEAD = 1024 * 1024;
/** A stream nobody reads any more is encoded on for this long (a player that asked for two bytes comes back for the rest). */
const IDLE_MS = 10_000;

/**
 * Every encoded stream: one encode per stream, shared by everyone reading it, at most `maxRunning` at once and
 * `maxPerAccount` for any one account. What they hold stays within `cacheBytes`: finished streams are kept for
 * whoever asks next, the least recently read going first, and past that, encodes let go of what their readers
 * are past (see fit).
 */
export class EncodedStreams {
  /** The encode a request for each stream joins. */
  private running = new Map<string, EncodeJob>();
  /** Every encode under way: the ones above, and ones that let go of a start a later reader needed (see job). */
  private active = new Set<EncodeJob>();
  private finished = new Map<string, EncodeJob>();
  private idleTimers = new Map<EncodeJob, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly opts: {
      maxRunning: number;
      maxPerAccount: number;
      cacheBytes: number;
      idleMs?: number;
      readAhead?: number;
      log?: { warn: (obj: object, msg: string) => void };
    },
  ) {}

  /** How many streams are being encoded, in all and for each account. */
  counts(): { running: number; byAccount: Map<number | null, number> } {
    const byAccount = new Map<number | null, number>();
    for (const job of this.active) byAccount.set(job.account, (byAccount.get(job.account) ?? 0) + 1);
    return { running: this.active.size, byAccount };
  }

  /** Bytes held by finished streams kept and by encodes under way. */
  held(): number {
    let bytes = 0;
    for (const job of this.finished.values()) bytes += job.bytes;
    for (const job of this.active) bytes += job.bytes;
    return bytes;
  }

  /**
   * The stream for `key`: the one being encoded or kept, else a new encode from `open()` (ffmpeg's output), if
   * the limits allow it. Throws EncodeBusyError when they don't, once streams nobody is reading have made room.
   * `range` is the bytes the caller is about to read: an encode that has let go of them isn't joined but
   * replaced by a new one, and goes on for its own readers.
   */
  job(key: string, account: number | null, layout: StreamLayout, open: () => Readable, range = { from: 0, to: 0 }): EncodeJob {
    const kept = this.finished.get(key);
    if (kept) {
      // Most recently read last.
      this.finished.delete(key);
      this.finished.set(key, kept);
      return kept;
    }
    const running = this.running.get(key);
    if (running?.serves(range.from, range.to)) return running;
    if (!this.roomFor(account)) throw new EncodeBusyError('Too many songs are being encoded right now: try again in a moment');
    const job = new EncodeJob(key, layout, account, this.opts.readAhead);
    this.running.set(key, job);
    this.active.add(job);
    job.on('idle', () => this.idleSoon(job));
    job.on('busy', () => this.cancelIdle(job));
    job.on('done', () => this.done(job));
    job.on('failed', () => this.forget(job));
    job.on('grew', () => this.fit());
    try {
      job.run(open());
    } catch (err) {
      this.forget(job);
      throw err;
    }
    // Nobody reads it yet: the request about to does, but a request that never does mustn't keep it going.
    this.idleSoon(job);
    return job;
  }

  /**
   * Room for one more encode for this account. Streams nobody reads any more (a player that asked for two bytes
   * and went) are stopped to make it, the longest unread first: under the account's own limit only its own help.
   */
  private roomFor(account: number | null): boolean {
    const fits = () => {
      const { running, byAccount } = this.counts();
      return running < this.opts.maxRunning && (byAccount.get(account) ?? 0) < this.opts.maxPerAccount;
    };
    if (fits()) return true;
    const idle = [...this.active].filter((j) => j.idle).sort((a, b) => a.usedAt - b.usedAt);
    for (const job of idle) {
      const accountFull = (this.counts().byAccount.get(account) ?? 0) >= this.opts.maxPerAccount;
      if (accountFull && job.account !== account) continue;
      this.stopJob(job);
      if (fits()) return true;
    }
    return false;
  }

  private idleSoon(job: EncodeJob) {
    if (job.state !== 'running' || !job.idle) return;
    this.cancelIdle(job);
    const timer = setTimeout(() => {
      this.idleTimers.delete(job);
      if (job.idle && job.state === 'running') this.stopJob(job);
    }, this.opts.idleMs ?? IDLE_MS);
    timer.unref?.();
    this.idleTimers.set(job, timer);
  }

  private cancelIdle(job: EncodeJob) {
    clearTimeout(this.idleTimers.get(job));
    this.idleTimers.delete(job);
  }

  private stopJob(job: EncodeJob) {
    job.stop();
    this.forget(job);
  }

  private forget(job: EncodeJob) {
    this.cancelIdle(job);
    this.active.delete(job);
    if (this.running.get(job.key) === job) this.running.delete(job.key);
  }

  private done(job: EncodeJob) {
    this.forget(job);
    if (job.truncated) this.opts.log?.warn({ key: job.key }, 'an encoded stream ran out of the length it declared: its end is cut short');
    else if (job.layout.codec === 'aac' && job.made < job.layout.samples) {
      this.opts.log?.warn({ key: job.key, made: job.made, expected: job.layout.samples }, 'the encoder made fewer frames than the stream declared');
    }
    // Not kept: a stream that has let go of its start, or one that would push out all the others (an hour's mix).
    // What its readers are past is let go of now.
    if (!this.keepable(job)) return job.trim();
    this.finished.set(job.key, job);
    this.fit();
  }

  /** A stream that can be kept once it's finished: it has all its bytes, and they'd fit in half of what's kept. */
  private keepable(job: EncodeJob): boolean {
    return job.whole && job.bytes <= this.opts.cacheBytes / 2;
  }

  /**
   * What's held within cacheBytes. Encodes that won't be kept once finished let go of what their readers are past
   * first (it goes then anyway), then the least recently read finished streams go, then every encode over its
   * share lets go of what its readers are past. Bytes a reader still needs are held whatever it takes.
   */
  private fit() {
    const budget = this.opts.cacheBytes;
    let bytes = this.held();
    if (bytes <= budget) return;
    for (const job of this.active) {
      if (this.keepable(job)) continue;
      bytes -= job.bytes;
      job.trim();
      bytes += job.bytes;
    }
    for (const [key, kept] of this.finished) {
      if (bytes <= budget) return;
      this.finished.delete(key);
      bytes -= kept.bytes;
    }
    if (bytes <= budget) return;
    const share = budget / this.active.size;
    for (const job of this.active) if (job.bytes > share) job.trim();
  }

  /** Stop every encode (the server is closing). */
  close() {
    for (const job of [...this.active]) this.stopJob(job);
    this.finished.clear();
  }
}
