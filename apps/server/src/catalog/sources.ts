import type { FolderListing, SourceInfo, SourceInput, SourceTestResult } from '@playarr/shared';
import { basename } from 'node:path';
import { LidarrClient } from '../lidarr/client.ts';
import { FolderSource } from './folderSource.ts';
import { LidarrSource } from './lidarr.ts';
import { checkFolder, listFolders } from './paths.ts';
import type { CatalogStore, SourceRecord } from './store.ts';
import type { CatalogSource } from './types.ts';

interface LidarrSettings {
  url?: string;
  apiKey?: string;
}

interface FolderSettings {
  path?: string;
}

/** Settings fields that are never sent to the browser. */
const SECRET_FIELDS = ['apiKey'];
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
export class SourceManager {
  constructor(
    private readonly store: CatalogStore,
    /** The one Lidarr client the rest of the server shares (artwork, requests, Discover). */
    private readonly lidarr: LidarrClient,
    private readonly log: { info: (msg: string) => void },
    /** Folders that folder sources may use (FOLDER_ROOTS). */
    private readonly folderRoots: string[] = ['/'],
  ) {}

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
        if (root) list.push({ id: s.id, source: new FolderSource({ sourceId: s.id, root, store: this.store }) });
      }
    }
    if (!lidarrSet) this.lidarr.configure('', '');
    return list;
  }

  list(opts: { includeSettings: boolean; syncing: boolean }): SourceInfo[] {
    const counts = this.store.sourceCounts();
    return this.store.listSources().map((s) => toInfo(s, counts.get(s.id), opts));
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
      if (!input.settings?.path) throw new SourceError('A folder source needs a folder', 400);
      const path = this.checkFolder(input.settings.path);
      id = this.store.addSource('folder', input.name?.trim() || basename(path) || path, { path });
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
    const { url, apiKey, path } = input.settings ?? {};
    let settings: Record<string, unknown> | undefined;
    if (input.settings && source.kind === 'folder') {
      settings = path ? { ...source.settings, path: this.checkFolder(path) } : undefined;
    } else if (input.settings) {
      settings = { ...source.settings, ...(url ? { url: trimUrl(url) } : {}), ...(apiKey ? { apiKey } : {}) };
    }
    this.store.updateSource(id, { name: input.name?.trim() || undefined, enabled: input.enabled, settings });
    this.active();
    return this.info(id);
  }

  remove(id: number) {
    if (!this.store.source(id)) throw new SourceError('Source not found', 404);
    this.store.removeSource(id);
    this.active();
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

  private checkFolder(path: string): string {
    try {
      return checkFolder(path, this.folderRoots);
    } catch (err) {
      throw new SourceError((err as Error).message, 400);
    }
  }

  private info(id: number): SourceInfo {
    return toInfo(this.store.source(id)!, this.store.sourceCounts().get(id), { includeSettings: true, syncing: false });
  }
}

function toInfo(
  s: SourceRecord,
  counts: { songs: number; albums: number } | undefined,
  opts: { includeSettings: boolean; syncing: boolean },
): SourceInfo {
  return {
    id: s.id,
    kind: s.kind,
    name: s.name,
    position: s.position,
    enabled: s.enabled,
    ...(opts.includeSettings ? { settings: { url: (s.settings as LidarrSettings).url, path: (s.settings as FolderSettings).path } } : {}),
    secrets: SECRET_FIELDS.filter((f) => !!s.settings[f]),
    lastSyncAt: s.lastSyncAt,
    error: s.lastError,
    syncing: opts.syncing && s.enabled,
    songs: counts?.songs ?? 0,
    albums: counts?.albums ?? 0,
  };
}

const trimUrl = (url: string) => url.trim().replace(/\/+$/, '');
