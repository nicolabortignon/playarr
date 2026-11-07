/**
 * DJ transitions land on the sample on every player only if an encoded stream's first sample is the song's sample
 * `start` as each player decodes it, exactly. These tests hold that: a click track (clicks over a bed of noise),
 * made into a stream by the server's own code, decoded the way each player decodes it, every click looked for
 * where it is in the song (by cross-correlation with the song around it). They need the tools they decode with,
 * so each runs where its tools are:
 *
 * - **Apple's decoders**, on macOS: afconvert reads files through Core Audio's ExtAudioFile, as AVAudioFile does
 *   (the iOS app's FileDecoder). The frames come from Apple's own encoder, whose priming is the stream's own
 *   (2112 samples), so this holds the container: the init segment, the fragments, iTunSMPB.
 * - **ffmpeg**, wherever it's installed (FFMPEG_PATH): the encode as the server runs it (ffmpeg's encoder, the
 *   pre-roll, the seek, the gain), decoded by ffmpeg (the demuxer and decoder Chrome uses) and, on macOS, by
 *   Apple's decoders too.
 *
 * docs/server/streaming-and-art.md (Encoded streams) has the rest of the measurements: AudioFileStream (the
 * app's StreamDecoder) and AVPlayer (Safari) over HTTP, seeking included.
 */
import { spawnSync } from 'node:child_process';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { tempDir } from '../catalog/testFixtures.ts';
import { encodeInput, EncodeJob, streamLayout } from './encoded.ts';
import { ffmpegEncodedStream } from './source.ts';

const RATE = 44_100;
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const runs = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return !result.error && result.status === 0;
};
const hasAfconvert = process.platform === 'darwin' && runs('/usr/bin/which', ['afconvert']);
const hasFfmpeg = runs(FFMPEG, ['-version']);

/** Eight seconds of quiet noise with a click every 57331 samples from sample 10000: 44.1 kHz stereo. */
function clickTrack() {
  const frames = 8 * RATE;
  const marks: number[] = [];
  for (let m = 10_000; m < frames - 10_000; m += 57_331) marks.push(m);
  const left = new Float32Array(frames);
  let seed = 12_345;
  let smooth = 0;
  for (let i = 0; i < frames; i++) {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    // Low-passed a little, like music's bed rather than hiss, so the encoder spends real bits on it.
    smooth = smooth * 0.7 + ((seed / 0x7fffffff) * 2 - 1) * 0.3;
    left[i] = smooth * 0.1;
  }
  for (const m of marks) left[m] = 0.9;
  return { left, marks, wav: wav(left) };
}

