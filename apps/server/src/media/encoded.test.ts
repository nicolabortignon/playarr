import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdtsFrames,
  EncodeBusyError,
  encodeInput,
  EncodedStreams,
  EncodeJob,
  fragmentLengths,
  OggOpusPackets,
  PRE_ROLL,
  PRIMING,
  streamLayout,
  TAIL_ZEROS,
  type StreamLayout,
} from './encoded.ts';
import { initSegment, moofSize } from './mp4.ts';

/** An ADTS frame around `payload`, as ffmpeg writes them: AAC-LC, 44.1 kHz, stereo, no CRC, one raw block. */
function adts(payload: Buffer): Buffer {
  const length = payload.length + 7;
  return Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80 | (length >> 11), (length >> 3) & 0xff, ((length & 7) << 5) | 0x1f, 0xfc]), payload]);
}

/** Frame `i`'s payload: 100 bytes that say which frame it is. */
const payload = (i: number) => Buffer.from(`frame ${i}`.padEnd(100, '.'));

/** `count` ADTS frames, numbered from `from`. */
const frames = (count: number, from = 0) => Buffer.concat(Array.from({ length: count }, (_, i) => adts(payload(from + i))));

/** Everything a generator hands on, as one buffer. */
async function collect(pieces: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const piece of pieces) out.push(piece);
  return Buffer.concat(out);
}

/** The top-level boxes of a stream: type and size. */
function boxes(bytes: Buffer): { type: string; size: number; body: Buffer }[] {
  const out = [];
  for (let at = 0; at < bytes.length; ) {
    const size = bytes.readUInt32BE(at);
    out.push({ type: bytes.toString('latin1', at + 4, at + 8), size, body: bytes.subarray(at + 8, at + size) });
    at += size;
  }
  return out;
}

/** A three-second song's stream: 132 frames (the priming, the song, the last frame's padding). */
const THREE_SECONDS = 3 * 44_100;
const layout = () => streamLayout('aac', 128, THREE_SECONDS);

/** Writes `bytes` to `source` in pieces of an awkward size, as a pipe hands them on. */
function feed(source: PassThrough, bytes: Buffer, piece = 777) {
  for (let at = 0; at < bytes.length; at += piece) source.write(bytes.subarray(at, at + piece));
}

describe('streamLayout', () => {
  it('lays an AAC stream out as the priming, the song and the last frame’s padding, in whole frames', () => {
    const l = streamLayout('aac', 128, THREE_SECONDS);
    expect(l.samples).toBe(Math.ceil((PRIMING + THREE_SECONDS) / 1024));
    expect(l.track).toEqual({ codec: 'aac', kbps: 128, priming: 2112, valid: THREE_SECONDS, frames: l.samples });
    expect(l.init.equals(initSegment(l.track))).toBe(true);
    // The encoder is fed the pre-roll before the song's first sample, and the song.
    expect([l.feed, l.preRoll]).toEqual([PRE_ROLL + THREE_SECONDS, PRE_ROLL]);
    expect(PRE_ROLL + 1024).toBe(PRIMING);
  });

  it('declares a length with room for the encoder going over its bitrate', () => {
    for (const kbps of [128, 256] as const) {
      const l = streamLayout('aac', kbps, 180 * 44_100);
      const atBitrate = ((l.samples * 1024) / 44_100) * kbps * 125;
      expect(l.total - l.init.length).toBeGreaterThan(atBitrate * 1.2);
      expect(l.total - l.init.length).toBeLessThan(atBitrate * 1.25);
    }
  });

  it('lays an Opus stream out at 48 kHz, with no pre-roll', () => {
    const l = streamLayout('opus', 128, THREE_SECONDS);
    expect(l.track).toEqual({ codec: 'opus', kbps: 128, preSkip: 312, valid: 144_000 });
    expect([l.feed, l.preRoll]).toEqual([THREE_SECONDS, 0]);
    expect(l.samples).toBe(Math.ceil((312 + 144_000) / 960) + 1);
  });

  it('is the same for the same song, and refuses a length that isn’t one', () => {
    expect(streamLayout('aac', 256, 1000)).toEqual(streamLayout('aac', 256, 1000));
    for (const valid of [0, -5, 1.5, Number.NaN]) expect(() => streamLayout('aac', 128, valid)).toThrow(RangeError);
  });
});

