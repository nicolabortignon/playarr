import { describe, expect, it } from 'vitest';
import { readAlacInfo } from './mp4.ts';

const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const u32 = (n: number) => Buffer.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

/** An MP4 file holding one Apple Lossless track, the audio (mdat) before or after its tables (moov). */
function alacFile(opts: { sampleRate: number; bits: number; channels: number; timescale: number; duration: number; mdatFirst?: boolean; codec?: string; mdhdVersion?: 0 | 1 }) {
  const config = Buffer.alloc(28);
  config.writeUInt32BE(4096, 4); // frame length
  config.writeUInt8(opts.bits, 9);
  config.writeUInt8(opts.channels, 13);
  config.writeUInt32BE(opts.sampleRate, 24);
  // The sound description's own rate is 16.16 fixed point: a 96 kHz file can't say so there.
  const description = Buffer.alloc(28);
  description.writeUInt16BE(1, 6); // data reference
  description.writeUInt16BE(2, 16); // channels
  description.writeUInt16BE(16, 18); // sample size
  description.writeUInt32BE((Math.min(opts.sampleRate, 65535) * 65536) >>> 0, 24);
  const entry = box(opts.codec ?? 'alac', description, box('alac', config));
  const mdhd =
    opts.mdhdVersion === 1
      ? box('mdhd', Buffer.from([1, 0, 0, 0]), Buffer.alloc(16), u32(opts.timescale), u32(0), u32(opts.duration), Buffer.alloc(4))
      : box('mdhd', Buffer.alloc(4), Buffer.alloc(8), u32(opts.timescale), u32(opts.duration), Buffer.alloc(4));
  const moov = box(
    'moov',
    box('mvhd', Buffer.alloc(100)),
    box('trak', box('tkhd', Buffer.alloc(84)), box('mdia', mdhd, box('hdlr', Buffer.alloc(25)), box('minf', box('stbl', box('stsd', Buffer.alloc(4), u32(1), entry))))),
  );
  const mdat = box('mdat', Buffer.alloc(5000, 7));
  const ftyp = box('ftyp', Buffer.from('M4A \0\0\0\0M4A isom', 'latin1'));
  return Buffer.concat(opts.mdatFirst ? [ftyp, mdat, moov] : [ftyp, moov, mdat]);
}

/** Reads of the file, counted. */
function reader(file: Buffer) {
  const reads: [number, number][] = [];
  return { reads, read: async (start: number, end: number) => (reads.push([start, end]), file.subarray(start, end + 1)) };
}

describe('readAlacInfo', () => {
  it('reads a hi-res file’s rate, depth and length from its own config, not the sound description', async () => {
    const file = alacFile({ sampleRate: 96_000, bits: 24, channels: 2, timescale: 96_000, duration: 240_007 });
    expect(await readAlacInfo(reader(file).read, file.length)).toEqual({ frames: 240_007, sampleRate: 96_000, bits: 24, channels: 2 });
  });

  it('skips over the audio to the tables after it, reading only box headers on the way', async () => {
    const file = alacFile({ sampleRate: 44_100, bits: 16, channels: 2, timescale: 44_100, duration: 110_257, mdatFirst: true });
    const { read, reads } = reader(file);
    expect((await readAlacInfo(read, file.length))?.frames).toBe(110_257);
    expect(reads.every(([start, end]) => end - start < 1000)).toBe(true);
  });

  it('scales a duration kept in another timescale, and reads a 64-bit media header', async () => {
    const file = alacFile({ sampleRate: 48_000, bits: 16, channels: 1, timescale: 600, duration: 1500, mdhdVersion: 1 });
    expect(await readAlacInfo(reader(file).read, file.length)).toEqual({ frames: 120_000, sampleRate: 48_000, bits: 16, channels: 1 });
  });

  it('says nothing of a file that isn’t Apple Lossless', async () => {
    const file = alacFile({ sampleRate: 44_100, bits: 16, channels: 2, timescale: 44_100, duration: 1, codec: 'mp4a' });
    expect(await readAlacInfo(reader(file).read, file.length)).toBeNull();
    expect(await readAlacInfo(reader(Buffer.from('not an mp4 file at all')).read, 22)).toBeNull();
  });
});
