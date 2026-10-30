# Sources, Phase 6: Network Shares Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A folder source can be an SMB share (Windows, macOS, a NAS), read without mounting anything, through rclone. NFS is documented as "mount it on the host, then use This server".

**Architecture:** A new `RcloneFolderFs` (kind `smb`) implements the Phase 5 `FolderFs` interface with the `rclone` binary: `rclone lsjson` lists, stats and browses (one short-lived process per call), and one long-lived `rclone serve http` per share, bound to 127.0.0.1 on a free port with random credentials, serves byte ranges for streaming and tag reading. Analysis and fingerprints run on this server: ffmpeg and fpcalc read the loopback URL. Connection settings travel only in environment variables (`RCLONE_SMB_*`, the password obscured the way rclone expects), never on a command line. rclone is optional: when it isn't installed the SMB choice is shown but disabled.

**Tech Stack:** rclone ≥ 1.60 (SMB backend; Docker: Alpine `rclone`), Node 25 `child_process`/`http`, Fastify 5, zod 4, vitest 5; React 19, TanStack Query 5. pnpm via `corepack pnpm`.

**Design:** `docs/plans/2026-10-30-sources-design.md` (Network shares; Rollout phase 6). Builds on Phase 5 (`FolderFs`, `FolderAccess`, remote folder settings).

## Why rclone and not a Node SMB client

Evaluated 2026-10-30: `node-smb2` 1.3.5 and `@awo00/smb2` 1.1.1 are the only maintained Node clients and are one codebase. They negotiate only SMB 2.0.2/2.1, implement no message signing and no encryption (Windows 11 24H2 and Windows Server 2025 require signing by default), and expose no ranged read. rclone's SMB backend speaks SMB 2.0.2–3.1.1 with signing and NTLMv2, lists with sizes and times, and serves ranges over HTTP.

Prototyped with rclone 1.75.2 (local backend standing in for SMB, same serve/list code):
- `rclone --config "" lsjson -R --files-only --no-mimetype --exclude '.*' --exclude '.*/**' REMOTE` → `[{"Path","Name","Size","ModTime","IsDir"}]`, hidden folders skipped.
- `lsjson --stat REMOTE` → one object (folders: `Size: -1`, `IsDir: true`); exit code **3** for a missing folder, **4** for a missing file.
- Connection failures: exit 1, last stderr line `… CRITICAL: Failed to create file system for ":smb:share/x": couldn't connect SMB: dial tcp …: connect: connection refused`.
- `rclone serve http REMOTE --config "" --read-only --dir-cache-time 10s` with `RCLONE_ADDR=127.0.0.1:PORT RCLONE_USER=u RCLONE_PASS=p` in the environment: 401 without credentials, `206` + `Content-Range` for ranges, `Content-Length` and `Last-Modified` on HEAD; stderr prints `HTTP Server started on [http://127.0.0.1:PORT/]` when ready. The credentials don't appear in `ps`.
- `RCLONE_SMB_PASS` must be obscured: AES-256-CTR with rclone's fixed public key, random 16-byte IV, `base64url(iv ‖ ciphertext)`. A Node port was checked both ways against `rclone obscure`/`reveal` (`rCT8g9glnAwjqSXuumvcrycJ` reveals to `pw`).
- `:smb:` with no share lists the server's shares (rclone docs; not prototyped without a server).

## Decisions

