/**
 * Fragmented MP4, as the encoded streams send it (media/encoded.ts): an init segment (ftyp, moov) that says
 * what the stream holds before a sample of it is encoded, then fragments (moof, mdat) as the encoder hands them
 * on (the first about a second, the rest about ten: see fragmentLengths), then a free box that fills the stream
 * to the length it declared at the start.
 *
 * Every box is written here, nothing from ffmpeg's own muxer, so the init segment can be known up front and
 * says exactly what every player needs to place the samples:
 *
 * - **AAC**: the encoder's priming and padding go in iTunSMPB, and there's no edit list. Measured on macOS 27
 *   (docs/server/streaming-and-art.md, Encoded streams): AudioFileStream and AVAudioFile (the iOS app's two
 *   decoders) and AVFoundation's own timeline (AVPlayer, so Safari) all trim exactly what iTunSMPB says.
 *   FFmpeg's mov demuxer reads it too, by its source (the priming as `initial_padding`, skipped as the stream
 *   starts); Chrome plays MP4 through it, but isn't measured. An edit list would be trimmed twice by
 *   AVFoundation, which takes its own 2112 samples off every AAC track first, and ignored by AudioFileStream.
 * - **Opus**: its pre-skip in dOps and the edit list the Opus-in-ISOBMFF spec asks for (AVFoundation honors it
 *   for Opus, once).
 *
 * The writer is pure and deterministic (no creation times, no tool names): the same samples always make the
 * same bytes, so a stream asked for again, or from a byte on, is byte for byte the one sent before.
 */

/** The rate every encoded stream is made at (Opus's own is 48 kHz: see OPUS_RATE). */
export const STREAM_RATE = 44_100;
/** Opus always runs at 48 kHz: its timestamps, pre-skip and packets count at this rate. */
export const OPUS_RATE = 48_000;
/** Samples in an AAC-LC frame. */
export const AAC_FRAME = 1024;
/** Samples in an Opus packet as ffmpeg's libopus makes them (20 ms at 48 kHz). */
export const OPUS_PACKET = 960;
/** A free box's header: the least padding there can be once there's any. */
export const FREE_HEADER = 8;

const u8 = (n: number) => Buffer.from([n & 0xff]);
function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}
function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

/** An ISO BMFF box: its size, its type, its contents. */
export function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
}

/** A full box: a box whose contents start with a version and 24 bits of flags. */
function fullBox(type: string, version: number, flags: number, ...parts: Buffer[]): Buffer {
  return box(type, u8(version), u8(flags >> 16), u8(flags >> 8), u8(flags), ...parts);
}

/** The identity matrix, as mvhd and tkhd carry it. */
const MATRIX = Buffer.concat([0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32));

/** AAC-LC in 44.1 kHz stereo, as an encoded stream holds it. */
export interface AacTrack {
  codec: 'aac';
  /** Samples the decoder drops at the start: the encoder's delay and the pre-roll (see media/encoded.ts). */
  priming: number;
  /** Samples of the song the stream holds, after the priming. */
  valid: number;
  /** AAC frames in the stream: the priming, the song and the encoder's padding of the last frame. */
  frames: number;
  kbps: number;
}

/** Opus in stereo (decoded at 48 kHz), as an encoded stream holds it. */
export interface OpusTrack {
  codec: 'opus';
  /** Samples (48 kHz) the decoder drops at the start: the encoder's lookahead. */
  preSkip: number;
  /** Samples (48 kHz) of the song the stream holds, after the pre-skip. */
  valid: number;
  kbps: number;
}

export type StreamTrack = AacTrack | OpusTrack;

/** The AAC frames' padding at the end: what follows the song in the last frame. */
export const aacRemainder = (t: Pick<AacTrack, 'frames' | 'priming' | 'valid'>) => t.frames * AAC_FRAME - t.priming - t.valid;

/**
 * iTunSMPB as Apple writes it (and FFmpeg reads it): a zero, the priming, the padding at the end, the song's
 * samples (16 hex digits), then eight zeros.
 */
