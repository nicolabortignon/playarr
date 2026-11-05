import Fastify from 'fastify';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { LOUDNESS_RATE } from '../analysis/loudness.ts';
import type { SongLoudness } from '../analysis/loudnessJobs.ts';
import type { FileResolver } from '../catalog/files.ts';
import type { Library } from '../library/library.ts';
import type { MediaSource, PcmStreamOptions } from '../media/source.ts';
import { streamRoutes } from './stream.ts';

const SAMPLES = 2 * LOUDNESS_RATE; // a two-second song
const MEASURED: SongLoudness = { recordingId: 'rec', fileId: 7, lufs: -9, peak: -0.2, samples: SAMPLES, size: 1000, mtimeMs: 42 };

function setup(opts: { measured?: SongLoudness; codec?: string; container?: string; stat?: { size: number; mtimeMs: number } } = {}) {
  const decodes: PcmStreamOptions[] = [];
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
  } as unknown as MediaSource;
  const codec = opts.codec ?? 'FLAC';
  const container = opts.container ?? codec.toLowerCase();
  const library = { file: async (id: number) => (id === 7 ? { id: 7, sourceId: 1, path: '/music/a', size: 1000, format: { codec, container } } : undefined) } as unknown as Library;
  const files = { resolve: () => ({ media, path: '/music/a' }) } as unknown as FileResolver;
  const loudness = { loudnessOfFile: vi.fn((id: number) => (id === 7 ? opts.measured ?? MEASURED : undefined)), remeasureLoudness: vi.fn() };
  // A two-second hi-res song: 24-bit stereo at 96 kHz.
  const pcmLength = vi.fn(async () => ({ frames: 2 * 96_000, sampleRate: 96_000, channels: 2, bits: 24 }));
  const app = Fastify();
  streamRoutes(app, { library, files, loudness, pcmLength });
  return { app, decodes, loudness, pcmLength };
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
