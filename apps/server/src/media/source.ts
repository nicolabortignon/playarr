import type { ByteRange } from '@playarr/shared';
import { posix } from 'node:path';
import type { Readable } from 'node:stream';

export interface FileStat {
  size: number;
  mtimeMs: number;
}

export type { ByteRange };

/** Where audio bytes come from: local disk in production, SSH/SFTP from a dev machine. */
export interface MediaSource {
  readonly kind: 'none' | 'local' | 'sftp' | 'ssh' | 'smb';
  stat(path: string): Promise<FileStat>;
  open(path: string, range?: ByteRange): Promise<Readable>;
  /** Throws with a human-readable message if the source is unusable. */
  check(probePath?: string): Promise<void>;
  /** Decode a file to s16le PCM (mono unless asked for stereo) with ffmpeg, where the files live. Absent if this source can't. */
  pcm?(path: string, opts: PcmOptions): Promise<Buffer>;
  close(): Promise<void>;
}

export interface PcmOptions {
  sampleRate: number;
  /** Decode at most this many seconds (from the start, from `startSeconds`, or the last ones with `fromEnd`). */
  maxSeconds: number;
  /**
   * Start decoding this many seconds into the file. The transition renderer uses it to pull
   * an exact section out of the middle of a song without decoding everything before it.
   */
  startSeconds?: number;
  /**
   * Decode the last `maxSeconds` of the file instead of the first. The analyzer needs a song's
   * ending to plan the mix out of it, and long songs would otherwise never get there.
   * Can't be combined with `startSeconds`.
   */
  fromEnd?: boolean;
  /**
   * Seek by decoding from the start and throwing away everything before `startSeconds`, rather than
   * jumping in the container. Slower, but exact for formats whose seeking is an estimate (MP3 has no
   * index, so a jump lands only roughly where asked): the transition renderer needs the sample asked for.
   */
  exactSeek?: boolean;
  /** 1 for analysis (the default, smallest), 2 when rendering audio people will hear. */
  channels?: 1 | 2;
  signal?: AbortSignal;
}

/**
 * Seconds as a plain decimal ffmpeg understands. Rounded to the millisecond so tiny values
 * never turn into exponent notation like "1e-7", which ffmpeg would reject.
 */
function seconds(value: number): string {
  return String(Number(value.toFixed(3)));
}

/**
 * Refuse anything but sane numbers. These end up on an ffmpeg command line (over SSH too, where
 * they're shell-quoted along with everything else), so a NaN or a negative must never get through.
 */
function checkPcmOptions({ sampleRate, maxSeconds, startSeconds, fromEnd, exactSeek, channels }: PcmOptions): void {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError(`Invalid sample rate: ${sampleRate}`);
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) throw new RangeError(`Invalid maxSeconds: ${maxSeconds}`);
  if (startSeconds !== undefined && (!Number.isFinite(startSeconds) || startSeconds < 0)) {
    throw new RangeError(`Invalid startSeconds: ${startSeconds}`);
  }
  if (startSeconds !== undefined && fromEnd) throw new RangeError('startSeconds and fromEnd cannot be combined');
  if (exactSeek && fromEnd) throw new RangeError('exactSeek and fromEnd cannot be combined');
  if (channels !== undefined && channels !== 1 && channels !== 2) throw new RangeError(`Invalid channels: ${channels}`);
}

/**
 * ffmpeg arguments that decode `path` to s16le PCM on stdout.
 *
 * Seeking (`-ss` / `-sseof`) goes before `-i` so ffmpeg jumps in the container instead of
 * decoding and throwing away everything before; for audio it still decodes accurately from
 * the requested point. `-t` stays even with `-sseof`: it is harmless there and still caps the
 * output if the file is shorter than `maxSeconds` (ffmpeg then just starts at the beginning).
 * With `exactSeek`, `-ss` and `-t` go after `-i` instead: ffmpeg decodes from the start and
 * drops what comes before, so the first sample out is exactly the one asked for.
 */
export function ffmpegPcmArgs(path: string, opts: PcmOptions): string[] {
  checkPcmOptions(opts);
  const { sampleRate, maxSeconds, startSeconds, fromEnd, exactSeek, channels = 1 } = opts;
  const seek = startSeconds !== undefined ? ['-ss', seconds(startSeconds)] : fromEnd ? ['-sseof', `-${seconds(maxSeconds)}`] : [];
  const length = ['-t', seconds(maxSeconds)];
  const input = ['-i', path];
  return [
    ...['-hide_banner', '-loglevel', 'error', '-nostdin'],
    ...(exactSeek ? [...input, ...seek, ...length] : [...seek, ...length, ...input]),
    ...['-vn', '-ac', String(channels), '-ar', String(sampleRate), '-f', 's16le', '-'],
  ];
}

/**
 * Most PCM bytes we'll collect from one ffmpeg run. A stereo 44.1 kHz s16le section of 150 s
 * is 44100 × 2 × 2 × 150 ≈ 26.5 MB; this leaves plenty of room above that.
 */
export const PCM_MAX_BUFFER = 96 * 1024 * 1024;

export class MediaUnavailableError extends Error {}

export class NoMediaSource implements MediaSource {
  readonly kind = 'none' as const;
  private fail(): never {
    throw new MediaUnavailableError(
      'Audio streaming is not configured. Set MEDIA_SOURCE (local, sftp or ssh) in .env.',
    );
  }
  async stat(): Promise<FileStat> {
    this.fail();
  }
  async open(): Promise<Readable> {
    this.fail();
  }
  async check() {
    this.fail();
  }
  async close() {}
}

/** Translate a Lidarr path to the path Playarr should read, via the first matching prefix. */
export function mapPath(lidarrPath: string, pathMap: [string, string][]): string {
  for (const [from, to] of pathMap) {
    const prefix = from.endsWith('/') ? from : `${from}/`;
    if (lidarrPath === from || lidarrPath.startsWith(prefix)) {
      return posix.normalize(to + lidarrPath.slice(from.length));
    }
  }
  return posix.normalize(lidarrPath);
}