export function itunSmpb(priming: number, remainder: number, valid: number): string {
  const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, '0');
  return [' 00000000', hex(priming, 8), hex(remainder, 8), hex(valid, 16), ...Array(8).fill('00000000')].join(' ');
}

/** An MPEG-4 descriptor: its tag, its length (in the four-byte form players expect from MP4 files), its body. */
function descriptor(tag: number, body: Buffer): Buffer {
  const n = body.length;
  return Buffer.concat([Buffer.from([tag, 0x80 | ((n >> 21) & 0x7f), 0x80 | ((n >> 14) & 0x7f), 0x80 | ((n >> 7) & 0x7f), n & 0x7f]), body]);
}

/** mp4a with its esds: AAC-LC (object type 2), 44.1 kHz (index 4), two channels. */
function mp4a(kbps: number): Buffer {
  // AudioSpecificConfig: 5 bits of object type, 4 of rate index, 4 of channel configuration, 3 of zeros.
  const asc = Buffer.from([(2 << 3) | (4 >> 1), ((4 & 1) << 7) | (2 << 3)]);
  const bitrate = kbps * 1000;
  // DecoderConfigDescriptor: MPEG-4 audio (0x40), an audio stream (0x15), no buffer size given, the most a
  // frame can take (6144 bits a channel, so 2 × 768 bytes per 1024 samples), then the average.
  const decoderConfig = descriptor(
    0x04,
    Buffer.concat([u8(0x40), u8(0x15), Buffer.alloc(3), u32(Math.ceil((2 * 768 * 8 * STREAM_RATE) / AAC_FRAME)), u32(bitrate), descriptor(0x05, asc)]),
  );
  const es = descriptor(0x03, Buffer.concat([u16(1), u8(0), decoderConfig, descriptor(0x06, u8(0x02))]));
  return box('mp4a', Buffer.alloc(6), u16(1), Buffer.alloc(8), u16(2), u16(16), u16(0), u16(0), u32(STREAM_RATE << 16), fullBox('esds', 0, 0, es));
}

/** Opus with its dOps (Opus in ISOBMFF, 4.3.2): version 0, two channels, the pre-skip, the input's rate, no gain, mapping family 0. */
function opusEntry(preSkip: number): Buffer {
  const dOps = box('dOps', u8(0), u8(2), u16(preSkip), u32(STREAM_RATE), u16(0), u8(0));
  // The sample entry's rate is 48 kHz whatever the input's, as the spec says.
  return box('Opus', Buffer.alloc(6), u16(1), Buffer.alloc(8), u16(2), u16(16), u16(0), u16(0), u32(OPUS_RATE << 16), dOps);
}

/** udta → meta → ilst with iTunSMPB, as iTunes files carry it. */
function smpbBox(text: string): Buffer {
  const item = box(
    '----',
    fullBox('mean', 0, 0, Buffer.from('com.apple.iTunes', 'latin1')),
    fullBox('name', 0, 0, Buffer.from('iTunSMPB', 'latin1')),
    box('data', u32(1), u32(0), Buffer.from(text, 'latin1')),
  );
  const handler = fullBox('hdlr', 0, 0, u32(0), Buffer.from('mdir', 'latin1'), Buffer.from('appl', 'latin1'), Buffer.alloc(9));
  return box('udta', fullBox('meta', 0, 0, handler, box('ilst', item)));
}

/**
 * The init segment: ftyp and a moov with no samples of its own (they're in the fragments), the movie's length,
 * and how the decoder trims the start and end (iTunSMPB for AAC, the edit list for Opus).
 */
