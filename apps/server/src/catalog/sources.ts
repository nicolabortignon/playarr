import type { FolderAccessKind, FolderBrowseRequest, FolderListing, SourceInfo, SourceInput, SourceTestResult } from '@playarr/shared';
import { posix } from 'node:path';
import { LidarrClient } from '../lidarr/client.ts';
import type { FolderAccess, FolderSettings } from './folderAccess.ts';
import { LocalFolderFs, type FolderFs } from './folderFs.ts';
import { FolderSource, isAudioFile } from './folderSource.ts';
import { LidarrSource } from './lidarr.ts';
import { isWritable } from './organizer.ts';
import { checkFolder, listFolders } from './paths.ts';
import type { CatalogStore, SourceRecord } from './store.ts';
import type { CatalogSource } from './types.ts';

interface LidarrSettings {
  url?: string;
  apiKey?: string;
}

/** Settings fields that are never sent to the browser. */
const SECRET_FIELDS = ['apiKey', 'password'];
const SEEDED = 'sources.seeded_from_env';

export class SourceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Sources as Settings manages them: rows in the database, turned into catalog adapters. */
interface MatcherHandle {
  pendingGroups(sourceId: number): number;
  enqueue(sourceId: number): void;
}

export class SourceManager {
  private matcher?: MatcherHandle;
  private folders?: Pick<FolderAccess, 'create' | 'get' | 'release'>;

  constructor(
    private readonly store: CatalogStore,
    /** The one Lidarr client the rest of the server shares (artwork, requests, Discover). */
    private readonly lidarr: LidarrClient,
    private readonly log: { info: (msg: string) => void },
    /** Folders that folder sources may use (FOLDER_ROOTS). */
    private readonly folderRoots: string[] = ['/'],
  ) {}

  /** Folder scans hand new files to the matcher; Settings shows its progress. */
  useMatcher(matcher: MatcherHandle) {
    this.matcher = matcher;
  }

  /** Folder sources reach their files (on this server, over SSH/SFTP, or on an SMB share) through this. */
  useFolderAccess(access: Pick<FolderAccess, 'create' | 'get' | 'release'>) {
    this.folders = access;
  }

  /** Copy .env's Lidarr settings into the database, once. After that, Settings owns them. */
  seedFromEnv(env: { url?: string; apiKey?: string }) {
    if (this.store.appSetting(SEEDED)) {
      if (env.url || env.apiKey) {
        this.log.info('LIDARR_URL and LIDARR_API_KEY in .env are ignored: Lidarr is managed in Settings → Sources');
      }
      return;
    }
    if (env.url && env.apiKey) {
      const settings = { url: trimUrl(env.url), apiKey: env.apiKey };
      // Phase 1 created the Lidarr row without settings. Keep its id: its copies point at it.
      const existing = this.store.listSources().find((s) => s.kind === 'lidarr');
      if (existing) this.store.updateSource(existing.id, { settings });
      else this.store.addSource('lidarr', 'Lidarr', settings);
      this.log.info('Lidarr settings copied from .env into Settings → Sources');
    }
    this.store.setAppSetting(SEEDED, new Date().toISOString());
  }

  /** Adapters for the enabled sources, in Settings order. Also points the shared Lidarr client at the Lidarr source, or unsets it. */
  active(): { id: number; source: CatalogSource }[] {
    const list: { id: number; source: CatalogSource }[] = [];
    let lidarrSet = false;
    for (const s of this.store.listSources()) {
      if (!s.enabled) continue;
      if (s.kind === 'lidarr' && !lidarrSet) {
        const settings = s.settings as LidarrSettings;
        if (!settings.url || !settings.apiKey) continue;
        this.lidarr.configure(settings.url, settings.apiKey);
        list.push({ id: s.id, source: new LidarrSource(this.lidarr) });
        lidarrSet = true;
      } else if (s.kind === 'folder') {
        const root = (s.settings as FolderSettings).path;
        const fs = root ? this.folderFs(s) : undefined;
        if (root && fs) {
          const source = new FolderSource({
            sourceId: s.id,
            root,
            store: this.store,
            fs,
            onScanned: (id) => this.matcher?.enqueue(id),
          });
          list.push({ id: s.id, source });
        }
      }
    }
    if (!lidarrSet) this.lidarr.configure('', '');
    return list;
  }

