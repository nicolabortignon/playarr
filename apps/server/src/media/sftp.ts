import type { Readable } from 'node:stream';
import type { SFTPWrapper } from 'ssh2';
import type { ByteRange, FileStat, MediaSource } from './source.ts';
import type { SshConnection } from './ssh.ts';

/** Reads audio over an SFTP session on a shared SSH connection. */
export class SftpMediaSource implements MediaSource {
  readonly kind = 'sftp' as const;
  private sftp: Promise<SFTPWrapper> | null = null;

  constructor(private readonly conn: SshConnection) {}

  /** The SFTP session, opened on first use and shared. */
  session(): Promise<SFTPWrapper> {
    this.sftp ??= this.conn
      .get()
      .then(
        (client) =>
          new Promise<SFTPWrapper>((resolve, reject) => {
            client.sftp((err, sftp) => {
              if (err) return reject(err);
              sftp.on('close', () => (this.sftp = null));
              resolve(sftp);
            });
          }),
      )
      .catch((err: Error) => {
        this.sftp = null;
        throw err;
      });
    return this.sftp;
  }

  async stat(path: string): Promise<FileStat> {
    const sftp = await this.session();
    return new Promise((resolve, reject) => {
      sftp.stat(path, (err, s) =>
        err ? reject(new Error(`${path}: ${err.message}`)) : resolve({ size: s.size, mtimeMs: s.mtime * 1000 }),
      );
    });
  }

  async open(path: string, range?: ByteRange): Promise<Readable> {
    const sftp = await this.session();
    return sftp.createReadStream(path, {
      ...(range ? { start: range.start, end: range.end } : {}),
      highWaterMark: 256 * 1024,
    });
  }

  async check(probePath?: string) {
    await this.session();
    if (probePath) await this.stat(probePath);
  }

  async close() {
    this.sftp = null;
    await this.conn.close();
  }
}