- **Settings of an SMB folder source:** `{ access: 'smb', host, port (445), user, password? (secret), domain? (default WORKGROUP), path }` where `path` is `/<share>/<folder inside it>`: the first segment is the share. Browsing at `/` lists shares. Saving needs at least a share (`Choose a share`). For guest access the user types `guest` and no password.
- **Paths everywhere are `/<share>/…`**, so FolderFs paths, copy paths, and the scanner work unchanged.
- **One `rclone serve http` per share**, started on first read, stopped when the source's filesystem closes (settings change, removal, shutdown). If it exits it is restarted on the next read. Loopback only, random user and password per process.
- **Reads:** 4 files at a time. Directory listings in serve are cached 10 s, so a file found by a scan streams within seconds.
- **Analysis and fingerprints** run here (local ffmpeg/fpcalc on the loopback URL), best effort: a failure means no analysis or fingerprint for that song, as elsewhere.
- **Organizing** stays local-only (Phase 5 already refuses non-local folders).
- **Saved password rule** from Phase 5 holds: it's reused only for the same host and user.
- **Availability:** `GET /api/settings/folders/access` → `{ smb: boolean }` (rclone runs). Without rclone, adding or browsing an SMB folder answers 400 `SMB shares need rclone on the server`.
- **Testing:** pure parts (obscure, error cleanup, listing parsers, settings) are unit-tested; `RcloneFolderFs` is integration-tested against a real `rclone` with its **local** backend standing in for SMB (`describe.skipIf` when rclone isn't installed; `RCLONE_BIN` points at a binary). No SMB server in tests.

## Conventions

- Run from `/Users/bortignon/dev/playarr`. Server tests: `corepack pnpm -C apps/server test`; one file: `corepack pnpm -C apps/server exec vitest run src/media/rclone.test.ts`. Typecheck: `corepack pnpm -C apps/server typecheck`; web: `corepack pnpm -C apps/web exec tsc --noEmit`; build: `corepack pnpm -C apps/web exec vite build`.
- rclone for integration tests in this environment: `RCLONE_BIN=$(ls -d /tmp/rclone-dl/rclone-*/)rclone` (downloaded for the prototype; if missing, the integration tests skip; say so in the report).
- Commit after every task on `main`, staging only that task's files. Don't push.

---

### Task 1: Shared types and config

**Files:** `packages/shared/src/index.ts`, `apps/server/src/config.ts`, `apps/server/src/media/source.ts`, `apps/server/src/catalog/folderFs.ts` (kind union only)

- `export type FolderAccessKind = 'local' | 'ssh' | 'sftp' | 'smb';`
- `SourceInfo.settings`, `SourceInput.settings` and `FolderBrowseRequest.connection` gain `domain?: string` (update the doc comments: "SSH, SFTP or SMB"; for SMB, `path` is `/share/folder`).
- Append:

```ts
/** Which folder locations this server can reach. */
export interface FolderAccessOptions {
  /** rclone is installed, so SMB shares work. */
  smb: boolean;
}
```

- `config.ts`, next to `FPCALC_PATH`: `/** rclone, for folders on SMB shares (optional). */ RCLONE_PATH: z.string().default('rclone'),`
- `MediaSource.kind` and `FolderFs.kind` unions gain `'smb'`.

Typecheck both apps. Commit: `git add packages/shared/src/index.ts apps/server/src/config.ts apps/server/src/media/source.ts apps/server/src/catalog/folderFs.ts && git commit -m "Shares: shared types and config"`

---

### Task 2: rclone basics

**Files:** Create `apps/server/src/media/rclone.ts`; test `apps/server/src/media/rclone.test.ts`

**Failing tests:**

```ts
// apps/server/src/media/rclone.test.ts
import { describe, expect, it } from 'vitest';
import { cleanRcloneError, obscure, parseLsjson, reveal, smbEnv } from './rclone.ts';

describe('obscure', () => {
  it('matches rclone', () => {
    expect(reveal('rCT8g9glnAwjqSXuumvcrycJ')).toBe('pw');
    expect(reveal(obscure(`pä ss'"$x`))).toBe(`pä ss'"$x`);
    expect(obscure('pw')).not.toBe(obscure('pw'));
  });
});

describe('cleanRcloneError', () => {
  it('keeps the useful part of the last line', () => {
    const stderr =
      '2026/10/30 18:33:42 NOTICE: Config file not found\n' +
      '2026/10/30 18:33:42 CRITICAL: Failed to create file system for ":smb:share/x": couldn\'t connect SMB: dial tcp 127.0.0.1:1: connect: connection refused\n';
    expect(cleanRcloneError(stderr)).toBe("couldn't connect SMB: dial tcp 127.0.0.1:1: connect: connection refused");
    expect(cleanRcloneError('2026/10/30 18:33:37 NOTICE: Failed to lsjson: directory not found\n')).toBe('directory not found');
    expect(cleanRcloneError('')).toBe('');
  });
});

describe('parseLsjson', () => {
  it('reads entries', () => {
    expect(
      parseLsjson('[{"Path":"A/01.flac","Name":"01.flac","Size":12,"ModTime":"2026-10-30T18:32:22.5Z","IsDir":false},{"Path":"B","Name":"B","Size":-1,"ModTime":"","IsDir":true}]'),
    ).toEqual([
      { path: 'A/01.flac', name: '01.flac', size: 12, mtimeMs: Date.parse('2026-10-30T18:32:22.5Z'), dir: false },
      { path: 'B', name: 'B', size: 0, mtimeMs: 0, dir: true },
    ]);
  });
});

