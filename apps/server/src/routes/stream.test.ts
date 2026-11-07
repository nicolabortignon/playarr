import Fastify from 'fastify';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { LOUDNESS_RATE } from '../analysis/loudness.ts';
import type { SongLoudness } from '../analysis/loudnessJobs.ts';
import type { FileResolver } from '../catalog/files.ts';
import type { Library } from '../library/library.ts';
import { EncodedStreams, PRE_ROLL, streamLayout } from '../media/encoded.ts';
import type { EncodeOptions, MediaSource, PcmStreamOptions } from '../media/source.ts';
import { streamRoutes } from './stream.ts';

const SAMPLES = 2 * LOUDNESS_RATE; // a two-second song
const MEASURED: SongLoudness = { recordingId: 'rec', fileId: 7, lufs: -9, peak: -0.2, samples: SAMPLES, size: 1000, mtimeMs: 42 };

/**
 * A stand-in for ffmpeg's AAC encoder: as many ADTS frames as it makes from what it's fed (its 1024 samples of
 * delay, then the samples), each a hundred bytes.
 */
function fakeAac(o: EncodeOptions): Readable {
  const count = Math.ceil((1024 + o.samples) / 1024);
  const frame = Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80, (107 >> 3) & 0xff, ((107 & 7) << 5) | 0x1f, 0xfc]), Buffer.alloc(100, 0xaa)]);
  return Readable.from([Buffer.concat(Array(count).fill(frame))]);
}

function setup(
  opts: {
    measured?: SongLoudness | null;
    codec?: string;
    container?: string;
    stat?: { size: number; mtimeMs: number };
    encode?: ((o: EncodeOptions) => Readable) | null;
    encoded?: EncodedStreams | null;
    pcmLength?: { frames: number; sampleRate: number; channels: number; bits: number } | null;
  } = {},
) {
  const decodes: PcmStreamOptions[] = [];
  const encodes: EncodeOptions[] = [];
  const encode = opts.encode === undefined ? fakeAac : opts.encode;
  const media = {
    kind: 'local',
    open: async () => Readable.from([Buffer.from('the file itself')]),
    stat: async () => opts.stat ?? { size: 1000, mtimeMs: 42 },
    pcmStream: vi.fn((_path: string, o: PcmStreamOptions) => {
      decodes.push(o);
      // What's left of the song from where the decode starts, all 1s.
      const rate = o.sampleRate;
      const from = Math.round((o.startSeconds ?? 0) * rate);
      return Readable.from([Buffer.alloc((2 * rate - from) * ((o.channels ?? 1) * (o.bits ?? 16)) / 8, 1)]);
    }),
    ...(encode
      ? {
          encodedStream: vi.fn((_path: string, o: EncodeOptions) => {
            encodes.push(o);
            return encode(o);
          }),
        }
      : {}),
  } as unknown as MediaSource;
  const codec = opts.codec ?? 'FLAC';
  const container = opts.container ?? codec.toLowerCase();
  const library = { file: async (id: number) => (id === 7 ? { id: 7, sourceId: 1, path: '/music/a', size: 1000, format: { codec, container } } : undefined) } as unknown as Library;
  const files = { resolve: () => ({ media, path: '/music/a' }) } as unknown as FileResolver;
  const measured = opts.measured === undefined ? MEASURED : opts.measured;
  const loudness = { loudnessOfFile: vi.fn((id: number) => (id === 7 ? measured ?? undefined : undefined)), remeasureLoudness: vi.fn() };
  // A two-second hi-res song: 24-bit stereo at 96 kHz.
  const header = opts.pcmLength !== undefined ? opts.pcmLength : { frames: 2 * 96_000, sampleRate: 96_000, channels: 2, bits: 24 };
  const pcmLength = vi.fn(async () => header);
  const encoded = opts.encoded === undefined ? new EncodedStreams({ maxRunning: 8, maxPerAccount: 4, cacheBytes: 1024 * 1024 }) : (opts.encoded ?? undefined);
  const app = Fastify();
  streamRoutes(app, { library, files, loudness, pcmLength, ...(encoded ? { encoded } : {}) });
  return { app, decodes, encodes, loudness, pcmLength, media };
}

