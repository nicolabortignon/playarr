import { describe, expect, it, vi } from 'vitest';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../catalog/testFixtures.ts';
import { ffmpegEncodeArgs, ffmpegEncodedStream, ffmpegPcmArgs, ffmpegPcmStream, type EncodeOptions } from './source.ts';

/** True if `needle` appears as a contiguous run inside `haystack`; returns its index or -1. */
function indexOfRun(haystack: string[], needle: string[]): number {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((v, j) => haystack[i + j] === v)) return i;
  }
  return -1;
}

describe('ffmpegPcmArgs', () => {
  it('keeps the original mono, from-the-start arguments by default', () => {
    expect(ffmpegPcmArgs('/music/a.flac', { sampleRate: 11025, maxSeconds: 180 })).toEqual([
      ...['-hide_banner', '-loglevel', 'error', '-nostdin'],
      ...['-t', '180', '-i', '/music/a.flac'],
      ...['-vn', '-ac', '1', '-ar', '11025', '-f', 's16le', '-'],
    ]);
  });

  it('seeks to startSeconds before the input and decodes stereo when asked', () => {
    const args = ffmpegPcmArgs('/music/a.flac', {
      sampleRate: 44100,
      maxSeconds: 30,
      startSeconds: 200.5,
      channels: 2,
    });
    const input = args.indexOf('-i');
    const seek = indexOfRun(args, ['-ss', '200.5']);
    expect(seek).toBeGreaterThanOrEqual(0);
    expect(seek).toBeLessThan(input);
    expect(indexOfRun(args, ['-t', '30'])).toBeGreaterThanOrEqual(0);
    expect(indexOfRun(args, ['-ac', '2', '-ar', '44100'])).toBeGreaterThan(input);
    expect(args).not.toContain('-sseof');
  });

  it('with exactSeek, seeks and limits the length after the input, so ffmpeg decodes and drops up to the start', () => {
    const args = ffmpegPcmArgs('/music/a.mp3', { sampleRate: 44100, maxSeconds: 30, startSeconds: 200.5, channels: 2, exactSeek: true });
    expect(args).toEqual([
      ...['-hide_banner', '-loglevel', 'error', '-nostdin'],
      ...['-i', '/music/a.mp3', '-ss', '200.5', '-t', '30'],
      ...['-vn', '-ac', '2', '-ar', '44100', '-f', 's16le', '-'],
    ]);
    expect(() => ffmpegPcmArgs('/music/a.mp3', { sampleRate: 44100, maxSeconds: 30, fromEnd: true, exactSeek: true })).toThrow();
  });

  it('seeks relative to the end of the file when fromEnd is set', () => {
    const args = ffmpegPcmArgs('/music/a.flac', { sampleRate: 11025, maxSeconds: 180, fromEnd: true });
    const input = args.indexOf('-i');
    const seek = indexOfRun(args, ['-sseof', '-180']);
    expect(seek).toBeGreaterThanOrEqual(0);
    expect(seek).toBeLessThan(input);
    expect(args).not.toContain('-ss');
    expect(indexOfRun(args, ['-ac', '1'])).toBeGreaterThan(input);
  });

  it('decodes to 24-bit samples when asked, for a hi-res file streamed as it is', () => {
    const args = ffmpegPcmArgs('/music/a.m4a', { sampleRate: 96000, maxSeconds: 30, channels: 2, bits: 24 });
    expect(args.slice(-8)).toEqual(['-vn', '-ac', '2', '-ar', '96000', '-f', 's24le', '-']);
  });

  it('passes the path as one argument right after -i, whatever it contains', () => {
    const path = "/music/it's -ss 5; rm -rf.flac";
    const args = ffmpegPcmArgs(path, { sampleRate: 11025, maxSeconds: 10 });
    expect(args[args.indexOf('-i') + 1]).toBe(path);
  });

  it.each([
    ['NaN sample rate', { sampleRate: NaN, maxSeconds: 30 }],
    ['zero sample rate', { sampleRate: 0, maxSeconds: 30 }],
    ['fractional sample rate', { sampleRate: 44100.5, maxSeconds: 30 }],
    ['NaN maxSeconds', { sampleRate: 44100, maxSeconds: NaN }],
    ['negative maxSeconds', { sampleRate: 44100, maxSeconds: -5 }],
    ['infinite maxSeconds', { sampleRate: 44100, maxSeconds: Infinity }],
    ['NaN startSeconds', { sampleRate: 44100, maxSeconds: 30, startSeconds: NaN }],
    ['negative startSeconds', { sampleRate: 44100, maxSeconds: 30, startSeconds: -1 }],
    ['three channels', { sampleRate: 44100, maxSeconds: 30, channels: 3 as 1 }],
    ['32-bit samples', { sampleRate: 44100, maxSeconds: 30, bits: 32 as 16 }],
    ['startSeconds with fromEnd', { sampleRate: 44100, maxSeconds: 30, startSeconds: 10, fromEnd: true }],
    ['NaN gain', { sampleRate: 44100, maxSeconds: 30, gainDb: NaN }],
    ['a gain no song needs', { sampleRate: 44100, maxSeconds: 30, gainDb: 40 }],
  ])('rejects %s', (_label, opts) => {
    expect(() => ffmpegPcmArgs('/music/a.flac', opts)).toThrow();
  });

  it('turns the audio up or down as it decodes, and seeks to the microsecond', () => {
    const args = ffmpegPcmArgs('/music/a.flac', { sampleRate: 44100, maxSeconds: 30, startSeconds: 1 / 44100, channels: 2, gainDb: -6.25 });
    expect(indexOfRun(args, ['-af', 'volume=-6.25dB'])).toBeGreaterThan(args.indexOf('-i'));
    expect(indexOfRun(args, ['-ss', '0.000023'])).toBeGreaterThanOrEqual(0);
    expect(ffmpegPcmArgs('/music/a.flac', { sampleRate: 44100, maxSeconds: 30, gainDb: 0 })).not.toContain('-af');
  });
});

