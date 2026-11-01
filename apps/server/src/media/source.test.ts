import { describe, expect, it } from 'vitest';
import { ffmpegPcmArgs } from './source.ts';

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
    ['startSeconds with fromEnd', { sampleRate: 44100, maxSeconds: 30, startSeconds: 10, fromEnd: true }],
  ])('rejects %s', (_label, opts) => {
    expect(() => ffmpegPcmArgs('/music/a.flac', opts)).toThrow();
  });
});
