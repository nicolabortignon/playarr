# Sources, Phase 2: Settings Panel and the Lidarr Source Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Settings page whose Sources panel lists, adds, edits, reorders, rescans and removes catalog sources, with Lidarr's connection moved from `.env` into the database and Lidarr becoming optional.

**Architecture:** A `SourceManager` (server) owns the `sources` rows: it seeds the Lidarr source from `.env` once, turns enabled rows into catalog adapters for `Library`, and points the one shared `LidarrClient` at the Lidarr source (or leaves it unconfigured, in which case every Lidarr call fails fast with a 503). New `/api/settings/sources` routes expose it; changes are only accepted from the local network until Playarr has a login. The web app gets a `/settings/:panel?` page with a Sources panel, gear entry points, and hides requests and Discover when there is no Lidarr.

**Tech Stack:** Fastify 5, `node:sqlite`, zod 4, vitest 5 (server); React 19, React Router 7, TanStack Query 5, motion `Reorder`, Tailwind 4, lucide-react (web). pnpm via `corepack pnpm`.

**Design:** `docs/plans/2026-10-30-sources-design.md` (Settings and the Sources UI; Access; Rollout phase 2). Builds on Phase 1 (`docs/plans/2026-10-30-sources-phase1-catalog.md`, implemented): `apps/server/src/catalog/{types,keys,store,build,lidarr}.ts`, `Library` built from `CatalogStore`.

**Scope limits (YAGNI):** only Lidarr sources can be added in this phase (folder sources are phase 3); at most one Lidarr source (the rest of the server shares one `LidarrClient`); Playback, Requests and Appearance panels appear as disabled tabs; rescan syncs all sources (there is only one kind yet).

---

## Conventions

- Run everything from the repo root `/Users/bortignon/dev/playarr`.
- Server tests: `corepack pnpm -C apps/server test`; one file: `corepack pnpm -C apps/server exec vitest run src/net.test.ts`.
- Server typecheck: `corepack pnpm -C apps/server typecheck`. Web typecheck: `corepack pnpm -C apps/web exec tsc --noEmit`. Don't use the root `pnpm typecheck` (it shells out to `pnpm`, which isn't on PATH).
- Web smoke tests need a running server and a Lidarr; they are not part of this plan's verification (the user asked to skip live checks for now). Still add the new smoke case in Task 12.
- Imports use explicit `.ts` extensions on the server; the web app imports without extensions (match each package).
- Commit after every task, directly on `main`, staging only that task's files (`git add <paths>`, never `-A`).

---

### Task 1: Shared types for sources; Lidarr optional in health

**Files:**
- Modify: `packages/shared/src/index.ts`

**Step 1: Make `HealthStatus.lidarr` optional**

Replace the `lidarr` line of `HealthStatus`:

```ts
  /** Absent when there is no Lidarr source. */
  lidarr?: { ok: boolean; version?: string; error?: string };
```

**Step 2: Append the source types at the end of the file**

```ts
// ── Settings: catalog sources ───────────────────────────────────────────────

export type SourceKind = 'lidarr' | 'folder';

export interface SourceInfo {
  id: number;
  kind: SourceKind;
  name: string;
  /** Place in the priority list: equally good copies play from the source listed first. */
  position: number;
  enabled: boolean;
  /** Connection settings without secrets. Absent for visitors outside the local network. */
  settings?: { url?: string };
  /** Secret fields that have a saved value. The values themselves are never sent. */
  secrets: string[];
  lastSyncAt?: string;
  error?: string;
  syncing: boolean;
  songs: number;
  albums: number;
}

export interface SourcesResponse {
  sources: SourceInfo[];
  /** False for visitors outside the local network: Settings is read-only for them. */
  canEdit: boolean;
}

export interface SourceInput {
  kind?: SourceKind;
  name?: string;
  enabled?: boolean;
  /** For Lidarr: url and apiKey. Leaving apiKey out keeps the saved one. */
  settings?: { url?: string; apiKey?: string };
}

export interface SourceTestResult {
  ok: boolean;
  version?: string;
  error?: string;
}
```

**Step 3: Typecheck both apps**

Run: `corepack pnpm -C apps/server typecheck; corepack pnpm -C apps/web exec tsc --noEmit`
Expected: server clean. Web reports errors in `components/Nav.tsx` (`data?.lidarr.ok`: possibly undefined). Leave them: Task 11 fixes Nav. Note the exact errors.

