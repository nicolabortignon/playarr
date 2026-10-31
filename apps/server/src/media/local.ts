import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { ffmpegPcmArgs, type ByteRange, type FileStat, type MediaSource, type PcmOptions } from './source.ts';
import { lowPriority } from '../lowPriority.ts';

export class LocalMediaSource implements MediaSource {
  readonly kind = 'local' as const;

  constructor(private readonly ffmpeg = 'ffmpeg') {}

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

  pcm(path: string, opts: PcmOptions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      lowPriority(
        execFile(
          this.ffmpeg,
          ffmpegPcmArgs(path, opts),
          { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, signal: opts.signal },
          (err, stdout, stderr) => (err ? reject(new Error(`ffmpeg: ${stderr.toString().trim() || err.message}`)) : resolve(stdout)),
        ),
      );
    });
  }
}
