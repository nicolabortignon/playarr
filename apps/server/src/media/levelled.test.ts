import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { LOUDNESS_RATE } from '../analysis/loudness.ts';
import { WAV_HEADER_BYTES, wavHeader, wavRange } from './levelled.ts';

/** Frame i of the fake song: both channels hold i (mod 32768), so any byte tells where it came from. */
function frames(from: number, count: number): Buffer {
  const out = Buffer.alloc(count * 4);
  for (let k = 0; k < count; k++) {
    out.writeInt16LE((from + k) % 32768, k * 4);
    out.writeInt16LE((from + k) % 32768, k * 4 + 2);
  }
  return out;
}

const read = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

/** The whole file, as it would be with a perfect decode. */
const whole = (n: number) => Buffer.concat([wavHeader(n * 4), frames(0, n)]);

describe('wavHeader', () => {
  it('describes 16-bit stereo PCM at the loudness rate', () => {
    const h = wavHeader(400);
    expect(h.toString('ascii', 0, 4)).toBe('RIFF');
    expect(h.readUInt32LE(4)).toBe(436);
    expect(h.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect([h.readUInt16LE(20), h.readUInt16LE(22), h.readUInt32LE(24), h.readUInt32LE(28), h.readUInt16LE(32), h.readUInt16LE(34)]).toEqual([
      1,
      2,
      LOUDNESS_RATE,
      LOUDNESS_RATE * 4,
      4,
      16,
    ]);
    expect(h.toString('ascii', 36, 40)).toBe('data');
    expect(h.readUInt32LE(40)).toBe(400);
  });
});

describe('wavRange', () => {
  const N = 1000;
  const decoder = (opts: { short?: number; long?: number } = {}) =>
    vi.fn((from: number, count: number) => {
      const n = Math.max(0, count - (opts.short ?? 0) + (opts.long ?? 0));
      // In pieces that split frames, as a pipe does.
      const bytes = frames(from, n);
      return Readable.from([bytes.subarray(0, 7), bytes.subarray(7)]);
    });

  it('serves the whole file: the header, then the song from its start', async () => {
    const decode = decoder();
    expect((await read(wavRange({ frames: N, start: 0, end: WAV_HEADER_BYTES + N * 4 - 1, decode }))).equals(whole(N))).toBe(true);
    expect(decode).toHaveBeenCalledWith(0, N);
  });

  it('answers a probe of the first bytes without decoding anything', async () => {
    const decode = decoder();
    expect((await read(wavRange({ frames: N, start: 0, end: 1, decode }))).equals(whole(N).subarray(0, 2))).toBe(true);
    expect(decode).not.toHaveBeenCalled();
  });

  it('serves a range from the middle of a frame, decoding from that frame on', async () => {
    const decode = decoder();
    const start = WAV_HEADER_BYTES + 401 * 4 + 3;
    const end = WAV_HEADER_BYTES + 600 * 4 + 1;
    expect((await read(wavRange({ frames: N, start, end, decode }))).equals(whole(N).subarray(start, end + 1))).toBe(true);
    expect(decode).toHaveBeenCalledWith(401, 200);
  });

  it('keeps the length the header says: silence where the decode ends early, cut where it runs on', async () => {
    const end = WAV_HEADER_BYTES + N * 4 - 1;
    const short = await read(wavRange({ frames: N, start: 0, end, decode: decoder({ short: 10 }) }));
    expect(short.length).toBe(end + 1);
    expect(short.subarray(end + 1 - 40).equals(Buffer.alloc(40))).toBe(true);
    const long = await read(wavRange({ frames: N, start: 0, end, decode: decoder({ long: 10 }) }));
    expect(long.equals(whole(N))).toBe(true);
  });

  it('stops decoding when the listener goes away', async () => {
    let decoded: Readable | undefined;
    const stream = wavRange({
      frames: N,
      start: WAV_HEADER_BYTES,
      end: WAV_HEADER_BYTES + N * 4 - 1,
      decode: () => (decoded = new Readable({ read() {} })),
    });
    stream.resume();
    await vi.waitFor(() => expect(decoded).toBeDefined());
    stream.destroy();
    await vi.waitFor(() => expect(decoded!.destroyed).toBe(true));
  });
});