**Step 4: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "Shared: source types for Settings; Lidarr optional in health"
```

---

### Task 2: Database: sync errors and app settings

**Files:**
- Modify: `apps/server/src/db.ts`
- Modify: `apps/server/src/db.test.ts`

**Step 1: Write the failing test**

Add to the `describe('migrate')` block in `apps/server/src/db.test.ts`:

```ts
  it('adds sync errors to sources and an app settings table', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const columns = (db.prepare('PRAGMA table_info(sources)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain('last_error');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'app_settings'").get()).toBeTruthy();
  });
```

**Step 2: Run it to verify it fails**

Run: `corepack pnpm -C apps/server exec vitest run src/db.test.ts`
Expected: FAIL (`last_error` missing).

**Step 3: Implement**

Append to the end of `MIGRATIONS` in `apps/server/src/db.ts`:

```ts
  // Sources managed in Settings: the last sync error, and app-wide flags (e.g. ".env seeded").
  `ALTER TABLE sources ADD COLUMN last_error TEXT;
   CREATE TABLE app_settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
```

**Step 4: Run it to verify it passes**

Run: `corepack pnpm -C apps/server exec vitest run src/db.test.ts`
Expected: PASS (3 tests).

**Step 5: Commit**

```bash
git add apps/server/src/db.ts apps/server/src/db.test.ts
git commit -m "Database: source sync errors and app settings"
```

---

### Task 3: CatalogStore: manage sources

**Files:**
- Modify: `apps/server/src/catalog/store.ts`
- Modify: `apps/server/src/catalog/store.test.ts`

**Step 1: Write the failing tests**

Append to `apps/server/src/catalog/store.test.ts`:

```ts
describe('CatalogStore: managing sources', () => {
  it('lists sources with their settings and sync errors', () => {
    const store = new CatalogStore(freshDb());
    const id = store.addSource('lidarr', 'Lidarr', { url: 'http://lidarr:8686', apiKey: 'k' });
    store.setSyncError(id, 'Cannot reach Lidarr');
    expect(store.source(id)).toMatchObject({
      kind: 'lidarr',
      enabled: true,
      settings: { url: 'http://lidarr:8686', apiKey: 'k' },
      lastError: 'Cannot reach Lidarr',
    });
    store.setSyncError(id, null);
    expect(store.source(id)!.lastError).toBeUndefined();
  });

  it('updates name, enabled and settings', () => {
    const store = new CatalogStore(freshDb());
    const id = store.addSource('lidarr', 'Lidarr');
    store.updateSource(id, { name: 'Home', enabled: false, settings: { url: 'http://nas:8686' } });
    expect(store.source(id)).toMatchObject({ name: 'Home', enabled: false, settings: { url: 'http://nas:8686' } });
  });

  it('removes a source with its copies, keeping catalog rows', () => {
    const store = new CatalogStore(freshDb());
    const id = store.ensureSource('lidarr', 'Lidarr');
    store.applySync(id, mezzanine());
    store.removeSource(id);
    const rows = store.load();
    expect(rows.sources).toEqual([]);
    expect(rows.copies).toEqual([]);
    expect(rows.tracks).toHaveLength(2);
  });

  it('reorders sources and rejects an incomplete order', () => {
    const store = new CatalogStore(freshDb());
    const a = store.addSource('lidarr', 'A');
    const b = store.addSource('folder', 'B');
    store.reorderSources([b, a]);
    expect(store.listSources().map((s) => s.id)).toEqual([b, a]);
    expect(() => store.reorderSources([a])).toThrow(/every source/);
  });

  it('counts the songs and albums each source has', () => {
    const store = new CatalogStore(freshDb());
    const id = store.ensureSource('lidarr', 'Lidarr');
    store.applySync(id, mezzanine());
    expect(store.sourceCounts().get(id)).toEqual({ songs: 2, albums: 1 });
  });

  it('keeps app settings', () => {
    const store = new CatalogStore(freshDb());
    expect(store.appSetting('x')).toBeUndefined();
    store.setAppSetting('x', '1');
    store.setAppSetting('x', '2');
    expect(store.appSetting('x')).toBe('2');
  });
});
```

**Step 2: Run them to verify they fail**

Run: `corepack pnpm -C apps/server exec vitest run src/catalog/store.test.ts`
Expected: FAIL (`source`, `setSyncError`, etc. don't exist; `addSource` takes 2 arguments).

**Step 3: Implement**

In `apps/server/src/catalog/store.ts`:

Add next to the other row types:

```ts
/** A source as Settings manages it. `settings` holds secrets: never send it to the browser as is. */
export interface SourceRecord extends SourceRow {
  settings: Record<string, unknown>;
  lastError?: string;
}
```

Replace `addSource` with a version that takes settings:

```ts
  addSource(kind: SourceKind, name: string, settings: Record<string, unknown> = {}): number {
    const { next } = this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM sources').get() as {
      next: number;
    };
    const res = this.db
      .prepare('INSERT INTO sources (kind, name, position, settings, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(kind, name, next, JSON.stringify(settings), new Date().toISOString());
    return Number(res.lastInsertRowid);
  }
```

Add these methods to the class (after `hasData`):

```ts
  listSources(): SourceRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, kind, name, position, enabled, settings, state, last_sync_at, last_error FROM sources ORDER BY position',
      )
      .all() as {
      id: number;
      kind: SourceKind;
      name: string;
      position: number;
      enabled: number;
      settings: string;
      state: string | null;
      last_sync_at: string | null;
      last_error: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      position: r.position,
      enabled: r.enabled === 1,
      lastSyncAt: r.last_sync_at ?? undefined,
      lastError: r.last_error ?? undefined,
      state: r.state ? (JSON.parse(r.state) as SourceState) : {},
      settings: JSON.parse(r.settings) as Record<string, unknown>,
    }));
  }

  source(id: number): SourceRecord | undefined {
    return this.listSources().find((s) => s.id === id);
  }

  updateSource(id: number, patch: { name?: string; enabled?: boolean; settings?: Record<string, unknown> }) {
    if (patch.name !== undefined) this.db.prepare('UPDATE sources SET name = ? WHERE id = ?').run(patch.name, id);
    if (patch.enabled !== undefined) {
      this.db.prepare('UPDATE sources SET enabled = ? WHERE id = ?').run(patch.enabled ? 1 : 0, id);
    }
    if (patch.settings !== undefined) {
      this.db.prepare('UPDATE sources SET settings = ? WHERE id = ?').run(JSON.stringify(patch.settings), id);
    }
  }

  /** Delete a source and its copies. Catalog rows stay, so their ids are never reused. */
  removeSource(id: number) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM copies WHERE source_id = ?').run(id);
      this.db.prepare('DELETE FROM sources WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Rewrite positions in this order. `ids` must list every source exactly once. */
  reorderSources(ids: number[]) {
    const current = this.listSources()
      .map((s) => s.id)
      .sort((a, b) => a - b);
    const wanted = [...ids].sort((a, b) => a - b);
    if (wanted.length !== current.length || wanted.some((id, i) => id !== current[i])) {
      throw new Error('The new order must list every source exactly once');
    }
    this.db.exec('BEGIN');
    try {
      const update = this.db.prepare('UPDATE sources SET position = ? WHERE id = ?');
      ids.forEach((id, i) => update.run(i, id));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  setSyncError(id: number, error: string | null) {
    this.db.prepare('UPDATE sources SET last_error = ? WHERE id = ?').run(error, id);
  }

  /** How many songs and albums each source has a copy of. */
  sourceCounts(): Map<number, { songs: number; albums: number }> {
    const rows = this.db
      .prepare(
        `SELECT c.source_id AS id, COUNT(DISTINCT c.track_id) AS songs, COUNT(DISTINCT t.album_id) AS albums
         FROM copies c JOIN catalog_tracks t ON t.id = c.track_id
         GROUP BY c.source_id`,
      )
      .all() as { id: number; songs: number; albums: number }[];
    return new Map(rows.map((r) => [r.id, { songs: r.songs, albums: r.albums }]));
  }

  appSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setAppSetting(key: string, value: string) {
    this.db
      .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
```

**Step 4: Run the tests to verify they pass**

Run: `corepack pnpm -C apps/server exec vitest run src/catalog/store.test.ts`
Expected: PASS (14 tests).

**Step 5: Commit**

```bash
git add apps/server/src/catalog/store.ts apps/server/src/catalog/store.test.ts
git commit -m "Catalog store: list, update, reorder and remove sources; app settings"
```

---

### Task 4: LidarrClient can be configured later, or not at all

**Files:**
- Modify: `apps/server/src/lidarr/client.ts`
- Test: `apps/server/src/lidarr/client.test.ts` (create)

**Step 1: Write the failing tests**

```ts
// apps/server/src/lidarr/client.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LidarrClient } from './client.ts';

afterEach(() => vi.restoreAllMocks());

describe('LidarrClient', () => {
  it('fails fast with a 503 when no Lidarr is set up', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const client = new LidarrClient();
    expect(client.configured).toBe(false);
    await expect(client.artists()).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('can be pointed at a Lidarr later', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ version: '3.1.6' }), { status: 200 }));
    const client = new LidarrClient();
    client.configure('http://lidarr:8686/', 'key');
    expect(client.configured).toBe(true);
    await expect(client.systemStatus()).resolves.toEqual({ version: '3.1.6' });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://lidarr:8686/api/v1/system/status');
  });
});
```

**Step 2: Run them to verify they fail**

Run: `corepack pnpm -C apps/server exec vitest run src/lidarr/client.test.ts`
Expected: FAIL (`configured` / `configure` don't exist; the constructor requires arguments).

**Step 3: Implement**

In `apps/server/src/lidarr/client.ts`, replace the constructor:

```ts
  private baseUrl = '';
  private apiKey = '';

  constructor(baseUrl = '', apiKey = '') {
    this.configure(baseUrl, apiKey);
  }

  /** Point the client at a Lidarr. Empty values leave it unconfigured. */
  configure(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  get configured(): boolean {
    return !!this.baseUrl && !!this.apiKey;
  }
```

and add this as the first line of the private `request` method:

```ts
    if (!this.configured) throw new LidarrError('No Lidarr source is set up. Add one in Settings → Sources.', 503);
```

**Step 4: Run the tests to verify they pass, then typecheck**

Run: `corepack pnpm -C apps/server exec vitest run src/lidarr/client.test.ts && corepack pnpm -C apps/server typecheck`
Expected: PASS (2 tests); typecheck clean.

**Step 5: Commit**

```bash
git add apps/server/src/lidarr/client.ts apps/server/src/lidarr/client.test.ts
git commit -m "Lidarr client: configurable at runtime, fails fast when unset"
```

---

### Task 5: Local-network check

**Files:**
- Create: `apps/server/src/net.ts`
- Test: `apps/server/src/net.test.ts`

**Step 1: Write the failing test**

```ts
// apps/server/src/net.test.ts
import { describe, expect, it } from 'vitest';
import { isLocalAddress } from './net.ts';

describe('isLocalAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.20',
    '169.254.10.1',
    '::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:192.168.1.20',
  ])('%s is local', (address) => {
    expect(isLocalAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '172.32.0.1', '203.0.113.5', '2001:db8::1', '::ffff:8.8.8.8', 'garbage', '', undefined])(
    '%s is not local',
    (address) => {
      expect(isLocalAddress(address)).toBe(false);
    },
  );
});
```

**Step 2: Run it to verify it fails**

Run: `corepack pnpm -C apps/server exec vitest run src/net.test.ts`
Expected: FAIL, cannot resolve `./net.ts`.

**Step 3: Implement**

```ts
// apps/server/src/net.ts
import { isIP } from 'node:net';

/**
 * True for loopback, private (RFC 1918), link-local and unique-local addresses.
 * Pass the socket's address, never a forwarded header: a proxy header can be forged.
 */
export function isLocalAddress(address: string | undefined): boolean {
  if (!address) return false;
  let a = address.toLowerCase();
  if (a.startsWith('::ffff:') && isIP(a.slice(7)) === 4) a = a.slice(7);
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number) as [number, number];
    return p === 127 || p === 10 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254);
  }
  if (isIP(a) === 6) return a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
  return false;
}
```

**Step 4: Run it to verify it passes**

Run: `corepack pnpm -C apps/server exec vitest run src/net.test.ts`
Expected: PASS (18 tests).

**Step 5: Commit**

```bash
git add apps/server/src/net.ts apps/server/src/net.test.ts
git commit -m "Local-network check for Settings changes"
```

---

### Task 6: SourceManager

**Files:**
- Create: `apps/server/src/catalog/sources.ts`
- Test: `apps/server/src/catalog/sources.test.ts`

**Step 1: Write the failing tests**

```ts
// apps/server/src/catalog/sources.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LidarrClient } from '../lidarr/client.ts';
import { SourceError, SourceManager } from './sources.ts';
import { CatalogStore } from './store.ts';
import { freshDb } from './testFixtures.ts';

const ENV = { url: 'http://lidarr:8686', apiKey: 'secret-key' };

function setup() {
  const store = new CatalogStore(freshDb());
  const lidarr = new LidarrClient();
  return { store, lidarr, manager: new SourceManager(store, lidarr, { info: () => {} }) };
}

afterEach(() => vi.restoreAllMocks());

describe('SourceManager', () => {
  it('seeds a Lidarr source from .env, once', () => {
    const { store, manager } = setup();
    manager.seedFromEnv(ENV);
    const [source] = store.listSources();
    expect(source).toMatchObject({ kind: 'lidarr', settings: ENV });
    store.removeSource(source!.id);
    manager.seedFromEnv(ENV); // a restart after the user removed it
    expect(store.listSources()).toEqual([]);
  });

  it('fills the Lidarr row Phase 1 created, keeping its id', () => {
    const { store, manager } = setup();
    const id = store.ensureSource('lidarr', 'Lidarr');
    manager.seedFromEnv(ENV);
    expect(store.listSources().map((s) => [s.id, s.settings])).toEqual([[id, ENV]]);
  });

  it('adds no source when .env has no Lidarr', () => {
    const { store, manager } = setup();
    manager.seedFromEnv({});
    expect(store.listSources()).toEqual([]);
  });

  it('points the shared Lidarr client at the enabled Lidarr source', () => {
    const { store, lidarr, manager } = setup();
    manager.seedFromEnv(ENV);
    expect(manager.active()).toHaveLength(1);
    expect(lidarr.configured).toBe(true);
    store.updateSource(store.listSources()[0]!.id, { enabled: false });
    expect(manager.active()).toEqual([]);
    expect(lidarr.configured).toBe(false);
  });

  it('never sends secrets, and hides settings from remote visitors', () => {
    const { manager } = setup();
    manager.seedFromEnv(ENV);
    const [local] = manager.list({ includeSettings: true, syncing: false });
    expect(local).toMatchObject({ settings: { url: ENV.url }, secrets: ['apiKey'] });
    expect(JSON.stringify(local)).not.toContain(ENV.apiKey);
    const [remote] = manager.list({ includeSettings: false, syncing: false });
    expect(remote!.settings).toBeUndefined();
  });

  it('keeps the saved API key when an update leaves it out', () => {
    const { store, manager } = setup();
    manager.seedFromEnv(ENV);
    const id = store.listSources()[0]!.id;
    manager.update(id, { name: 'Home Lidarr', settings: { url: 'http://nas:8686/' } });
    expect(store.source(id)).toMatchObject({
      name: 'Home Lidarr',
      settings: { url: 'http://nas:8686', apiKey: ENV.apiKey },
    });
  });

  it('unsets the Lidarr client when its source is removed', () => {
    const { store, lidarr, manager } = setup();
    manager.seedFromEnv(ENV);
    manager.active();
    manager.remove(store.listSources()[0]!.id);
    expect(lidarr.configured).toBe(false);
  });

  it('allows one Lidarr source, with a URL and a key', () => {
    const { manager } = setup();
    expect(() => manager.add({ settings: { url: ENV.url } })).toThrow(/URL and an API key/);
    manager.add({ kind: 'lidarr', settings: ENV });
    expect(() => manager.add({ kind: 'lidarr', settings: ENV })).toThrow(SourceError);
  });

  it('only accepts Lidarr sources for now', () => {
    expect(() => setup().manager.add({ kind: 'folder' })).toThrow(/Only Lidarr/);
  });

  it('rejects an order that misses a source', () => {
    const { manager } = setup();
    manager.seedFromEnv(ENV);
    expect(() => manager.reorder([])).toThrow(SourceError);
  });

  it('tests a connection with the saved key', async () => {
    const { store, manager } = setup();
    manager.seedFromEnv(ENV);
    const id = store.listSources()[0]!.id;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ version: '3.1.6' }), { status: 200 }));
    await expect(manager.test({ id, url: 'http://nas:8686' })).resolves.toEqual({ ok: true, version: '3.1.6' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://nas:8686/api/v1/system/status');
    expect((init!.headers as Record<string, string>)['X-Api-Key']).toBe(ENV.apiKey);
  });

  it('reports a failed connection test', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(setup().manager.test({ url: ENV.url, apiKey: 'wrong' })).resolves.toEqual({
      ok: false,
      error: 'Lidarr rejected the API key',
    });
  });
});
```

**Step 2: Run them to verify they fail**

Run: `corepack pnpm -C apps/server exec vitest run src/catalog/sources.test.ts`
Expected: FAIL, cannot resolve `./sources.ts`.

**Step 3: Implement**

```ts
// apps/server/src/catalog/sources.ts
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
```

**Step 4: Run the tests to verify they pass**

Run: `corepack pnpm -C apps/server exec vitest run src/catalog/sources.test.ts`
Expected: PASS (12 tests).

**Step 5: Commit**

```bash
git add apps/server/src/catalog/sources.ts apps/server/src/catalog/sources.test.ts
git commit -m "Source manager: seed from .env once, adapters, add/update/remove/reorder/test"
```

---

### Task 7: Library takes its sources from the manager, records sync errors, reloads

**Files:**
- Modify: `apps/server/src/library/library.ts`
- Test: `apps/server/src/library/library.test.ts` (create)

**Step 1: Write the failing tests**

```ts
// apps/server/src/library/library.test.ts
import { describe, expect, it, vi } from 'vitest';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb, mezzanine } from '../catalog/testFixtures.ts';
import type { CatalogSource } from '../catalog/types.ts';
import { Library } from './library.ts';

const log = { info: () => {}, error: () => {} };
const ok: CatalogSource = { kind: 'lidarr', sync: async () => mezzanine() };
const broken: CatalogSource = {
  kind: 'folder',
  sync: async () => {
    throw new Error('Drive not mounted');
  },
};

describe('Library', () => {
  it('records a failing source and keeps the others', async () => {
    const store = new CatalogStore(freshDb());
    const a = store.addSource('lidarr', 'Lidarr');
    const b = store.addSource('folder', 'Drive');
    const library = new Library(store, () => [{ id: a, source: ok }, { id: b, source: broken }], log);
    await library.refresh();
    expect((await library.albums()).map((x) => x.title)).toEqual(['Mezzanine']);
    expect(store.source(b)!.lastError).toBe('Drive not mounted');
    expect(store.source(a)!.lastError).toBeUndefined();
  });

  it('fails the refresh when every source fails', async () => {
    const store = new CatalogStore(freshDb());
    const b = store.addSource('folder', 'Drive');
    const library = new Library(store, () => [{ id: b, source: broken }], log);
    await expect(library.refresh()).rejects.toThrow('Drive not mounted');
  });

  it('reloads from the store without syncing', async () => {
    const store = new CatalogStore(freshDb());
    const a = store.addSource('lidarr', 'Lidarr');
    const sync = vi.fn(async () => mezzanine());
    const library = new Library(store, () => [{ id: a, source: { kind: 'lidarr', sync } }], log);
    await library.refresh();
    expect(library.refreshing).toBe(false);
    store.removeSource(a);
    library.reload();
    expect(await library.albums()).toEqual([]);
    expect(sync).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run them to verify they fail**

Run: `corepack pnpm -C apps/server exec vitest run src/library/library.test.ts`
Expected: FAIL (the constructor takes an array, `reload` and `refreshing` don't exist, errors aren't recorded).

**Step 3: Implement**

In `apps/server/src/library/library.ts`:

Change the `sources` constructor parameter to a function, so sources added in Settings are picked up on the next refresh:

```ts
    /** The sources to sync, read on every refresh (Settings can change them). */
    private readonly sources: () => { id: number; source: CatalogSource }[],
```

Add after `loadStored()`:

```ts
  /** True while the sources are syncing. */
  get refreshing(): boolean {
    return this.inflight !== null;
  }

  /** Rebuild from the stored catalog without syncing, e.g. after a source was removed or reordered. */
  reload() {
    this.snapshot = toSnapshot(buildCatalog(this.store.load()));
    for (const listener of this.listeners) listener(this);
  }
```

Replace the body of `build()`:

```ts
  private async build(): Promise<Snapshot> {
    const results = await Promise.allSettled(
      this.sources().map(async ({ id, source }) => {
        try {
          this.store.applySync(id, await source.sync());
          this.store.setSyncError(id, null);
        } catch (err) {
          this.store.setSyncError(id, (err as Error).message);
          throw err;
        }
      }),
    );
    const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as Error] : []));
    // One unreachable source shouldn't hide the others: its last sync stays in the catalog.
    if (failures.length && failures.length === results.length) throw failures[0];
    for (const err of failures) this.log.error(`A source failed to sync: ${err.message}`);
    return toSnapshot(buildCatalog(this.store.load()));
  }