describe('ffmpegEncodeArgs', () => {
  const FROM_START: EncodeOptions = { codec: 'aac', kbps: 128, skipSamples: 0, leadSamples: 1088, samples: 89_288 };

  it('encodes AAC as ADTS, every sample counted in the filters at 44.1 kHz: the silence before the song, then exactly so many samples', () => {
    expect(ffmpegEncodeArgs('/music/a.flac', FROM_START)).toEqual([
      ...['-hide_banner', '-loglevel', 'error', '-nostdin'],
      ...['-i', '/music/a.flac', '-map', '0:a:0', '-vn', '-sn', '-dn'],
      ...['-af', 'aresample=44100,adelay=1088S:all=1,apad=whole_len=89288,atrim=end_sample=89288'],
      ...['-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-f', 'adts'],
      ...['-fflags', '+bitexact', '-flags:a', '+bitexact', '-'],
    ]);
  });

  it('seeks before the input, drops the samples up to the start, and applies the gain', () => {
    const args = ffmpegEncodeArgs('/music/a.flac', { codec: 'aac', kbps: 256, seekSeconds: 0.97, skipSamples: 235, leadSamples: 0, samples: 45_188, gainDb: -6.5 });
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(indexOfRun(args, ['-ss', '0.97'])).toBeGreaterThanOrEqual(0);
    expect(indexOfRun(args, ['-af', 'aresample=44100,atrim=start_sample=235,volume=-6.5dB,apad=whole_len=45188,atrim=end_sample=45188'])).toBeGreaterThan(args.indexOf('-i'));
    expect(indexOfRun(args, ['-b:a', '256k'])).toBeGreaterThanOrEqual(0);
  });

  it('encodes Opus with libopus at a constant bitrate, in 20 ms packets at 48 kHz, as Ogg', () => {
    const args = ffmpegEncodeArgs('/music/a.flac', { ...FROM_START, codec: 'opus', leadSamples: 0, samples: 88_200 });
    expect(indexOfRun(args, ['-c:a', 'libopus', '-b:a', '128k', '-vbr', 'off', '-application', 'audio', '-frame_duration', '20', '-ar', '48000', '-f', 'ogg'])).toBeGreaterThan(0);
  });

  it('passes the path as one argument right after -i, whatever it contains', () => {
    const path = "/music/it's -ss 5; rm -rf.flac";
    const args = ffmpegEncodeArgs(path, FROM_START);
    expect(args[args.indexOf('-i') + 1]).toBe(path);
  });

  it.each([
    ['another codec', { codec: 'mp3' as 'aac' }],
    ['a bitrate not on offer', { kbps: 192 }],
    ['a NaN seek', { seekSeconds: Number.NaN }],
    ['a negative seek', { seekSeconds: -1 }],
    ['a fraction of a sample to skip', { skipSamples: 1.5 }],
    ['negative silence', { leadSamples: -1 }],
    ['no samples', { samples: 0 }],
    ['a gain no song needs', { gainDb: 40 }],
  ])('rejects %s', (_label, change) => {
    expect(() => ffmpegEncodeArgs('/music/a.flac', { ...FROM_START, ...change })).toThrow(RangeError);
  });
});