describe('smbEnv', () => {
  it('puts the connection in rclone environment variables, the password obscured', () => {
    const env = smbEnv({ host: 'nas', port: 445, user: 'me', password: 'pw', domain: 'HOME' });
    expect(env).toMatchObject({ RCLONE_SMB_HOST: 'nas', RCLONE_SMB_PORT: '445', RCLONE_SMB_USER: 'me', RCLONE_SMB_DOMAIN: 'HOME' });
    expect(reveal(env.RCLONE_SMB_PASS!)).toBe('pw');
    expect(smbEnv({ host: 'nas', user: 'guest' })).not.toHaveProperty('RCLONE_SMB_PASS');
  });
});
```

**Implement:**

```ts
// apps/server/src/media/rclone.ts
import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// rclone's fixed, public key for "obscured" config values (not encryption; it keeps passwords off screens).
const OBSCURE_KEY = Buffer.from([
  0x9c, 0x93, 0x5b, 0x48, 0x73, 0x0a, 0x55, 0x4d, 0x6b, 0xfd, 0x7c, 0x63, 0xc8, 0x86, 0xa9, 0x2b,
  0xd3, 0x90, 0x19, 0x8e, 0xb8, 0x12, 0x8a, 0xfb, 0xf4, 0xde, 0x16, 0x2b, 0x8b, 0x95, 0xf6, 0x38,
]);

/** A password the way rclone wants it in RCLONE_*_PASS. */
export function obscure(plain: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-ctr', OBSCURE_KEY, iv);
  return Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final()]).toString('base64url');
}

export function reveal(obscured: string): string {
  const data = Buffer.from(obscured, 'base64url');
  const decipher = createDecipheriv('aes-256-ctr', OBSCURE_KEY, data.subarray(0, 16));
  return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString('utf8');
}

/** The last stderr line, without rclone's timestamp, level and "Failed to …:" preamble. */
export function cleanRcloneError(stderr: string): string {
  const last = stderr.trim().split('\n').pop() ?? '';
  return last
    .replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d [A-Z]+\s*:\s*/, '')
    .replace(/^Failed to create file system for ".*?":\s*/, '')
    .replace(/^Failed to \w+:\s*/, '')
    .trim();
}

export interface RcloneEntry {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  dir: boolean;
}

export function parseLsjson(out: string): RcloneEntry[] {
  const items = JSON.parse(out) as { Path: string; Name: string; Size: number; ModTime: string; IsDir: boolean }[];
  return items.map((i) => ({
    path: i.Path,
    name: i.Name,
    size: Math.max(0, i.Size),
    mtimeMs: i.ModTime ? Date.parse(i.ModTime) : 0,
    dir: i.IsDir,
  }));
}

export interface SmbConnection {
  host: string;
  port?: number;
  user: string;
  password?: string;
  domain?: string;
}

/** rclone's SMB backend configured entirely from the environment: nothing on the command line. */
export function smbEnv(c: SmbConnection): Record<string, string> {
  return {
    RCLONE_SMB_HOST: c.host,
    RCLONE_SMB_PORT: String(c.port ?? 445),
    RCLONE_SMB_USER: c.user,
    ...(c.domain ? { RCLONE_SMB_DOMAIN: c.domain } : {}),
    ...(c.password ? { RCLONE_SMB_PASS: obscure(c.password) } : {}),
  };
}

export class RcloneMissingError extends Error {}

/** Runs rclone commands with a fixed environment and no config file. */
export class Rclone {
  constructor(
    readonly bin: string,
    readonly env: Record<string, string>,
  ) {}

  /** The environment child processes get: ours (PATH, HOME…) minus any RCLONE_* of our own, plus the connection. */
  processEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('RCLONE_')));
    return { ...base, ...this.env, ...extra };
  }

  /** stdout of `rclone --config "" …args`; rejects with { code, message } on failure. */
  run(args: string[], timeoutMs = 120_000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.bin,
        ['--config', '', '--contimeout', '10s', ...args],
        { env: this.processEnv(), maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs },
        (err, stdout, stderr) => {
          if (!err) return resolve(stdout);
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new RcloneMissingError('SMB shares need rclone on the server'));
          reject(Object.assign(new Error(cleanRcloneError(stderr) || err.message), { exitCode: typeof err.code === 'number' ? err.code : undefined }));
        },
      );
    });
  }
}