```

**Step 4: Run the tests to verify they pass**

Run: `corepack pnpm -C apps/server exec vitest run src/library/library.test.ts`
Expected: PASS (3 tests). (`index.ts` won't typecheck until Task 9; that's expected.)

**Step 5: Commit**

```bash
git add apps/server/src/library/library.ts apps/server/src/library/library.test.ts
git commit -m "Library: sources read on each refresh, sync errors recorded, reload without syncing"
```

---

### Task 8: Settings routes

**Files:**
- Create: `apps/server/src/routes/settings.ts`
- Test: `apps/server/src/routes/settings.test.ts`

**Step 1: Write the failing tests**

```ts
// apps/server/src/routes/settings.test.ts
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { SourceManager } from '../catalog/sources.ts';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import { LidarrClient } from '../lidarr/client.ts';
import { settingsRoutes } from './settings.ts';

const HOME = '192.168.1.20';
const AWAY = '203.0.113.5';
const lidarr = { kind: 'lidarr', name: 'Lidarr', settings: { url: 'http://lidarr:8686', apiKey: 'secret-key' } };

function setup() {
  const store = new CatalogStore(freshDb());
  const sources = new SourceManager(store, new LidarrClient(), { info: () => {} });
  const library = { refresh: vi.fn(async () => {}), reload: vi.fn(), refreshing: false };
  const app = Fastify();
  settingsRoutes(app, { sources, library });
  return { app, store, library };
}

