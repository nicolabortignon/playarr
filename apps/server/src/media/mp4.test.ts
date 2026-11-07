import { describe, expect, it } from 'vitest';
import { aacRemainder, fragment, freeHeader, initSegment, itunSmpb, moofSize, type AacTrack, type OpusTrack } from './mp4.ts';

/** A box as the tests read it: its type, where it starts, its size, and its contents' bytes. */
interface Box {
  type: string;
  start: number;
  size: number;
  body: Buffer;
}

/** The boxes in `bytes`, one level deep. */
function boxes(bytes: Buffer, from = 0): Box[] {
  const out: Box[] = [];
  let at = 0;
  while (at < bytes.length) {
    const size = bytes.readUInt32BE(at);
    expect(size).toBeGreaterThanOrEqual(8);
    out.push({ type: bytes.toString('latin1', at + 4, at + 8), start: from + at, size, body: bytes.subarray(at + 8, at + size) });
    at += size;
  }
  expect(at).toBe(bytes.length);
  return out;
}

/** How far into a box its children start: past a full box's version and flags, or a sample entry's own fields. */
const CHILDREN_AT: Record<string, number> = { meta: 4, stsd: 8, mp4a: 28, Opus: 28 };

/** The box at `path` (types separated by slashes), looking into each box on the way. */
function find(bytes: Buffer, path: string): Box | undefined {
  let found: Box | undefined;
  let within = bytes;
  for (const type of path.split('/')) {
    found = boxes(within).find((b) => b.type === type);
    if (!found) return undefined;
    within = found.body.subarray(CHILDREN_AT[type] ?? 0);
  }
  return found;
}

const AAC: AacTrack = { codec: 'aac', priming: 2112, valid: 529_200, frames: 519, kbps: 128 };
const OPUS: OpusTrack = { codec: 'opus', preSkip: 312, valid: 576_000, kbps: 128 };

describe('iTunSMPB', () => {
  it('is written as Apple writes it: priming, padding and length in hex, then zeros', () => {
    expect(itunSmpb(2112, 144, 529_200)).toBe(' 00000000 00000840 00000090 0000000000081330 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000');
  });

  it('counts the padding as what’s left of the last frame after the song', () => {
    expect(aacRemainder(AAC)).toBe(519 * 1024 - 2112 - 529_200);
    expect(aacRemainder({ frames: 3, priming: 2112, valid: 960 })).toBe(0);
  });
});

describe('init segment (AAC)', () => {
  const init = initSegment(AAC);

  it('is an M4A file’s ftyp and a moov, nothing else', () => {
    expect(boxes(init).map((b) => b.type)).toEqual(['ftyp', 'moov']);
    expect(find(init, 'ftyp')!.body.toString('latin1', 0, 4)).toBe('M4A ');
  });

  it('carries the priming, padding and length in iTunSMPB, and no edit list', () => {
    const item = find(init, 'moov/udta/meta/ilst/----')!;
    const parts = boxes(item.body);
    expect(parts.map((b) => b.type)).toEqual(['mean', 'name', 'data']);
    expect(parts[0]!.body.toString('latin1', 4)).toBe('com.apple.iTunes');
    expect(parts[1]!.body.toString('latin1', 4)).toBe('iTunSMPB');
    expect(parts[2]!.body.toString('latin1', 8)).toBe(itunSmpb(2112, 144, 529_200));
    expect(find(init, 'moov/trak/edts')).toBeUndefined();
  });

  it('says how long the song is, and how long its frames are', () => {
    const mvhd = find(init, 'moov/mvhd')!.body;
    expect([mvhd.readUInt32BE(12), mvhd.readUInt32BE(16)]).toEqual([44_100, 529_200]);
    const mdhd = find(init, 'moov/trak/mdia/mdhd')!.body;
    expect(mdhd.readUInt32BE(12)).toBe(44_100);
    const mehd = find(init, 'moov/mvex/mehd')!.body;
    expect(mehd.readUInt32BE(4)).toBe(519 * 1024);
    const trex = find(init, 'moov/mvex/trex')!.body;
    // Track 1, the first sample description, a frame per sample.
    expect([trex.readUInt32BE(4), trex.readUInt32BE(8), trex.readUInt32BE(12)]).toEqual([1, 1, 1024]);
  });

  it('describes AAC-LC at 44.1 kHz in stereo', () => {
    const mp4a = find(init, 'moov/trak/mdia/minf/stbl/stsd/mp4a')!.body;
    expect([mp4a.readUInt16BE(16), mp4a.readUInt16BE(18), mp4a.readUInt32BE(24) >>> 16]).toEqual([2, 16, 44_100]);
    const esds = find(init, 'moov/trak/mdia/minf/stbl/stsd/mp4a/esds')!.body;
    // The AudioSpecificConfig, at the end of the decoder config: object type 2, rate index 4, two channels.
    const asc = esds.indexOf(Buffer.from([0x05, 0x80, 0x80, 0x80, 0x02]));
    expect([...esds.subarray(asc + 5, asc + 7)]).toEqual([0x12, 0x10]);
    // The average bitrate, after the object type (0x40), the stream type (0x15), the buffer size and the maximum.
    const config = esds.indexOf(Buffer.from([0x04, 0x80, 0x80, 0x80]));
    expect(esds[config + 5]).toBe(0x40);
    expect(esds.readUInt32BE(config + 5 + 9)).toBe(128_000);
  });

  it('has no samples of its own: they are in the fragments', () => {
    for (const type of ['stts', 'stsc', 'stco']) expect(find(init, `moov/trak/mdia/minf/stbl/${type}`)!.body.readUInt32BE(4)).toBe(0);
    expect(find(init, 'moov/trak/mdia/minf/stbl/stsz')!.body.readUInt32BE(8)).toBe(0);
  });

  it('is the same bytes every time', () => {
    expect(initSegment({ ...AAC }).equals(init)).toBe(true);
    expect(initSegment({ ...AAC, valid: AAC.valid - 1 }).equals(init)).toBe(false);
  });
});