/** Whether rclone runs at all. */
export function hasRclone(bin = 'rclone'): Promise<boolean> {
  return new Promise((resolve) => execFile(bin, ['version'], { timeout: 5000 }, (err) => resolve(!err)));
}
```

Run: PASS (5). Commit: `git add apps/server/src/media/rclone.ts apps/server/src/media/rclone.test.ts && git commit -m "rclone basics: obscured passwords, errors, listings, SMB environment"`

---

### Task 3: A local HTTP server per share, and an SMB media source

**Files:** Create `apps/server/src/media/rcloneServe.ts`; test `apps/server/src/media/rcloneServe.test.ts`

`RcloneServer` runs `rclone serve http <remote>` on loopback; `RcloneMediaSource` reads `/<share>/<rest>` paths through one server per share.

**Failing tests** (integration; skipped without rclone):

```ts
// apps/server/src/media/rcloneServe.test.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../catalog/testFixtures.ts';
import { Rclone } from './rclone.ts';
import { RcloneMediaSource } from './rcloneServe.ts';

const bin = process.env.RCLONE_BIN ?? 'rclone';
const available = (() => {
  try {
    execFileSync(bin, ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let cleanup: () => void = () => {};
afterEach(() => cleanup());

describe.skipIf(!available)('RcloneMediaSource (local backend standing in for SMB)', () => {
  function setup() {
    const t = tempDir();
    mkdirSync(join(t.dir, 'share/A'), { recursive: true });
    writeFileSync(join(t.dir, 'share/A/01 it’s.flac'), 'abcdefghijklmnopqrstuvwxyz');
    const media = new RcloneMediaSource(new Rclone(bin, {}), `:local:${t.dir}/`);
    cleanup = () => {
      void media.close();
      t.cleanup();
    };
    return media;
  }

  it('reads whole files and byte ranges over loopback HTTP', async () => {
    const media = setup();
    expect(await text(await media.open('/share/A/01 it’s.flac'))).toBe('abcdefghijklmnopqrstuvwxyz');
    expect(await text(await media.open('/share/A/01 it’s.flac', { start: 2, end: 4 }))).toBe('cde');
    expect((await media.stat('/share/A/01 it’s.flac')).size).toBe(26);
  });

  it('fails clearly for missing files and paths outside a share', async () => {
    const media = setup();
    await expect(media.open('/share/nope.flac')).rejects.toThrow(/404|not found/i);
    await expect(media.open('/')).rejects.toThrow(/share/);
  });

  it('restarts its server after close', async () => {
    const media = setup();
    await media.open('/share/A/01 it’s.flac');
    await media.close();
    expect(await text(await media.open('/share/A/01 it’s.flac', { start: 0, end: 0 }))).toBe('a');
  });
});
```

**Implement:**

```ts
// apps/server/src/media/rcloneServe.ts
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { request, type IncomingMessage } from 'node:http';
import { createServer } from 'node:net';
import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import { cleanRcloneError, type Rclone } from './rclone.ts';
import { ffmpegPcmArgs, type ByteRange, type FileStat, type MediaSource, type PcmOptions } from './source.ts';

/** A free loopback port (tiny race between closing and rclone binding; a failed start retries once). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** `rclone serve http <remote>` on 127.0.0.1, with credentials only it and we know. */
export class RcloneServer {
  private proc?: ChildProcess;
  private ready?: Promise<string>;
  private readonly user = randomBytes(8).toString('hex');
  private readonly pass = randomBytes(24).toString('hex');

  constructor(
    private readonly rclone: Rclone,
    private readonly remote: string,
  ) {}

  /** The base URL with credentials, starting the server if needed. */
  url(): Promise<string> {
    this.ready ??= this.start().catch(async (err) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  get auth() {
    return `${this.user}:${this.pass}`;
  }

  private async start(attempt = 0): Promise<string> {
    const port = await freePort();
    const proc = spawn(this.rclone.bin, ['serve', 'http', this.remote, '--config', '', '--read-only', '--dir-cache-time', '10s', '--contimeout', '10s'], {
      env: this.rclone.processEnv({ RCLONE_ADDR: `127.0.0.1:${port}`, RCLONE_USER: this.user, RCLONE_PASS: this.pass }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.proc = proc;
    let stderr = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('rclone took too long to start')), 30_000);
        proc.stderr!.on('data', (d: Buffer) => {
          stderr += d;
          if (stderr.includes('Server started on')) {
            clearTimeout(timer);
            resolve();
          }
        });
        proc.once('error', (err) => {
          clearTimeout(timer);
          reject((err as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('SMB shares need rclone on the server') : err);
        });
        proc.once('exit', () => {
          clearTimeout(timer);
          reject(new Error(cleanRcloneError(stderr) || 'rclone stopped'));
        });
      });
    } catch (err) {
      proc.kill();
      if (attempt === 0 && /address already in use/i.test((err as Error).message)) return this.start(1);
      throw err;
    }
    proc.once('exit', () => {
      if (this.proc === proc) {
        this.proc = undefined;
        this.ready = undefined;
      }
    });
    return `http://127.0.0.1:${port}`;
  }

  async close() {
    const proc = this.proc;
    this.proc = undefined;
    this.ready = undefined;
    if (proc && proc.exitCode === null) {
      await new Promise<void>((resolve) => {
        proc.once('exit', () => resolve());
        proc.kill();
        setTimeout(resolve, 2000);
      });
    }
  }
}

const encodePath = (rel: string) => rel.split('/').map(encodeURIComponent).join('/');

/**
 * Files on SMB shares (or any rclone remote), addressed as /<share>/<path>.
 * `prefix` is the rclone remote the share names are appended to: ":smb:" in production.
 */
export class RcloneMediaSource implements MediaSource {
  readonly kind = 'smb' as const;
  private readonly servers = new Map<string, RcloneServer>();

  constructor(
    readonly rclone: Rclone,
    private readonly prefix: string,
    private readonly tools: { ffmpeg?: string } = {},
  ) {}

  /** The share's server and the file's path inside the share. */
  private locate(path: string): { server: RcloneServer; rel: string } {
    const clean = posix.normalize(path).replace(/^\/+/, '');
    const [share, ...rest] = clean.split('/');
    if (!share || share === '.' || share === '..' || rest.length === 0) throw new Error(`${path} isn’t a file on a share`);
    let server = this.servers.get(share);
    if (!server) {
      server = new RcloneServer(this.rclone, `${this.prefix}${share}`);
      this.servers.set(share, server);
    }
    return { server, rel: rest.join('/') };
  }

  /** A loopback URL for the file, with credentials (for ffmpeg and fpcalc on this server). */
  async urlFor(path: string): Promise<string> {
    const { server, rel } = this.locate(path);
    const base = new URL(await server.url());
    const [user, pass] = server.auth.split(':');
    base.username = user!;
    base.password = pass!;
    base.pathname = `/${encodePath(rel)}`;
    return base.toString();
  }

  private async get(path: string, method: 'GET' | 'HEAD', range?: ByteRange): Promise<IncomingMessage> {
    const { server, rel } = this.locate(path);
    const base = await server.url();
    return new Promise((resolve, reject) => {
      const req = request(
        `${base}/${encodePath(rel)}`,
        {
          method,
          auth: server.auth,
          headers: range ? { Range: `bytes=${range.start}-${range.end}` } : {},
        },
        (res) => {
          if (res.statusCode === 200 || res.statusCode === 206) return resolve(res);
          res.resume();
          reject(new Error(res.statusCode === 404 ? `${path}: not found (404)` : `${path}: HTTP ${res.statusCode}`));
        },
      );
      req.once('error', reject);
      req.end();
    });
  }

  async stat(path: string): Promise<FileStat> {
    const res = await this.get(path, 'HEAD');
    res.resume();
    const modified = res.headers['last-modified'];
    return { size: Number(res.headers['content-length'] ?? 0), mtimeMs: modified ? Date.parse(modified) : 0 };
  }

  async open(path: string, range?: ByteRange): Promise<Readable> {
    return this.get(path, 'GET', range);
  }

  /** Lists the remote's root (or the probe path): fails with rclone's message when the connection doesn't work. */
  async check(probePath?: string) {
    const target = probePath ? probePath.replace(/^\/+/, '') : '';
    await this.rclone.run(['lsjson', '--stat', `${this.prefix}${target}`], 30_000).catch((err: Error & { exitCode?: number }) => {
      // A missing folder still means we're connected; the caller checks the folder itself.
      if (err.exitCode === 3 || err.exitCode === 4) return '';
      throw err;
    });
  }

  async pcm(path: string, opts: PcmOptions): Promise<Buffer> {
    const url = await this.urlFor(path);
    return new Promise((resolve, reject) => {
      execFile(
        this.tools.ffmpeg ?? 'ffmpeg',
        ffmpegPcmArgs(url, opts),
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, signal: opts.signal },
        (err, stdout, stderr) => (err ? reject(new Error(`ffmpeg: ${stderr.toString().trim() || err.message}`)) : resolve(stdout)),
      );
    });
  }

  async close() {
    await Promise.all([...this.servers.values()].map((s) => s.close()));
    this.servers.clear();
  }
}
```

Note: `check()` with no probe and the `:smb:` prefix runs `lsjson --stat :smb:`, which connects and authenticates. If `--stat` on the server root turns out unsupported, use `['lsjson', '--max-depth', '1', '--dirs-only', prefix]` instead (record it).

Run with `RCLONE_BIN=… corepack pnpm -C apps/server exec vitest run src/media/rcloneServe.test.ts`: PASS (3). Without `RCLONE_BIN` and no rclone on PATH: skipped. Commit: `git add apps/server/src/media/rcloneServe.ts apps/server/src/media/rcloneServe.test.ts && git commit -m "rclone: a loopback HTTP server per share, and a media source over it"`

---

### Task 4: RcloneFolderFs

**Files:** `apps/server/src/catalog/folderFs.ts`; test `apps/server/src/catalog/rcloneFs.test.ts`

**Failing tests** (integration, same `available`/`bin` preamble as Task 3; `flacBytes` from `./testFixtures.ts`):

```ts
describe.skipIf(!available)('RcloneFolderFs (local backend standing in for SMB)', () => {
  function setup() {
    const t = tempDir();
    mkdirSync(join(t.dir, 'share/Massive Attack/Mezzanine'), { recursive: true });
    mkdirSync(join(t.dir, 'share/.trash'), { recursive: true });
    writeFileSync(join(t.dir, 'share/Massive Attack/Mezzanine/01 Angel.flac'), flacBytes({ TITLE: 'Angel', MUSICBRAINZ_TRACKID: 'rec-1' }));
    writeFileSync(join(t.dir, 'share/Massive Attack/Mezzanine/cover.jpg'), Buffer.from([1, 2, 3]));
    writeFileSync(join(t.dir, 'share/.trash/old.flac'), flacBytes({ TITLE: 'Old' }));
    const fs = new RcloneFolderFs(new Rclone(bin, {}), `:local:${t.dir}/`);
    cleanup = () => {
      void fs.close();
      t.cleanup();
    };
    return fs;
  }

  it('lists audio files under a folder, skipping hidden ones', async () => {
    const fs = setup();
    const found = await fs.listAudio('/share');
    expect(found.map((f) => f.path)).toEqual(['/share/Massive Attack/Mezzanine/01 Angel.flac']);
    expect(found[0]).toMatchObject({ rel: 'Massive Attack/Mezzanine/01 Angel.flac' });
    expect(found[0]!.size).toBeGreaterThan(0);
    expect(found[0]!.mtimeMs).toBeGreaterThan(0);
  });

  it('stats and lists folders, with shares at the root', async () => {
    const fs = setup();
    expect(await fs.stat('/')).toMatchObject({ dir: true });
    expect(await fs.stat('/share/Massive Attack')).toMatchObject({ dir: true });
    expect(await fs.stat('/share/Massive Attack/Mezzanine/cover.jpg')).toMatchObject({ dir: false, size: 3 });
    expect(await fs.stat('/share/nope')).toBeNull();
    expect((await fs.readdir('/')).map((e) => e.name)).toContain('share');
    expect(await fs.readdir('/share/Massive Attack/Mezzanine')).toEqual(
      expect.arrayContaining([{ name: 'cover.jpg', dir: false, file: true }, { name: '01 Angel.flac', dir: false, file: true }]),
    );
  });

  it('reads tags through byte ranges and whole small files', async () => {
    const fs = setup();
    const path = '/share/Massive Attack/Mezzanine/01 Angel.flac';
    const size = (await fs.stat(path))!.size;
    expect(await fs.readTags(path, size)).toMatchObject({ title: 'Angel', recordingMbid: 'rec-1' });
    expect(await fs.readFile('/share/Massive Attack/Mezzanine/cover.jpg')).toEqual(Buffer.from([1, 2, 3]));
  });
});
```

Also a unit test (always runs) that a connection failure surfaces: `new RcloneFolderFs(new Rclone('/nonexistent/rclone', {}), ':smb:').listAudio('/share')` rejects with `/need rclone/`.

**Implement** in `folderFs.ts` (imports: `Rclone`, `parseLsjson` from `../media/rclone.ts`, `RcloneMediaSource` from `../media/rcloneServe.ts`, `fpcalc` already imported):

```ts
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
      return entry ? { size: entry.size, mtimeMs: entry.mtimeMs, dir: entry.dir } : null;
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
```

Note: `stat` throwing on connection errors (instead of `null`) is deliberate: `verify()`/`browse()` call `media.check()` first; `FolderSource.sync` turns a throw into the source's error, which is what the user should see. If any existing caller relies on `stat` never throwing, catch there and record it.

Run (with `RCLONE_BIN`): PASS. Commit: `git add apps/server/src/catalog/folderFs.ts apps/server/src/catalog/rcloneFs.test.ts && git commit -m "Folder filesystem for SMB shares, through rclone"`

---

### Task 5: FolderAccess and SourceManager know SMB

**Files:** `apps/server/src/catalog/folderAccess.ts` (+ test), `apps/server/src/catalog/sources.ts` (+ test)

**FolderAccess:**
- `FolderSettings` gains `domain?: string`.
- `tools` gains `rclone?: string` (the binary, only when it runs) and `localFingerprints` keeps meaning "fpcalc runs here".
- In `create()`: before the SSH branch,

```ts
    if (access === 'smb') {
      if (!this.tools.rclone) throw new Error('SMB shares need rclone on the server');
      if (!settings.host || !settings.user) throw new Error('A share needs a host and a user (guest for guest access)');
      const rclone = new Rclone(this.tools.rclone, smbEnv({ host: settings.host, port: settings.port, user: settings.user, password: settings.password, domain: settings.domain }));
      return new RcloneFolderFs(rclone, ':smb:', { ffmpeg: this.tools.ffmpeg, fpcalc: this.tools.localFingerprints ? this.tools.fpcalc : undefined });
    }
```

- Test: an SMB source gets kind `smb` when `rclone: 'rclone'` is given; without it `get()` throws / `create()` throws `/need rclone/`.

**SourceManager** (`folderSettings`, `browse`, `publicSettings`):
- Default port by access: `const defaultPort = access === 'smb' ? 445 : 22;` used wherever `?? 22` appears for folders.
- SMB settings: no `privateKeyPath`; keep `domain` (`(input.domain ?? saved.domain)?.trim() || undefined`); path must have a share: `if (access === 'smb' && posix.normalize(path).split('/').filter(Boolean).length === 0) throw new SourceError('Choose a share', 400);`
- The saved-password rule stays (same host and user).
- `browse()` for SMB: same flow; at `/` the entries are shares (all `dir`). `fs.stat('/')` already answers a directory. The "Can’t open" message reads `Can’t open ${path} on ${host}` as for SSH.
- `publicSettings`: SMB folders return `{ path, access, host, port, user, domain }`; SSH/SFTP unchanged.
- Error wording: errors whose message mentions rclone come back as 400 with that message.

**Tests** (`sources.test.ts`, with the fake access pattern from Phase 5):
- Adding an SMB folder stores `{ access: 'smb', host, user, port: 445, path: '/music/Albums', domain }`, keeps the password secret (`secrets: ['password']`, not in JSON), and `settings` has no `privateKeyPath`.
- `path: '/'` for SMB → `SourceError` "Choose a share".
- Browsing `{ connection: { access: 'smb', host: 'nas', user: 'me' } }` at `/` calls `create` with `port: 445` and returns the fake's entries as folders.

Run: PASS. Commit: `git add apps/server/src/catalog/folderAccess.ts apps/server/src/catalog/folderAccess.test.ts apps/server/src/catalog/sources.ts apps/server/src/catalog/sources.test.ts && git commit -m "Folder access and sources: SMB shares"`

---

### Task 6: API and wiring

**Files:** `apps/server/src/routes/settings.ts`, `apps/server/src/routes/settings.test.ts`, `apps/server/src/index.ts`

- zod: the folder access enum adds `'smb'`; connection fields add `domain: z.string().trim().max(100).optional()` (both in `sourceInput.settings` and the browse `connection`).
- Deps gain `shares: boolean`; route: `app.get('/api/settings/folders/access', editable, (): FolderAccessOptions => ({ smb: deps.shares }));`
- Test: home network → `{ smb: false }` with `shares: false` in `setup()` deps (add the dep to the test's setup); away → 403. And an SMB source input with an invalid port → 400.
- `index.ts`: `const shares = await hasRclone(config.RCLONE_PATH);` next to `hasFpcalc`; pass `rclone: shares ? config.RCLONE_PATH : undefined` to `FolderAccess`, and `shares` to `settingsRoutes`. Log once at startup when rclone is missing: `SMB shares are off: rclone isn’t installed` (info level).

Typecheck, all tests, build. Commit: `git add apps/server/src/routes/settings.ts apps/server/src/routes/settings.test.ts apps/server/src/index.ts && git commit -m "Server: SMB folder sources wired in"`

---

### Task 7: Web: SMB shares in the folder form

**Files:** `apps/web/src/lib/api.ts`, `apps/web/src/lib/queries.ts`, `apps/web/src/components/SourcesPanel.tsx`

- API: `folderAccess: () => request<FolderAccessOptions>('/api/settings/folders/access')`.
- Query: `export const useFolderAccess = () => useQuery({ queryKey: ['folder-access'], queryFn: api.folderAccess, staleTime: 5 * 60_000 });`
- `FolderForm`:
  - The location choices become **This server / SSH / SFTP / SMB share**. The SMB button is disabled (with `title="SMB shares need rclone on the server"` and a one-line note under the group when selected while unavailable) when `useFolderAccess().data?.smb === false`. A saved SMB source stays editable regardless.
  - Switching location swaps the port default: to SMB, a port of 22 becomes 445; away from SMB, 445 becomes 22.
  - SMB fields: Host, Port, User (hint: "guest for guest access"), Password (saved/replace like SSH), Domain (optional, placeholder `WORKGROUP`). No key file.
  - Note for SMB: "Playarr reads the share with rclone. Song analysis and fingerprints run on this server."
  - The browser's request for SMB includes `domain`; its root label at `/` reads `Shares on <host>`; choosing `/` itself isn't allowed (Save disabled until a share is chosen).
  - Save sends `domain` for SMB (empty string clears it) and never `privateKeyPath`.
- `SourceRow`: SMB folders show `smb://user@host/share/folder` and the `Network` icon.

Typecheck and build: clean. Commit: `git add apps/web/src/lib/api.ts apps/web/src/lib/queries.ts apps/web/src/components/SourcesPanel.tsx && git commit -m "Web: folder sources on SMB shares"`

---

### Task 8: Docker and docs

**Files:** `docker/Dockerfile`, `README.md`, `PLAN.md`, `docs/plans/2026-10-30-sources-design.md`, `.env.example`

- Dockerfile runtime stage: `RUN apk add --no-cache ffmpeg chromaprint rclone` and add to its comment: `# rclone reads SMB shares (folder sources on a share).`
- `.env.example`: `# RCLONE_PATH=rclone   # for folder sources on SMB shares` near `FPCALC_PATH`.
- README, Folder sources: `Folders can be on SMB shares too (Windows, macOS, most NAS), read through rclone: it's in the Docker image; native installs need rclone on the PATH. For NFS, mount the export on the host and add it as a folder on This server (in Docker, under the folder mounted at /host).`
- Design doc, Rollout item 6: append `Done: SMB through rclone (the Node clients speak only SMB 2.1 without signing); NFS via host mount.`
- PLAN.md decisions log: `| 2026-10-30 | Network shares (phase 6): SMB folder sources through rclone, not a Node client (node-smb2/@awo00/smb2 negotiate only SMB 2.0.2/2.1 with no signing, which Windows 11 24H2 and Server 2025 require). rclone lsjson lists/stats/browses; one rclone serve http per share on 127.0.0.1 (free port, random credentials) serves ranges for streaming and tags; ffmpeg/fpcalc read that URL here. Connection settings go only through RCLONE_SMB_* environment variables with the password obscured. Paths are /share/folder; browsing / lists shares. rclone is optional (SMB disabled without it). NFS: mount on the host, use This server. |`

Commit: `git add docker/Dockerfile README.md PLAN.md docs/plans/2026-10-30-sources-design.md .env.example && git commit -m "Docs: SMB shares through rclone, NFS through the host"`

---

## Not verified by this plan

- A real SMB server: share listing at `:smb:`, auth (NTLMv2, guest, domain accounts), signing-required servers, error messages from real servers.
- ffmpeg and fpcalc reading the loopback URL with credentials (analysis, fingerprints for SMB).
- Speed of a first scan over SMB (`lsjson -R` on a large share; two range reads per file through serve).
- The Docker image with rclone, and the Settings form in a browser.