describe('settings routes', () => {
  it('adds a source from the home network and starts a sync', async () => {
    const { app, library } = setup();
    const res = await app.inject({ method: 'POST', url: '/api/settings/sources', payload: lidarr, remoteAddress: HOME });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: 'lidarr', secrets: ['apiKey'], settings: { url: 'http://lidarr:8686' } });
    expect(res.body).not.toContain('secret-key');
    expect(library.refresh).toHaveBeenCalled();
  });

  it('refuses changes from outside the home network', async () => {
    const { app, store } = setup();
    const res = await app.inject({ method: 'POST', url: '/api/settings/sources', payload: lidarr, remoteAddress: AWAY });
    expect(res.statusCode).toBe(403);
    expect(store.listSources()).toEqual([]);
  });

  it('shows sources read-only, without settings, to remote visitors', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/api/settings/sources', payload: lidarr, remoteAddress: HOME });
    const res = await app.inject({ method: 'GET', url: '/api/settings/sources', remoteAddress: AWAY });
    expect(res.json()).toMatchObject({ canEdit: false, sources: [{ name: 'Lidarr' }] });
    expect(res.json().sources[0].settings).toBeUndefined();
  });

  it('validates input', async () => {
    const res = await setup().app.inject({
      method: 'POST',
      url: '/api/settings/sources',
      payload: { settings: { url: 'not a url' } },
      remoteAddress: HOME,
    });
    expect(res.statusCode).toBe(400);
  });

  it('removes a source and rebuilds without syncing', async () => {
    const { app, store, library } = setup();
    const { id } = (
      await app.inject({ method: 'POST', url: '/api/settings/sources', payload: lidarr, remoteAddress: HOME })
    ).json();
    library.refresh.mockClear();
    const res = await app.inject({ method: 'DELETE', url: `/api/settings/sources/${id}`, remoteAddress: HOME });
    expect(res.statusCode).toBe(204);
    expect(store.listSources()).toEqual([]);
    expect(library.reload).toHaveBeenCalled();
    expect(library.refresh).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown source', async () => {
    const res = await setup().app.inject({
      method: 'PATCH',
      url: '/api/settings/sources/99',
      payload: { name: 'x' },
      remoteAddress: HOME,
    });
    expect(res.statusCode).toBe(404);
  });
});
```

**Step 2: Run them to verify they fail**

Run: `corepack pnpm -C apps/server exec vitest run src/routes/settings.test.ts`
Expected: FAIL, cannot resolve `./settings.ts`.

**Step 3: Implement**

```ts
// apps/server/src/routes/settings.ts
import type { SourcesResponse } from '@playarr/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SourceError, type SourceManager } from '../catalog/sources.ts';
import type { Library } from '../library/library.ts';
import { isLocalAddress } from '../net.ts';

