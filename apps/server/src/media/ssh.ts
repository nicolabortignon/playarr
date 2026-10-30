import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Readable } from 'node:stream';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { ffmpegPcmArgs, type ByteRange, type FileStat, type MediaSource, type PcmOptions } from './source.ts';

export interface SshOptions {
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  password?: string;
}

/**
 * One persistent SSH connection, reconnected on demand.
 * Auth order: private key file → password → ssh-agent (SSH_AUTH_SOCK).
 */
export class SshConnection {
  private client: Promise<Client> | null = null;

  constructor(readonly opts: SshOptions) {}

  get(): Promise<Client> {
    this.client ??= (async () => {
      const config: ConnectConfig = {
        host: this.opts.host,
        port: this.opts.port,
        username: this.opts.username,
        keepaliveInterval: 15_000,
        readyTimeout: 10_000,
      };
      if (this.opts.privateKeyPath) {
        config.privateKey = await readFile(this.opts.privateKeyPath.replace(/^~(?=\/)/, homedir()));
      } else if (this.opts.password) {
        config.password = this.opts.password;
      } else if (process.env.SSH_AUTH_SOCK) {
        config.agent = process.env.SSH_AUTH_SOCK;
      }
      const client = new Client();
      await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve).once('error', reject).connect(config);
      });
      const reset = () => {
        this.client = null;
      };
      client.on('close', reset).on('error', reset);
      return client;
    })().catch((err: Error) => {
      this.client = null;
      throw new Error(`SSH connection to ${this.opts.username}@${this.opts.host} failed: ${err.message}`);
    });
    return this.client;
  }

  async close() {
    const client = this.client;
    this.client = null;
    if (client) (await client.catch(() => null))?.end();
  }
}

/** Quote a string for a POSIX shell. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

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

/**
 * Reads files by running commands over SSH (`stat`, `tail | head`).
 * For hosts where SFTP is restricted but the account has a shell, e.g. UGREEN UGOS,
 * whose SFTP server only exposes shares created in its UI.
 */
export class SshExecMediaSource implements MediaSource {
  readonly kind = 'ssh' as const;
  private readonly shell: SshShell;

  constructor(
    private readonly conn: SshConnection,
    private readonly ffmpeg = 'ffmpeg',
  ) {
    this.shell = new SshShell(conn);
  }

  async stat(path: string): Promise<FileStat> {
    const out = await this.shell.run(`stat -L -c '%s %Y' -- ${shellQuote(path)}`);
    const [size, mtime] = out.trim().split(' ').map(Number);
    if (!Number.isFinite(size) || !Number.isFinite(mtime)) throw new Error(`Unexpected stat output: ${out}`);
    return { size: size!, mtimeMs: mtime! * 1000 };
  }

  async open(path: string, range?: ByteRange): Promise<Readable> {
    const file = shellQuote(path);
    // GNU tail seeks straight to the offset on regular files, so this is cheap for large files.
    const command = range
      ? `tail -c +${range.start + 1} -- ${file} | head -c ${range.end - range.start + 1}`
      : `cat -- ${file}`;
    const channel = await this.shell.exec(command);
    channel.stderr.resume();
    return channel;
  }

  async check(probePath?: string) {
    await this.conn.get();
    if (probePath) await this.stat(probePath);
  }

  /** Decode on the host (niced, so playback stays smooth); only small mono PCM crosses the network. */
  async pcm(path: string, opts: PcmOptions): Promise<Buffer> {
    const args = ffmpegPcmArgs(path, opts).map(shellQuote).join(' ');
    const channel = await this.shell.exec(`nice -n 10 ${shellQuote(this.ffmpeg)} ${args}`);
    const abort = () => channel.close();
    opts.signal?.addEventListener('abort', abort, { once: true });
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let err = '';
      channel.on('data', (d: Buffer) => chunks.push(d));
      channel.stderr.on('data', (d: Buffer) => (err += d));
      channel.on('close', (code: number | null) => {
        opts.signal?.removeEventListener('abort', abort);
        if (opts.signal?.aborted) return reject(opts.signal.reason);
        if (code === 0) return resolve(Buffer.concat(chunks));
        reject(new Error(`ffmpeg: ${cleanSshError(err) || `exit code ${code}`}`));
      });
    });
  }

  async close() {
    await this.conn.close();
  }
}
