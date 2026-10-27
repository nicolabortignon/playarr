import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { ByteRange, FileStat, MediaSource } from './source.ts';

export class LocalMediaSource implements MediaSource {
  readonly kind = 'local' as const;

  async stat(path: string): Promise<FileStat> {
    const s = await stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  }

  async open(path: string, range?: ByteRange): Promise<Readable> {
    return createReadStream(path, range ? { start: range.start, end: range.end } : undefined);
  }

  async check(probePath?: string) {
    if (probePath) await access(probePath);
  }

  async close() {}
}