const sourceInput = z.object({
  kind: z.enum(['lidarr', 'folder']).optional(),
  name: z.string().trim().max(80).optional(),
  enabled: z.boolean().optional(),
  settings: z
    .object({ url: z.url().optional(), apiKey: z.string().trim().max(200).optional() })
    .optional(),
});
const testInput = z.object({
  id: z.number().int().optional(),
  url: z.url().optional(),
  apiKey: z.string().trim().max(200).optional(),
});
const orderInput = z.object({ ids: z.array(z.number().int()) });

type LibraryControl = Pick<Library, 'refresh' | 'reload' | 'refreshing'>;
type Id = { Params: { id: string } };

const isLocal = (req: FastifyRequest) => isLocalAddress(req.socket.remoteAddress);

/** Until Playarr has a login, settings can only be changed from the local network. */
async function requireLocal(req: FastifyRequest, reply: FastifyReply) {
  if (!isLocal(req)) return reply.code(403).send({ error: 'Settings can only be changed from your home network' });
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new SourceError(result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 400);
  }
  return result.data;
}

async function handle(reply: FastifyReply, fn: () => unknown) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SourceError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

export function settingsRoutes(app: FastifyInstance, deps: { sources: SourceManager; library: LibraryControl }) {
  const { sources, library } = deps;
  // Sync errors are shown per source in the panel, so a failed background sync needs no handling here.
  const syncInBackground = () => void library.refresh().catch(() => {});
  const editable = { onRequest: requireLocal };

  app.get('/api/settings/sources', (req): SourcesResponse => {
    const canEdit = isLocal(req);
    return { sources: sources.list({ includeSettings: canEdit, syncing: library.refreshing }), canEdit };
  });

  app.post('/api/settings/sources', editable, (req, reply) =>
    handle(reply, () => {
      const info = sources.add(parse(sourceInput, req.body));
      syncInBackground();
      return reply.code(201).send(info);
    }),
  );

  app.patch<Id>('/api/settings/sources/:id', editable, (req, reply) =>
    handle(reply, () => {
      const info = sources.update(Number(req.params.id), parse(sourceInput, req.body));
      syncInBackground();
      return info;
    }),
  );

  app.delete<Id>('/api/settings/sources/:id', editable, (req, reply) =>
    handle(reply, () => {
      sources.remove(Number(req.params.id));
      library.reload();
      return reply.code(204).send();
    }),
  );

  app.put('/api/settings/sources/order', editable, (req, reply) =>
    handle(reply, (): SourcesResponse => {
      sources.reorder(parse(orderInput, req.body).ids);
      library.reload();
      return { sources: sources.list({ includeSettings: true, syncing: library.refreshing }), canEdit: true };
    }),
  );

  app.post('/api/settings/sources/test', editable, (req, reply) =>
    handle(reply, () => sources.test(parse(testInput, req.body))),
  );

  app.post<Id>('/api/settings/sources/:id/rescan', editable, (_req, reply) =>
    handle(reply, () => {
      syncInBackground();
      return reply.code(202).send({});
    }),
  );
}
```

**Step 4: Run the tests to verify they pass**

Run: `corepack pnpm -C apps/server exec vitest run src/routes/settings.test.ts`
Expected: PASS (6 tests).

**Step 5: Commit**

```bash
git add apps/server/src/routes/settings.ts apps/server/src/routes/settings.test.ts
git commit -m "Settings API: sources, with changes only from the local network"
```

---

### Task 9: Wire it up; Lidarr optional in config, health and requests

**Files:**
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/routes/api.ts`
- Modify: `apps/server/src/discover/requests.ts`

**Step 1: `config.ts`: Lidarr settings become optional (used once, to seed the Lidarr source)**

```ts
  // Optional: copied into Settings → Sources on first start, then managed there.
  LIDARR_URL: z
    .url()
    .transform((u) => u.replace(/\/+$/, ''))
    .optional(),
  LIDARR_API_KEY: z.string().optional(),
```

**Step 2: `index.ts`**

Add imports:

```ts
import { SourceManager } from './catalog/sources.ts';
import { settingsRoutes } from './routes/settings.ts';
```

Replace the block from `const lidarr = …` through the `new Library(...)` call with:

```ts
// One Lidarr client for the whole server; the Lidarr source in Settings points it at a Lidarr (or not).
const lidarr = new LidarrClient();
const db = openDatabase(resolve(config.DATA_DIR));
const store = new CatalogStore(db);
const sources = new SourceManager(store, lidarr, { info: (m) => app.log.info(m) });
sources.seedFromEnv({ url: config.LIDARR_URL, apiKey: config.LIDARR_API_KEY });
sources.active(); // configure the Lidarr client before anything uses it
const library = new Library(store, () => sources.active(), {
  info: (m) => app.log.info(m),
  error: (m) => app.log.error(m),
});
```

Register the routes next to the others:

```ts
settingsRoutes(app, { sources, library });
```

Replace the startup log line `app.log.info(\`Lidarr: ${config.LIDARR_URL} · media source: ${media.kind}\`);` with:

```ts
app.log.info(`Sources: ${store.listSources().map((s) => s.name).join(', ') || 'none'} · media source: ${media.kind}`);
```

Then check nothing else reads the removed values:

Run: `grep -rn "LIDARR_URL\|LIDARR_API_KEY\|ensureSource" apps/server/src --include='*.ts' | grep -v test`
Expected: only `config.ts`, `index.ts` (the `seedFromEnv` call) and `catalog/store.ts` (the `ensureSource` definition).

**Step 3: `routes/api.ts`: health without a Lidarr source**

Replace the first element of the `Promise.allSettled` array with:

```ts
      lidarr.configured ? lidarr.systemStatus() : Promise.resolve(undefined),
```

and the `lidarr:` property of the returned object with:

```ts
      lidarr: !lidarr.configured
        ? undefined
        : lidarrOk
          ? { ok: true, version: lidarrResult.value?.version }
          : { ok: false, error: (lidarrResult.reason as Error).message },
```

(`ok: lidarrOk && mediaOk` stays: with no Lidarr, `lidarrOk` is true.)

**Step 4: `discover/requests.ts`: a clear error when there's no Lidarr**

In `request()`, right after `await this.loaded;`:

```ts
    if (!this.lidarr.configured) {
      throw new RequestError('Requests need a Lidarr source. Add one in Settings → Sources.', 409);
    }
```

**Step 5: Typecheck, test, build**

Run: `corepack pnpm -C apps/server typecheck && corepack pnpm -C apps/server test && corepack pnpm -C apps/server build`
Expected: typecheck clean; all server tests pass; build succeeds.

**Step 6: Smoke-check the server starts without a `.env`**

```bash
cd /tmp && rm -rf playarr-p2 && mkdir playarr-p2 && cd playarr-p2
DATA_DIR=$PWD/data CACHE_DIR=$PWD/cache PORT=4099 node --disable-warning=ExperimentalWarning /Users/bortignon/dev/playarr/apps/server/dist/index.js &
sleep 3
curl -s localhost:4099/api/health
curl -s localhost:4099/api/settings/sources
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:4099/api/requests -H 'Content-Type: application/json' -d '{"mbid":"00000000-0000-0000-0000-000000000000"}'
kill %1
```

