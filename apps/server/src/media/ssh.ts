import type { SshHostKey } from '@playarr/shared';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { PassThrough, type Readable } from 'node:stream';
import { Client, type ClientChannel, type ConnectConfig, type ServerHostKeyAlgorithm } from 'ssh2';
import { ffmpegEncodeArgs, ffmpegPcmArgs, PCM_MAX_BUFFER, type ByteRange, type EncodeOptions, type FileStat, type MediaSource, type PcmOptions, type PcmStreamOptions } from './source.ts';

export interface SshOptions {
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  password?: string;
  /** The key trusted for this host and port. Without one, the first key the host shows is trusted. */
  hostKey?: SshHostKey;
  /** Accept a key other than `hostKey` on the first connection: an admin saving the source trusts the key the host shows. */
  trustNewHostKey?: boolean;
  /** The key the host showed, when it wasn't `hostKey` (the first use, or a new key trusted), once the connection is made. */
  onHostKey?: (key: SshHostKey) => void;
  /** How to trust a changed key, ending "If you reinstalled or replaced that machine, …" in the error that refuses it. */
  howToTrust?: string;
}

/** Not reaching or not getting into the host, as opposed to a command failing once connected. */
export class SshConnectError extends Error {}

/** The host showed a key other than the one trusted for it. Refused before any password or key is sent. */
export class HostKeyChangedError extends SshConnectError {
  constructor(
    readonly trusted: SshHostKey,
    readonly found: SshHostKey,
    howToTrust = 'restart Playarr to trust the new key',
  ) {
    super(
      `The SSH host’s key has changed since Playarr first connected (it was ${trusted.fingerprint}, now ${found.fingerprint}). ` +
        `If you reinstalled or replaced that machine, ${howToTrust}; if not, something may be pretending to be it.`,
    );
  }
}