  list(opts: { includeSettings: boolean; syncing: boolean }): SourceInfo[] {
    const counts = this.store.sourceCounts();
    const matchCounts = this.store.matchCounts();
    return this.store
      .listSources()
      .map((s) => toInfo(s, counts.get(s.id), this.matching(s.id, matchCounts), opts));
  }

  add(input: SourceInput): SourceInfo {
    const kind = input.kind ?? 'lidarr';
    let id: number;
    if (kind === 'lidarr') {
      const { url, apiKey } = input.settings ?? {};
      if (!url || !apiKey) throw new SourceError('A Lidarr source needs a URL and an API key', 400);
      if (this.store.listSources().some((s) => s.kind === 'lidarr')) {
        throw new SourceError('There is already a Lidarr source', 409);
      }
      id = this.store.addSource('lidarr', input.name?.trim() || 'Lidarr', { url: trimUrl(url), apiKey });
    } else if (kind === 'folder') {
      const settings = this.folderSettings(input.settings);
      const path = settings.path!;
      id = this.store.addSource('folder', input.name?.trim() || posix.basename(path) || path, withoutUndefined(settings));
    } else {
      throw new SourceError(`Unknown source kind: ${String(kind)}`, 400);
    }
    if (input.enabled === false) this.store.updateSource(id, { enabled: false });
    this.active();
    return this.info(id);
  }

  update(id: number, input: SourceInput): SourceInfo {
    const source = this.store.source(id);
    if (!source) throw new SourceError('Source not found', 404);
    const { url, apiKey } = input.settings ?? {};
    let settings: Record<string, unknown> | undefined;
    if (input.settings && source.kind === 'folder') {
      settings = withoutUndefined(this.folderSettings(input.settings, source.settings as FolderSettings));
    } else if (input.settings) {
      settings = { ...source.settings, ...(url ? { url: trimUrl(url) } : {}), ...(apiKey ? { apiKey } : {}) };
    }
    this.store.updateSource(id, { name: input.name?.trim() || undefined, enabled: input.enabled, settings });
    // New settings, new connection.
    if (settings) this.folders?.release(id);
    this.active();
    return this.info(id);
  }

  remove(id: number) {
    if (!this.store.source(id)) throw new SourceError('Source not found', 404);
    this.store.removeSource(id);
    this.folders?.release(id);
    this.active();
  }

  /**
   * Before saving a folder on another machine: connect and check the folder is there.
   * With an id, the source's saved settings fill in what the input leaves out. Local folders are checked by add/update.
   */
  async verify(input: SourceInput, id?: number): Promise<void> {
    const source = id !== undefined ? this.store.source(id) : undefined;
    if (id !== undefined && !source) throw new SourceError('Source not found', 404);
    const kind = source?.kind ?? input.kind ?? 'lidarr';
    if (kind !== 'folder' || !input.settings) return;
    const saved = (source?.settings ?? {}) as FolderSettings;
    if ((input.settings.access ?? saved.access ?? 'local') === 'local') return;
    const settings = this.folderSettings(input.settings, saved);
    const fs = this.openFolderFs(settings);
    try {
      await fs.media.check();
      const s = await fs.stat(settings.path!);
      if (!s?.dir) throw new SourceError(`Can’t open ${settings.path} on ${settings.host}`, 400);
    } catch (err) {
      throw err instanceof SourceError ? err : new SourceError((err as Error).message, 400);
    } finally {
      await fs.close().catch(() => {});
    }
  }