describe('init segment (Opus)', () => {
  const init = initSegment(OPUS);

  it('carries the pre-skip in dOps and in the edit list, at 48 kHz', () => {
    const dOps = find(init, 'moov/trak/mdia/minf/stbl/stsd/Opus/dOps')!.body;
    // Version 0, two channels, the pre-skip, the input's rate, no gain, mapping family 0.
    expect([dOps[0], dOps[1], dOps.readUInt16BE(2), dOps.readUInt32BE(4), dOps.readInt16BE(8), dOps[10]]).toEqual([0, 2, 312, 44_100, 0, 0]);
    const elst = find(init, 'moov/trak/edts/elst')!.body;
    // One entry: the song's length, from the pre-skip on, at normal rate.
    expect([elst.readUInt32BE(4), elst.readUInt32BE(8), elst.readUInt32BE(12), elst.readUInt16BE(16)]).toEqual([1, 576_000, 312, 1]);
    expect(find(init, 'moov/trak/mdia/mdhd')!.body.readUInt32BE(12)).toBe(48_000);
    expect(find(init, 'moov/mvex/trex')!.body.readUInt32BE(12)).toBe(960);
  });

  it('has no iTunSMPB', () => {
    expect(find(init, 'moov/udta')).toBeUndefined();
  });
});

describe('fragments', () => {
  const samples = [Buffer.from('first frame'), Buffer.from('second'), Buffer.from('3')];
  const bytes = fragment(7, 3 * 1024, 1024, samples);

  it('is a moof of the size moofSize says, then the samples in an mdat', () => {
    const [moof, mdat] = boxes(bytes);
    expect(moof!.type).toBe('moof');
    expect(moof!.size).toBe(moofSize(3));
    expect(mdat!.type).toBe('mdat');
    expect(mdat!.body.toString()).toBe('first framesecond3');
  });

  it('says where its samples start in the media, how long each lasts and how big each is', () => {
    const traf = boxes(boxes(boxes(bytes)[0]!.body)[1]!.body);
    expect(traf.map((b) => b.type)).toEqual(['tfhd', 'tfdt', 'trun']);
    const [tfhd, tfdt, trun] = traf.map((b) => b.body);
    // default-base-is-moof and a default duration; track 1; a frame each.
    expect([tfhd!.readUInt32BE(0) & 0xffffff, tfhd!.readUInt32BE(4), tfhd!.readUInt32BE(8)]).toEqual([0x020008, 1, 1024]);
    expect([tfdt![0], Number(tfdt!.readBigUInt64BE(4))]).toEqual([1, 3 * 1024]);
    // Data offset and sample sizes; the offset points past the moof and the mdat's header, at the first sample.
    expect(trun!.readUInt32BE(0) & 0xffffff).toBe(0x000201);
    expect([trun!.readUInt32BE(4), trun!.readUInt32BE(8)]).toEqual([3, moofSize(3) + 8]);
    expect([trun!.readUInt32BE(12), trun!.readUInt32BE(16), trun!.readUInt32BE(20)]).toEqual([11, 6, 1]);
    expect(bytes.toString('latin1', trun!.readUInt32BE(8), trun!.readUInt32BE(8) + 11)).toBe('first frame');
  });

  it('numbers itself', () => {
    const mfhd = boxes(boxes(bytes)[0]!.body)[0]!;
    expect([mfhd.type, mfhd.body.readUInt32BE(4)]).toEqual(['mfhd', 7]);
  });
});

describe('free box', () => {
  it('starts with its size and type; it can’t be smaller than its header', () => {
    expect(freeHeader(4096)).toEqual(Buffer.from([0, 0, 0x10, 0, 0x66, 0x72, 0x65, 0x65]));
    expect(() => freeHeader(7)).toThrow(RangeError);
  });
});
