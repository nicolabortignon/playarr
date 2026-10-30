# Sources, Phase 5: SSH and SFTP Folder Sources Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A folder source can live on another machine, reached over SSH or SFTP: scanned, tag-read, streamed, shown with artwork, analyzed and fingerprinted (SSH only), browsed in Settings, all without mounting anything.

**Architecture:** Folder code stops touching `node:fs` directly and goes through a `FolderFs` per source: `LocalFolderFs` (today's behaviour), `SshFolderFs` (commands over one SSH connection: GNU `find` for listings, `stat`, `cat`, remote `fpcalc`; reads and decoding through the existing `SshExecMediaSource`) and `SftpFolderFs` (SFTP `readdir`/`stat`/`readFile` and the existing `SftpMediaSource`; no commands, so no analysis or fingerprints). Tags of remote files are read from byte ranges with `music-metadata`'s `parseFromTokenizer` and `@tokenizer/range` (prototyped: a FLAC's tags in 2 range reads). A `FolderAccess` registry creates and caches one `FolderFs` per folder source from its settings. `FolderSource`, `FileResolver` (streaming, analysis), the copy-artwork route and the matcher's fingerprints ask it for the right `FolderFs`. Settings gains a location choice (This server / SSH / SFTP) with connection fields and remote browsing.

**Tech Stack:** Node 25, ssh2 (existing), `music-metadata` 12, `@tokenizer/range` 0.13 (new), Fastify 5, zod 4, vitest 5; React 19, TanStack Query 5. pnpm via `corepack pnpm`.

**Design:** `docs/plans/2026-10-30-sources-design.md` (Folder locations; Rollout phase 5). Builds on Phases 1–4b.

## Decisions

- **Settings of a remote folder source:** `{ access: 'ssh' | 'sftp', host, port (22), user, path, password? (secret, write-only), privateKeyPath? }`. Auth order as today: key file (a path on the Playarr server) → password → ssh-agent. `FOLDER_ROOTS` applies to local folders only; on a remote host the SSH account's permissions are the limit.
- **Validation:** adding or editing a remote folder connects and checks that the path is a directory before saving (errors come back as 400 with the SSH message).
- **SSH listing** needs GNU `find` (`-printf`); BusyBox hosts get a clear error ("Listing files over SSH needs GNU find on the host; use SFTP instead").
- **Reads:** over SSH each byte range is one `tail | head` channel and sshd allows about 10 per connection, so remote tag reading runs 3 files at a time (SFTP: 6; local: 8). Ranges are fetched in chunks of at least 64 KB.
- **Organizing files stays local-only** in this phase: the plan for a remote source says why (`OrganizePlan.reason`) and apply/undo answer 409.
- **Connections** live as long as their source's settings don't change; editing settings or removing the source closes them. Browsing an unsaved connection opens a short-lived connection per request.
- **Secrets:** `password` joins `apiKey` as a write-only field (`SourceInfo.secrets` lists it; omitted on update keeps the saved one).

## Conventions

- Run from `/Users/bortignon/dev/playarr`. Server tests: `corepack pnpm -C apps/server test`; one file: `corepack pnpm -C apps/server exec vitest run src/catalog/folderFs.test.ts`. Typecheck: `corepack pnpm -C apps/server typecheck`; web: `corepack pnpm -C apps/web exec tsc --noEmit`; build: `corepack pnpm -C apps/web exec vite build`.
- No SSH server in tests: SSH and SFTP behaviour is tested through small fakes (a fake shell, a fake SFTP session) and pure parsers.
- Commit after every task on `main`, staging only that task's files. Don't push.

---

### Task 1: Dependency and shared types

**Files:** `apps/server/package.json`, `pnpm-lock.yaml`, `packages/shared/src/index.ts`

Run: `corepack pnpm -C apps/server add @tokenizer/range@^0.13.1`

Shared types:

```ts
export type FolderAccessKind = 'local' | 'ssh' | 'sftp';
```

`SourceInfo.settings` becomes:

```ts
  settings?: {
    url?: string;
    path?: string;
    /** Folder sources: where the folder is. Absent means this server. */
    access?: FolderAccessKind;
    host?: string;
    port?: number;
    user?: string;
    privateKeyPath?: string;
  };
```

`SourceInput.settings` becomes:

```ts
  /** Lidarr: url, apiKey. Folder: path, plus access/host/port/user/password/privateKeyPath for SSH or SFTP. Leaving a secret out keeps the saved one. */
  settings?: {
    url?: string;
    apiKey?: string;
    path?: string;
    access?: FolderAccessKind;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    privateKeyPath?: string;
  };
```

Append:

```ts
/** Browse folders on this server, or over a (possibly unsaved) SSH/SFTP connection. */
export interface FolderBrowseRequest {
  path?: string;
  /** A saved source whose connection (and saved password) to use. */
  id?: number;
  connection?: {
    access: FolderAccessKind;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    privateKeyPath?: string;
  };
}
```

Add to `OrganizePlan`: `/** Why files can't be organized here, when they can't. */ reason?: string;`

Typecheck both apps (clean). Commit: `git add apps/server/package.json pnpm-lock.yaml packages/shared/src/index.ts && git commit -m "Remote folders: range tokenizer dependency and shared types"`

---

### Task 2: An SSH shell, and SFTP sessions others can use

**Files:** `apps/server/src/media/ssh.ts`, `apps/server/src/media/sftp.ts`

Behaviour-preserving refactor; existing tests must keep passing.

In `ssh.ts`, extract command running into an exported class and make `SshExecMediaSource` use it:

```ts
/** Runs commands over a shared SSH connection. */
export interface Shell {
  run(command: string): Promise<string>;
  runBuffer(command: string): Promise<Buffer>;
}

export class SshShell implements Shell {
  constructor(private readonly conn: SshConnection) {}

  async exec(command: string): Promise<ClientChannel> {
    const client = await this.conn.get();
    return new Promise((resolve, reject) => {
      client.exec(command, (err, channel) => (err ? reject(err) : resolve(channel)));
    });
  }

  async run(command: string): Promise<string> {
    return (await this.runBuffer(command)).toString('utf8');
  }

  /** stdout of a command; rejects with stderr on a non-zero exit. */
  async runBuffer(command: string): Promise<Buffer> {
    const channel = await this.exec(command);
    return new Promise((resolve, reject) => {
      const out: Buffer[] = [];
      let err = '';
      channel.on('data', (d: Buffer) => out.push(d));
      channel.stderr.on('data', (d: Buffer) => (err += d));
      channel.on('close', (code: number | null) => {
        if (code === 0) return resolve(Buffer.concat(out));
        reject(new Error(cleanSshError(err) || `exit code ${code}`));
      });
    });
  }
}

/** Drop sshd's noise about a missing home directory. */
export const cleanSshError = (stderr: string) => stderr.replace(/^Could not chdir to home directory.*\n?/m, '').trim();
```

`SshExecMediaSource`: keep its constructor `(conn, ffmpeg)`; create `private readonly shell = new SshShell(conn)` and replace its private `exec`/`run` with `this.shell.exec`/`this.shell.run` (and use `cleanSshError` in `pcm`).

In `sftp.ts`, rename the private `sftp()` to a public `session()` (update its callers in the file).

Run all server tests and typecheck: unchanged results. Commit: `git add apps/server/src/media/ssh.ts apps/server/src/media/sftp.ts && git commit -m "SSH: a reusable shell; SFTP sessions available to others"`

---

### Task 3: Tags and pictures from byte ranges

**Files:** `apps/server/src/catalog/tags.ts`; test `apps/server/src/catalog/tags.test.ts`

**Failing test** (add to `tags.test.ts`; import `LocalMediaSource` from `../media/local.ts`, `statSync` from `node:fs`, `vi`):

```ts
  it('reads tags from byte ranges through any media source', async () => {
    const path = file('01.flac', flacBytes({ TITLE: 'Angel', MUSICBRAINZ_TRACKID: 'rec-1' }));
    const media = new LocalMediaSource();
    const open = vi.spyOn(media, 'open');
    const tags = await readTagsFrom(media, path, statSync(path).size);
    expect(tags).toMatchObject({ title: 'Angel', recordingMbid: 'rec-1', duration: 200, format: { codec: 'FLAC', container: 'flac' } });
    expect(open.mock.calls.every(([, range]) => range !== undefined)).toBe(true);
  });
```

**Implement** in `tags.ts`:

- Factor the mapping out of `readTags` into `function toTagInfo(metadata: IAudioMetadata, path: string): TagInfo | null` (the existing body after `parseFile`), so `readTags(path)` becomes `toTagInfo(await parseFile(path, { skipCovers: true }), path)`.
- Add:

```ts
import { tokenizer as rangeTokenizer, type IRangeRequestClient } from '@tokenizer/range';
import { parseFromTokenizer, type IAudioMetadata } from 'music-metadata';
import { mimeForPath } from '../library/format.ts';
import type { MediaSource } from '../media/index.ts';

/** A range-request client over a MediaSource, so music-metadata can read any part of a remote file. */
function rangeClient(media: MediaSource, path: string, size: number): IRangeRequestClient {
  const info = { size, mimeType: mimeForPath(path), path, acceptPartialRequests: true };
  return {
    getHeadInfo: async () => info,
    async getResponse(_method, range) {
      const start = range?.[0] ?? 0;
      const end = Math.min(range?.[1] ?? size - 1, size - 1);
      const chunks: Buffer[] = [];
      for await (const chunk of await media.open(path, { start, end })) chunks.push(chunk as Buffer);
      const data = Buffer.concat(chunks);
      return {
        ...info,
        contentRange: { firstBytePosition: start, lastBytePosition: start + data.length - 1, instanceLength: size },
        arrayBuffer: async () => new Uint8Array(data),
      };
    },
    abort() {},
  };
}

async function parseRemote(media: MediaSource, path: string, size: number, skipCovers: boolean): Promise<IAudioMetadata> {
  const tok = await rangeTokenizer(rangeClient(media, path, size), { minimumChunkSize: 64 * 1024 });
  return parseFromTokenizer(tok, { skipCovers, duration: false });
}

/** Tags of a file read through byte ranges (SSH, SFTP). */
export async function readTagsFrom(media: MediaSource, path: string, size: number): Promise<TagInfo | null> {
  return toTagInfo(await parseRemote(media, path, size, true), path);
}

/** The embedded picture of a file read through byte ranges. */
export async function pictureFrom(media: MediaSource, path: string, size: number): Promise<{ body: Buffer; mime: string } | null> {
  const picture = (await parseRemote(media, path, size, false)).common.picture?.[0];
  return picture ? { body: Buffer.from(picture.data), mime: picture.format } : null;
}
```

Run tags tests: PASS (4). Commit: `git add apps/server/src/catalog/tags.ts apps/server/src/catalog/tags.test.ts && git commit -m "Tags and pictures from byte ranges, for remote folders"`

---

### Task 4: FolderFs: local, SSH, SFTP

**Files:** Create `apps/server/src/catalog/folderFs.ts`; test `apps/server/src/catalog/folderFs.test.ts`

**Failing tests:**

```ts
// apps/server/src/catalog/folderFs.test.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Shell } from '../media/ssh.ts';
import { LocalFolderFs, parseFindListing, parseStat, SftpFolderFs, SshFolderFs } from './folderFs.ts';
import { flacBytes, tempDir } from './testFixtures.ts';

let cleanup = () => {};
afterEach(() => cleanup());

describe('parsers', () => {
  it('reads GNU find listings, skipping non-audio files', () => {
    expect(parseFindListing('/music', '1200\t1700000000.5\tA/B/01.flac\n10\t1700000001\tA/B/cover.jpg\n')).toEqual([
      { rel: 'A/B/01.flac', path: '/music/A/B/01.flac', size: 1200, mtimeMs: 1700000000500 },
    ]);
  });
  it('reads stat output', () => {
    expect(parseStat('123 1700000000 regular file\n')).toEqual({ size: 123, mtimeMs: 1700000000000, dir: false });
    expect(parseStat('4096 1700000000 directory\n')).toEqual({ size: 4096, mtimeMs: 1700000000000, dir: true });
  });
});

describe('LocalFolderFs', () => {
  it('lists, stats and reads files on this server', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    mkdirSync(join(t.dir, 'A'));
    writeFileSync(join(t.dir, 'A/01.flac'), flacBytes({ TITLE: 'Angel' }));
    writeFileSync(join(t.dir, 'A/cover.jpg'), Buffer.from([1]));
    const fs = new LocalFolderFs();
    expect((await fs.listAudio(t.dir)).map((f) => f.rel)).toEqual(['A/01.flac']);
    expect((await fs.stat(join(t.dir, 'A')))!.dir).toBe(true);
    expect(await fs.stat(join(t.dir, 'nope'))).toBeNull();
    expect((await fs.readdir(join(t.dir, 'A'))).map((e) => e.name).sort()).toEqual(['01.flac', 'cover.jpg']);
    expect(await fs.readFile(join(t.dir, 'A/cover.jpg'))).toEqual(Buffer.from([1]));
    expect((await fs.readTags(join(t.dir, 'A/01.flac'), 0))!.title).toBe('Angel');
  });
});

function fakeShell(outputs: Record<string, string>): Shell & { commands: string[] } {
  const commands: string[] = [];
  const answer = async (command: string) => {
    commands.push(command);
    const hit = Object.entries(outputs).find(([prefix]) => command.startsWith(prefix));
    if (!hit) throw new Error(`No such file: ${command}`);
    return hit[1];
  };
  return { commands, run: answer, runBuffer: async (c) => Buffer.from(await answer(c)) };
}

describe('SshFolderFs', () => {
  it('lists audio files with one find command, skipping hidden folders', async () => {
    const shell = fakeShell({ find: '1200\t1700000000\tA/01.flac\n' });
    const fs = new SshFolderFs(shell, { kind: 'ssh' } as never, 'fpcalc');
    expect(await fs.listAudio('/music')).toEqual([{ rel: 'A/01.flac', path: '/music/A/01.flac', size: 1200, mtimeMs: 1700000000000 }]);
    expect(shell.commands[0]).toContain("'/music'");
    expect(shell.commands[0]).toContain('-prune');
  });

  it('explains a host without GNU find', async () => {
    const shell: Shell = { run: async () => Promise.reject(new Error('find: unrecognized: -printf')), runBuffer: async () => Buffer.alloc(0) };
    const fs = new SshFolderFs(shell, { kind: 'ssh' } as never, 'fpcalc');
    await expect(fs.listAudio('/music')).rejects.toThrow(/GNU find/);
  });

  it('stats, lists folders and fingerprints over the shell', async () => {
    const shell = fakeShell({
      stat: '4096 1700000000 directory\n',
      'find ': 'd\tAlbums\nf\tnotes.txt\n',
      'nice -n 10 ': '{"duration": 379.5, "fingerprint": "AQAA"}',
    });
    const fs = new SshFolderFs(shell, { kind: 'ssh' } as never, 'fpcalc');
    expect(await fs.stat('/music')).toEqual({ size: 4096, mtimeMs: 1700000000000, dir: true });
    expect(await fs.readdir('/music')).toEqual([
      { name: 'Albums', dir: true, file: false },
      { name: 'notes.txt', dir: false, file: true },
    ]);
    expect(await fs.fingerprint!('/music/a.flac')).toEqual({ duration: 379.5, fingerprint: 'AQAA' });
  });

  it('treats a failed stat as missing', async () => {
    const fs = new SshFolderFs(fakeShell({}), { kind: 'ssh' } as never, 'fpcalc');
    expect(await fs.stat('/nope')).toBeNull();
  });
});

describe('SftpFolderFs', () => {
  const attrs = (dir: boolean, size = 10) => ({ size, mtime: 1700000000, isDirectory: () => dir, isFile: () => !dir });
  const tree: Record<string, { filename: string; attrs: ReturnType<typeof attrs> }[]> = {
    '/music': [
      { filename: 'A', attrs: attrs(true) },
      { filename: '.hidden', attrs: attrs(true) },
    ],
    '/music/A': [
      { filename: '01.flac', attrs: attrs(false, 1200) },
      { filename: 'cover.jpg', attrs: attrs(false) },
    ],
  };
  const session = {
    readdir: (p: string, cb: (err: Error | null, list?: unknown) => void) => (tree[p] ? cb(null, tree[p]) : cb(new Error('No such file'))),
    stat: (p: string, cb: (err: Error | null, s?: unknown) => void) => (tree[p] ? cb(null, attrs(true)) : cb(new Error('No such file'))),
    readFile: (_p: string, cb: (err: Error | null, b?: Buffer) => void) => cb(null, Buffer.from([7])),
  };
  const media = { kind: 'sftp', session: async () => session } as never;

  it('walks folders, skipping hidden ones', async () => {
    const fs = new SftpFolderFs(media);
    expect(await fs.listAudio('/music')).toEqual([{ rel: 'A/01.flac', path: '/music/A/01.flac', size: 1200, mtimeMs: 1700000000000 }]);
    expect(fs.fingerprint).toBeUndefined();
  });

  it('stats, lists and reads', async () => {
    const fs = new SftpFolderFs(media);
    expect((await fs.stat('/music'))!.dir).toBe(true);
    expect(await fs.stat('/nope')).toBeNull();
    expect((await fs.readdir('/music/A')).map((e) => e.name)).toEqual(['01.flac', 'cover.jpg']);
    expect(await fs.readFile('/music/A/cover.jpg')).toEqual(Buffer.from([7]));
  });
});
```

**Implement:**

```ts
// apps/server/src/catalog/folderFs.ts
import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import type { SFTPWrapper } from 'ssh2';
import { LocalMediaSource } from '../media/local.ts';
import type { MediaSource } from '../media/index.ts';
import type { SftpMediaSource } from '../media/sftp.ts';
import { shellQuote, type Shell } from '../media/ssh.ts';
import { fpcalc, type Fingerprint } from './acoustid.ts';
import { isAudioFile, listAudioFiles } from './folderSource.ts';
import { pictureFrom, readTags, readTagsFrom, type TagInfo } from './tags.ts';
import { parseFile } from 'music-metadata';

export interface FoundFile {
  rel: string;
  path: string;
  size: number;
  mtimeMs: number;
}

export interface FsEntry {
  name: string;
  dir: boolean;
  file: boolean;
}

/** A folder source's filesystem: this server's disk, or another machine over SSH or SFTP. */
export interface FolderFs {
  readonly kind: 'local' | 'ssh' | 'sftp';
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

  readTags(path: string) {
    return readTags(path);
  }

  async picture(path: string) {
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
```

Note: `FoundFile` is declared here; make `folderSource.ts` import it from `./folderFs.ts` instead of declaring its own (avoid a circular *value* import: `folderFs.ts` imports `isAudioFile`/`listAudioFiles` values from `folderSource.ts`, so `folderSource.ts` may only import *types* from `folderFs.ts`).

Run: PASS (9). Commit: `git add apps/server/src/catalog/folderFs.ts apps/server/src/catalog/folderFs.test.ts apps/server/src/catalog/folderSource.ts && git commit -m "Folder filesystems: this server, SSH and SFTP"`

---

### Task 5: FolderAccess: one filesystem per folder source

**Files:** Create `apps/server/src/catalog/folderAccess.ts`; test `apps/server/src/catalog/folderAccess.test.ts`

**Failing tests:**

```ts
// apps/server/src/catalog/folderAccess.test.ts
import { describe, expect, it } from 'vitest';
import { FolderAccess } from './folderAccess.ts';
import { CatalogStore } from './store.ts';
import { freshDb } from './testFixtures.ts';

describe('FolderAccess', () => {
  it('gives each folder source its filesystem, cached until its settings change', async () => {
    const store = new CatalogStore(freshDb());
    const local = store.addSource('folder', 'Here', { path: '/music' });
    const remote = store.addSource('folder', 'NAS', { path: '/volume1/music', access: 'sftp', host: 'nas', user: 'me' });
    const lidarr = store.addSource('lidarr', 'Lidarr', { url: 'http://x', apiKey: 'k' });
    const access = new FolderAccess(store, { ffmpeg: 'ffmpeg', fpcalc: 'fpcalc', localFingerprints: false });
    expect(access.get(local)!.kind).toBe('local');
    expect(access.get(remote)!.kind).toBe('sftp');
    expect(access.get(remote)).toBe(access.get(remote));
    expect(access.get(lidarr)).toBeUndefined();
    const before = access.get(remote);
    store.updateSource(remote, { settings: { path: '/volume1/music', access: 'ssh', host: 'nas', user: 'me' } });
    expect(access.get(remote)).not.toBe(before);
    expect(access.get(remote)!.kind).toBe('ssh');
    await access.closeAll();
  });

  it('needs a host and a user for remote folders', () => {
    const access = new FolderAccess(new CatalogStore(freshDb()), { ffmpeg: 'ffmpeg', fpcalc: 'fpcalc', localFingerprints: false });
    expect(() => access.create({ path: '/m', access: 'ssh' })).toThrow(/host and a user/);
  });
});
```

**Implement:**

```ts
// apps/server/src/catalog/folderAccess.ts
import type { FolderAccessKind } from '@playarr/shared';
import { SftpMediaSource } from '../media/sftp.ts';
import { SshConnection, SshExecMediaSource, SshShell } from '../media/ssh.ts';
import { LocalFolderFs, SftpFolderFs, SshFolderFs, type FolderFs } from './folderFs.ts';
import type { CatalogStore } from './store.ts';

export interface FolderSettings {
  path?: string;
  access?: FolderAccessKind;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  privateKeyPath?: string;
}

/** One FolderFs per folder source, created from its settings and kept until they change. */
export class FolderAccess {
  private readonly cache = new Map<number, { key: string; fs: FolderFs }>();

  constructor(
    private readonly store: CatalogStore,
    private readonly tools: { ffmpeg: string; fpcalc: string; localFingerprints: boolean },
  ) {}

  get(sourceId: number): FolderFs | undefined {
    const source = this.store.source(sourceId);
    if (!source || source.kind !== 'folder') {
      this.release(sourceId);
      return undefined;
    }
    const key = JSON.stringify(source.settings);
    const cached = this.cache.get(sourceId);
    if (cached?.key === key) return cached.fs;
    void cached?.fs.close();
    const fs = this.create(source.settings as FolderSettings);
    this.cache.set(sourceId, { key, fs });
    return fs;
  }

  /** A filesystem for these settings, not cached (browsing an unsaved connection). Close it after use. */
  create(settings: FolderSettings): FolderFs {
    const access = settings.access ?? 'local';
    if (access === 'local') {
      return new LocalFolderFs({ ffmpeg: this.tools.ffmpeg, fpcalc: this.tools.localFingerprints ? this.tools.fpcalc : undefined });
    }
    if (!settings.host || !settings.user) throw new Error('A remote folder needs a host and a user');
    const conn = new SshConnection({
      host: settings.host,
      port: settings.port ?? 22,
      username: settings.user,
      password: settings.password,
      privateKeyPath: settings.privateKeyPath,
    });
    if (access === 'sftp') return new SftpFolderFs(new SftpMediaSource(conn));
    return new SshFolderFs(new SshShell(conn), new SshExecMediaSource(conn, this.tools.ffmpeg), this.tools.fpcalc, () => conn.close());
  }

  release(sourceId: number) {
    const cached = this.cache.get(sourceId);
    this.cache.delete(sourceId);
    void cached?.fs.close();
  }

  async closeAll() {
    await Promise.all([...this.cache.values()].map((c) => c.fs.close()));
    this.cache.clear();
  }
}
```

(`SshConnection` connects lazily, so creating these in tests opens no connection.) Run: PASS (2). Commit: `git add apps/server/src/catalog/folderAccess.ts apps/server/src/catalog/folderAccess.test.ts && git commit -m "Folder access: one filesystem per folder source"`

---

### Task 6: Everything folder-related goes through FolderFs

**Files:** `apps/server/src/catalog/folderSource.ts` (+ test), `apps/server/src/catalog/folderArt.ts` (+ test), `apps/server/src/catalog/files.ts` (+ test), `apps/server/src/catalog/matcher.ts` (+ test), `apps/server/src/routes/art.ts`, `apps/server/src/catalog/organizer.ts` (+ test)

Existing tests are the safety net: update their setup to the new signatures, keep their assertions.

1. **`FolderSource`**: options gain `fs: FolderFs`; `readTags?` becomes `(path: string, size: number) => Promise<TagInfo | null>`; `concurrency` defaults to `fs.concurrency`. In `sync()`: root check `(await fs.stat(root))?.dir`, listing `await fs.listAudio(root)`, reading `read(f.path, f.size)` with `read = this.opts.readTags ?? ((p, size) => fs.readTags(p, size))`. Tests: pass `fs: new LocalFolderFs()`. Add one test with a fake remote `FolderFs` (an object implementing the interface whose `listAudio` returns one file and `readTags` returns tags) proving no local filesystem call is needed: `sync()` returns that file as a copy.

2. **`copyCover(fs, path, size)`** (`folderArt.ts`): try `fs.picture(path, size)`; then look for `cover|folder|front|album.(jpe?g|png|webp)` among `(await fs.readdir(posix.dirname(path))).filter((e) => e.file)` and `fs.readFile` it. Tests: pass `new LocalFolderFs()` and the file size (`statSync(path).size`).

3. **`FileResolver`**: the constructor's third parameter becomes `folders: { get(sourceId: number): FolderFs | undefined }`; the folder branch returns `{ media: folders.get(file.sourceId)!.media, path }` (404 `FileAccessError` if `get` returns undefined). The `isInside(path, root)` check stays. Tests: pass `{ get: () => ({ media: local }) as never }`.

4. **Art route** `/art/copy/:id`: deps gain `folders: { get(id: number): FolderFs | undefined }`; drop the "local only" check; after resolving, `const fs = deps.folders.get(file.sourceId)` (404 if none) and `copyCover(fs, path, file.size)`.

5. **Matcher fingerprints**: `MatcherDeps.fingerprint` becomes `(sourceId: number, path: string) => Promise<Fingerprint | null>`; thread `sourceId` into `matchGroup`/`byFingerprint` and call `fingerprint(sourceId, f.path)`. Test: `expect(fingerprint).toHaveBeenCalledWith(sourceId, '/music/Massive Attack/Angel.flac')`.

6. **Organizer**: `root()` also returns the source's `access`; `plan()` for a non-local source returns `{ writable: false, reason: 'Organizing works for folders on this server only.', moves: [], skipped: [], lastBatch }`; `apply`/`undo` throw `OrganizeError('Organizing works for folders on this server only', 409)`. Add a test for a remote source's plan.

Run all server tests and typecheck: `index.ts` errors expected (wiring, Task 8); everything else clean and passing. Commit: `git add apps/server/src/catalog/folderSource.ts apps/server/src/catalog/folderSource.test.ts apps/server/src/catalog/folderArt.ts apps/server/src/catalog/folderArt.test.ts apps/server/src/catalog/files.ts apps/server/src/catalog/files.test.ts apps/server/src/catalog/matcher.ts apps/server/src/catalog/matcher.test.ts apps/server/src/routes/art.ts apps/server/src/catalog/organizer.ts apps/server/src/catalog/organizer.test.ts && git commit -m "Folder scanning, artwork, streaming and fingerprints through FolderFs"`

---

### Task 7: SourceManager: remote folders, verification, browsing

**Files:** `apps/server/src/catalog/sources.ts`, `apps/server/src/catalog/sources.test.ts`

**Failing tests** (inside the `folders` describe; a fake access that returns a fake filesystem):

```ts
    function fakeRemote(dirs: Record<string, string[]>) {
      const fs = {
        kind: 'ssh',
        stat: async (p: string) => (dirs[p] ? { size: 0, mtimeMs: 0, dir: true } : null),
        readdir: async (p: string) => (dirs[p] ?? []).map((name) => ({ name, dir: !name.includes('.'), file: name.includes('.') })),
        close: async () => {},
      };
      return { create: vi.fn(() => fs), get: () => fs as never, release: () => {} };
    }

    it('adds a remote folder after checking it over the connection, keeping the password secret', async () => {
      const { store, manager } = withFolders();
      const access = fakeRemote({ '/volume1/music': [] });
      manager.useFolderAccess(access as never);
      const input = { kind: 'folder' as const, settings: { access: 'ssh' as const, host: 'nas', user: 'me', password: 'pw', path: '/volume1/music' } };
      await manager.verify(input);
      const info = manager.add(input);
      expect(info).toMatchObject({ name: 'music', settings: { access: 'ssh', host: 'nas', user: 'me', path: '/volume1/music', port: 22 }, secrets: ['password'] });
      expect(JSON.stringify(info)).not.toContain('pw');
      expect(info.writable).toBeUndefined();
      expect(store.source(info.id)!.settings).toMatchObject({ password: 'pw' });
    });

    it('rejects a remote folder that isn’t there, or has no host', async () => {
      const { manager } = withFolders();
      manager.useFolderAccess(fakeRemote({}) as never);
      await expect(manager.verify({ kind: 'folder', settings: { access: 'ssh', host: 'nas', user: 'me', path: '/nope' } })).rejects.toThrow(SourceError);
      expect(() => manager.add({ kind: 'folder', settings: { access: 'ssh', path: '/m' } })).toThrow(/host and a user/);
    });

    it('browses a remote connection, reusing a saved password', async () => {
      const { manager, store } = withFolders();
      const access = fakeRemote({ '/': ['volume1', 'etc'], '/volume1': ['music', 'notes.txt'] });
      manager.useFolderAccess(access as never);
      const id = store.addSource('folder', 'NAS', { access: 'sftp', host: 'nas', user: 'me', password: 'pw', path: '/volume1' });
      const listing = await manager.browse({ id, path: '/volume1' });
      expect(listing).toEqual({ path: '/volume1', parent: '/', folders: [{ name: 'music', path: '/volume1/music' }], audioFiles: 0 });
      expect(access.create).toHaveBeenCalledWith(expect.objectContaining({ password: 'pw', host: 'nas' }));
      expect((await manager.browse({ connection: { access: 'ssh', host: 'nas', user: 'me' } })).path).toBe('/');
    });
```

(add `vi` to the vitest import.)

**Implement** in `sources.ts`:

- `SECRET_FIELDS = ['apiKey', 'password']`.
- `useFolderAccess(access: Pick<FolderAccess, 'create' | 'get' | 'release'>)`; store as `private folders?`. In `active()`, folder sources get `fs: this.folders?.get(s.id) ?? new LocalFolderFs()` (import from `./folderFs.ts`).
- A helper to normalize folder settings from input (+ saved settings for updates):

```ts
  private folderSettings(input: SourceInput['settings'] = {}, saved: FolderSettings = {}): FolderSettings {
    const access = input.access ?? saved.access ?? 'local';
    const path = input.path ?? saved.path;
    if (!path) throw new SourceError('A folder source needs a folder', 400);
    if (access === 'local') return { path: this.checkFolder(path) };
    const host = (input.host ?? saved.host)?.trim();
    const user = (input.user ?? saved.user)?.trim();
    if (!host || !user) throw new SourceError('A remote folder needs a host and a user', 400);
    if (!path.startsWith('/')) throw new SourceError('The folder must be an absolute path on that host', 400);
    return {
      access,
      host,
      user,
      port: input.port ?? saved.port ?? 22,
      path: posix.normalize(path).replace(/(.)\/+$/, '$1'),
      password: input.password || saved.password || undefined,
      privateKeyPath: (input.privateKeyPath ?? saved.privateKeyPath)?.trim() || undefined,
    };
  }
```

- `add()` folder branch: `const settings = this.folderSettings(input.settings); id = this.store.addSource('folder', input.name?.trim() || posix.basename(settings.path!) || settings.path!, { ...settings });` (drop undefined fields with `JSON.parse(JSON.stringify(...))` before storing).
- `update()` folder branch: `settings = input.settings ? this.folderSettings(input.settings, source.settings as FolderSettings) : undefined`; after updating, `this.folders?.release(id)` so the next use reconnects.
- `remove()`: `this.folders?.release(id)`.
- `async verify(input: SourceInput, id?: number)`: only for folder kinds with a remote `access` (resolved with saved settings when `id` is given): `const fs = this.folders!.create(settings)`; `const s = await fs.stat(settings.path!)`; `await fs.close()`; if `!s?.dir` throw `SourceError(\`Can’t open ${settings.path} on ${settings.host}\`, 400)`; connection errors (thrown by `stat` implementations that reject, or `create`) become 400 with their message. Local folders: no-op (`add`/`update` validate synchronously).
- `async browse(req: FolderBrowseRequest): Promise<FolderListing>`:
  - no `connection` and no `id`, or a local connection: `this.listFolders(req.path)` (existing).
  - otherwise build settings from `req.connection` merged over the saved source's settings (`req.id`), with `path` defaulting to `'/'`; `const fs = this.folders!.create(settings)`; list `fs.readdir(path)`: folders = entries with `dir` and not starting with `.`, sorted case-insensitively, as `{ name, path: posix.join(path, name) }`; `audioFiles` = entries with `file` and `isAudioFile(name)`; `parent = path === '/' ? null : posix.dirname(path)`; close `fs` in `finally`; errors → `SourceError(message, 400)`.
- `toInfo`: settings include `access`, `host`, `port`, `user`, `privateKeyPath` (never `password`); `writable` only when the folder is local.

Run: PASS. Commit: `git add apps/server/src/catalog/sources.ts apps/server/src/catalog/sources.test.ts && git commit -m "Source manager: SSH and SFTP folder sources, verified and browsable"`

---

### Task 8: API and wiring

**Files:** `apps/server/src/routes/settings.ts`, `apps/server/src/routes/settings.test.ts`, `apps/server/src/index.ts`

**Tests** (`settings.test.ts`):

```ts
  it('browses over a connection from the home network only', async () => {
    const { app } = setup();
    const away = await app.inject({ method: 'POST', url: '/api/settings/folders/browse', payload: {}, remoteAddress: AWAY });
    expect(away.statusCode).toBe(403);
    const home = await app.inject({ method: 'POST', url: '/api/settings/folders/browse', payload: {}, remoteAddress: HOME });
    expect(home.json()).toMatchObject({ path: null });
  });

  it('validates remote connection fields', async () => {
    const res = await setup().app.inject({
      method: 'POST',
      url: '/api/settings/sources',
      payload: { kind: 'folder', settings: { access: 'ssh', host: 'nas', user: 'me', port: 99999, path: '/m' } },
      remoteAddress: HOME,
    });
    expect(res.statusCode).toBe(400);
  });
```

**Implement** (`routes/settings.ts`):

- `sourceInput.settings` gains: `access: z.enum(['local', 'ssh', 'sftp']).optional()`, `host: z.string().trim().max(255).optional()`, `port: z.number().int().min(1).max(65535).optional()`, `user: z.string().trim().max(100).optional()`, `password: z.string().max(500).optional()`, `privateKeyPath: z.string().trim().max(4096).optional()`.
- `const browseInput = z.object({ path: z.string().max(4096).optional(), id: z.number().int().optional(), connection: z.object({ access: z.enum(['local', 'ssh', 'sftp']), host: z.string().trim().max(255).optional(), port: z.number().int().min(1).max(65535).optional(), user: z.string().trim().max(100).optional(), password: z.string().max(500).optional(), privateKeyPath: z.string().trim().max(4096).optional() }).optional() });`
- POST `/api/settings/sources`: `const input = parse(sourceInput, req.body); await sources.verify(input); const info = sources.add(input); …` (make the handler async).
- PATCH: `await sources.verify(input, id)` before `sources.update`.
- `app.post('/api/settings/folders/browse', editable, (req, reply) => handle(reply, () => sources.browse(parse(browseInput, req.body))));`

**Wire** (`index.ts`):

```ts
const folders = new FolderAccess(store, { ffmpeg: config.FFMPEG_PATH, fpcalc: config.FPCALC_PATH, localFingerprints: fingerprints });
sources.useFolderAccess(folders);
```

(`fingerprints` is the `hasFpcalc` result; make sure it's computed before this line.) Pass `folders` to `new FileResolver(store, { media, pathMap }, folders)`, to `artRoutes(…, folders)` and use `fingerprint: (sourceId, path) => folders.get(sourceId)?.fingerprint?.(path) ?? Promise.resolve(null)` in the `Matcher` deps (drop the old local-only `fpcalc(...)`). In `shutdown`, `await folders.closeAll()` before closing the app.

Typecheck, all tests, build: clean/pass. Commit: `git add apps/server/src/routes/settings.ts apps/server/src/routes/settings.test.ts apps/server/src/index.ts && git commit -m "Server: remote folder sources wired in, browse over SSH/SFTP"`

---

### Task 9: Web: choosing where a folder is

**Files:** `apps/web/src/lib/api.ts`, `apps/web/src/lib/queries.ts`, `apps/web/src/components/SourcesPanel.tsx`, `apps/web/src/components/OrganizeDialog.tsx`

**API** (add `FolderBrowseRequest` to imports):

```ts
  browseFolders: (req: FolderBrowseRequest) =>
    request<FolderListing>('/api/settings/folders/browse', { method: 'POST', body: JSON.stringify(req) }),
```

**Query** (replace `useFolders` with a general one; update its callers):

```ts
/** Folders to choose from: on this server, or over a (possibly unsaved) SSH/SFTP connection. */
export const useFolderListing = (req: FolderBrowseRequest, enabled = true) =>
  useQuery({
    queryKey: ['folders', req.path ?? '', req.id ?? null, req.connection ? { ...req.connection, password: !!req.connection.password } : null],
    queryFn: () => api.browseFolders(req),
    enabled,
    retry: false,
  });
```

**`SourcesPanel.tsx`:**

- `FolderBrowser` takes `{ value, onChange, request }` where `request: Omit<FolderBrowseRequest, 'path'>` (the connection and/or saved id); it keeps `at` state and calls `useFolderListing({ ...request, path: at })`. For local folders pass `request={{}}`.
- `FolderForm`:
  - State: `access` (`'local' | 'ssh' | 'sftp'`, from `source?.settings?.access ?? 'local'`), `host`, `port` (default 22), `user`, `password` + `replacingPassword` (like the Lidarr key: "Saved · Replace" when `source?.secrets.includes('password')`), `keyPath`, and `connected` (whether the browser should load; true for local, and for remote once the user presses Connect or when editing a saved remote source).
  - A segmented control for access: three buttons "This server", "SSH", "SFTP" (`role="radiogroup"`), styled like the Settings tabs.
  - For SSH/SFTP: fields Host, Port, User, Password (or saved), Key file on the server (optional, placeholder `~/.ssh/id_ed25519`); a short note: "SSH also runs song analysis and fingerprints on that machine. SFTP only reads files." and a **Connect** button (`SECONDARY`) that sets `connected` (and re-keys the browser so it reloads).
  - The browser's `request`: local → `{}`; remote → `{ id: source?.id, connection: { access, host, port, user, password: replacingPassword ? password || undefined : undefined, privateKeyPath: keyPath || undefined } }`; rendered only when `connected` and (for remote) host and user are filled.
  - Save sends `settings: { path, access, ...(remote ? { host, port, user, privateKeyPath: keyPath || undefined, ...(password ? { password } : {}) } : {}) }`.
- `SourceRow`: for remote folders, show `user@host:path` in the details and use the lucide `Network` icon instead of `FolderOpen`.

**`OrganizeDialog.tsx`:** when `plan.reason` is set, show it (instead of the Docker read-write explanation) and no moves.

Typecheck and build: clean. Commit: `git add apps/web/src/lib/api.ts apps/web/src/lib/queries.ts apps/web/src/components/SourcesPanel.tsx apps/web/src/components/OrganizeDialog.tsx && git commit -m "Web: folder sources on other machines over SSH or SFTP"`

---

### Task 10: Docs

**Files:** `PLAN.md`, `README.md`

- PLAN.md decisions log: `| 2026-10-30 | Remote folder sources (phase 5): a folder source can be on another machine over SSH (GNU find listings, stat/cat/tail over one connection, ffmpeg and fpcalc run remotely) or SFTP (readdir/stat/readFile; no analysis or fingerprints). Folder code goes through a FolderFs per source (FolderAccess caches one per source until its settings change). Remote tags come from byte ranges (music-metadata + @tokenizer/range, ≥64 KB chunks; SSH reads 3 files at a time because sshd allows ~10 channels). Remote folders are verified on save; the password is a write-only secret; FOLDER_ROOTS applies to local folders only; organizing stays local-only. |`
- README Folder sources bullet: add `A folder can also be on another machine, over SSH or SFTP, without mounting anything.`

Commit: `git add PLAN.md README.md && git commit -m "Docs: remote folder sources"`

---

## Not verified by this plan

- A real SSH or SFTP server (only fakes and a local media source in tests): connection errors, auth by key/agent, UGOS's restricted SFTP, BusyBox `find`.
- Tag reading over real SSH latency (number of range reads per format, speed of a first scan).
- Remote `fpcalc`/`ffmpeg` availability and paths on the host.
- The Settings form in a browser.