  /** Folders to choose from: on this server (inside FOLDER_ROOTS), or over a (possibly unsaved) SSH, SFTP or SMB connection (at / an SMB server lists its shares). */
  async browse(req: FolderBrowseRequest): Promise<FolderListing> {
    const source = req.id !== undefined ? this.store.source(req.id) : undefined;
    const saved = (source?.kind === 'folder' ? source.settings : {}) as FolderSettings;
    const access = req.connection?.access ?? saved.access ?? 'local';
    if (access === 'local') return this.listFolders(req.path);
    const c = req.connection ?? { access };
    const host = c.host?.trim() || saved.host;
    const user = c.user?.trim() || saved.user;
    if (!host || !user) throw new SourceError('A remote folder needs a host and a user', 400);
    const path = posix.normalize(req.path || '/');
    if (!path.startsWith('/')) throw new SourceError('The folder must be an absolute path on that host', 400);
    const wasSmb = saved.access === 'smb';
    const settings: FolderSettings = {
      access,
      host,
      user,
      port: c.port ?? ((access === 'smb') === wasSmb ? saved.port : undefined) ?? defaultPort(access),
      path,
      // A saved password only ever goes back to the host and account it was saved for.
      password: c.password || (host === saved.host && user === saved.user ? saved.password : undefined),
      ...(access === 'smb'
        ? { domain: c.domain?.trim() || (wasSmb ? saved.domain : undefined) }
        : { privateKeyPath: c.privateKeyPath?.trim() || saved.privateKeyPath }),
    };
    const fs = this.openFolderFs(settings);
    try {
      await fs.media.check();
      if (!(await fs.stat(path))?.dir) throw new SourceError(`Can’t open ${path} on ${host}`, 400);
      const entries = await fs.readdir(path);
      const folders = entries
        .filter((e) => e.dir && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: posix.join(path, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      const audioFiles = entries.filter((e) => e.file && isAudioFile(e.name)).length;
      return { path, parent: path === '/' ? null : posix.dirname(path), folders, audioFiles };
    } catch (err) {
      throw err instanceof SourceError ? err : new SourceError((err as Error).message, 400);
    } finally {
      await fs.close().catch(() => {});
    }
  }

  reorder(ids: number[]) {
    try {
      this.store.reorderSources(ids);
    } catch (err) {
      throw new SourceError((err as Error).message, 400);
    }
  }

  /** Try a Lidarr connection. With an id and no key, the saved key is used. */
  async test(input: { id?: number; url?: string; apiKey?: string }): Promise<SourceTestResult> {
    const saved = input.id !== undefined ? (this.store.source(input.id)?.settings as LidarrSettings | undefined) : undefined;
    const url = input.url || saved?.url;
    const apiKey = input.apiKey || saved?.apiKey;
    if (!url || !apiKey) return { ok: false, error: 'Enter the Lidarr URL and API key' };
    try {
      const status = await new LidarrClient(trimUrl(url), apiKey).systemStatus();
      return { ok: true, version: status.version };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async listFolders(path: string | undefined): Promise<FolderListing> {
    try {
      return await listFolders(path, this.folderRoots);
    } catch (err) {
      throw new SourceError((err as Error).message, 400);
    }
  }

  /** A folder source's filesystem, or none if it can't be reached as configured. */
  private folderFs(s: SourceRecord): FolderFs | undefined {
    try {
      if (this.folders) return this.folders.get(s.id);
    } catch (err) {
      this.log.info(`Folder source “${s.name}”: ${(err as Error).message}`);
      return undefined;
    }
    return ((s.settings as FolderSettings).access ?? 'local') === 'local' ? new LocalFolderFs() : undefined;
  }

  private openFolderFs(settings: FolderSettings): FolderFs {
    if (!this.folders) throw new SourceError('Folders on other machines aren’t available', 400);
    try {
      return this.folders.create(settings);
    } catch (err) {
      throw new SourceError((err as Error).message, 400);
    }
  }

  /** Folder settings from the input, with the saved ones (when editing) filling in what it leaves out. */
  private folderSettings(input: SourceInput['settings'] = {}, saved: FolderSettings = {}): FolderSettings {
    const access = input.access ?? saved.access ?? 'local';
    const path = input.path ?? saved.path;
    if (!path) throw new SourceError('A folder source needs a folder', 400);
    if (access === 'local') return { path: this.checkFolder(path) };
    const host = (input.host ?? saved.host)?.trim();
    const user = (input.user ?? saved.user)?.trim();
    if (!host || !user) throw new SourceError('A remote folder needs a host and a user', 400);
    if (!path.startsWith('/')) throw new SourceError('The folder must be an absolute path on that host', 400);
    const clean = posix.normalize(path).replace(/(.)\/+$/, '$1');
    if (access === 'smb' && clean.split('/').filter(Boolean).length === 0) throw new SourceError('Choose a share', 400);
    // Switching between SSH/SFTP and SMB starts from the new kind's port, not the old one's.
    const wasSmb = saved.access === 'smb';
    return {
      access,
      host,
      user,
      port: input.port ?? ((access === 'smb') === wasSmb ? saved.port : undefined) ?? defaultPort(access),
      path: clean,
      // A saved password only ever goes back to the host and account it was saved for.
      password: input.password || (host === saved.host && user === saved.user ? saved.password : undefined) || undefined,
      ...(access === 'smb'
        ? { domain: (input.domain ?? (wasSmb ? saved.domain : undefined))?.trim() || undefined }
        : { privateKeyPath: (input.privateKeyPath ?? saved.privateKeyPath)?.trim() || undefined }),
    };
  }

  private checkFolder(path: string): string {
    try {
      return checkFolder(path, this.folderRoots);
    } catch (err) {
      throw new SourceError((err as Error).message, 400);
    }
  }

  private info(id: number): SourceInfo {
    return toInfo(this.store.source(id)!, this.store.sourceCounts().get(id), this.matching(id, this.store.matchCounts()), {
      includeSettings: true,
      syncing: false,
    });
  }

  private matching(id: number, matchCounts: Map<number, { review: number }>) {
    return { review: matchCounts.get(id)?.review ?? 0, matching: this.matcher?.pendingGroups(id) ?? 0 };
  }
}

function toInfo(
  s: SourceRecord,
  counts: { songs: number; albums: number } | undefined,
  matching: { review: number; matching: number },
  opts: { includeSettings: boolean; syncing: boolean },
): SourceInfo {
  const folder = s.kind === 'folder' ? (s.settings as FolderSettings) : undefined;
  const localPath = folder && (folder.access ?? 'local') === 'local' ? folder.path : undefined;
  return {
    id: s.id,
    kind: s.kind,
    name: s.name,
    position: s.position,
    enabled: s.enabled,
    ...(opts.includeSettings ? { settings: publicSettings(s) } : {}),
    secrets: SECRET_FIELDS.filter((f) => !!s.settings[f]),
    lastSyncAt: s.lastSyncAt,
    error: s.lastError,
    syncing: opts.syncing && s.enabled,
    songs: counts?.songs ?? 0,
    albums: counts?.albums ?? 0,
    review: matching.review,
    matching: matching.matching,
    ...(localPath ? { writable: isWritable(localPath) } : {}),
  };
}

/** Connection settings the browser may see: never a secret. */
function publicSettings(s: SourceRecord): SourceInfo['settings'] {
  if (s.kind !== 'folder') return { url: (s.settings as LidarrSettings).url };
  const { path, access, host, port, user, privateKeyPath, domain } = s.settings as FolderSettings;
  if ((access ?? 'local') === 'local') return { path };
  if (access === 'smb') return { path, access, host, port, user, domain };
  return { path, access, host, port, user, privateKeyPath };
}

/** SMB listens on 445, SSH and SFTP on 22. */
const defaultPort = (access: FolderAccessKind) => (access === 'smb' ? 445 : 22);

/** Drop undefined fields before storing settings as JSON. */
const withoutUndefined = (o: object): Record<string, unknown> => JSON.parse(JSON.stringify(o)) as Record<string, unknown>;

const trimUrl = (url: string) => url.trim().replace(/\/+$/, '');