/** A 16-bit stereo WAV of `left` in both channels. */
function wav(left: Float32Array): Buffer {
  const data = Buffer.alloc(left.length * 4);
  for (let i = 0; i < left.length; i++) {
    const v = Math.round(Math.max(-1, Math.min(1, left[i]!)) * 32_767);
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The left channel of 16-bit stereo PCM. */
function leftOf(pcm: Buffer): Float32Array {
  const left = new Float32Array(Math.floor(pcm.length / 4));
  for (let i = 0; i < left.length; i++) left[i] = pcm.readInt16LE(i * 4) / 32_768;
  return left;
}

/** The left channel of a 16-bit stereo WAV file, whatever chunks come before its data. */
function readWav(path: string): Float32Array {
  const file = readFileSync(path);
  for (let at = 12; at + 8 <= file.length; ) {
    const size = file.readUInt32LE(at + 4);
    if (file.toString('latin1', at, at + 4) === 'data') return leftOf(file.subarray(at + 8, at + 8 + size));
    at += 8 + size + (size % 2);
  }
  throw new Error(`${path} has no audio`);
}

/**
 * Where each click lands in `decoded` (a stream from the song's sample `start`), against where it is in the song:
 * the lag (in samples) at which the decoded sound around it best matches the song's. 0 is exactly in place.
 */
function clickLags(decoded: Float32Array, song: Float32Array, start: number, marks: number[]): number[] {
  const reach = 4000;
  return marks
    .filter((m) => m - start - reach - 300 >= 0 && m - start + reach + 700 <= decoded.length)
    .map((m) => {
      let best = -Infinity;
      let bestLag = 0;
      for (let lag = -reach; lag <= reach; lag++) {
        let sum = 0;
        for (let k = -300; k < 700; k++) sum += decoded[m - start + lag + k]! * song[m + k]!;
        if (sum > best) [best, bestLag] = [sum, lag];
      }
      return bestLag;
    });
}

/** A stream as the server makes it, from `source` (ADTS from an encoder): every byte a player would get. */
async function streamFrom(source: Readable, valid: number) {
  const layout = streamLayout('aac', 128, valid);
  const job = new EncodeJob('test', layout, null);
  job.run(source);
  const pieces: Buffer[] = [];
  for await (const piece of job.read(0, layout.total - 1)) pieces.push(piece);
  return { bytes: Buffer.concat(pieces), job, layout };
}

/** Decodes a file with Apple's decoders (Core Audio's ExtAudioFile, as AVAudioFile does). */
function afconvertDecode(input: string, dir: string): Float32Array {
  const out = join(dir, `decoded-${Math.random().toString(36).slice(2)}.wav`);
  const result = spawnSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16', input, out], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`afconvert: ${result.stderr}`);
  return readWav(out);
}

/** Decodes a file with ffmpeg, to 44.1 kHz stereo. */
function ffmpegDecode(input: string): Float32Array {
  const result = spawnSync(FFMPEG, ['-v', 'error', '-i', input, '-f', 's16le', '-ac', '2', '-ar', String(RATE), '-'], { maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ffmpeg: ${result.stderr.toString()}`);
  return leftOf(result.stdout);
}

const tmp = tempDir();
const track = clickTrack();
const songPath = join(tmp.dir, 'click.wav');
writeFileSync(songPath, track.wav);
afterAll(() => tmp.cleanup());

describe.skipIf(!hasAfconvert)('encoded streams, decoded by Apple’s decoders', () => {
  it('places every sample exactly: Apple’s frames in the server’s fragmented MP4, priming in iTunSMPB', async () => {
    const adts = join(tmp.dir, 'apple.aac');
    expect(spawnSync('afconvert', ['-f', 'adts', '-d', 'aac', '-b', '128000', songPath, adts]).status).toBe(0);
    const { bytes, job } = await streamFrom(createReadStream(adts), track.left.length);
    expect(job.state).toBe('done');
    const stream = join(tmp.dir, 'apple.mp4');
    writeFileSync(stream, bytes);
    const decoded = afconvertDecode(stream, tmp.dir);
    // The song's length to the sample: the priming and the last frame's padding are trimmed.
    expect(decoded.length).toBe(track.left.length);
    const lags = clickLags(decoded, track.left, 0, track.marks);
    expect(lags).toHaveLength(track.marks.length);
    expect(lags.every((lag) => lag === 0)).toBe(true);
    // The same frames without the container (bare ADTS, which can't say what to trim): every click 2112 late.
    // What the stream's container is for, and proof the comparison sees a sample out of place.
    expect(clickLags(afconvertDecode(adts, tmp.dir), track.left, 0, track.marks).every((lag) => lag === 2112)).toBe(true);
  });
});

describe.skipIf(!hasFfmpeg)('encoded streams as the server encodes them, with ffmpeg', () => {
  /** The stream from the song's sample `start`, encoded as the route encodes it. */
  async function encoded(start: number, gainDb?: number) {
    const valid = track.left.length - start;
    const layout = streamLayout('aac', 128, valid);
    const source = ffmpegEncodedStream(FFMPEG, songPath, { codec: 'aac', kbps: 128, ...encodeInput(layout, start, true), ...(gainDb ? { gainDb } : {}), priority: 'normal' });
    const made = await streamFrom(source, valid);
    const path = join(tmp.dir, `stream-${start}-${gainDb ?? 0}.mp4`);
    writeFileSync(path, made.bytes);
    return { ...made, path, valid };
  }

  it.each([
    ['from its start', 0, undefined],
    ['from a sample in the middle, levelled', 100_003, -6],
  ])('places every sample exactly, %s', async (_label, start, gainDb) => {
    const { job, layout, path, valid } = await encoded(start, gainDb);
    // ffmpeg's encoder makes exactly the frames iTunSMPB counts.
    expect(job.state).toBe('done');
    expect(job.made).toBe(layout.samples);
    const byFfmpeg = ffmpegDecode(path);
    const lags = clickLags(byFfmpeg, track.left, start, track.marks);
    expect(lags.length).toBeGreaterThan(0);
    expect(lags.every((lag) => lag === 0)).toBe(true);
    if (gainDb) {
      // Turned down as asked (the noise's level, away from the clicks).
      const level = (x: Float32Array, from: number) => Math.sqrt(x.subarray(from, from + 20_000).reduce((sum, v) => sum + v * v, 0) / 20_000);
      expect(20 * Math.log10(level(byFfmpeg, 20_000) / level(track.left, start + 20_000))).toBeCloseTo(gainDb, 0);
    }
    if (hasAfconvert) {
      const byApple = afconvertDecode(path, tmp.dir);
      expect(byApple.length).toBe(valid);
      expect(clickLags(byApple, track.left, start, track.marks).every((lag) => lag === 0)).toBe(true);
    }
  });

  it('puts every click 2112 samples late in the bare frames, which can’t say what to trim', async () => {
    const valid = track.left.length;
    const layout = streamLayout('aac', 128, valid);
    const adts = ffmpegEncodedStream(FFMPEG, songPath, { codec: 'aac', kbps: 128, ...encodeInput(layout, 0, true), priority: 'normal' });
    const chunks: Buffer[] = [];
    for await (const chunk of adts) chunks.push(chunk as Buffer);
    const path = join(tmp.dir, 'bare.aac');
    writeFileSync(path, Buffer.concat(chunks));
    expect(clickLags(ffmpegDecode(path), track.left, 0, track.marks).every((lag) => lag === 2112)).toBe(true);
  });
});