describe('encodeInput', () => {
  const aac = layout();

  it('feeds silence where the pre-roll reaches before the song', () => {
    expect(encodeInput(aac, 0, true)).toEqual({ skipSamples: 0, leadSamples: PRE_ROLL, samples: aac.feed });
    expect(encodeInput(aac, 500, true)).toEqual({ skipSamples: 0, leadSamples: PRE_ROLL - 500, samples: aac.feed });
    expect(encodeInput(aac, PRE_ROLL, true)).toEqual({ skipSamples: 0, leadSamples: 0, samples: aac.feed });
  });

  it('seeks to the 10 ms step at or before the pre-roll, and drops the samples up to it', () => {
    // 140003 − 1088 = 138915: on the grid (3.15 s).
    expect(encodeInput(aac, 140_003, true)).toEqual({ seekSeconds: 3.15, skipSamples: 0, leadSamples: 0, samples: aac.feed });
    // 100000 − 1088 = 98912: 128 samples past 2.24 s.
    expect(encodeInput(aac, 100_000, true)).toEqual({ seekSeconds: 2.24, skipSamples: 128, leadSamples: 0, samples: aac.feed });
  });

  it('decodes a format that seeks only near a time from its start, dropping everything before', () => {
    expect(encodeInput(aac, 100_000, false)).toEqual({ skipSamples: 98_912, leadSamples: 0, samples: aac.feed });
  });

  it('starts an Opus stream at the very sample', () => {
    const opus = streamLayout('opus', 128, THREE_SECONDS);
    expect(encodeInput(opus, 0, true)).toEqual({ skipSamples: 0, leadSamples: 0, samples: THREE_SECONDS });
    expect(encodeInput(opus, 44_100, true)).toEqual({ seekSeconds: 1, skipSamples: 0, leadSamples: 0, samples: THREE_SECONDS });
  });
});

describe('AdtsFrames', () => {
  it('hands on each frame without its header, however the bytes arrive', () => {
    const parser = new AdtsFrames();
    const bytes = frames(3);
    const got = [...parser.push(bytes.subarray(0, 50)), ...parser.push(bytes.subarray(50, 220)), ...parser.push(bytes.subarray(220))];
    expect(got).toEqual([payload(0), payload(1), payload(2)]);
    expect(parser.leftover).toBe(0);
  });

  it('keeps a frame not yet whole for the next bytes', () => {
    const parser = new AdtsFrames();
    expect(parser.push(frames(1).subarray(0, 60))).toEqual([]);
    expect(parser.leftover).toBe(60);
  });

  it('skips the checksum of a frame that has one', () => {
    const frame = Buffer.concat([adts(Buffer.from('xxAAC')), Buffer.alloc(0)]);
    // protection_absent 0: a 9-byte header, the last two bytes the CRC.
    frame[1] = 0xf0;
    expect(new AdtsFrames().push(frame)).toEqual([Buffer.from('AAC')]);
  });

  it('refuses anything that isn’t AAC-LC at 44.1 kHz in stereo, a frame per header', () => {
    expect(() => new AdtsFrames().push(Buffer.from('ID3 tags and so on'))).toThrow('isn’t ADTS');
    const at48k = adts(payload(0));
    at48k[2] = 0x4c; // rate index 3
    expect(() => new AdtsFrames().push(at48k)).toThrow('44.1 kHz');
    const mono = adts(payload(0));
    mono[3] = 0x40 | (mono[3]! & 0x3f);
    expect(() => new AdtsFrames().push(mono)).toThrow('stereo');
    const twoBlocks = adts(payload(0));
    twoBlocks[6] = 0xfd;
    expect(() => new AdtsFrames().push(twoBlocks)).toThrow();
  });
});

