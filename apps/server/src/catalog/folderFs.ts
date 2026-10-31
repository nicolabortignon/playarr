import { parseFile } from 'music-metadata';
import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import type { SFTPWrapper } from 'ssh2';
import { LocalMediaSource } from '../media/local.ts';
import type { MediaSource } from '../media/index.ts';
import { parseLsjson, type Rclone } from '../media/rclone.ts';
import { RcloneMediaSource } from '../media/rcloneServe.ts';
import type { SftpMediaSource } from '../media/sftp.ts';
import { shellQuote, type Shell } from '../media/ssh.ts';
import { fpcalc, type Fingerprint } from './acoustid.ts';
import { isAudioFile, listAudioFiles } from './folderSource.ts';
import { pictureFrom, readTags, readTagsFrom, type TagInfo } from './tags.ts';

export interface FoundFile {
  rel: string;
  path: string;
  size: number;
  mtimeMs: number;
  /**
   * When the file appeared on this disk (its birth time), where the filesystem reports it. Copies keep
   * their old modification time, so this is the better "added" date for a folder's first scan.
   */
  createdMs?: number;
}

export interface FsEntry {
  name: string;
  dir: boolean;
  file: boolean;
}

/** A folder source's filesystem: this server's disk, another machine over SSH or SFTP, or an SMB share. */
export interface FolderFs {
  readonly kind: 'local' | 'ssh' | 'sftp' | 'smb';
  /** Streams bytes (and decodes audio, where it can) for streaming and analysis. */
  readonly media: MediaSource;
  /** How many files to read at once. */
  readonly concurrency: number;
  stat(path: string): Promise<{ size: number; mtimeMs: number; dir: boolean } | null>;
  readdir(path: string): Promise<FsEntry[]>;
  /** Audio files under `root`, skipping hidden files and folders. */
  listAudio(root: string): Promise<FoundFile[]>;
  readTags(path: string, size: number): Promise<TagInfo | null>;
  picture(path: string, size: number): Promise<{ body: Buffer; mime: string } | null>;
  readFile(path: string): Promise<Buffer>;
  /** Absent where fingerprints can't be computed. */
  fingerprint?(path: string): Promise<Fingerprint | null>;
  close(): Promise<void>;
}

export class LocalFolderFs implements FolderFs {
  readonly kind = 'local' as const;
  readonly concurrency = 8;
  readonly media: MediaSource;
  readonly fingerprint?: (path: string) => Promise<Fingerprint | null>;

  constructor(opts: { ffmpeg?: string; fpcalc?: string } = {}) {
    this.media = new LocalMediaSource(opts.ffmpeg);
    if (opts.fpcalc) this.fingerprint = fpcalc(opts.fpcalc);
  }

  async stat(path: string) {
    const s = await stat(path).catch(() => null);
    return s ? { size: s.size, mtimeMs: Math.floor(s.mtimeMs), dir: s.isDirectory() } : null;
  }

  async readdir(path: string): Promise<FsEntry[]> {
    const items = await readdir(path, { withFileTypes: true }).catch((): Dirent[] => []);
    return items.map((i) => ({ name: i.name, dir: i.isDirectory(), file: i.isFile() }));
  }

  listAudio(root: string) {
    return listAudioFiles(root);
  }

  readTags(path: string, _size?: number) {
    return readTags(path);
  }

  async picture(path: string, _size?: number) {
    const picture = (await parseFile(path, { duration: false })).common.picture?.[0];
    return picture ? { body: Buffer.from(picture.data), mime: picture.format } : null;
  }

  readFile(path: string) {
    return readFile(path);
  }

  async close() {}
}

