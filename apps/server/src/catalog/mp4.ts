/**
 * What an Apple Lossless file says about its audio in its own config box. music-metadata reads the MP4's generic
 * sample entry instead, whose sample rate field stops at 65535 Hz (a 96 kHz file reads as 44.1) and whose sample size
 * is 16 whatever the depth.
 */
export interface AlacInfo {
  /** Sample frames, from the audio track's duration. */
  frames: number;
  sampleRate: number;
  bits: number;
  channels: number;
}

/** Bytes `start` to `end` (inclusive) of the file; fewer at its end. */
export type ReadBytes = (start: number, end: number) => Promise<Buffer>;

/** The most of a moov box read: its tables for an album-length file are well under a megabyte. */
const MAX_MOOV_BYTES = 32 * 1024 * 1024;

/** The boxes in `buf` from `from` to `to`, as [type, start of its contents, end]. */
function* boxes(buf: Buffer, from = 0, to = buf.length): Generator<[string, number, number]> {
  let at = from;
  while (at + 8 <= to) {
    let size = buf.readUInt32BE(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) return;
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) return;
    yield [buf.toString('latin1', at + 4, at + 8), at + header, at + size];
    at += size;
  }
}

const child = (buf: Buffer, type: string, from: number, to: number) => [...boxes(buf, from, to)].find(([t]) => t === type);

/** The first track of an MP4 file coded as Apple Lossless, from its moov box; null for anything else. */
export async function readAlacInfo(read: ReadBytes, size: number): Promise<AlacInfo | null> {
  let moov: Buffer | undefined;
  // The top-level boxes, by their headers only: the audio (mdat) can come before moov, and is skipped over.
  for (let at = 0; at + 8 <= size; ) {
    const head = await read(at, Math.min(at + 15, size - 1));
    if (head.length < 8) return null;
    let box = head.readUInt32BE(0);
    if (box === 1 && head.length >= 16) box = Number(head.readBigUInt64BE(8));
    else if (box === 0) box = size - at;
    if (box < 8) return null;
    if (head.toString('latin1', 4, 8) === 'moov') {
      if (box > MAX_MOOV_BYTES) return null;
      moov = await read(at, at + box - 1);
      break;
    }
    at += box;
  }
  if (!moov) return null;
  const [, from, to] = [...boxes(moov)][0]!;
  for (const [type, start, end] of boxes(moov, from, to)) {
    if (type !== 'trak') continue;
    const mdia = child(moov, 'mdia', start, end);
    if (!mdia) continue;
    const mdhd = child(moov, 'mdhd', mdia[1], mdia[2]);
    const stsd = ['minf', 'stbl', 'stsd'].reduce<[string, number, number] | undefined>((box, t) => box && child(moov, t, box[1], box[2]), mdia);
    if (!mdhd || !stsd) continue;
    // stsd: version and flags, an entry count, then the sample entries.
    const entry = [...boxes(moov, stsd[1] + 8, stsd[2])][0];
    if (entry?.[0] !== 'alac') continue;
    // An audio sample entry: 8 bytes of reserved and data reference, 20 of the sound description (QuickTime's version
    // 1 adds 16, version 2 36), then its boxes.
    const version = moov.readUInt16BE(entry[1] + 8);
    const config = child(moov, 'alac', entry[1] + 28 + ([0, 16, 36][version] ?? 0), entry[2]);
    // The config: version and flags, then frame length (4), compatible version (1), bit depth, three tuning bytes,
    // channels, max run (2), max frame bytes (4), average bit rate (4), sample rate (4).
    if (!config || config[2] - config[1] < 28) continue;
    const c = config[1] + 4;
    const bits = moov.readUInt8(c + 5);
    const channels = moov.readUInt8(c + 9);
    const sampleRate = moov.readUInt32BE(c + 20);
    const v1 = moov.readUInt8(mdhd[1]) === 1;
    const timescale = moov.readUInt32BE(mdhd[1] + (v1 ? 20 : 12));
    const duration = v1 ? Number(moov.readBigUInt64BE(mdhd[1] + 24)) : moov.readUInt32BE(mdhd[1] + 16);
    if (!sampleRate || !timescale || !bits || !channels) return null;
    return { frames: Math.round((duration * sampleRate) / timescale), sampleRate, bits, channels };
  }
  return null;
}