describe('OggOpusPackets', () => {
  /** An Ogg page holding `packets` (the last may go on in the next page when `open`). */
  function page(packets: Buffer[], open = false): Buffer {
    const lacing: number[] = [];
    packets.forEach((p, i) => {
      for (let n = p.length; ; n -= 255) {
        if (n >= 255) lacing.push(255);
        else if (!(open && i === packets.length - 1)) lacing.push(n);
        if (n < 255) break;
      }
    });
    const header = Buffer.alloc(27);
    header.write('OggS', 0, 'latin1');
    header[26] = lacing.length;
    return Buffer.concat([header, Buffer.from(lacing), ...packets]);
  }
  const head = Buffer.concat([Buffer.from('OpusHead', 'latin1'), Buffer.from([1, 2]), Buffer.from([0x38, 0x01]), Buffer.alloc(7)]);
  const tags = Buffer.from('OpusTags and a vendor', 'latin1');

  it('reads the pre-skip from OpusHead and hands on the audio packets, OpusTags left out', () => {
    const parser = new OggOpusPackets();
    const audio = [Buffer.alloc(320, 1), Buffer.alloc(320, 2), Buffer.alloc(10, 3)];
    const bytes = Buffer.concat([page([head]), page([tags]), page(audio)]);
    const got = [...parser.push(bytes.subarray(0, 40)), ...parser.push(bytes.subarray(40, 400)), ...parser.push(bytes.subarray(400))];
    expect(parser.preSkip).toBe(312);
    expect(got).toEqual(audio);
  });

  it('joins a packet that goes on from one page into the next', () => {
    const parser = new OggOpusPackets();
    const long = Buffer.alloc(600, 7);
    // 600 bytes: 255 + 255 in the first page (a packet still going on), the last 90 in the next.
    const first = page([long.subarray(0, 510)], true);
    const second = page([long.subarray(510)]);
    const got = parser.push(Buffer.concat([page([head]), page([tags]), first, second]));
    expect(got).toEqual([long]);
  });

  it('refuses anything that isn’t Ogg Opus', () => {
    expect(() => new OggOpusPackets().push(Buffer.alloc(40))).toThrow('isn’t Ogg');
    expect(() => new OggOpusPackets().push(page([Buffer.from('OggVorbis header')]))).toThrow('isn’t Opus');
  });
});

