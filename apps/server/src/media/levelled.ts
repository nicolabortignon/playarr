/**
 * A song as a WAV file at its even-volume level, made as it's asked for: 16-bit stereo PCM at
 * LOUDNESS_RATE, decoded with the gain applied. Its length is known before a byte is decoded (the
 * loudness analysis counted the samples), so every byte of the file is at a known place: a range
 * from anywhere in it is decoded from that very sample, and a player seeks, buffers and joins songs as
 * in any other file. The levelling is in the audio itself, so it works where a player can't set the
 * volume (iPhones).
 */
import { PassThrough, type Readable } from 'node:stream';
import { LOUDNESS_RATE } from '../analysis/loudness.ts';

export const WAV_HEADER_BYTES = 44;
const CHANNELS = 2;
const BYTES_PER_FRAME = CHANNELS * 2;

/** The header of a WAV file holding `dataBytes` of 16-bit stereo PCM at LOUDNESS_RATE. */
export function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(WAV_HEADER_BYTES);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16); // the format chunk's size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(CHANNELS, 22);
  h.writeUInt32LE(LOUDNESS_RATE, 24);
  h.writeUInt32LE(LOUDNESS_RATE * BYTES_PER_FRAME, 28);
  h.writeUInt16LE(BYTES_PER_FRAME, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/**
 * Bytes `start` to `end` (inclusive) of a WAV file `frames` long, its audio from `decode` (sample
 * frames from `from`, `count` of them). A decode that comes up short is made up with silence and one
 * that runs long is cut, so the file is always exactly as long as its header says.
 */
export function wavRange(opts: {
  frames: number;
  start: number;
  end: number;
  decode: (from: number, count: number) => Readable;
}): Readable {
  const dataBytes = opts.frames * BYTES_PER_FRAME;
  const { start, end } = opts;
  let source: Readable | undefined;
  async function* body() {
    if (start < WAV_HEADER_BYTES) yield wavHeader(dataBytes).subarray(start, Math.min(end + 1, WAV_HEADER_BYTES));
    if (end < WAV_HEADER_BYTES) return;
    const dataStart = Math.max(0, start - WAV_HEADER_BYTES);
    const dataEnd = end - WAV_HEADER_BYTES;
    const from = Math.floor(dataStart / BYTES_PER_FRAME);
    let skip = dataStart - from * BYTES_PER_FRAME;
    let left = dataEnd - dataStart + 1;
    source = opts.decode(from, Math.ceil((dataEnd + 1) / BYTES_PER_FRAME) - from);
    for await (const chunk of source) {
      let piece = chunk as Buffer;
      if (skip) {
        const skipped = Math.min(skip, piece.length);
        piece = piece.subarray(skipped);
        skip -= skipped;
      }
      if (!piece.length) continue;
      if (piece.length >= left) {
        yield piece.subarray(0, left);
        left = 0;
        break;
      }
      yield piece;
      left -= piece.length;
    }
    while (left > 0) {
      const silence = Math.min(left, 64 * 1024);
      yield Buffer.alloc(silence);
      left -= silence;
    }
  }
  // Pumped by hand rather than Readable.from: that one waits for the generator to finish before it
  // closes, and the generator may be waiting on the decode, which then never stops.
  const out = new PassThrough();
  out.once('close', () => source?.destroy());
  void (async () => {
    try {
      for await (const piece of body()) {
        if (out.destroyed) return;
        if (!out.write(piece)) await new Promise((resolve) => (out.once('drain', resolve), out.once('close', resolve)));
      }
      out.end();
    } catch (err) {
      out.destroy(err as Error);
    }
  })();
  return out;
}