describe('levelled stream', () => {
  it('serves the song as a WAV file exactly as long as measured, turned by the gain asked for', async () => {
    const { app, decodes } = setup();
    const res = await app.inject({ url: '/stream/7/levelled.wav?gain=-5.5' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(Number(res.headers['content-length'])).toBe(44 + SAMPLES * 4);
    expect(res.rawPayload.length).toBe(44 + SAMPLES * 4);
    expect(res.rawPayload.toString('ascii', 0, 4)).toBe('RIFF');
    expect(decodes).toEqual([expect.objectContaining({ sampleRate: LOUDNESS_RATE, channels: 2, gainDb: -5.5, priority: 'normal' })]);
    expect(decodes[0]).not.toHaveProperty('startSeconds');
  });

  it('serves a range from where it’s asked, decoding from that sample', async () => {
    const { app, decodes } = setup();
    const start = 44 + LOUDNESS_RATE * 4; // one second in
    const res = await app.inject({ url: '/stream/7/levelled.wav?gain=2', headers: { range: `bytes=${start}-` } });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes ${start}-${43 + SAMPLES * 4}/${44 + SAMPLES * 4}`);
    expect(res.rawPayload.length).toBe(LOUDNESS_RATE * 4);
    expect(decodes[0]).toMatchObject({ startSeconds: 1, gainDb: 2 });
    expect(decodes[0]).not.toHaveProperty('exactSeek');
  });

  it('decodes an MP3 from its start for a range, as its seeking lands only near the time asked', async () => {
    const { app, decodes } = setup({ codec: 'MP3' });
    await app.inject({ url: '/stream/7/levelled.wav?gain=0', headers: { range: `bytes=${44 + 4000}-` } });
    expect(decodes[0]).toMatchObject({ startSeconds: 1000 / LOUDNESS_RATE, exactSeek: true });
  });

  it('says so for a song not measured yet, or a gain no song needs', async () => {
    const { app } = setup();
    expect((await app.inject({ url: '/stream/8/levelled.wav?gain=1' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/stream/7/levelled.wav?gain=50' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/stream/7/levelled.wav?gain=loud' })).statusCode).toBe(400);
  });

  it('measures a song again whose file changed since, and doesn’t serve it by the old length', async () => {
    const { app, loudness, decodes } = setup({ stat: { size: 2000, mtimeMs: 43 } });
    expect((await app.inject({ url: '/stream/7/levelled.wav?gain=1' })).statusCode).toBe(404);
    expect(loudness.remeasureLoudness).toHaveBeenCalledWith('rec');
    expect(decodes).toEqual([]);
  });
});

describe('Apple Lossless and AIFF as WAV, for browsers that can’t play them', () => {
  const WAV_BYTES = 44 + 2 * 96_000 * 6;

  it('serves the song as a WAV at its own rate and depth', async () => {
    const { app, decodes } = setup({ codec: 'ALAC', container: 'm4a' });
    const res = await app.inject({ url: '/stream/7/lossless.wav' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(Number(res.headers['content-length'])).toBe(WAV_BYTES);
    expect(res.rawPayload.length).toBe(WAV_BYTES);
    const header = res.rawPayload;
    expect([header.readUInt16LE(22), header.readUInt32LE(24), header.readUInt16LE(34)]).toEqual([2, 96_000, 24]);
    expect(decodes).toEqual([expect.objectContaining({ sampleRate: 96_000, channels: 2, bits: 24, priority: 'normal' })]);
  });

  it('seeks by decoding from the sample a range starts at', async () => {
    const { app, decodes } = setup({ codec: 'ALAC', container: 'm4a' });
    const start = 44 + 96_000 * 6; // one second in
    const res = await app.inject({ url: '/stream/7/lossless.wav', headers: { range: `bytes=${start}-` } });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes ${start}-${WAV_BYTES - 1}/${WAV_BYTES}`);
    expect(decodes[0]).toMatchObject({ startSeconds: 1 });
  });

  it('reads a file’s length once, not on every range', async () => {
    const { app, pcmLength } = setup({ codec: 'ALAC', container: 'm4a' });
    await app.inject({ url: '/stream/7/lossless.wav' });
    await app.inject({ url: '/stream/7/lossless.wav', headers: { range: 'bytes=100-' } });
    expect(pcmLength).toHaveBeenCalledTimes(1);
  });

  it('tells AIFF by its container', async () => {
    const { app } = setup({ codec: 'PCM', container: 'aiff' });
    expect((await app.inject({ url: '/stream/7/lossless.wav' })).headers['content-type']).toBe('audio/wav');
  });

  it('leaves every other format, and the file itself, as they are', async () => {
    const flac = setup({ codec: 'FLAC' });
    expect((await flac.app.inject({ url: '/stream/7/lossless.wav' })).statusCode).toBe(404);
    const alac = setup({ codec: 'ALAC', container: 'm4a' });
    expect((await alac.app.inject({ url: '/stream/7' })).payload).toBe('the file itself');
  });
});

describe('encoded streams', () => {
  const total = (kbps: 128 | 256, valid: number) => streamLayout('aac', kbps, valid).total;

  it('serves the song as AAC in fragmented MP4, a file of a length known before it’s encoded', async () => {
    const { app, encodes } = setup();
    const res = await app.inject({ url: '/stream/7/aac?kbps=128' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mp4');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(Number(res.headers['content-length'])).toBe(total(128, SAMPLES));
    expect(res.rawPayload.length).toBe(total(128, SAMPLES));
    expect(res.rawPayload.toString('latin1', 4, 12)).toBe('ftypM4A ');
    // The pre-roll before the song's first sample is silence; the song from its start, at the stream's length.
    expect(encodes).toEqual([{ codec: 'aac', kbps: 128, skipSamples: 0, leadSamples: PRE_ROLL, samples: PRE_ROLL + SAMPLES, priority: 'normal' }]);
  });

  it('answers byte ranges as a file does', async () => {
    const { app } = setup();
    const size = total(128, SAMPLES);
    const whole = (await app.inject({ url: '/stream/7/aac' })).rawPayload;
    // A player's first look: two bytes.
    const probe = await app.inject({ url: '/stream/7/aac', headers: { range: 'bytes=0-1' } });
    expect(probe.statusCode).toBe(206);
    expect(probe.headers['content-range']).toBe(`bytes 0-1/${size}`);
    expect(probe.rawPayload.equals(whole.subarray(0, 2))).toBe(true);
    const middle = await app.inject({ url: '/stream/7/aac', headers: { range: 'bytes=1000-' } });
    expect(middle.statusCode).toBe(206);
    expect(middle.headers['content-range']).toBe(`bytes 1000-${size - 1}/${size}`);
    expect(middle.rawPayload.equals(whole.subarray(1000))).toBe(true);
    const past = await app.inject({ url: '/stream/7/aac', headers: { range: `bytes=${size}-` } });
    expect(past.statusCode).toBe(416);
    expect(past.headers['content-range']).toBe(`bytes */${size}`);
  });

  it('streams from a sample on, at High, and levelled at the gain asked for', async () => {
    const { app, encodes } = setup();
    const res = await app.inject({ url: '/stream/7/levelled.aac?gain=-6.5&kbps=256&start=44100' });
    expect(res.statusCode).toBe(200);
    expect(Number(res.headers['content-length'])).toBe(total(256, SAMPLES - 44_100));
    // The pre-roll starts at 44100 − 1088 = 43012: decoded from 0.97 s (on the 10 ms grid), 235 samples dropped.
    expect(encodes).toEqual([
      { codec: 'aac', kbps: 256, seekSeconds: 0.97, skipSamples: 235, leadSamples: 0, samples: PRE_ROLL + SAMPLES - 44_100, gainDb: -6.5, priority: 'normal' },
    ]);
  });

  it('decodes an MP3 from its start for a stream from a sample on, as its seeking lands only near a time', async () => {
    const { app, encodes } = setup({ codec: 'MP3' });
    await app.inject({ url: '/stream/7/aac?start=44100' });
    expect(encodes[0]).toMatchObject({ skipSamples: 44_100 - PRE_ROLL, leadSamples: 0 });
    expect(encodes[0]).not.toHaveProperty('seekSeconds');
  });

  it('isn’t levelled unless asked: the plain stream ignores a gain', async () => {
    const { app, encodes } = setup();
    await app.inject({ url: '/stream/7/aac?gain=-6' });
    expect(encodes[0]).not.toHaveProperty('gainDb');
  });

  it('encodes a stream once for everyone asking for it, and serves it again from memory', async () => {
    const { app, encodes } = setup();
    const [a, b] = await Promise.all([app.inject({ url: '/stream/7/aac' }), app.inject({ url: '/stream/7/aac', headers: { range: 'bytes=500-' } })]);
    expect(b.rawPayload.equals(a.rawPayload.subarray(500))).toBe(true);
    await app.inject({ url: '/stream/7/aac' });
    expect(encodes).toHaveLength(1);
  });

  it('answers HEAD and a matching ETag without encoding', async () => {
    const { app, encodes } = setup();
    const head = await app.inject({ method: 'HEAD', url: '/stream/7/aac' });
    expect(head.statusCode).toBe(200);
    expect(Number(head.headers['content-length'])).toBe(total(128, SAMPLES));
    const etag = String(head.headers.etag);
    expect((await app.inject({ url: '/stream/7/aac', headers: { 'if-none-match': etag } })).statusCode).toBe(304);
    expect(encodes).toEqual([]);
  });

  it('gives each stream its own ETag: another bitrate, start, gain or version of the file is another stream', async () => {
    const etag = async (url: string, stat?: { size: number; mtimeMs: number }) =>
      (await setup(stat ? { stat, measured: null } : {}).app.inject({ method: 'HEAD', url })).headers.etag;
    const tags = new Set([
      await etag('/stream/7/aac'),
      await etag('/stream/7/aac?kbps=256'),
      await etag('/stream/7/aac?start=100'),
      await etag('/stream/7/levelled.aac?gain=-3'),
      await etag('/stream/7/aac', { size: 2000, mtimeMs: 43 }),
    ]);
    expect(tags.size).toBe(5);
  });

  it('refuses a bitrate, start or gain it doesn’t offer', async () => {
    const { app } = setup();
    for (const url of ['/stream/7/aac?kbps=192', '/stream/7/aac?start=-1', '/stream/7/aac?start=1.5', '/stream/7/levelled.aac?gain=50', `/stream/7/aac?start=${SAMPLES}`]) {
      expect((await app.inject({ url })).statusCode, url).toBe(400);
    }
  });

  it('reads the length from the file’s header when its loudness isn’t measured from this version of it', async () => {
    const { app, loudness } = setup({ stat: { size: 2000, mtimeMs: 43 }, pcmLength: { frames: 3 * 48_000, sampleRate: 48_000, channels: 2, bits: 16 } });
    const res = await app.inject({ method: 'HEAD', url: '/stream/7/aac' });
    expect(Number(res.headers['content-length'])).toBe(total(128, 3 * 44_100));
    expect(loudness.remeasureLoudness).toHaveBeenCalledWith('rec');
  });

  it('says so when it can’t encode: no encoder, a source that can’t, a length nobody knows', async () => {
    expect((await setup({ encoded: null }).app.inject({ url: '/stream/7/aac' })).statusCode).toBe(404);
    expect((await setup({ encode: null }).app.inject({ url: '/stream/7/aac' })).statusCode).toBe(404);
    expect((await setup({ measured: null, pcmLength: null }).app.inject({ url: '/stream/7/aac' })).statusCode).toBe(404);
    expect((await setup().app.inject({ url: '/stream/8/aac' })).statusCode).toBe(404);
  });

  it('answers 502 when the song can’t be encoded, rather than a stream that stops', async () => {
    const failing = () =>
      Readable.from(
        (async function* () {
          yield* [];
          throw new Error('ffmpeg: Invalid data found');
        })(),
      );
    const { app } = setup({ encode: failing });
    const res = await app.inject({ url: '/stream/7/aac' });
    expect(res.statusCode, res.payload).toBe(502);
    expect(res.json().error).toBe('This song couldn’t be encoded: ffmpeg: Invalid data found');
  });

  it('answers 503, to ask again in a moment, when the account is encoding all it may', async () => {
    const sources: PassThrough[] = [];
    const encoded = new EncodedStreams({ maxRunning: 8, maxPerAccount: 1, cacheBytes: 1024 * 1024 });
    const { app } = setup({
      encoded,
      encode: () => {
        const source = new PassThrough();
        sources.push(source);
        return source;
      },
    });
    // Someone is listening to one stream, still being encoded.
    const listening = app.inject({ url: '/stream/7/aac' });
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    const another = await app.inject({ url: '/stream/7/aac?start=1000' });
    expect(another.statusCode, another.payload).toBe(503);
    expect(another.headers['retry-after']).toBe('5');
    sources[0]!.end(fakeAac({ codec: 'aac', kbps: 128, skipSamples: 0, leadSamples: PRE_ROLL, samples: PRE_ROLL + SAMPLES }).read());
    expect((await listening).statusCode).toBe(200);
  });

  it('serves Opus as well, for a player that asks for it', async () => {
    const { app, encodes } = setup({ encode: () => new PassThrough() });
    await app.inject({ url: '/stream/7/opus?kbps=256', headers: { range: 'bytes=0-1' } });
    expect(encodes).toEqual([{ codec: 'opus', kbps: 256, skipSamples: 0, leadSamples: 0, samples: SAMPLES, priority: 'normal' }]);
    const head = await app.inject({ method: 'HEAD', url: '/stream/7/levelled.opus?gain=2' });
    expect(Number(head.headers['content-length'])).toBe(streamLayout('opus', 128, SAMPLES).total);
  });

  it('leaves the routes shipped apps use as they were', async () => {
    const { app } = setup();
    expect((await app.inject({ url: '/stream/7' })).payload).toBe('the file itself');
    expect((await app.inject({ url: '/stream/7/levelled.wav?gain=-2' })).headers['content-type']).toBe('audio/wav');
  });
});