export function initSegment(track: StreamTrack): Buffer {
  const aac = track.codec === 'aac';
  const timescale = aac ? STREAM_RATE : OPUS_RATE;
  const presented = track.valid;
  const ftyp = box('ftyp', Buffer.from(aac ? 'M4A ' : 'iso6', 'latin1'), u32(0), Buffer.from(aac ? 'M4A mp42isomiso6' : 'iso6isommp41Opus', 'latin1'));
  const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(timescale), u32(presented), u32(0x00010000), u16(0x0100), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(2));
  // Track enabled, in the movie and in previews.
  const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(presented), Buffer.alloc(8), u16(0), u16(0), u16(0x0100), u16(0), MATRIX, u32(0), u32(0));
  // The pre-skip, as the Opus spec has it: the presentation starts that far into the media. AAC has none (see above).
  const edts = aac ? Buffer.alloc(0) : box('edts', fullBox('elst', 0, 0, u32(1), u32(presented), u32(track.preSkip), u16(1), u16(0)));
  // Language "und", packed as three 5-bit letters.
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0));
  const hdlr = fullBox('hdlr', 0, 0, u32(0), Buffer.from('soun', 'latin1'), Buffer.alloc(12), Buffer.from('SoundHandler\0', 'latin1'));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
  const stsd = fullBox('stsd', 0, 0, u32(1), aac ? mp4a(track.kbps) : opusEntry(track.preSkip));
  const stbl = box('stbl', stsd, fullBox('stts', 0, 0, u32(0)), fullBox('stsc', 0, 0, u32(0)), fullBox('stsz', 0, 0, u32(0), u32(0)), fullBox('stco', 0, 0, u32(0)));
  const minf = box('minf', fullBox('smhd', 0, 0, u32(0)), dinf, stbl);
  const trak = box('trak', tkhd, edts, box('mdia', mdhd, hdlr, minf));
  // The fragments' samples last a frame each unless they say otherwise; the whole media's length for AAC
  // (Opus's packet count is the encoder's to decide, so it goes unsaid).
  const mehd = aac ? fullBox('mehd', 0, 0, u32(track.frames * AAC_FRAME)) : Buffer.alloc(0);
  const mvex = box('mvex', mehd, fullBox('trex', 0, 0, u32(1), u32(1), u32(aac ? AAC_FRAME : OPUS_PACKET), u32(0), u32(0)));
  const udta = aac ? smpbBox(itunSmpb(track.priming, aacRemainder(track), track.valid)) : Buffer.alloc(0);
  return Buffer.concat([ftyp, box('moov', mvhd, trak, mvex, udta)]);
}

/** The size of a fragment's moof for `samples` samples: fixed boxes, and 4 bytes per sample in the trun. */
export const moofSize = (samples: number) => 8 + 16 + 8 + 20 + 20 + 20 + 4 * samples;

/**
 * One fragment: a moof saying where the samples start in the media (`baseTime`, in the track's timescale), how
 * long each lasts (`duration`: a frame, or a packet) and how big each is, then the mdat with them.
 */
export function fragment(sequence: number, baseTime: number, duration: number, samples: Buffer[]): Buffer {
  const mfhd = fullBox('mfhd', 0, 0, u32(sequence));
  // tfhd: the data starts at the moof (default-base-is-moof), and every sample lasts `duration`.
  const tfhd = fullBox('tfhd', 0, 0x020008, u32(1), u32(duration));
  const tfdt = fullBox('tfdt', 1, 0, u64(baseTime));
  // trun: a data offset (from the moof's start to the first sample), and each sample's size.
  const size = moofSize(samples.length);
  const trun = fullBox('trun', 0, 0x000201, u32(samples.length), u32(size + 8), ...samples.map((s) => u32(s.length)));
  const moof = box('moof', mfhd, box('traf', tfhd, tfdt, trun));
  if (moof.length !== size) throw new Error(`moof is ${moof.length} bytes, not ${size}`);
  return Buffer.concat([moof, box('mdat', ...samples)]);
}

/** A free box's header, for padding `size` bytes in all (the rest of it is zeros, which needn't be kept). */
export function freeHeader(size: number): Buffer {
  if (size < FREE_HEADER) throw new RangeError(`A free box can't be ${size} bytes`);
  return Buffer.concat([u32(size), Buffer.from('free', 'latin1')]);
}
