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

/**
 * Reads files by running commands over SSH (`stat`, `tail | head`).
 * For hosts where SFTP is restricted but the account has a shell, e.g. UGREEN UGOS,
 * whose SFTP server only exposes shares created in its UI.
 */
export class SshExecMediaSource implements MediaSource {
  readonly kind = 'ssh' as const;

  constructor(
    private readonly conn: SshConnection,
    private readonly ffmpeg = 'ffmpeg',
  ) {}

  private async exec(command: string): Promise<ClientChannel> {
    const client = await this.conn.get();
    return new Promise((resolve, reject) => {
      client.exec(command, (err, channel) => (err ? reject(err) : resolve(channel)));
    });
  }

  /** Run a command and collect stdout; rejects with stderr on a non-zero exit. */
  private async run(command: string): Promise<string> {
    const channel = await this.exec(command);
    return new Promise((resolve, reject) => {
      let out = '';
      let err = '';
      channel.on('data', (d: Buffer) => (out += d));
      channel.stderr.on('data', (d: Buffer) => (err += d));
      channel.on('close', (code: number | null) => {
        if (code === 0) return resolve(out);
        // Drop sshd's noise about a missing home directory.
        const msg = err.replace(/^Could not chdir to home directory.*\n?/m, '').trim();
        reject(new Error(msg || `exit code ${code}`));
      });
    });
  }

  async stat(path: string): Promise<FileStat> {
    const out = await this.run(`stat -L -c '%s %Y' -- ${shellQuote(path)}`);
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
    const channel = await this.exec(command);
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
    const channel = await this.exec(`nice -n 10 ${shellQuote(this.ffmpeg)} ${args}`);
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
        const msg = err.replace(/^Could not chdir to home directory.*\n?/m, '').trim();
        reject(new Error(`ffmpeg: ${msg || `exit code ${code}`}`));
      });
    });
  }

  async close() {
    await this.conn.close();
  }
}
