import type { FolderAccessKind, FolderBrowseRequest, FolderListing, SourceInfo, SourceInput, SourceTestResult, SshHostKey } from '@playarr/shared';
import { posix } from 'node:path';
import { LidarrClient } from '../lidarr/client.ts';
import type { FolderAccess, FolderSettings, HostKeyHandling } from './folderAccess.ts';
import { LocalFolderFs, type FolderFs } from './folderFs.ts';
import { FolderSource, isAudioFile } from './folderSource.ts';
import { LidarrSource } from './lidarr.ts';
import { isWritable } from './organizer.ts';
import { checkFolder, listFolders } from './paths.ts';
import type { CatalogStore, MatchCounts, SourceCounts, SourceRecord } from './store.ts';
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

/** What checking a folder on another machine found, for saving with it. */
export interface Verified {
  /** SSH and SFTP: the key the host showed, when it isn't the one already saved (the first connection, or a new key trusted). */
  hostKey?: SshHostKey;
}

/** Sources as Settings manages them: rows in the database, turned into catalog adapters. */
interface MatcherHandle {
  pendingGroups(sourceId: number): number;
  /** After a scan, with its digest (SourceSync.digest). */
  enqueue(sourceId: number, scan?: string): void;
}

export class SourceManager {
  private matcher?: MatcherHandle;
  private folders?: Pick<FolderAccess, 'create' | 'get' | 'release'>;
  /**
   * Each source's adapter, kept while what it was made from stays (Lidarr's address and key; a folder's path and
   * filesystem): what an adapter remembers between syncs (the lengths it asked Lidarr for) lasts.
   */
  private readonly adapters = new Map<number, { made: unknown[]; source: CatalogSource }>();

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
        list.push({ id: s.id, source: this.adapter(s.id, [settings.url, settings.apiKey], () => new LidarrSource(this.lidarr)) });
        lidarrSet = true;
      } else if (s.kind === 'folder') {
        const root = (s.settings as FolderSettings).path;
        const fs = root ? this.folderFs(s) : undefined;
        if (root && fs) {
          const source = this.adapter(
            s.id,
            [root, fs],
            () =>
              new FolderSource({
                sourceId: s.id,
                root,
                store: this.store,
                fs,
                onScanned: (id, digest) => this.matcher?.enqueue(id, digest),
              }),
          );
          list.push({ id: s.id, source });
        }
      }
    }
    if (!lidarrSet) this.lidarr.configure('', '');
    return list;
  }

  /** The source's adapter, made again only when what it's made from has changed. */
  private adapter(id: number, made: unknown[], make: () => CatalogSource): CatalogSource {
    const kept = this.adapters.get(id);
    if (kept && kept.made.length === made.length && kept.made.every((m, i) => m === made[i])) return kept.source;
    const source = make();
    this.adapters.set(id, { made, source });
    return source;
  }

  list(opts: { includeSettings: boolean; syncing: boolean }): SourceInfo[] {
    const counts = this.store.sourceCounts();
    const matchCounts = this.store.matchCounts();
    return this.store
      .listSources()
      .map((s) => toInfo(s, counts.get(s.id), this.matching(s.id, matchCounts), opts));
  }

  /** `verified`: what `verify` found, saved with the source (the host's key). */
  add(input: SourceInput, verified: Verified = {}): SourceInfo {
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
      const settings = withHostKey(this.folderSettings(input.settings), verified);
      const path = settings.path!;
      id = this.store.addSource('folder', input.name?.trim() || posix.basename(path) || path, withoutUndefined(settings));
    } else {
      throw new SourceError(`Unknown source kind: ${String(kind)}`, 400);
    }
    if (input.enabled === false) this.store.updateSource(id, { enabled: false });
    this.active();
    return this.info(id);
  }

  /** `verified`: what `verify` found, saved with the source (the host's key, trusted anew). */
  update(id: number, input: SourceInput, verified: Verified = {}): SourceInfo {
    const source = this.store.source(id);
    if (!source) throw new SourceError('Source not found', 404);
    const { url, apiKey } = input.settings ?? {};
    let settings: Record<string, unknown> | undefined;
    if (input.settings && source.kind === 'folder') {
      settings = withoutUndefined(withHostKey(this.folderSettings(input.settings, source.settings as FolderSettings), verified));
    } else if (input.settings) {
      const saved = source.settings as LidarrSettings;
      // The saved key only ever goes to the server it was saved for: a new address needs its key.
      if (url && !apiKey && saved.url && !sameServer(url, saved.url)) {
        throw new SourceError('Enter the API key for the new Lidarr address', 400);
      }
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
    this.adapters.delete(id);
    this.active();
  }

  /**
   * Before saving a folder on another machine: connect and check the folder is there.
   * With an id, the source's saved settings fill in what the input leaves out. Local folders are checked by add/update.
   * Over SSH or SFTP, saving trusts the key the host shows now: the first one, or a new one (a reinstalled machine),
   * which goes back to add/update to be saved. A saved password never goes to a host whose key changed: trusting the
   * new key then takes the password typed again, so that no save made for another reason sends it to a stranger.
   */
  async verify(input: SourceInput, id?: number): Promise<Verified> {
    const source = id !== undefined ? this.store.source(id) : undefined;
    if (id !== undefined && !source) throw new SourceError('Source not found', 404);
    const kind = source?.kind ?? input.kind ?? 'lidarr';
    if (kind !== 'folder' || !input.settings) return {};
    const saved = (source?.settings ?? {}) as FolderSettings;
    if ((input.settings.access ?? saved.access ?? 'local') === 'local') return {};
    const settings = this.folderSettings(input.settings, saved);
    const savedPassword = !input.settings.password && !!settings.password && !settings.privateKeyPath;
    const verified: Verified = {};
    const fs = this.openFolderFs(settings, { trustNewHostKey: !savedPassword, onHostKey: (key) => (verified.hostKey = key) });
    try {
      await fs.media.check();
      const s = await fs.stat(settings.path!);
      if (!s?.dir) throw new SourceError(`Can’t open ${settings.path} on ${settings.host}`, 400);
    } catch (err) {
      throw err instanceof SourceError ? err : new SourceError((err as Error).message, 400);
    } finally {
      await fs.close().catch(() => {});
    }
    return verified;
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
      ...(access === 'smb'
        ? { domain: c.domain?.trim() || (wasSmb ? saved.domain : undefined) }
        : { privateKeyPath: c.privateKeyPath?.trim() || saved.privateKeyPath }),
    };
    // The saved password and host key, where they may go. Browsing never trusts a new key: saving the source does.
    Object.assign(settings, fromSaved(settings, saved, c.password));
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
    // The saved key only ever goes to the server it was saved for, never to an address typed in a test.
    const apiKey = input.apiKey || (url && saved?.url && sameServer(url, saved.url) ? saved.apiKey : undefined);
    if (!url || !apiKey) return { ok: false, error: input.url && saved?.apiKey ? 'Enter the API key for this address' : 'Enter the Lidarr URL and API key' };
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

  private openFolderFs(settings: FolderSettings, hostKeys?: HostKeyHandling): FolderFs {
    if (!this.folders) throw new SourceError('Folders on other machines aren’t available', 400);
    try {
      return this.folders.create(settings, hostKeys);
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
    const settings: FolderSettings = {
      access,
      host,
      user,
      port: input.port ?? ((access === 'smb') === wasSmb ? saved.port : undefined) ?? defaultPort(access),
      path: clean,
      ...(access === 'smb'
        ? { domain: (input.domain ?? (wasSmb ? saved.domain : undefined))?.trim() || undefined }
        : { privateKeyPath: (input.privateKeyPath ?? saved.privateKeyPath)?.trim() || undefined }),
    };
    return { ...settings, ...fromSaved(settings, saved, input.password) };
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

  private matching(id: number, matchCounts: Map<number, MatchCounts>) {
    const c = matchCounts.get(id);
    return { matched: c?.matched ?? 0, review: c?.review ?? 0, ignored: c?.ignored ?? 0, matching: this.matcher?.pendingGroups(id) ?? 0 };
  }
}

function toInfo(
  s: SourceRecord,
  counts: SourceCounts | undefined,
  matching: MatchCounts & { matching: number },
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
    albumsComplete: counts?.complete ?? 0,
    albumsIncomplete: counts?.incomplete ?? 0,
    albumsUnknown: counts?.unknown ?? 0,
    songsComplete: counts?.songsComplete ?? 0,
    songsIncomplete: counts?.songsIncomplete ?? 0,
    songsUnknown: counts?.songsUnknown ?? 0,
    matched: matching.matched,
    review: matching.review,
    ignored: matching.ignored,
    matching: matching.matching,
    ...(localPath ? { writable: isWritable(localPath) } : {}),
  };
}

/** Connection settings the browser may see: never a secret. */
function publicSettings(s: SourceRecord): SourceInfo['settings'] {
  if (s.kind !== 'folder') return { url: (s.settings as LidarrSettings).url };
  const { path, access, host, port, user, privateKeyPath, domain, hostKey } = s.settings as FolderSettings;
  if ((access ?? 'local') === 'local') return { path };
  if (access === 'smb') return { path, access, host, port, user, domain };
  return { path, access, host, port, user, privateKeyPath, hostKey };
}

/** SMB listens on 445, SSH and SFTP on 22. */
const defaultPort = (access: FolderAccessKind) => (access === 'smb' ? 445 : 22);

const overSsh = (access: FolderAccessKind | undefined) => access === 'ssh' || access === 'sftp';

/** Whether these settings log in with a password: not with a key file, nor as SMB's guest. */
const usesPassword = (s: FolderSettings) => (s.access === 'smb' ? s.user?.toLowerCase() !== 'guest' : !s.privateKeyPath);

/**
 * What of a saved connection goes with new settings. The saved password only ever goes back to the host, port and
 * user it was saved for: for anywhere else it must be typed again (400, before connecting), unless the new settings
 * don't log in with one, and then it's dropped. The host key stays with its host and port, over SSH or SFTP.
 */
function fromSaved(next: FolderSettings, saved: FolderSettings, typed?: string): Pick<FolderSettings, 'password' | 'hostKey'> {
  const sameAddress =
    !!next.host && !!saved.host && next.host.toLowerCase() === saved.host.toLowerCase() && next.port === (saved.port ?? defaultPort(saved.access ?? 'ssh'));
  const hostKey = sameAddress && overSsh(next.access) && overSsh(saved.access) ? saved.hostKey : undefined;
  if (typed) return { password: typed, hostKey };
  if (!saved.password) return { hostKey };
  if (sameAddress && next.user === saved.user) return { password: saved.password, hostKey };
  if (!usesPassword(next)) return { hostKey };
  throw new SourceError(sameAddress ? 'Enter the password again for the new user' : 'Enter the password again for the new address', 400);
}

/** Settings with the host key `verify` saw, over SSH or SFTP; else the saved one they carry, if any. */
const withHostKey = (settings: FolderSettings, verified: Verified): FolderSettings =>
  verified.hostKey && overSsh(settings.access) ? { ...settings, hostKey: verified.hostKey } : settings;

/** Drop undefined fields before storing settings as JSON. */
const withoutUndefined = (o: object): Record<string, unknown> => JSON.parse(JSON.stringify(o)) as Record<string, unknown>;

const trimUrl = (url: string) => url.trim().replace(/\/+$/, '');

/** Same scheme, host and port: where a saved secret may be sent again. */
function sameServer(a: string, b: string): boolean {
  try {
    return new URL(trimUrl(a)).origin === new URL(trimUrl(b)).origin;
  } catch {
    return false;
  }
}