/** "size \t mtime(s) \t relative path" lines from GNU find → audio files. */
export function parseFindListing(root: string, out: string): FoundFile[] {
  return out
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [size, mtime, rel] = line.split('\t');
      if (!rel || !isAudioFile(rel)) return [];
      return [{ rel, path: posix.join(root, rel), size: Number(size), mtimeMs: Math.floor(Number(mtime) * 1000) }];
    })
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/** "size mtime(s) type" from `stat -L -c '%s %Y %F'`. */
export function parseStat(out: string): { size: number; mtimeMs: number; dir: boolean } {
  const [size, mtime, ...type] = out.trim().split(' ');
  return { size: Number(size), mtimeMs: Number(mtime) * 1000, dir: type.join(' ') === 'directory' };
}

export class SshFolderFs implements FolderFs {
  readonly kind = 'ssh' as const;
  readonly concurrency = 3;

  constructor(
    private readonly shell: Shell,
    readonly media: MediaSource,
    private readonly fpcalcBin: string,
    private readonly onClose: () => Promise<void> = async () => {},
  ) {}

  async stat(path: string) {
    try {
      return parseStat(await this.shell.run(`stat -L -c '%s %Y %F' -- ${shellQuote(path)}`));
    } catch {
      return null;
    }
  }

  async readdir(path: string): Promise<FsEntry[]> {
    const out = await this.shell.run(`find ${shellQuote(path)} -mindepth 1 -maxdepth 1 -printf '%y\\t%f\\n'`).catch(() => '');
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [type, ...name] = line.split('\t');
        return { name: name.join('\t'), dir: type === 'd', file: type === 'f' };
      });
  }

  async listAudio(root: string): Promise<FoundFile[]> {
    try {
      const out = await this.shell.run(
        `find ${shellQuote(root)} -mindepth 1 \\( -name '.*' -prune \\) -o -type f -printf '%s\\t%T@\\t%P\\n'`,
      );
      return parseFindListing(root, out);
    } catch (err) {
      if (/printf|unrecognized|unknown predicate/i.test((err as Error).message)) {
        throw new Error('Listing files over SSH needs GNU find on the host; use SFTP instead');
      }
      throw err;
    }
  }

  readTags(path: string, size: number) {
    return readTagsFrom(this.media, path, size);
  }

  picture(path: string, size: number) {
    return pictureFrom(this.media, path, size);
  }

  readFile(path: string) {
    return this.shell.runBuffer(`cat -- ${shellQuote(path)}`);
  }

  async fingerprint(path: string): Promise<Fingerprint | null> {
    try {
      const json = JSON.parse(await this.shell.run(`nice -n 10 ${shellQuote(this.fpcalcBin)} -json -- ${shellQuote(path)}`)) as {
        duration?: number;
        fingerprint?: string;
      };
      return json.fingerprint && json.duration ? { duration: json.duration, fingerprint: json.fingerprint } : null;
    } catch {
      return null;
    }
  }

  close() {
    return this.onClose();
  }
}

type SftpSession = Pick<SFTPWrapper, 'readdir' | 'stat' | 'readFile'>;

export class SftpFolderFs implements FolderFs {
  readonly kind = 'sftp' as const;
  readonly concurrency = 6;

  constructor(readonly media: SftpMediaSource) {}

  private session(): Promise<SftpSession> {
    return this.media.session();
  }

  async stat(path: string) {
    const sftp = await this.session();
    return new Promise<{ size: number; mtimeMs: number; dir: boolean } | null>((resolve) =>
      sftp.stat(path, (err, s) => resolve(err ? null : { size: s.size, mtimeMs: s.mtime * 1000, dir: s.isDirectory() })),
    );
  }

  async readdir(path: string): Promise<FsEntry[]> {
    const sftp = await this.session();
    return new Promise((resolve) =>
      sftp.readdir(path, (err, list) =>
        resolve(err ? [] : list.map((e) => ({ name: e.filename, dir: e.attrs.isDirectory(), file: e.attrs.isFile() }))),
      ),
    );
  }