describe('EncodeJob', () => {
  it('makes the stream from the encoder’s frames: init, a fragment of a second, fragments of ten, then a free box to the length declared', async () => {
    // A twelve-second song: 519 frames.
    const l = streamLayout('aac', 128, 12 * 44_100);
    const job = new EncodeJob('song', l, 1);
    const source = new PassThrough();
    job.run(source);
    feed(source, frames(l.samples));
    source.end();
    const stream = await collect(job.read(0, l.total - 1));
    expect(job.state).toBe('done');
    expect(stream.length).toBe(l.total);
    expect(stream.subarray(0, l.init.length).equals(l.init)).toBe(true);
    const parts = boxes(stream.subarray(l.init.length));
    expect(parts.map((b) => b.type)).toEqual(['moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat', 'free']);
    expect(parts.filter((b) => b.type === 'moof').map((b) => b.size)).toEqual([moofSize(43), moofSize(431), moofSize(45)]);
    expect(fragmentLengths('aac', l.samples)).toEqual([43, 431, 45]);
    const audio = Buffer.concat(parts.filter((b) => b.type === 'mdat').map((b) => b.body));
    expect(audio.equals(Buffer.concat(Array.from({ length: l.samples }, (_, i) => payload(i))))).toBe(true);
    expect(parts.at(-1)!.size).toBe(l.total - job.produced);
    expect(stream.subarray(-TAIL_ZEROS).equals(Buffer.alloc(TAIL_ZEROS))).toBe(true);
    expect(job.made).toBe(l.samples);
  });

  it('keeps exactly the frames the stream declares, should the encoder hand on more', async () => {
    const l = layout();
    const job = new EncodeJob('song', l, 1);
    job.run(Readable.from([frames(l.samples + 5)]));
    await collect(job.read(0, l.total - 1));
    expect(job.made).toBe(l.samples);
  });

  it('hands a reader each byte as it’s made, and any range of the stream', async () => {
    const l = layout();
    const job = new EncodeJob('song', l, 1);
    const source = new PassThrough();
    job.run(source);
    const whole = collect(job.read(0, l.total - 1));
    const middle = collect(job.read(5000, 9999));
    feed(source, frames(60));
    await new Promise((resolve) => setTimeout(resolve, 5));
    feed(source, frames(l.samples - 60, 60));
    source.end();
    const stream = await whole;
    expect(stream.length).toBe(l.total);
    expect((await middle).equals(stream.subarray(5000, 10_000))).toBe(true);
    // Asked for again once it's made: the very same bytes.
    expect((await collect(job.read(0, l.total - 1))).equals(stream)).toBe(true);
  });

  it('answers a look at the stream’s last bytes at once, before they’re made', async () => {
    const l = layout();
    const job = new EncodeJob('song', l, 1);
    job.run(new PassThrough());
    expect(await collect(job.read(l.total - TAIL_ZEROS, l.total - 1))).toEqual(Buffer.alloc(TAIL_ZEROS));
  });

  it('fails its readers when the encoder fails, and says it has started so a request can answer', async () => {
    const l = layout();
    const job = new EncodeJob('song', l, 1);
    const source = new PassThrough();
    job.run(source);
    const reading = collect(job.read(0, l.total - 1));
    source.destroy(new Error('ffmpeg: Invalid data found'));
    await expect(reading).rejects.toThrow('ffmpeg: Invalid data found');
    await job.started;
    expect(job.state).toBe('failed');
  });

  it('fails on output that isn’t what the stream holds', async () => {
    const job = new EncodeJob('song', layout(), 1);
    job.run(Readable.from([Buffer.from('this is not ADTS at all')]));
    await job.started;
    expect(job.error?.message).toBe('The encoder’s output isn’t ADTS');
  });

  it('fails an Opus encode whose pre-skip isn’t the one the stream declared', async () => {
    const job = new EncodeJob('song', streamLayout('opus', 128, THREE_SECONDS), 1);
    const head = Buffer.concat([Buffer.from('OpusHead', 'latin1'), Buffer.from([1, 2, 0x00, 0x01]), Buffer.alloc(7)]);
    const pageHeader = Buffer.alloc(27);
    pageHeader.write('OggS', 0, 'latin1');
    pageHeader[26] = 1;
    job.run(Readable.from([Buffer.concat([pageHeader, Buffer.from([head.length]), head])]));
    await job.started;
    expect(job.error?.message).toBe('The Opus encoder’s pre-skip is 256, not 312');
  });

  it('ends the stream early, still padded to its length, when the length declared can’t hold the rest', async () => {
    const full = layout();
    const firstFragment = moofSize(43) + 8 + 43 * 100;
    // Room for the first fragment and the smallest free box, and a little more: not for the second.
    const l: StreamLayout = { ...full, total: full.init.length + firstFragment + 72 + 10 };
    const job = new EncodeJob('song', l, 1);
    job.run(Readable.from([frames(full.samples)]));
    const stream = await collect(job.read(0, l.total - 1));
    expect(job.truncated).toBe(true);
    expect(job.made).toBe(43);
    expect(stream.length).toBe(l.total);
    expect(boxes(stream.subarray(l.init.length)).map((b) => `${b.type}:${b.size}`).at(-1)).toBe('free:82');
  });

  it('pauses the encoder once it’s far ahead of every reader, and runs it again when a reader catches up', async () => {
    const l = layout();
    const job = new EncodeJob('song', l, 1, 1000);
    const source = new PassThrough();
    job.run(source);
    feed(source, frames(50));
    // A fragment (43 frames) is over a thousand bytes past where anyone has read.
    expect(job.made).toBe(43);
    expect(source.isPaused()).toBe(true);
    feed(source, frames(l.samples - 50, 50));
    source.end();
    expect(job.made).toBe(43);
    const stream = await collect(job.read(0, l.total - 1));
    expect(stream.length).toBe(l.total);
    expect(job.made).toBe(l.samples);
  });

  it('stops for good when told to', async () => {
    const source = new PassThrough();
    const job = new EncodeJob('song', layout(), 1);
    job.run(source);
    job.stop();
    expect(job.state).toBe('failed');
    expect(source.destroyed).toBe(true);
    await expect(collect(job.read(0, 10_000))).rejects.toThrow('The stream was stopped');
  });

  it('stops reading when the reader goes away', async () => {
    const l = layout();
    const job = new EncodeJob('song', l, 1);
    job.run(new PassThrough());
    const stop = new AbortController();
    const reading = collect(job.read(l.init.length, l.total - 1, stop.signal));
    stop.abort(new Error('gone'));
    await expect(reading).rejects.toThrow('gone');
  });
});