/** A host key as ssh2 hands it to `hostVerifier` (SSH's wire form): its type and OpenSSH's SHA-256 fingerprint. */
export function hostKeyOf(blob: Buffer): SshHostKey {
  const length = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  const type = blob.subarray(4, 4 + length).toString('latin1') || 'unknown';
  return { type, fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}` };
}

const sameHostKey = (a: SshHostKey, b: SshHostKey) => a.fingerprint === b.fingerprint;

/** ssh2's host key algorithms, in its order of preference. */
const HOST_KEY_ALGORITHMS: ServerHostKeyAlgorithm[] = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
];

/**
 * The trusted key's algorithms first, as OpenSSH orders them for a known host: a host that has since added a key of
 * another type still shows the one trusted, rather than looking changed. RSA keys sign with any of the three RSA algorithms.
 */
function hostKeyAlgorithms(trusted: SshHostKey | undefined): ServerHostKeyAlgorithm[] | undefined {
  const first: ServerHostKeyAlgorithm[] =
    trusted?.type === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] : HOST_KEY_ALGORITHMS.filter((a) => a === trusted?.type);
  return first.length ? [...first, ...HOST_KEY_ALGORITHMS.filter((a) => !first.includes(a))] : undefined;
}

/**
 * One persistent SSH connection, reconnected on demand.
 * Auth order: private key file → password → ssh-agent (SSH_AUTH_SOCK).
 * Host key: the trusted one (`hostKey`), else the first one seen; either way, a key once accepted is the only one this
 * connection accepts again. It's checked during the key exchange, before anything is sent to log in.
 */
export class SshConnection {
  private client: Promise<Client> | null = null;
  /** The key this connection accepted and logged in with. */
  private pinned?: SshHostKey;

  constructor(readonly opts: SshOptions) {}

  get(): Promise<Client> {
    this.client ??= this.connect().catch((err: Error) => {
      this.client = null;
      throw err;
    });
    return this.client;
  }

  private async connect(): Promise<Client> {
    const { host, port, username } = this.opts;
    const trusted = this.pinned ?? this.opts.hostKey;
    // What the host showed: the key accepted, or the one refused and the key it should have been.
    const shown: { seen?: SshHostKey; refused?: { trusted: SshHostKey; found: SshHostKey } } = {};
    const client = new Client();
    try {
      const config: ConnectConfig = {
        host,
        port,
        username,
        keepaliveInterval: 15_000,
        readyTimeout: 10_000,
        // Also asked again when the host renews the session's keys, by then against the pinned key.
        hostVerifier: (blob: Buffer) => {
          const key = hostKeyOf(blob);
          const expected = this.pinned ?? (this.opts.trustNewHostKey ? undefined : this.opts.hostKey);
          if (expected && !sameHostKey(expected, key)) {
            shown.refused = { trusted: expected, found: key };
            return false;
          }
          shown.seen = key;
          return true;
        },
      };
      const algorithms = hostKeyAlgorithms(trusted);
      if (algorithms) config.algorithms = { serverHostKey: algorithms };
      if (this.opts.privateKeyPath) {
        config.privateKey = await readFile(this.opts.privateKeyPath.replace(/^~(?=\/)/, homedir()));
      } else if (this.opts.password) {
        config.password = this.opts.password;
      } else if (process.env.SSH_AUTH_SOCK) {
        config.agent = process.env.SSH_AUTH_SOCK;
      }
      await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve).once('error', reject).connect(config);
      });
    } catch (err) {
      const { refused } = shown;
      if (refused) throw new HostKeyChangedError(refused.trusted, refused.found, this.opts.howToTrust);
      throw new SshConnectError(`SSH connection to ${username}@${host} failed: ${(err as Error).message}`);
    }
    // Recorded only once the host has proved it holds the key and let Playarr in.
    const { seen } = shown;
    if (seen) {
      if (!trusted || !sameHostKey(trusted, seen)) this.opts.onHostKey?.(seen);
      this.pinned = seen;
    }
    const reset = () => {
      this.client = null;
    };
    client.on('close', reset).on('error', reset);
    return client;
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

/** How long the host may take to start a command, and a command may go without a word, before it's given up on. */
const START_MS = 20_000;
const QUIET_MS = 60_000;
/** The most a command's answer may hold (a file's bytes, a listing). */
const ANSWER_MAX_BYTES = 64 * 1024 * 1024;

export interface RunOptions {
  /** Bytes of output past which the command is stopped and fails (default 64 MB). */
  maxBytes?: number;
  /** How long it may go without output before it's stopped and fails (default 60 s). */
  quietMs?: number;
}

/** Runs commands over a shared SSH connection. */
export interface Shell {
  run(command: string, opts?: RunOptions): Promise<string>;
  runBuffer(command: string, opts?: RunOptions): Promise<Buffer>;
}

export class SshShell implements Shell {
  constructor(
    private readonly conn: SshConnection,
    private readonly startMs = START_MS,
  ) {}

  /** A command started on the host; fails if the host hasn't started it within a while (a connection gone bad). */
  async exec(command: string): Promise<ClientChannel> {
    const client = await this.conn.get();
    return new Promise((resolve, reject) => {
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        reject(new Error(`The SSH host didn’t start a command within ${this.startMs / 1000} s`));
      }, this.startMs);
      client.exec(command, (err, channel) => {
        clearTimeout(timer);
        // Started after all, but given up on: nobody's reading it.
        if (late) return void channel?.close();
        if (err) reject(err);
        else resolve(channel);
      });
    });
  }

  async run(command: string, opts?: RunOptions): Promise<string> {
    return (await this.runBuffer(command, opts)).toString('utf8');
  }

  /** stdout of a command; see gather. */
  async runBuffer(command: string, opts?: RunOptions): Promise<Buffer> {
    return gather(await this.exec(command), opts);
  }
}

/**
 * What a command on the host writes to stdout, once it exits; rejects with its stderr on a non-zero exit, and stops
 * it (and rejects) when it goes quiet for too long, says too much, or `signal` calls it off.
 */
export function gather(
  channel: ClientChannel,
  { maxBytes = ANSWER_MAX_BYTES, quietMs = QUIET_MS, signal }: RunOptions & { signal?: AbortSignal } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    let bytes = 0;
    let err = '';
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(quiet);
      signal?.removeEventListener('abort', abort);
      settle();
    };
    // Given up on at once: a host that's gone may never confirm the close.
    const stop = (why: unknown) => {
      finish(() => reject(why));
      channel.close();
    };
    const abort = () => stop(signal!.reason);
    const quietFor = () => setTimeout(() => stop(new Error(`The SSH host stopped answering (nothing for ${quietMs / 1000} s)`)), quietMs);
    let quiet = quietFor();
    const heard = () => {
      if (done) return;
      clearTimeout(quiet);
      quiet = quietFor();
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    channel.on('data', (d: Buffer) => {
      if (done) return;
      bytes += d.length;
      if (bytes > maxBytes) return stop(new Error(`The SSH host’s answer was over ${Math.round(maxBytes / 1024 / 1024)} MB`));
      out.push(d);
      heard();
    });
    channel.stderr.on('data', (d: Buffer) => {
      err = (err + d).slice(-4000);
      heard();
    });
    channel.on('close', (code: number | null) =>
      finish(() => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(cleanSshError(err) || `exit code ${code}`)))),
    );
  });
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

  /**
   * Decode on the host (niced, so playback stays smooth); only PCM crosses the network.
   * Every argument, numbers included, goes through shellQuote, and ffmpegPcmArgs has already
   * rejected anything that is not a finite number, so nothing raw reaches the remote shell.
   */
  async pcm(path: string, opts: PcmOptions): Promise<Buffer> {
    const args = ffmpegPcmArgs(path, opts).map(shellQuote).join(' ');
    const channel = await this.shell.exec(`nice -n 10 ${shellQuote(this.ffmpeg)} ${args}`);
    // At most what this server's own ffmpeg may hand back (local.ts).
    return gather(channel, { maxBytes: PCM_MAX_BUFFER, ...(opts.signal ? { signal: opts.signal } : {}) }).catch((err: unknown) => {
      throw opts.signal?.aborted ? opts.signal.reason : new Error(`ffmpeg: ${(err as Error).message}`);
    });
  }

  pcmStream(path: string, opts: PcmStreamOptions): Readable {
    return this.ffmpegStream(ffmpegPcmArgs(path, opts), opts);
  }

  /** Encoded on the host as pcmStream decodes there: only the encoded audio crosses the network. */
  encodedStream(path: string, opts: EncodeOptions): Readable {
    return this.ffmpegStream(ffmpegEncodeArgs(path, opts), opts);
  }

  /** ffmpeg on the host with these arguments (checked numbers and quoted paths only), its stdout as it comes. */
  private ffmpegStream(ffmpegArgs: string[], opts: { priority?: 'low' | 'normal'; signal?: AbortSignal }): Readable {
    const args = ffmpegArgs.map(shellQuote).join(' ');
    const nice = opts.priority === 'normal' ? '' : 'nice -n 10 ';
    const out = new PassThrough();
    this.shell.exec(`${nice}${shellQuote(this.ffmpeg)} ${args}`).then(
      (channel) => {
        // The listener went (or the work was called off) before ffmpeg started on the host: nothing to hand on.
        if (out.destroyed || opts.signal?.aborted) return void channel.close();
        let err = '';
        const abort = () => channel.close();
        opts.signal?.addEventListener('abort', abort, { once: true });
        out.on('close', () => channel.close());
        channel.stderr.on('data', (d: Buffer) => (err = (err + d).slice(-2000)));
        // Held back while the reader is (an encoded stream far enough ahead of its listeners pauses); a reader gone
        // for good stops ffmpeg rather than holding it back.
        channel.on('data', (d: Buffer) => {
          if (out.destroyed) return void channel.close();
          if (!out.write(d)) channel.pause();
        });
        out.on('drain', () => channel.resume());
        channel.on('close', (code: number | null) => {
          opts.signal?.removeEventListener('abort', abort);
          if (code === 0) out.end();
          else out.destroy(opts.signal?.aborted ? opts.signal.reason : new Error(`ffmpeg: ${cleanSshError(err) || `exit code ${code}`}`));
        });
      },
      (e: Error) => out.destroy(e),
    );
    return out;
  }

  async close() {
    await this.conn.close();
  }
}
