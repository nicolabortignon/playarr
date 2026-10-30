import type { FolderAccessKind } from '@playarr/shared';
import { Rclone, smbEnv } from '../media/rclone.ts';
import { SftpMediaSource } from '../media/sftp.ts';
import { SshConnection, SshExecMediaSource, SshShell } from '../media/ssh.ts';
import { LocalFolderFs, RcloneFolderFs, SftpFolderFs, SshFolderFs, type FolderFs } from './folderFs.ts';
import type { CatalogStore } from './store.ts';

export interface FolderSettings {
  path?: string;
  access?: FolderAccessKind;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  privateKeyPath?: string;
  /** SMB: the account's domain. */
  domain?: string;
}

/** One FolderFs per folder source, created from its settings and kept until they change. */
export class FolderAccess {
  private readonly cache = new Map<number, { key: string; fs: FolderFs }>();

  constructor(
    private readonly store: CatalogStore,
    private readonly tools: {
      ffmpeg: string;
      fpcalc: string;
      /** fpcalc runs on this server. */
      localFingerprints: boolean;
      /** The rclone binary, only when it runs (SMB shares). */
      rclone?: string;
    },
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
    if (access === 'smb') {
      if (!this.tools.rclone) throw new Error('SMB shares need rclone on the server');
      if (!settings.host || !settings.user) throw new Error('A share needs a host and a user (guest for guest access)');
      const rclone = new Rclone(
        this.tools.rclone,
        smbEnv({ host: settings.host, port: settings.port, user: settings.user, password: settings.password, domain: settings.domain }),
      );
      return new RcloneFolderFs(rclone, ':smb:', {
        ffmpeg: this.tools.ffmpeg,
        fpcalc: this.tools.localFingerprints ? this.tools.fpcalc : undefined,
      });
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