describe('EncodedStreams', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A stand-in for the encoder: a source the test feeds, and how many were opened. */
  function encoder() {
    const sources: PassThrough[] = [];
    return {
      sources,
      open: () => {
        const source = new PassThrough();
        sources.push(source);
        return source;
      },
    };
  }

  /** Finishes a job's encode with all its frames. */
  async function finish(job: EncodeJob, source: PassThrough) {
    source.end(frames(job.layout.samples));
    await collect(job.read(0, job.layout.total - 1));
  }

  const streams = (opts: Partial<ConstructorParameters<typeof EncodedStreams>[0]> = {}) =>
    new EncodedStreams({ maxRunning: 8, maxPerAccount: 4, cacheBytes: 1024 * 1024, ...opts });

  it('runs one encode per stream, whoever asks for it', () => {
    const all = streams();
    const enc = encoder();
    const a = all.job('7:etag', 1, layout(), enc.open);
    const b = all.job('7:etag', 2, layout(), enc.open);
    expect(b).toBe(a);
    expect(enc.sources).toHaveLength(1);
  });

  it('keeps a finished stream for whoever asks next, without encoding it again', async () => {
    const all = streams();
    const enc = encoder();
    const job = all.job('7:etag', 1, layout(), enc.open);
    await finish(job, enc.sources[0]!);
    expect(all.job('7:etag', 1, layout(), enc.open)).toBe(job);
    expect(enc.sources).toHaveLength(1);
    expect(all.counts().running).toBe(0);
  });

  it('encodes at most so many songs for an account at once, and so many in all', () => {
    const all = streams({ maxRunning: 3, maxPerAccount: 2 });
    const enc = encoder();
    for (const key of ['a', 'b']) all.job(key, 1, layout(), enc.open).attach();
    expect(() => all.job('c', 1, layout(), enc.open)).toThrow(EncodeBusyError);
    all.job('d', 2, layout(), enc.open).attach();
    expect(() => all.job('e', 3, layout(), enc.open)).toThrow(EncodeBusyError);
    expect(all.counts()).toEqual({ running: 3, byAccount: new Map([[1, 2], [2, 1]]) });
  });

  it('stops a stream nobody reads any more to make room, the longest unread first', () => {
    const all = streams({ maxRunning: 2 });
    const enc = encoder();
    vi.useFakeTimers({ toFake: ['Date'] });
    const older = all.job('a', 1, layout(), enc.open);
    vi.advanceTimersByTime(1000);
    const newer = all.job('b', 2, layout(), enc.open);
    all.job('c', 3, layout(), enc.open);
    expect(older.state).toBe('failed');
    expect(newer.state).toBe('running');
    expect(enc.sources[0]!.destroyed).toBe(true);
  });

  it('makes room under an account’s own limit only by stopping its own streams', () => {
    const all = streams({ maxPerAccount: 1 });
    const enc = encoder();
    all.job('mine', 1, layout(), enc.open).attach();
    const theirs = all.job('theirs', 2, layout(), enc.open);
    expect(() => all.job('another of mine', 1, layout(), enc.open)).toThrow(EncodeBusyError);
    expect(theirs.state).toBe('running');
  });

  it('stops a stream nobody reads after a while, and encodes it again when asked', () => {
    vi.useFakeTimers();
    const all = streams({ idleMs: 10_000 });
    const enc = encoder();
    const job = all.job('a', 1, layout(), enc.open);
    job.attach();
    job.detach();
    vi.advanceTimersByTime(9_999);
    expect(job.state).toBe('running');
    vi.advanceTimersByTime(1);
    expect(job.state).toBe('failed');
    expect(all.job('a', 1, layout(), enc.open)).not.toBe(job);
    expect(enc.sources).toHaveLength(2);
  });

  it('keeps encoding a stream someone reads, however long it takes', () => {
    vi.useFakeTimers();
    const all = streams({ idleMs: 10_000 });
    const job = all.job('a', 1, layout(), encoder().open);
    job.attach();
    vi.advanceTimersByTime(60_000);
    expect(job.state).toBe('running');
  });

  it('forgets an encode that failed: the next request tries again', async () => {
    const all = streams();
    const enc = encoder();
    const job = all.job('a', 1, layout(), enc.open);
    enc.sources[0]!.destroy(new Error('ffmpeg: No such file'));
    await job.started;
    await Promise.resolve();
    expect(all.job('a', 1, layout(), enc.open)).not.toBe(job);
  });

  it('keeps finished streams up to its size, the least recently read going first', async () => {
    const enc = encoder();
    const probe = streams();
    const one = probe.job('probe', 1, layout(), enc.open);
    await finish(one, enc.sources[0]!);
    // Room for two finished streams, not three.
    const all = streams({ cacheBytes: one.bytes * 2 + 100 });
    const jobs: EncodeJob[] = [];
    for (const key of ['a', 'b']) {
      jobs.push(all.job(key, 1, layout(), enc.open));
      await finish(jobs.at(-1)!, enc.sources.at(-1)!);
    }
    // 'a' read again: 'b' is now the least recently read.
    expect(all.job('a', 1, layout(), enc.open)).toBe(jobs[0]);
    const c = all.job('c', 1, layout(), enc.open);
    await finish(c, enc.sources.at(-1)!);
    expect(all.job('a', 1, layout(), enc.open)).toBe(jobs[0]);
    expect(all.job('c', 1, layout(), enc.open)).toBe(c);
    expect(all.job('b', 1, layout(), enc.open)).not.toBe(jobs[1]);
  });

  it('says so when a stream came out shorter than it declared', async () => {
    const warn = vi.fn();
    const all = streams({ log: { warn } });
    const enc = encoder();
    const job = all.job('a', 1, layout(), enc.open);
    enc.sources[0]!.end(frames(100));
    await collect(job.read(0, job.layout.total - 1));
    expect(warn).toHaveBeenCalledWith({ key: 'a', made: 100, expected: 132 }, 'the encoder made fewer frames than the stream declared');
  });

  it('stops every encode when the server closes', () => {
    const all = streams();
    const enc = encoder();
    const job = all.job('a', 1, layout(), enc.open);
    job.attach();
    all.close();
    expect(job.state).toBe('failed');
    expect(all.counts().running).toBe(0);
  });
});