Expected: health has no `lidarr` field; sources is `{"sources":[],"canEdit":true}`; the request answers `409`.

**Step 7: Commit**

```bash
git add apps/server/src/config.ts apps/server/src/index.ts apps/server/src/routes/api.ts apps/server/src/discover/requests.ts
git commit -m "Server: sources managed in Settings, Lidarr optional"
```

---

### Task 10: Web: API client and queries

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/queries.ts`

**Step 1: `api.ts`**

Add `SourceInfo`, `SourceInput`, `SourcesResponse`, `SourceTestResult` to the `@playarr/shared` type import, and add to the `api` object:

```ts
  sources: () => get<SourcesResponse>('/api/settings/sources'),
  addSource: (input: SourceInput) =>
    request<SourceInfo>('/api/settings/sources', { method: 'POST', body: JSON.stringify(input) }),
  updateSource: (id: number, input: SourceInput) =>
    request<SourceInfo>(`/api/settings/sources/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  removeSource: (id: number) => request<void>(`/api/settings/sources/${id}`, { method: 'DELETE' }),
  reorderSources: (ids: number[]) =>
    request<SourcesResponse>('/api/settings/sources/order', { method: 'PUT', body: JSON.stringify({ ids }) }),
  testSource: (body: { id?: number; url?: string; apiKey?: string }) =>
    request<SourceTestResult>('/api/settings/sources/test', { method: 'POST', body: JSON.stringify(body) }),
  rescanSource: (id: number) => request<void>(`/api/settings/sources/${id}/rescan`, { method: 'POST' }),
```

**Step 2: `queries.ts`**

Add `SourceInput` to the `@playarr/shared` type import, and append:

```ts
/** Sources for Settings. Polls while they sync, and refreshes everything once a sync finishes. */
export function useSources() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['sources'],
    queryFn: api.sources,
    refetchInterval: (q) => (q.state.data?.sources.some((s) => s.syncing) ? 2000 : 30_000),
  });
  const syncing = !!query.data?.sources.some((s) => s.syncing);
  const wasSyncing = useRef(false);
  useEffect(() => {
    if (wasSyncing.current && !syncing) void client.invalidateQueries();
    wasSyncing.current = syncing;
  }, [syncing, client]);
  return query;
}

/** False once we know there's no Lidarr source: requests and Discover are hidden then. */
export function useHasLidarr() {
  const { data } = useHealth();
  return data === undefined || data.lidarr !== undefined;
}

export function useSourceActions() {
  const client = useQueryClient();
  const changed = () => {
    void client.invalidateQueries({ queryKey: ['sources'] });
    void client.invalidateQueries({ queryKey: ['health'] });
  };
  const fail = (err: Error) => toast(err.message);
  return {
    add: useMutation({ mutationFn: api.addSource, onSuccess: changed, onError: fail }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: number; input: SourceInput }) => api.updateSource(id, input),
      onSuccess: changed,
      onError: fail,
    }),
    remove: useMutation({
      mutationFn: api.removeSource,
      onSuccess: () => void client.invalidateQueries(), // its songs leave every list
      onError: fail,
    }),
    reorder: useMutation({
      mutationFn: api.reorderSources,
      onSuccess: (data) => client.setQueryData(['sources'], data),
      onError: (err: Error) => {
        fail(err);
        changed();
      },
    }),
    rescan: useMutation({ mutationFn: api.rescanSource, onSuccess: changed, onError: fail }),
  };
}
```

(`useRef`, `useEffect`, `useMutation`, `useQueryClient` and `toast` are already imported in this file.)

**Step 3: Typecheck**

Run: `corepack pnpm -C apps/web exec tsc --noEmit`
Expected: only the Nav errors from Task 1 remain.

**Step 4: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/queries.ts
git commit -m "Web: sources API and queries"
```

---

### Task 11: Web: Settings page and Sources panel

**Files:**
- Create: `apps/web/src/pages/Settings.tsx`
- Create: `apps/web/src/components/SourcesPanel.tsx`
- Modify: `apps/web/src/routes.tsx`
- Modify: `apps/web/src/components/Nav.tsx`
- Modify: `apps/web/src/pages/Library.tsx`

**Step 1: `pages/Settings.tsx`**

```tsx
import { Link, useParams } from 'react-router';
import { SourcesPanel } from '../components/SourcesPanel';
import { cn } from '../lib/cn';
import { PageTitle } from './Albums';

const PANELS = [
  { id: 'sources', label: 'Sources', ready: true },
  { id: 'playback', label: 'Playback', ready: false },
  { id: 'requests', label: 'Requests', ready: false },
  { id: 'appearance', label: 'Appearance', ready: false },
] as const;

export function SettingsPage() {
  const { panel } = useParams();
  const current = PANELS.find((p) => p.id === panel && p.ready) ?? PANELS[0];
  return (
    <div className="max-w-4xl px-5 pt-8 md:px-10 md:pt-14">
      <PageTitle title="Settings" />
      <nav aria-label="Settings" className="scrollbar-none mb-10 flex gap-6 overflow-x-auto border-b border-line">
        {PANELS.map((p) =>
          p.ready ? (
            <Link
              key={p.id}
              to={`/settings/${p.id}`}
              aria-current={p.id === current.id ? 'page' : undefined}
              className={cn(
                '-mb-px border-b-2 pb-3 text-[15px] whitespace-nowrap transition-colors',
                p.id === current.id ? 'border-accent text-paper' : 'border-transparent text-paper-dim/70 hover:text-paper',
              )}
            >
              {p.label}
            </Link>
          ) : (
            <span key={p.id} title="Coming later" className="-mb-px border-b-2 border-transparent pb-3 text-[15px] whitespace-nowrap text-muted/50">
              {p.label}
            </span>
          ),
        )}
      </nav>
      {current.id === 'sources' && <SourcesPanel />}
    </div>
  );
}
```

**Step 2: `components/SourcesPanel.tsx`**

```tsx
import type { SourceInfo, SourceTestResult } from '@playarr/shared';
import { Check, FolderOpen, GripVertical, Loader2, Pencil, Plus, RefreshCw, Server, Trash2, TriangleAlert } from 'lucide-react';
import { Reorder, useDragControls } from 'motion/react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { plural } from '../lib/format';
import { useSourceActions, useSources } from '../lib/queries';
import { Dialog } from './Dialog';

const INPUT =
  'h-11 w-full rounded-lg border border-line bg-ink-900 px-3 text-[15px] text-paper outline-none transition focus:border-accent';
const PRIMARY =
  'inline-flex h-10 items-center justify-center rounded-full bg-accent px-5 text-[14px] font-medium text-accent-ink transition disabled:opacity-50';
const SECONDARY =
  'inline-flex h-10 items-center justify-center gap-2 rounded-full border border-line px-5 text-[14px] text-paper transition hover:bg-paper/5 disabled:opacity-50';

/** Settings → Sources: where the library comes from, in priority order. */
export function SourcesPanel() {
  const { data, error } = useSources();
  const actions = useSourceActions();
  const [order, setOrder] = useState<SourceInfo[]>([]);
  const [editing, setEditing] = useState<SourceInfo | 'new' | null>(null);

  useEffect(() => {
    if (data) setOrder(data.sources);
  }, [data]);

  if (error) return <p className="text-sm text-red-300/80">{(error as Error).message}</p>;
  if (!data) return <div className="h-24 animate-pulse rounded-lg bg-paper/5" />;

  const { canEdit } = data;
  const commitOrder = () => {
    const ids = order.map((s) => s.id);
    if (ids.join() !== data.sources.map((s) => s.id).join()) actions.reorder.mutate(ids);
  };

  return (
    <section>
      <p className="mb-6 max-w-prose text-sm text-muted">
        Where your music comes from. When a song is in more than one place, Playarr plays the best-quality copy; between equal
        copies, the source higher in this list wins.
      </p>
      {!canEdit && (
        <p className="mb-6 rounded-lg border border-line px-4 py-3 text-sm text-paper-dim">
          You’re using Playarr from outside your home network, so settings are read-only.
        </p>
      )}
      {data.sources.length === 0 && (
        <p className="mb-6 text-[15px] text-paper-dim">No sources yet. Add Lidarr to start your library.</p>
      )}

      <Reorder.Group axis="y" values={order} onReorder={setOrder} as="ol" className="-mx-2">
        {order.map((s) => (
          <SourceRow key={s.id} source={s} canEdit={canEdit} onDragEnd={commitOrder} onEdit={() => setEditing(s)} />
        ))}
      </Reorder.Group>

      {canEdit && (
        <button type="button" onClick={() => setEditing('new')} className={cn(SECONDARY, 'mt-6')}>
          <Plus className="size-4" /> Add source
        </button>
      )}

      <SourceDialog
        target={editing}
        hasLidarr={data.sources.some((s) => s.kind === 'lidarr')}
        onClose={() => setEditing(null)}
      />
    </section>
  );
}

function SourceRow({
  source: s,
  canEdit,
  onDragEnd,
  onEdit,
}: {
  source: SourceInfo;
  canEdit: boolean;
  onDragEnd: () => void;
  onEdit: () => void;
}) {
  const controls = useDragControls();
  const actions = useSourceActions();
  const remove = () => {
    if (window.confirm(`Remove “${s.name}”? Its songs leave your library; favorites and playlists keep them, greyed out.`)) {
      actions.remove.mutate(s.id);
    }
  };
  const details = [s.settings?.url, `${plural(s.songs, 'song')} · ${plural(s.albums, 'album')}`].filter(Boolean).join(' · ');

  return (
    <Reorder.Item
      value={s}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDragEnd}
      as="li"
      className="flex items-center gap-3 rounded-lg bg-ink-900 px-2 py-3"
    >
      {canEdit && (
        <span
          role="button"
          aria-label={`Drag to reorder ${s.name}`}
          onPointerDown={(e) => controls.start(e)}
          className="grid h-9 cursor-grab touch-none place-items-center text-muted active:cursor-grabbing"
        >
          <GripVertical className="size-4" />
        </span>
      )}
      <span className="grid size-11 shrink-0 place-items-center rounded-md bg-ink-800 text-accent">
        <Server className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[17px] text-paper">{s.name}</span>
          {!s.enabled && <span className="font-mono text-[10px] tracking-wider text-muted uppercase">Off</span>}
        </div>
        <div className="truncate font-mono text-[12px] text-muted">{details}</div>
        <SourceStatus source={s} />
      </div>
      {canEdit && (
        <div className="flex items-center gap-1">
          <IconButton label="Rescan" onClick={() => actions.rescan.mutate(s.id)} disabled={s.syncing}>
            {s.syncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </IconButton>
          <IconButton label="Edit" onClick={onEdit}>
            <Pencil className="size-4" />
          </IconButton>
          <IconButton label="Remove" onClick={remove}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      )}
    </Reorder.Item>
  );
}

function SourceStatus({ source: s }: { source: SourceInfo }) {
  const [text, tone] = s.syncing
    ? ['Syncing…', 'text-accent']
    : s.error
      ? [s.error, 'text-red-300/80']
      : !s.enabled
        ? ['Turned off', 'text-muted']
        : s.lastSyncAt
          ? [`Synced ${new Date(s.lastSyncAt).toLocaleString()}`, 'text-muted']
          : ['Not synced yet', 'text-muted'];
  return (
    <div className={cn('mt-0.5 truncate text-[12px]', tone)} title={text}>
      {text}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-paper/8 hover:text-paper disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function SourceDialog({
  target,
  hasLidarr,
  onClose,
}: {
  target: SourceInfo | 'new' | null;
  hasLidarr: boolean;
  onClose: () => void;
}) {
  const editing = target && target !== 'new' ? target : undefined;
  const [kind, setKind] = useState<'lidarr' | null>(null);
  useEffect(() => setKind(null), [target]);

  return (
    <Dialog open={target !== null} onClose={onClose} title={editing ? `Edit ${editing.name}` : 'Add source'}>
      {editing || kind === 'lidarr' ? (
        <LidarrForm key={editing?.id ?? 'new'} source={editing} onDone={onClose} />
      ) : (
        <div className="space-y-2 p-5">
          <KindOption
            icon={<Server className="size-5" />}
            title="Lidarr"
            detail={hasLidarr ? 'Playarr connects to one Lidarr, and it’s already added.' : 'Your Lidarr library, with requests.'}
            disabled={hasLidarr}
            onClick={() => setKind('lidarr')}
          />
          <KindOption
            icon={<FolderOpen className="size-5" />}
            title="Folder"
            detail="Music in a folder on this server. Coming in a later update."
            disabled
          />
        </div>
      )}
    </Dialog>
  );
}

function KindOption({
  icon,
  title,
  detail,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-4 rounded-lg px-3 py-3 text-left transition hover:bg-paper/[0.04] disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-md bg-ink-800 text-accent">{icon}</span>
      <span>
        <span className="block text-[16px] text-paper">{title}</span>
        <span className="block text-[13px] text-muted">{detail}</span>
      </span>
    </button>
  );
}

function LidarrForm({ source, onDone }: { source?: SourceInfo; onDone: () => void }) {
  const actions = useSourceActions();
  const keySaved = !!source?.secrets.includes('apiKey');
  const [name, setName] = useState(source?.name ?? 'Lidarr');
  const [url, setUrl] = useState(source?.settings?.url ?? '');
  const [apiKey, setApiKey] = useState('');
  const [replacingKey, setReplacingKey] = useState(!keySaved);
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [test, setTest] = useState<SourceTestResult | 'running' | null>(null);
  const settings = { url, ...(replacingKey && apiKey ? { apiKey } : {}) };
  const pending = actions.add.isPending || actions.update.isPending;

  const runTest = async () => {
    setTest('running');
    try {
      setTest(await api.testSource({ id: source?.id, ...settings }));
    } catch (err) {
      setTest({ ok: false, error: (err as Error).message });
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const input = { name, enabled, settings };
    if (source) actions.update.mutate({ id: source.id, input }, { onSuccess: onDone });
    else actions.add.mutate({ kind: 'lidarr', ...input }, { onSuccess: onDone });
  };

  return (
    <form onSubmit={save} className="space-y-4 p-5">
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} required maxLength={80} />
      </Field>
      <Field label="URL">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://192.168.1.10:8686"
          className={INPUT}
          required
        />
      </Field>
      <Field label="API key" hint="In Lidarr: Settings → General → Security">
        {replacingKey ? (
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className={cn(INPUT, 'font-mono')}
            autoComplete="off"
            spellCheck={false}
            required={!keySaved}
            placeholder={keySaved ? 'New API key' : undefined}
          />
        ) : (
          <div className="flex h-11 items-center gap-3">
            <span className="font-mono text-[13px] text-paper-dim">Saved</span>
            <button type="button" onClick={() => setReplacingKey(true)} className="text-[13px] text-accent hover:underline">
              Replace
            </button>
          </div>
        )}
      </Field>
      {source && (
        <label className="flex items-center gap-2 text-sm text-paper-dim">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Use this source
        </label>
      )}
      {test === 'running' && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> Connecting…
        </p>
      )}
      {test && test !== 'running' && (
        <p className={cn('flex items-center gap-2 text-sm', test.ok ? 'text-emerald-300' : 'text-red-300/80')}>
          {test.ok ? <Check className="size-4" /> : <TriangleAlert className="size-4" />}
          {test.ok ? `Connected to Lidarr ${test.version ?? ''}` : test.error}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={runTest} disabled={test === 'running' || !url} className={SECONDARY}>
          Test
        </button>
        <button type="submit" disabled={pending} className={PRIMARY}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-mono text-[11px] tracking-[0.2em] text-muted uppercase">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-muted">{hint}</span>}
    </label>
  );
}
```

**Step 3: `routes.tsx`**

Import `SettingsPage` from `./pages/Settings` and add before the `'*'` route:

```tsx
      { path: 'settings/:panel?', element: <SettingsPage /> },
```

**Step 4: `components/Nav.tsx`**

Add `Settings` to the lucide-react import. In `Sidebar`, make the Settings link the first child of the `mt-auto space-y-3 px-3` div (above the stats):

```tsx
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cn(
              '-mx-3 flex h-9 items-center gap-3 rounded-md px-3 text-[14px] transition-colors',
              isActive ? 'bg-paper/[0.06] text-paper' : 'text-paper-dim/70 hover:text-paper',
            )
          }
        >
          <Settings className="size-[17px]" strokeWidth={1.75} />
          Settings
        </NavLink>
```

In `ConnectionStatus`, only show the Lidarr row when there is a Lidarr source (this also fixes the Task 1 type errors):

```tsx
  const items = [
    ...(data?.lidarr
      ? [
          {
            label: 'Lidarr',
            ok: !isError && data.lidarr.ok,
            detail: data.lidarr.ok ? `v${data.lidarr.version}` : data.lidarr.error,
          },
        ]
      : []),
    { label: 'Streaming', ok: !isError && data?.media.ok, detail: data?.media.ok ? data.media.source : data?.media.error },
  ];
```

**Step 5: `pages/Library.tsx`: a gear on phones (the sidebar has its own on desktop)**

Add `Settings` to the lucide-react import and replace `<PageTitle title="Library" />` with:

```tsx
      <PageTitle title="Library">
        <Link
          to="/settings"
          aria-label="Settings"
          className="grid size-10 place-items-center rounded-full text-muted transition hover:bg-paper/8 hover:text-paper md:hidden"
        >
          <Settings className="size-5" />
        </Link>
      </PageTitle>
```

**Step 6: Typecheck and build**

Run: `corepack pnpm -C apps/web exec tsc --noEmit && corepack pnpm -C apps/web exec vite build`
Expected: typecheck clean; build succeeds.

**Step 7: Commit**

```bash
git add apps/web/src/pages/Settings.tsx apps/web/src/components/SourcesPanel.tsx apps/web/src/routes.tsx apps/web/src/components/Nav.tsx apps/web/src/pages/Library.tsx
git commit -m "Web: Settings page with the Sources panel"
```

---

### Task 12: Web: no Lidarr, no requests; wording; smoke case

**Files:**
- Modify: `apps/web/src/components/Discover.tsx`
- Modify: `apps/web/src/pages/Search.tsx`
- Modify: `apps/web/src/pages/Home.tsx`
- Modify: `apps/web/src/smoke.test.tsx`

**Step 1: `RequestButton` hides itself without Lidarr**

In `components/Discover.tsx`, import `useHasLidarr` from `../lib/queries` (alongside `useRequestAlbum`). In `RequestButton`, after the existing hook calls (`useRequestAlbum`, `useNavigate`) and before any `return`, add:

```tsx
  const hasLidarr = useHasLidarr();
```

and right after `const { state, progress, message, albumId } = availability;`:

```tsx
  // Without Lidarr nothing can be requested; "In library" still links to the album.
  if (!hasLidarr && state !== 'available') return null;
```

(This one change covers Search, the Discover artist page and "Songs like these".)

**Step 2: `pages/Search.tsx`: no "Not in your library" section without Lidarr**

Import `useHasLidarr` from `../lib/queries`, call `const hasLidarr = useHasLidarr();` at the top of `SearchPage`, and change:

```tsx
      {deferred && <DiscoverSection q={deferred} />}
```

to:

```tsx
      {deferred && hasLidarr && <DiscoverSection q={deferred} />}
```

**Step 3: `pages/Home.tsx`: the library isn't only Lidarr's any more**

- `waiting in your Lidarr library.` → `waiting in your library.`
- `kicker="Fresh from Lidarr"` → `kicker="Just added"`

**Step 4: Smoke case for Settings**

In `apps/web/src/smoke.test.tsx`, add to the `it.each` list:

```tsx
    ['/settings', /Where your music comes from/],
```

**Step 5: Typecheck and build**

Run: `corepack pnpm -C apps/web exec tsc --noEmit && corepack pnpm -C apps/web exec vite build`
Expected: clean; build succeeds.

**Step 6: Commit**

```bash
git add apps/web/src/components/Discover.tsx apps/web/src/pages/Search.tsx apps/web/src/pages/Home.tsx apps/web/src/smoke.test.tsx
git commit -m "Web: hide requests and Discover without Lidarr; smoke case for Settings"
```

---

### Task 13: Docs

**Files:**
- Modify: `PLAN.md`
- Modify: `README.md`
- Modify: `.env.example`

**Step 1: PLAN.md decisions log (§12)**

```
| 2026-10-30 | Settings → Sources (phase 2): sources live in the database. `.env`'s `LIDARR_URL`/`LIDARR_API_KEY` seed the Lidarr source once, then Settings owns them (a removed source isn't recreated). Lidarr is optional: without it, requests and Discover are hidden and `/api/requests` answers 409. One Lidarr at most (the server shares one client). Settings changes are only accepted from loopback/private addresses, judged by the socket address, until there's a login; check on the NAS that internet visitors don't appear private (Docker's userland proxy can rewrite source addresses). |
```

**Step 2: README.md**

In "Running it", change the `.env` sentence to:

```
Copy `.env.example` to `.env`. `LIDARR_URL` and `LIDARR_API_KEY` are optional: on first start they become the Lidarr source in **Settings → Sources**, where it's managed from then on. Set `MEDIA_SOURCE` (plus `PATH_MAP` if Playarr sees the music at a different path than Lidarr).
```

**Step 3: `.env.example`**

Above `LIDARR_URL=`, add:

```
# Optional. Copied into Settings → Sources on first start, then managed there.
```

**Step 4: Commit**

```bash
git add PLAN.md README.md .env.example
git commit -m "Docs: sources managed in Settings, Lidarr optional"
```

---

## Not verified by this plan (needs the user's environment)

- The panel against a real Lidarr: add, edit (key kept), test, rescan, remove, reorder.
- Web smoke tests (need a running server with data).
- On the NAS, from mobile data: `GET /api/settings/sources` should return `canEdit: false`. If it returns `true`, Docker is rewriting the client address and the guard is ineffective there.
