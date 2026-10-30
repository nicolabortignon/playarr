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
  /** Decode a file to mono s16le PCM with ffmpeg, where the files live. Absent if this source can't. */
  pcm?(path: string, opts: PcmOptions): Promise<Buffer>;
  close(): Promise<void>;
}

export interface PcmOptions {
  sampleRate: number;
  /** Decode at most this many seconds from the start. */
  maxSeconds: number;
  signal?: AbortSignal;
}

/** ffmpeg arguments that decode `path` to mono s16le PCM on stdout. */
export function ffmpegPcmArgs(path: string, { sampleRate, maxSeconds }: PcmOptions): string[] {
  return [
    ...['-hide_banner', '-loglevel', 'error', '-nostdin'],
    ...['-t', String(maxSeconds), '-i', path],
    ...['-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-'],
  ];
}

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
