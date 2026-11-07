import type { FolderAccessKind, SshHostKey } from '@playarr/shared';
import { Rclone, smbEnv } from '../media/rclone.ts';
import { SftpMediaSource } from '../media/sftp.ts';
import { SshConnection, SshExecMediaSource, SshShell, type SshOptions } from '../media/ssh.ts';
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
  /** SSH and SFTP: the host key trusted for this host and port, recorded on the first connection. */
  hostKey?: SshHostKey;
}

/** How a connection treats the host's key, beyond checking it against the settings' `hostKey`. */
export type HostKeyHandling = Pick<SshOptions, 'trustNewHostKey' | 'onHostKey'>;

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
    const settings = source.settings as FolderSettings;
    const fs = this.create(settings, { onHostKey: (hostKey) => this.remember(sourceId, key, hostKey) });
    this.cache.set(sourceId, { key, fs });
    return fs;
  }

  /**
   * A filesystem for these settings, not cached (browsing an unsaved connection, checking one before it's saved).
   * Close it after use. Over SSH or SFTP, a host whose key isn't the settings' `hostKey` is refused unless `hostKeys`
   * says to trust it; without a `hostKey`, the first key seen is trusted.
   */
  create(settings: FolderSettings, hostKeys: HostKeyHandling = {}): FolderFs {
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
    // Saving the source trusts the key the host shows then; a saved password must be typed again for that (SourceManager.verify).
    const withPassword = !settings.privateKeyPath && !!settings.password;
    const conn = new SshConnection({
      host: settings.host,
      port: settings.port ?? 22,
      username: settings.user,
      password: settings.password,
      privateKeyPath: settings.privateKeyPath,
      hostKey: settings.hostKey,
      howToTrust: `edit the source in Settings → Sources${withPassword ? ', enter its password again' : ''} and save it to trust the new key`,
      ...hostKeys,
    });
    if (access === 'sftp') return new SftpFolderFs(new SftpMediaSource(conn));
    return new SshFolderFs(new SshShell(conn), new SshExecMediaSource(conn, this.tools.ffmpeg), this.tools.fpcalc, () => conn.close());
  }

  /**
   * Trust on first use: a source saved before Playarr checked host keys keeps the key its first connection saw. Only
   * while its settings are still those the connection was made with, and never over a key already trusted.
   */
  private remember(sourceId: number, madeWith: string, hostKey: SshHostKey) {
    const source = this.store.source(sourceId);
    if (!source || JSON.stringify(source.settings) !== madeWith || (source.settings as FolderSettings).hostKey) return;
    const settings = { ...source.settings, hostKey };
    this.store.updateSource(sourceId, { settings });
    // The same connection, now with its key on record: not a change of settings to reconnect for.
    const cached = this.cache.get(sourceId);
    if (cached?.key === madeWith) this.cache.set(sourceId, { key: JSON.stringify(settings), fs: cached.fs });
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