  async listAudio(root: string): Promise<FoundFile[]> {
    const sftp = await this.session();
    const found: FoundFile[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      const list = await new Promise<{ filename: string; attrs: { size: number; mtime: number; isDirectory(): boolean; isFile(): boolean } }[]>(
        (resolve) => sftp.readdir(dir, (err, l) => resolve(err ? [] : l)),
      );
      for (const e of list) {
        if (e.filename.startsWith('.')) continue;
        const itemRel = rel ? `${rel}/${e.filename}` : e.filename;
        if (e.attrs.isDirectory()) await walk(posix.join(dir, e.filename), itemRel);
        else if (e.attrs.isFile() && isAudioFile(e.filename)) {
          found.push({ rel: itemRel, path: posix.join(dir, e.filename), size: e.attrs.size, mtimeMs: e.attrs.mtime * 1000 });
        }
      }
    };
    await walk(root, '');
    return found.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  readTags(path: string, size: number) {
    return readTagsFrom(this.media, path, size);
  }

  picture(path: string, size: number) {
    return pictureFrom(this.media, path, size);
  }

  async readFile(path: string): Promise<Buffer> {
    const sftp = await this.session();
    return new Promise((resolve, reject) => sftp.readFile(path, (err, data) => (err ? reject(err) : resolve(data))));
  }

  close() {
    return this.media.close();
  }
}

/** A folder on an SMB share (any rclone remote), paths written /<share>/<folder>/<file>. */
export class RcloneFolderFs implements FolderFs {
  readonly kind = 'smb' as const;
  readonly concurrency = 4;
  readonly media: RcloneMediaSource;
  readonly fingerprint?: (path: string) => Promise<Fingerprint | null>;

  constructor(
    private readonly rclone: Rclone,
    private readonly prefix: string,
    tools: { ffmpeg?: string; fpcalc?: string } = {},
  ) {
    this.media = new RcloneMediaSource(rclone, prefix, tools);
    if (tools.fpcalc) {
      const run = fpcalc(tools.fpcalc);
      this.fingerprint = async (path) => run(await this.media.urlFor(path));
    }
  }

  private remote(path: string) {
    return `${this.prefix}${posix.normalize(path).replace(/^\/+/, '')}`;
  }

  async stat(path: string) {
    if (posix.normalize(path) === '/') return { size: 0, mtimeMs: 0, dir: true };
    try {
      const [entry] = parseLsjson(`[${await this.rclone.run(['lsjson', '--stat', '--no-mimetype', this.remote(path)])}]`);
      return entry ? { size: entry.size, mtimeMs: Math.floor(entry.mtimeMs), dir: entry.dir } : null;
    } catch (err) {
      const code = (err as { exitCode?: number }).exitCode;
      if (code === 3 || code === 4) return null;
      throw err;
    }
  }

  async readdir(path: string): Promise<FsEntry[]> {
    const out = await this.rclone.run(['lsjson', '--no-mimetype', '--no-modtime', this.remote(path)]);
    return parseLsjson(out).map((e) => ({ name: e.name, dir: e.dir, file: !e.dir }));
  }

  async listAudio(root: string): Promise<FoundFile[]> {
    const out = await this.rclone.run(
      ['lsjson', '-R', '--files-only', '--no-mimetype', '--exclude', '.*', '--exclude', '.*/**', this.remote(root)],
      30 * 60_000,
    );
    return parseLsjson(out)
      .filter((e) => isAudioFile(e.name))
      .map((e) => ({ rel: e.path, path: posix.join(root, e.path), size: e.size, mtimeMs: Math.floor(e.mtimeMs) }))
      .sort((a, b) => a.rel.localeCompare(b.rel));
  }

  readTags(path: string, size: number) {
    return readTagsFrom(this.media, path, size);
  }

  picture(path: string, size: number) {
    return pictureFrom(this.media, path, size);
  }

  async readFile(path: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.media.open(path)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  close() {
    return this.media.close();
  }
}
