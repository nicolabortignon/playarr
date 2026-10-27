import { posix } from 'node:path';
import type { Readable } from 'node:stream';

export interface FileStat {
  size: number;
  mtimeMs: number;
}

/** Inclusive byte range, like fs.createReadStream's start/end. */
export interface ByteRange {
  start: number;
  end: number;
}

/** Where audio bytes come from: local disk in production, SSH/SFTP from a dev machine. */
export interface MediaSource {
  readonly kind: 'none' | 'local' | 'sftp' | 'ssh';
  stat(path: string): Promise<FileStat>;
  open(path: string, range?: ByteRange): Promise<Readable>;
  /** Throws with a human-readable message if the source is unusable. */
  check(probePath?: string): Promise<void>;
  close(): Promise<void>;
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
