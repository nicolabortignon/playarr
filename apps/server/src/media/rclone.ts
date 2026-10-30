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
