import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { request, type IncomingMessage } from 'node:http';
import { createServer } from 'node:net';
import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import { cleanRcloneError, type Rclone } from './rclone.ts';
import { ffmpegPcmArgs, type ByteRange, type FileStat, type MediaSource, type PcmOptions } from './source.ts';
import { lowPriority } from '../lowPriority.ts';

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
    let started = false;
    // Keep draining stderr for the process's whole life (a full pipe would block rclone), but only keep what starting printed.
    proc.stderr!.on('data', (d: Buffer) => {
      if (!started) stderr = (stderr + d).slice(-8192);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('rclone took too long to start')), 30_000);
        proc.stderr!.on('data', () => {
          if (!started && stderr.includes('Server started on')) {
            started = true;
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
      lowPriority(
        execFile(
          this.tools.ffmpeg ?? 'ffmpeg',
          ffmpegPcmArgs(url, opts),
          { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, signal: opts.signal },
          (err, stdout, stderr) => (err ? reject(new Error(`ffmpeg: ${stderr.toString().trim() || err.message}`)) : resolve(stdout)),
        ),
      );
    });
  }

  async close() {
    await Promise.all([...this.servers.values()].map((s) => s.close()));
    this.servers.clear();
  }
}
