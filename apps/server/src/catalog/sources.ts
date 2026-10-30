import type { SourceInfo, SourceInput, SourceTestResult } from '@playarr/shared';
import { LidarrClient } from '../lidarr/client.ts';
import { LidarrSource } from './lidarr.ts';
import type { CatalogStore, SourceRecord } from './store.ts';
import type { CatalogSource } from './types.ts';

interface LidarrSettings {
  url?: string;
  apiKey?: string;
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

  /** Adapters for the enabled sources. Also points the shared Lidarr client at the Lidarr source, or unsets it. */
  active(): { id: number; source: CatalogSource }[] {
    const list: { id: number; source: CatalogSource }[] = [];
    const lidarr = this.store.listSources().find((s) => s.kind === 'lidarr' && s.enabled);
    const settings = lidarr?.settings as LidarrSettings | undefined;
    if (lidarr && settings?.url && settings.apiKey) {
      this.lidarr.configure(settings.url, settings.apiKey);
      list.push({ id: lidarr.id, source: new LidarrSource(this.lidarr) });
    } else {
      this.lidarr.configure('', '');
    }
    return list;
  }

  list(opts: { includeSettings: boolean; syncing: boolean }): SourceInfo[] {
    const counts = this.store.sourceCounts();
    return this.store.listSources().map((s) => toInfo(s, counts.get(s.id), opts));
  }

  add(input: SourceInput): SourceInfo {
    if ((input.kind ?? 'lidarr') !== 'lidarr') throw new SourceError('Only Lidarr sources can be added for now', 400);
    const { url, apiKey } = input.settings ?? {};
    if (!url || !apiKey) throw new SourceError('A Lidarr source needs a URL and an API key', 400);
    if (this.store.listSources().some((s) => s.kind === 'lidarr')) {
      throw new SourceError('There is already a Lidarr source', 409);
    }
    const id = this.store.addSource('lidarr', input.name?.trim() || 'Lidarr', { url: trimUrl(url), apiKey });
    if (input.enabled === false) this.store.updateSource(id, { enabled: false });
    this.active();
    return this.info(id);
  }

  update(id: number, input: SourceInput): SourceInfo {
    const source = this.store.source(id);
    if (!source) throw new SourceError('Source not found', 404);
    const { url, apiKey } = input.settings ?? {};
    const settings = input.settings
      ? { ...source.settings, ...(url ? { url: trimUrl(url) } : {}), ...(apiKey ? { apiKey } : {}) }
      : undefined;
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
    ...(opts.includeSettings ? { settings: { url: (s.settings as LidarrSettings).url } } : {}),
    secrets: SECRET_FIELDS.filter((f) => !!s.settings[f]),
    lastSyncAt: s.lastSyncAt,
    error: s.lastError,
    syncing: opts.syncing && s.enabled,
    songs: counts?.songs ?? 0,
    albums: counts?.albums ?? 0,
  };
}

const trimUrl = (url: string) => url.trim().replace(/\/+$/, '');
