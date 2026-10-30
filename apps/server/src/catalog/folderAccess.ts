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