describe('ffmpegPcmStream', () => {
  /** A stand-in for ffmpeg: a shell script doing `body`, whatever arguments it's given. */
  function fakeFfmpeg(body: string) {
    const t = tempDir();
    const bin = join(t.dir, 'ffmpeg');
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    return { bin, cleanup: t.cleanup };
  }
  const read = async (stream: NodeJS.ReadableStream) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString();
  };
  const OPTS = { sampleRate: 44100, maxSeconds: 30, channels: 2 as const };

  it('hands on what ffmpeg decodes', async () => {
    const ffmpeg = fakeFfmpeg("printf 'pcm bytes'");
    try {
      expect(await read(ffmpegPcmStream(ffmpeg.bin, '/music/a.flac', { ...OPTS, priority: 'normal' }))).toBe('pcm bytes');
    } finally {
      ffmpeg.cleanup();
    }
  });

  it('hands on what ffmpeg encodes, given the encode’s arguments', async () => {
    const t = tempDir();
    const argsFile = join(t.dir, 'args');
    const ffmpeg = fakeFfmpeg(`echo "$@" > '${argsFile}'; printf 'adts frames'`);
    try {
      const opts: EncodeOptions = { codec: 'aac', kbps: 128, skipSamples: 0, leadSamples: 1088, samples: 2000, priority: 'normal' };
      expect(await read(ffmpegEncodedStream(ffmpeg.bin, '/music/a.flac', opts))).toBe('adts frames');
      expect(readFileSync(argsFile, 'utf8').trim()).toBe(ffmpegEncodeArgs('/music/a.flac', opts).join(' '));
    } finally {
      ffmpeg.cleanup();
      t.cleanup();
    }
  });

  it('fails with ffmpeg’s reason when it fails', async () => {
    const ffmpeg = fakeFfmpeg("printf 'some'; echo 'Invalid data found' >&2; exit 1");
    try {
      await expect(read(ffmpegPcmStream(ffmpeg.bin, '/music/a.flac', OPTS))).rejects.toThrow('ffmpeg: Invalid data found');
    } finally {
      ffmpeg.cleanup();
    }
  });

  it('stops ffmpeg when the stream is closed early', async () => {
    const t = tempDir();
    const pidFile = join(t.dir, 'pid');
    const ffmpeg = fakeFfmpeg(`echo $$ > '${pidFile}'; printf 'start'; exec sleep 30`);
    try {
      const stream = ffmpegPcmStream(ffmpeg.bin, '/music/a.flac', OPTS);
      await new Promise((resolve) => stream.once('data', resolve));
      const pid = Number(readFileSync(pidFile, 'utf8'));
      stream.destroy();
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 3000 });
    } finally {
      ffmpeg.cleanup();
      t.cleanup();
    }
  });

  /** Whether the process `pid` is still running. */
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('stops an ffmpeg stuck writing to a pipe nobody reads, which SIGTERM alone never does', async () => {
    const t = tempDir();
    const pidFile = join(t.dir, 'pid');
    // As ffmpeg handles signals: SIGTERM waits for the write under way, SIGPIPE is ignored and a failed write ends it.
    const ffmpeg = fakeFfmpeg(`trap '' TERM PIPE; echo $$ > '${pidFile}'; while :; do printf '%065536d' 0 || exit 1; done`);
    try {
      const stream = ffmpegEncodedStream(ffmpeg.bin, '/music/a.flac', { codec: 'aac', kbps: 128, skipSamples: 0, leadSamples: 1088, samples: 2000 });
      await new Promise((resolve) => stream.once('data', resolve));
      // Nobody reads on (an encode paused ahead of its listeners): the pipe fills and ffmpeg's write blocks.
      stream.pause();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const pid = Number(readFileSync(pidFile, 'utf8'));
      stream.destroy();
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 500 });
    } finally {
      ffmpeg.cleanup();
      t.cleanup();
    }
  });

  it('kills an ffmpeg that won’t stop when asked', async () => {
    const t = tempDir();
    const pidFile = join(t.dir, 'pid');
    const ffmpeg = fakeFfmpeg(`trap '' TERM PIPE; echo $$ > '${pidFile}'; printf 'start'; exec sleep 30`);
    try {
      const stream = ffmpegPcmStream(ffmpeg.bin, '/music/a.flac', OPTS);
      await new Promise((resolve) => stream.once('data', resolve));
      const pid = Number(readFileSync(pidFile, 'utf8'));
      stream.destroy();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(alive(pid)).toBe(true); // asked, given a moment
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 2000 });
    } finally {
      ffmpeg.cleanup();
      t.cleanup();
    }
  });
});
