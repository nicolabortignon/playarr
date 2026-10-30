# Sources, Phase 1: Catalog Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move the library from "rebuilt straight from Lidarr" to "one catalog in SQLite fed by source adapters", with Lidarr as the first adapter and no visible change for the user.

**Architecture:** A `CatalogSource` adapter reports artists, albums, tracks and file copies, each with a merge key. `CatalogStore` writes them to new SQLite tables and assigns permanent Playarr ids. `buildCatalog` turns the stored rows into the same `Artist` / `AlbumDetail` / `Track` objects the API returns today, picking the best copy per track. `Library` keeps its public methods and is now built from the store.

**Tech Stack:** Node 25, TypeScript 7, Fastify 5, `node:sqlite`, vitest 5. pnpm via `corepack pnpm` (pnpm is not on PATH in Claude's shell).

**Design:** `docs/plans/2026-10-30-sources-design.md`. This plan covers rollout phase 1 only. Phases 2 to 6 each get their own plan once the previous one has landed, because each depends on what the previous one changed.

---

## Key decision in this plan: seed Playarr ids from Lidarr ids

The design called for a map from old Lidarr ids to new Playarr ids. This plan avoids that: when a row is first created, it takes the Lidarr id as its Playarr id if that id is free (artists, albums and tracks from Lidarr's ids; copies from Lidarr's track-file ids). On an existing install every id therefore stays exactly the same, so `/albums/123` links, saved queues (`fileId`, `albumId`) and the offline song cache (keyed by `fileId`) keep working with no migration code. Rows are never deleted from the catalog tables (only copies are), and all tables use `AUTOINCREMENT`, so an id is never reused for something else. Task 8 updates the design doc to match.

Lidarr's numeric id also stays in artwork URLs (`/art/album/<lidarrId>/cover`), which are built by the Lidarr adapter and fetched from Lidarr. That is correct: they identify Lidarr's image, not the Playarr album.

## Conventions

- Run everything from the repo root `/Users/bortignon/dev/playarr`.
- Server tests: `corepack pnpm -C apps/server test` (vitest picks up `src/**/*.test.ts`). One file: `corepack pnpm -C apps/server exec vitest run src/catalog/store.test.ts`.
- Typecheck: `corepack pnpm -C apps/server typecheck`. Do not use `pnpm typecheck` at the root: it shells out to `pnpm`, which isn't on PATH. (`packages/shared` typecheck is already broken: no TypeScript dependency there. Not in scope.)
- Imports use explicit `.ts` extensions (`allowImportingTsExtensions`).
- Commit after every task, directly on `main`, only the files of that task (user's standing request).

---

### Task 0: Capture a baseline of the API before changing anything

The strongest check for "no visible change" is comparing real API output before and after.

**Prerequisite:** a root `.env` with `LIDARR_URL`, `LIDARR_API_KEY` and a working `MEDIA_SOURCE` (see `.env.example`). This checkout currently has none. If it's still missing, ask the user to restore it; do not invent values. If Lidarr can't be reached from Claude's sandbox (PLAN.md notes the sandbox blocks some hosts), ask the user to run the server, or run it with the sandbox disabled if they approve.

**Step 1: Start the server**

```bash
corepack pnpm -C apps/server dev
```

Run it in the background. Wait for the log line `Library refreshed: … artists, … albums, … tracks`.

**Step 2: Save the baseline**

```bash
mkdir -p /tmp/playarr-baseline && cd /tmp/playarr-baseline
api=http://localhost:4000/api
sorted='if type=="array" then sort_by(.id) else . end'
curl -s $api/artists | jq -S "$sorted" > artists.json
curl -s $api/albums | jq -S "$sorted" > albums.json
curl -s $api/favorites | jq -S . > favorites.json
curl -s $api/playlists | jq -S "$sorted" > playlists.json
curl -s $api/albums | jq -r '.[].id' | while read id; do curl -s $api/albums/$id; done | jq -S -s 'sort_by(.id)' > album-details.json
curl -s $api/artists | jq -r '.[].id' | while read id; do curl -s $api/artists/$id; done | jq -S -s 'sort_by(.id)' > artist-details.json
wc -c *.json
```

Expected: six non-empty files. Stop the server.

No commit (nothing in the repo changed).

---

### Task 1: Catalog tables in the database

**Files:**
- Modify: `apps/server/src/db.ts`
- Test: `apps/server/src/db.test.ts` (create)

**Step 1: Write the failing test**

```ts
// apps/server/src/db.test.ts
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from './db.ts';

describe('migrate', () => {
  it('creates the catalog tables', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (t) => t.name,
    );
    expect(tables).toEqual(
      expect.arrayContaining(['sources', 'catalog_artists', 'catalog_albums', 'catalog_tracks', 'copies']),
    );
  });

  it('is idempotent', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });
});
```

**Step 2: Run it to verify it fails**

Run: `corepack pnpm -C apps/server exec vitest run src/db.test.ts`
Expected: FAIL, `migrate` is not exported.

**Step 3: Implement**

In `apps/server/src/db.ts`, append this entry to the end of the `MIGRATIONS` array (after the `cover_snapshot` one):

```ts
  // Catalog sources (Lidarr, folders) and the merged catalog they feed. Catalog rows are never
  // deleted, and AUTOINCREMENT never hands out an id twice, so ids in links, queues and the
  // offline song cache always mean the same thing. Metadata lives in JSON `meta` columns.
  `CREATE TABLE sources (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     kind         TEXT NOT NULL,
     name         TEXT NOT NULL,
     position     INTEGER NOT NULL,
     enabled      INTEGER NOT NULL DEFAULT 1,
     settings     TEXT NOT NULL DEFAULT '{}',
     state        TEXT,
     last_sync_at TEXT,
     created_at   TEXT NOT NULL
   );
   CREATE TABLE catalog_artists (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     key        TEXT NOT NULL UNIQUE,
     meta       TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE catalog_albums (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     key        TEXT NOT NULL UNIQUE,
     artist_id  INTEGER NOT NULL REFERENCES catalog_artists (id),
     meta       TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE catalog_tracks (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     key          TEXT NOT NULL UNIQUE,
     album_id     INTEGER NOT NULL REFERENCES catalog_albums (id),
     recording_id TEXT NOT NULL,
     meta         TEXT NOT NULL,
     updated_at   TEXT NOT NULL
   );
   CREATE TABLE copies (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     source_id  INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
     source_ref TEXT NOT NULL,
     track_id   INTEGER NOT NULL REFERENCES catalog_tracks (id),
     path       TEXT NOT NULL,
     size       INTEGER NOT NULL,
     format     TEXT NOT NULL,
     added_at   TEXT,
     updated_at TEXT NOT NULL,
     UNIQUE (source_id, source_ref)
   );
   CREATE INDEX copies_by_track ON copies (track_id);`,
```

Then split the migration loop out of `openDatabase` so tests can run it on an in-memory database:

```ts
export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'playarr.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** Run the migrations this database hasn't had yet. */
export function migrate(db: DatabaseSync) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[i]!);
    db.exec(`PRAGMA user_version = ${i + 1}`);
    db.exec('COMMIT');
  }
}
```

**Step 4: Run it to verify it passes**

Run: `corepack pnpm -C apps/server exec vitest run src/db.test.ts`
Expected: PASS (2 tests).

**Step 5: Commit**

```bash
git add apps/server/src/db.ts apps/server/src/db.test.ts
git commit -m "Catalog tables: sources, artists, albums, tracks and file copies"
```

---

### Task 2: Source adapter types and merge keys

Types and three small functions, no behaviour to test on their own; they are exercised by Tasks 3 to 5.

**Files:**
- Create: `apps/server/src/catalog/types.ts`
- Create: `apps/server/src/catalog/keys.ts`

**Step 1: Write the types**

```ts
// apps/server/src/catalog/types.ts
import type { AudioFormat } from '@playarr/shared';

export type SourceKind = 'lidarr' | 'folder';

/**
 * What a source reports. `key`s identify the same artist, album or song across sources
 * (see keys.ts); `preferredId` is the id to use when the row is first created, if it's free
 * (Lidarr's ids, so existing links, queues and offline songs keep working).
 */
export interface SourceArtist {
  key: string;
  preferredId?: number;
  mbid?: string;
  name: string;
  sortName: string;
  genres: string[];
  overview?: string;
  imageUrl?: string;
  fanartUrl?: string;
  logoUrl?: string;
}

export interface SourceAlbum {
  key: string;
  preferredId?: number;
  artistKey: string;
  /** MusicBrainz release group. */
  mbid?: string;
  title: string;
  albumType: string;
  secondaryTypes: string[];
  releaseDate?: string;
  genres: string[];
  overview?: string;
  coverUrl?: string;
  totalTrackCount?: number;
}

export interface SourceTrack {
  key: string;
  preferredId?: number;
  albumKey: string;
  /** MusicBrainz recording id, or "track:<id>" when unknown. Favorites and playlists key on it. */
  recordingId: string;
  title: string;
  trackNumber: number;
  discNumber: number;
  duration: number; // seconds
  explicit: boolean;
}

export interface SourceCopy {
  /** Stable within the source: Lidarr's track-file id, or a path relative to the folder. */
  ref: string;
  preferredId?: number;
  trackKey: string;
  /** As the source reports it (Lidarr's path; mapped with PATH_MAP before reading). */
  path: string;
  size: number;
  format: AudioFormat;
  addedAt?: string;
}

/** Lidarr's view of a release group, owned or not; requests use it. */
export interface LidarrAlbumState {
  mbid: string;
  lidarrId: number;
  monitored: boolean;
}

export interface SourceSync {
  artists: SourceArtist[];
  albums: SourceAlbum[];
  tracks: SourceTrack[];
  copies: SourceCopy[];
  lidarrAlbums?: LidarrAlbumState[];
}

export interface CatalogSource {
  readonly kind: SourceKind;
  /** Everything the source currently has. Copies it no longer reports are removed. */
  sync(): Promise<SourceSync>;
}
```

**Step 2: Write the keys**

```ts
// apps/server/src/catalog/keys.ts
import { albumKey, normalize } from '../library/search.ts';

// MusicBrainz ids when known, so the same music from different sources merges. Name-based keys
// are the fallback for music MusicBrainz doesn't know (folder sources, later phases).

export const artistKeyFor = (mbid: string | undefined, name: string) =>
  mbid ? `mb:${mbid}` : `name:${normalize(name)}`;

export const albumKeyFor = (mbid: string | undefined, artistName: string, title: string) =>
  mbid ? `mb:${mbid}` : `name:${albumKey(artistName, title)}`;

/** A song on an album. Keyed by recording, so editions of an album share their songs. */
export const trackKeyFor = (albumKeyValue: string, recordingId: string) => `${albumKeyValue}#${recordingId}`;
```

**Step 3: Typecheck**

Run: `corepack pnpm -C apps/server typecheck`
Expected: no output, exit 0.

**Step 4: Commit**

```bash
git add apps/server/src/catalog/types.ts apps/server/src/catalog/keys.ts
git commit -m "Catalog: source adapter types and merge keys"
```

---

### Task 3: CatalogStore (write syncs, assign ids, read rows)

**Files:**
- Create: `apps/server/src/catalog/store.ts`
- Create: `apps/server/src/catalog/testFixtures.ts`
- Test: `apps/server/src/catalog/store.test.ts`

**Step 1: Write the shared test fixture**

```ts
// apps/server/src/catalog/testFixtures.ts
import type { AudioFormat } from '@playarr/shared';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db.ts';
import type { SourceSync } from './types.ts';

export function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

export const FLAC: AudioFormat = { codec: 'FLAC', container: 'flac', bits: 16, sampleRate: 44100, lossless: true };
export const FLAC_24: AudioFormat = { codec: 'FLAC', container: 'flac', bits: 24, sampleRate: 96000, lossless: true };
export const MP3: AudioFormat = { codec: 'MP3', container: 'mp3', bitrate: 320, lossless: false };

/** One artist, one album, two songs, each with one FLAC copy; ids as Lidarr would give them. */
export function mezzanine(): SourceSync {
  return {
    artists: [
      { key: 'mb:art-1', preferredId: 7, mbid: 'art-1', name: 'Massive Attack', sortName: 'Massive Attack', genres: ['trip hop'] },
    ],
    albums: [
      {
        key: 'mb:rg-1',
        preferredId: 70,
        artistKey: 'mb:art-1',
        mbid: 'rg-1',
        title: 'Mezzanine',
        albumType: 'Album',
        secondaryTypes: [],
        releaseDate: '1998-04-20T00:00:00Z',
        genres: [],
        totalTrackCount: 11,
      },
    ],
    tracks: [
      { key: 'mb:rg-1#rec-2', preferredId: 701, albumKey: 'mb:rg-1', recordingId: 'rec-2', title: 'Risingson', trackNumber: 2, discNumber: 1, duration: 298, explicit: false },
      { key: 'mb:rg-1#rec-1', preferredId: 700, albumKey: 'mb:rg-1', recordingId: 'rec-1', title: 'Angel', trackNumber: 1, discNumber: 1, duration: 379, explicit: false },
    ],
    copies: [
      { ref: '9000', preferredId: 9000, trackKey: 'mb:rg-1#rec-1', path: '/music/Massive Attack/Mezzanine/01.flac', size: 40_000_000, format: FLAC, addedAt: '2026-10-01T10:00:00Z' },
      { ref: '9001', preferredId: 9001, trackKey: 'mb:rg-1#rec-2', path: '/music/Massive Attack/Mezzanine/02.flac', size: 30_000_000, format: FLAC, addedAt: '2026-10-02T10:00:00Z' },
    ],
    lidarrAlbums: [
      { mbid: 'rg-1', lidarrId: 70, monitored: true },
      { mbid: 'rg-2', lidarrId: 71, monitored: true },
    ],
  };
}
```

(The tracks are deliberately listed out of order; Task 4 checks they get sorted.)

**Step 2: Write the failing tests**

```ts
// apps/server/src/catalog/store.test.ts
import { describe, expect, it } from 'vitest';
import { CatalogStore } from './store.ts';
import { freshDb, mezzanine } from './testFixtures.ts';

function setup() {
  const store = new CatalogStore(freshDb());
  const sourceId = store.ensureSource('lidarr', 'Lidarr');
  return { store, sourceId };
}

describe('CatalogStore', () => {
  it('creates one source per kind with ensureSource', () => {
    const { store, sourceId } = setup();
    expect(store.ensureSource('lidarr', 'Lidarr')).toBe(sourceId);
    expect(store.addSource('folder', 'Music')).not.toBe(sourceId);
    expect(store.load().sources.map((s) => [s.kind, s.position])).toEqual([
      ['lidarr', 0],
      ['folder', 1],
    ]);
  });

  it('uses the preferred ids on first sight', () => {
    const { store, sourceId } = setup();
    store.applySync(sourceId, mezzanine());
    const rows = store.load();
    expect(rows.artists.map((a) => a.id)).toEqual([7]);
    expect(rows.albums.map((a) => [a.id, a.artistId])).toEqual([[70, 7]]);
    expect(rows.tracks.map((t) => t.id).sort()).toEqual([700, 701]);
    expect(rows.copies.map((c) => [c.id, c.trackId]).sort()).toEqual([
      [9000, 700],
      [9001, 701],
    ]);
    expect(store.hasData()).toBe(true);
  });

  it('keeps ids when the source later reports different ones', () => {
    const { store, sourceId } = setup();
    store.applySync(sourceId, mezzanine());
    const resync = mezzanine();
    resync.albums[0]!.preferredId = 99; // e.g. the album was removed and re-added in Lidarr
    resync.albums[0]!.title = 'Mezzanine (Remastered)';
    store.applySync(sourceId, resync);
    const [album] = store.load().albums;
    expect(album!.id).toBe(70);
    expect(album!.meta.title).toBe('Mezzanine (Remastered)');
  });

  it('allocates a fresh id when the preferred one is taken', () => {
    const { store, sourceId } = setup();
    store.applySync(sourceId, mezzanine());
    const more = mezzanine();
    more.albums.push({ ...more.albums[0]!, key: 'mb:rg-9', mbid: 'rg-9', title: 'Heligoland', preferredId: 70 });
    store.applySync(sourceId, more);
    expect(store.load().albums.find((a) => a.key === 'mb:rg-9')!.id).toBe(71);
  });

  it('removes copies the source no longer has, but keeps the song row', () => {
    const { store, sourceId } = setup();
    store.applySync(sourceId, mezzanine());
    const fewer = mezzanine();
    fewer.copies = fewer.copies.slice(0, 1);
    store.applySync(sourceId, fewer);
    const rows = store.load();
    expect(rows.copies.map((c) => c.id)).toEqual([9000]);
    expect(rows.tracks).toHaveLength(2);
  });

  it('never reuses a copy id', () => {
    const { store, sourceId } = setup();
    store.applySync(sourceId, mezzanine());
    const fewer = mezzanine();
    fewer.copies = fewer.copies.slice(0, 1);
    store.applySync(sourceId, fewer);
    const added = mezzanine();
    added.copies = [added.copies[0]!, { ...added.copies[1]!, ref: 'new-file', preferredId: undefined }];
    store.applySync(sourceId, added);
    expect(store.load().copies.map((c) => c.id).sort()).toEqual([9000, 9002]);
  });

  it("stores Lidarr's album list on the source", () => {
    const { store, sourceId } = setup();
    store.applySync(sourceId, mezzanine());
    const [source] = store.load().sources;
    expect(source!.state.lidarrAlbums).toHaveLength(2);
    expect(source!.lastSyncAt).toBeTruthy();
  });

  it('applies nothing when a sync refers to something unknown', () => {
    const { store, sourceId } = setup();
    const broken = mezzanine();
    broken.copies.push({ ...broken.copies[0]!, ref: 'x', preferredId: undefined, trackKey: 'mb:nope#nope' });
    expect(() => store.applySync(sourceId, broken)).toThrow(/unknown track/);
    expect(store.hasData()).toBe(false);
    expect(store.load().artists).toEqual([]);
  });
});
```

**Step 3: Run them to verify they fail**

Run: `corepack pnpm -C apps/server exec vitest run src/catalog/store.test.ts`
Expected: FAIL, cannot resolve `./store.ts`.

**Step 4: Implement**

```ts
// apps/server/src/catalog/store.ts
import type { AudioFormat } from '@playarr/shared';
import type { DatabaseSync } from 'node:sqlite';
import type { LidarrAlbumState, SourceAlbum, SourceArtist, SourceCopy, SourceKind, SourceSync, SourceTrack } from './types.ts';

export type ArtistInfo = Omit<SourceArtist, 'key' | 'preferredId'>;
export type AlbumInfo = Omit<SourceAlbum, 'key' | 'preferredId' | 'artistKey'>;
export type TrackInfo = Omit<SourceTrack, 'key' | 'preferredId' | 'albumKey' | 'recordingId'>;

export interface SourceState {
  lidarrAlbums?: LidarrAlbumState[];
}

export interface SourceRow {
  id: number;
  kind: SourceKind;
  name: string;
  position: number;
  enabled: boolean;
  lastSyncAt?: string;
  state: SourceState;
}
export interface ArtistRow {
  id: number;
  key: string;
  meta: ArtistInfo;
}
export interface AlbumRow {
  id: number;
  key: string;
  artistId: number;
  meta: AlbumInfo;
}
export interface TrackRow {
  id: number;
  key: string;
  albumId: number;
  recordingId: string;
  meta: TrackInfo;
}
export interface CopyRow {
  id: number;
  sourceId: number;
  trackId: number;
  path: string;
  size: number;
  format: AudioFormat;
  addedAt?: string;
}

export interface CatalogRows {
  sources: SourceRow[];
  artists: ArtistRow[];
  albums: AlbumRow[];
  tracks: TrackRow[];
  copies: CopyRow[];
}

type CatalogTable = 'catalog_artists' | 'catalog_albums' | 'catalog_tracks';

/** The catalog in SQLite: what each source reported, with permanent Playarr ids. */
export class CatalogStore {
  constructor(private readonly db: DatabaseSync) {}

  addSource(kind: SourceKind, name: string): number {
    const { next } = this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM sources').get() as {
      next: number;
    };
    const res = this.db
      .prepare('INSERT INTO sources (kind, name, position, created_at) VALUES (?, ?, ?, ?)')
      .run(kind, name, next, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  /** The first source of this kind, created if there is none. */
  ensureSource(kind: SourceKind, name: string): number {
    const row = this.db.prepare('SELECT id FROM sources WHERE kind = ? ORDER BY position LIMIT 1').get(kind) as
      | { id: number }
      | undefined;
    return row?.id ?? this.addSource(kind, name);
  }

  hasData(): boolean {
    return !!this.db.prepare('SELECT 1 FROM copies LIMIT 1').get();
  }

  /** Replace what this source has with `sync`, all or nothing. */
  applySync(sourceId: number, sync: SourceSync) {
    const now = new Date().toISOString();
    this.db.exec('BEGIN');
    try {
      const artistIds = new Map<string, number>();
      for (const { key, preferredId, ...meta } of sync.artists) {
        artistIds.set(key, this.upsert('catalog_artists', key, preferredId, {}, meta, now));
      }
      const albumIds = new Map<string, number>();
      for (const { key, preferredId, artistKey, ...meta } of sync.albums) {
        const artistId = artistIds.get(artistKey);
        if (artistId === undefined) throw new Error(`Album ${key} refers to unknown artist ${artistKey}`);
        albumIds.set(key, this.upsert('catalog_albums', key, preferredId, { artist_id: artistId }, meta, now));
      }
      const trackIds = new Map<string, number>();
      for (const { key, preferredId, albumKey, recordingId, ...meta } of sync.tracks) {
        const albumId = albumIds.get(albumKey);
        if (albumId === undefined) throw new Error(`Track ${key} refers to unknown album ${albumKey}`);
        trackIds.set(
          key,
          this.upsert('catalog_tracks', key, preferredId, { album_id: albumId, recording_id: recordingId }, meta, now),
        );
      }
      const seen = new Set<number>();
      for (const copy of sync.copies) {
        const trackId = trackIds.get(copy.trackKey);
        if (trackId === undefined) throw new Error(`Copy ${copy.ref} refers to unknown track ${copy.trackKey}`);
        seen.add(this.upsertCopy(sourceId, copy, trackId, now));
      }
      // Files the source no longer has. Catalog rows stay, so their ids are never reused.
      const remove = this.db.prepare('DELETE FROM copies WHERE id = ?');
      for (const { id } of this.db.prepare('SELECT id FROM copies WHERE source_id = ?').all(sourceId) as {
        id: number;
      }[]) {
        if (!seen.has(id)) remove.run(id);
      }
      const state: SourceState = { lidarrAlbums: sync.lidarrAlbums };
      this.db
        .prepare('UPDATE sources SET state = ?, last_sync_at = ? WHERE id = ?')
        .run(JSON.stringify(state), now, sourceId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  load(): CatalogRows {
    const all = <T>(sql: string) => this.db.prepare(sql).all() as T[];
    return {
      sources: all<{
        id: number;
        kind: SourceKind;
        name: string;
        position: number;
        enabled: number;
        state: string | null;
        last_sync_at: string | null;
      }>('SELECT id, kind, name, position, enabled, state, last_sync_at FROM sources ORDER BY position').map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        position: r.position,
        enabled: r.enabled === 1,
        lastSyncAt: r.last_sync_at ?? undefined,
        state: r.state ? (JSON.parse(r.state) as SourceState) : {},
      })),
      artists: all<{ id: number; key: string; meta: string }>('SELECT id, key, meta FROM catalog_artists').map((r) => ({
        id: r.id,
        key: r.key,
        meta: JSON.parse(r.meta) as ArtistInfo,
      })),
      albums: all<{ id: number; key: string; artist_id: number; meta: string }>(
        'SELECT id, key, artist_id, meta FROM catalog_albums',
      ).map((r) => ({ id: r.id, key: r.key, artistId: r.artist_id, meta: JSON.parse(r.meta) as AlbumInfo })),
      tracks: all<{ id: number; key: string; album_id: number; recording_id: string; meta: string }>(
        'SELECT id, key, album_id, recording_id, meta FROM catalog_tracks',
      ).map((r) => ({
        id: r.id,
        key: r.key,
        albumId: r.album_id,
        recordingId: r.recording_id,
        meta: JSON.parse(r.meta) as TrackInfo,
      })),
      copies: all<{
        id: number;
        source_id: number;
        track_id: number;
        path: string;
        size: number;
        format: string;
        added_at: string | null;
      }>('SELECT id, source_id, track_id, path, size, format, added_at FROM copies').map((r) => ({
        id: r.id,
        sourceId: r.source_id,
        trackId: r.track_id,
        path: r.path,
        size: r.size,
        format: JSON.parse(r.format) as AudioFormat,
        addedAt: r.added_at ?? undefined,
      })),
    };
  }

  /** Insert or update a catalog row by key; returns its id. */
  private upsert(
    table: CatalogTable,
    key: string,
    preferredId: number | undefined,
    columns: Record<string, string | number>,
    meta: object,
    now: string,
  ): number {
    const names = Object.keys(columns);
    const values = Object.values(columns);
    const existing = this.db.prepare(`SELECT id FROM ${table} WHERE key = ?`).get(key) as { id: number } | undefined;
    if (existing) {
      const sets = [...names.map((n) => `${n} = ?`), 'meta = ?', 'updated_at = ?'].join(', ');
      this.db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`).run(...values, JSON.stringify(meta), now, existing.id);
      return existing.id;
    }
    const cols = ['id', 'key', ...names, 'meta', 'updated_at'];
    const res = this.db
      .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(this.freeId(table, preferredId), key, ...values, JSON.stringify(meta), now);
    return Number(res.lastInsertRowid);
  }

  private upsertCopy(sourceId: number, copy: SourceCopy, trackId: number, now: string): number {
    const fields = [trackId, copy.path, copy.size, JSON.stringify(copy.format), copy.addedAt ?? null, now] as const;
    const existing = this.db
      .prepare('SELECT id FROM copies WHERE source_id = ? AND source_ref = ?')
      .get(sourceId, copy.ref) as { id: number } | undefined;
    if (existing) {
      this.db
        .prepare('UPDATE copies SET track_id = ?, path = ?, size = ?, format = ?, added_at = ?, updated_at = ? WHERE id = ?')
        .run(...fields, existing.id);
      return existing.id;
    }
    const res = this.db
      .prepare(
        `INSERT INTO copies (id, source_id, source_ref, track_id, path, size, format, added_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(this.freeId('copies', copy.preferredId), sourceId, copy.ref, ...fields);
    return Number(res.lastInsertRowid);
  }

  /** The preferred id if no row has it, else null so AUTOINCREMENT picks one never used before. */
  private freeId(table: CatalogTable | 'copies', preferred: number | undefined): number | null {
    if (preferred === undefined) return null;
    return this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(preferred) ? null : preferred;
  }
}
```

Note on `freeId` for copies: a deleted copy's id is "free" again by this check, but a preferred id only ever comes from Lidarr, which never reuses its own track-file ids, so it can only ever point at the same file.

**Step 5: Run the tests to verify they pass**

Run: `corepack pnpm -C apps/server exec vitest run src/catalog/store.test.ts`
Expected: PASS (8 tests).

**Step 6: Commit**

```bash
git add apps/server/src/catalog/store.ts apps/server/src/catalog/store.test.ts apps/server/src/catalog/testFixtures.ts
git commit -m "Catalog store: apply source syncs with permanent ids, read rows back"
```

---

### Task 4: Build the library from catalog rows, with best-copy choice

**Files:**
- Create: `apps/server/src/catalog/build.ts`
- Test: `apps/server/src/catalog/build.test.ts`

**Step 1: Write the failing tests**

```ts
// apps/server/src/catalog/build.test.ts
import { describe, expect, it } from 'vitest';
import { buildCatalog, compareCopies } from './build.ts';
import { CatalogStore } from './store.ts';
import { FLAC, FLAC_24, MP3, freshDb, mezzanine } from './testFixtures.ts';

function lidarrOnly() {
  const db = freshDb();
  const store = new CatalogStore(db);
  store.applySync(store.ensureSource('lidarr', 'Lidarr'), mezzanine());
  return { db, store };
}

describe('buildCatalog', () => {
  it('builds albums and tracks the way the API returns them', () => {
    const c = buildCatalog(lidarrOnly().store.load());
    const album = c.albums.get(70)!;
    expect(album).toMatchObject({
      id: 70,
      title: 'Mezzanine',
      artistId: 7,
      artistName: 'Massive Attack',
      year: 1998,
      genres: ['trip hop'], // album has none: falls back to the artist's
      duration: 379 + 298,
      trackCount: 2,
      totalTrackCount: 11,
      discCount: 1,
      addedAt: '2026-10-02T10:00:00Z',
      format: FLAC,
    });
    expect(album.tracks.map((t) => t.title)).toEqual(['Angel', 'Risingson']); // sorted by number
    expect(album.tracks[0]).toEqual({
      id: 700,
      recordingId: 'rec-1',
      fileId: 9000,
      albumId: 70,
      artistId: 7,
      title: 'Angel',
      artistName: 'Massive Attack',
      albumTitle: 'Mezzanine',
      trackNumber: 1,
      discNumber: 1,
      duration: 379,
      explicit: false,
      format: FLAC,
      size: 40_000_000,
      streamUrl: '/stream/9000',
    });
    expect(c.artists.get(7)).toMatchObject({ name: 'Massive Attack', albumCount: 1, trackCount: 2 });
    expect(c.tracks.map((t) => t.id)).toEqual([700, 701]);
    expect(c.files.get(9000)).toMatchObject({ path: '/music/Massive Attack/Mezzanine/01.flac', sourceId: 1 });
    expect(c.stats).toMatchObject({ artists: 1, albums: 1, tracks: 2, durationSeconds: 677, sizeBytes: 70_000_000 });
  });

  it('maps release groups to Lidarr albums and to playable library albums', () => {
    const c = buildCatalog(lidarrOnly().store.load());
    expect(c.albumsByMbid.get('rg-1')).toEqual({ lidarrId: 70, monitored: true, albumId: 70 });
    expect(c.albumsByMbid.get('rg-2')).toEqual({ lidarrId: 71, monitored: true, albumId: undefined });
    expect(c.artistIdByMbid.get('art-1')).toBe(7);
  });

  it('leaves out songs, albums and artists without copies', () => {
    const { store } = lidarrOnly();
    const sync = mezzanine();
    sync.copies = [];
    store.applySync(1, sync);
    const c = buildCatalog(store.load());
    expect([c.artists.size, c.albums.size, c.tracks.length]).toEqual([0, 0, 0]);
  });

  describe('best copy', () => {
    function twoSources(lidarrFormat: typeof FLAC, folderFormat: typeof FLAC) {
      const { db, store } = lidarrOnly();
      const lidarr = mezzanine();
      lidarr.copies[0]!.format = lidarrFormat;
      store.applySync(1, lidarr);
      const folder = mezzanine();
      folder.copies = [{ ...folder.copies[0]!, ref: 'Mezzanine/01.flac', preferredId: undefined, format: folderFormat }];
      store.applySync(store.addSource('folder', 'Music'), folder);
      return { db, store, folderCopyId: Math.max(...store.load().copies.map((c) => c.id)) };
    }

    it('plays the better quality, whatever the source order', () => {
      const { store, folderCopyId } = twoSources(MP3, FLAC);
      const c = buildCatalog(store.load());
      expect(c.albums.get(70)!.tracks[0]!.fileId).toBe(folderCopyId);
      expect(c.files.has(9000)).toBe(true); // other copies stay streamable (saved queues)
    });

    it('breaks ties with the source order', () => {
      const { store } = twoSources(FLAC, FLAC);
      expect(buildCatalog(store.load()).albums.get(70)!.tracks[0]!.fileId).toBe(9000);
    });

    it('skips disabled sources', () => {
      const { db, store, folderCopyId } = twoSources(MP3, FLAC);
      db.prepare('UPDATE sources SET enabled = 0 WHERE kind = ?').run('folder');
      const c = buildCatalog(store.load());
      expect(c.albums.get(70)!.tracks[0]!.fileId).toBe(9000);
      expect(c.files.has(folderCopyId)).toBe(false);
    });
  });
});

describe('compareCopies', () => {
  const at = (format: typeof FLAC, position = 0) => ({ format, position });
  it('ranks lossless, then bit depth, then source order', () => {
    expect(compareCopies(at(FLAC), at(MP3))).toBeLessThan(0);
    expect(compareCopies(at(FLAC_24), at(FLAC))).toBeLessThan(0);
    expect(compareCopies(at(FLAC, 0), at(FLAC, 1))).toBeLessThan(0);
    expect(compareCopies(at(MP3, 0), at(FLAC, 1))).toBeGreaterThan(0);
  });
});
```

**Step 2: Run them to verify they fail**

Run: `corepack pnpm -C apps/server exec vitest run src/catalog/build.test.ts`
Expected: FAIL, cannot resolve `./build.ts`.

**Step 3: Implement**

`toAlbumDetail`, `toArtist` and the format pick are moved here from `library/library.ts` (Task 6 deletes the originals); field order is kept so API output is byte-identical.

```ts
// apps/server/src/catalog/build.ts
import type { AlbumDetail, Artist, AudioFormat, LibraryStats, Track } from '@playarr/shared';
import { formatKey } from '../library/format.ts';
import { albumKeyFor } from './keys.ts';
import type { AlbumRow, ArtistRow, CatalogRows, CopyRow } from './store.ts';

export interface FileRecord {
  id: number;
  sourceId: number;
  path: string; // as the source reports it
  size: number;
  format: AudioFormat;
}

/** A release group as Lidarr sees it (if it does), and the library album once it's playable. */
export interface LidarrAlbumRef {
  lidarrId?: number;
  monitored: boolean;
  albumId?: number;
}

export interface Catalog {
  artists: Map<number, Artist>;
  albums: Map<number, AlbumDetail>;
  tracks: Track[];
  /** Every copy on an enabled source, so saved queues can still stream a copy that's no longer the best. */
  files: Map<number, FileRecord>;
  albumsByMbid: Map<string, LidarrAlbumRef>;
  artistIdByMbid: Map<string, number>;
  stats: LibraryStats;
}

interface Ranked {
  format: AudioFormat;
  /** The source's place in the Settings list (lower comes first). */
  position: number;
}

/** Negative when `a` should play rather than `b`: lossless, bit depth, sample rate, bitrate, then source order. */
export function compareCopies(a: Ranked, b: Ranked): number {
  const fa = a.format;
  const fb = b.format;
  return (
    Number(fb.lossless) - Number(fa.lossless) ||
    (fb.bits ?? 0) - (fa.bits ?? 0) ||
    (fb.sampleRate ?? 0) - (fa.sampleRate ?? 0) ||
    (fb.bitrate ?? 0) - (fa.bitrate ?? 0) ||
    a.position - b.position
  );
}

export function buildCatalog(rows: CatalogRows): Catalog {
  const position = new Map(rows.sources.filter((s) => s.enabled).map((s) => [s.id, s.position]));
  const rank = (c: CopyRow): Ranked => ({ format: c.format, position: position.get(c.sourceId)! });

  const files = new Map<number, FileRecord>();
  const copiesByTrack = new Map<number, CopyRow[]>();
  for (const c of rows.copies) {
    if (!position.has(c.sourceId)) continue;
    files.set(c.id, { id: c.id, sourceId: c.sourceId, path: c.path, size: c.size, format: c.format });
    const list = copiesByTrack.get(c.trackId);
    if (list) list.push(c);
    else copiesByTrack.set(c.trackId, [c]);
  }

  const artistRows = new Map(rows.artists.map((a) => [a.id, a]));
  const albumRows = new Map(rows.albums.map((a) => [a.id, a]));

  const byAlbum = new Map<number, { tracks: Track[]; added: string[] }>();
  for (const t of rows.tracks) {
    const copies = copiesByTrack.get(t.id);
    const album = albumRows.get(t.albumId);
    const artist = album && artistRows.get(album.artistId);
    if (!copies || !album || !artist) continue;
    const copy = copies.reduce((best, c) => (compareCopies(rank(c), rank(best)) < 0 ? c : best));
    const track: Track = {
      id: t.id,
      recordingId: t.recordingId,
      fileId: copy.id,
      albumId: album.id,
      artistId: artist.id,
      title: t.meta.title,
      artistName: artist.meta.name,
      albumTitle: album.meta.title,
      trackNumber: t.meta.trackNumber,
      discNumber: t.meta.discNumber,
      duration: t.meta.duration,
      explicit: t.meta.explicit,
      format: copy.format,
      size: copy.size,
      streamUrl: `/stream/${copy.id}`,
      coverUrl: album.meta.coverUrl,
    };
    let entry = byAlbum.get(album.id);
    if (!entry) byAlbum.set(album.id, (entry = { tracks: [], added: [] }));
    entry.tracks.push(track);
    for (const c of copies) if (c.addedAt) entry.added.push(c.addedAt);
  }

  const albums = new Map<number, AlbumDetail>();
  const tracks: Track[] = [];
  const albumIdsByArtist = new Map<number, number[]>();
  for (const [albumId, entry] of [...byAlbum].sort(([a], [b]) => a - b)) {
    entry.tracks.sort((a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber);
    const row = albumRows.get(albumId)!;
    const artist = artistRows.get(row.artistId)!;
    albums.set(albumId, toAlbumDetail(row, artist, entry.tracks, entry.added));
    tracks.push(...entry.tracks);
    const ids = albumIdsByArtist.get(artist.id) ?? [];
    ids.push(albumId);
    albumIdsByArtist.set(artist.id, ids);
  }

  const artists = new Map<number, Artist>();
  const artistIdByMbid = new Map<string, number>();
  for (const [artistId, albumIds] of albumIdsByArtist) {
    const row = artistRows.get(artistId)!;
    artists.set(artistId, toArtist(row, albumIds.map((id) => albums.get(id)!)));
    if (row.meta.mbid) artistIdByMbid.set(row.meta.mbid, artistId);
  }

  // Playable albums by release group, then Lidarr's own list (owned or not) on top.
  const albumsByMbid = new Map<string, LidarrAlbumRef>();
  for (const album of albums.values()) {
    const mbid = albumRows.get(album.id)!.meta.mbid;
    if (mbid) albumsByMbid.set(mbid, { monitored: false, albumId: album.id });
  }
  const albumIdByKey = new Map(rows.albums.map((a) => [a.key, a.id]));
  for (const source of rows.sources) {
    if (!position.has(source.id)) continue;
    for (const la of source.state.lidarrAlbums ?? []) {
      const id = albumIdByKey.get(albumKeyFor(la.mbid, '', ''));
      albumsByMbid.set(la.mbid, {
        lidarrId: la.lidarrId,
        monitored: la.monitored,
        albumId: id !== undefined && albums.has(id) ? id : undefined,
      });
    }
  }

  let durationSeconds = 0;
  let sizeBytes = 0;
  for (const t of tracks) {
    durationSeconds += t.duration;
    sizeBytes += t.size;
  }
  const lastSync = rows.sources.flatMap((s) => (s.lastSyncAt ? [s.lastSyncAt] : [])).sort().at(-1);

  return {
    artists,
    albums,
    tracks,
    files,
    albumsByMbid,
    artistIdByMbid,
    stats: {
      artists: artists.size,
      albums: albums.size,
      tracks: tracks.length,
      durationSeconds,
      sizeBytes,
      refreshedAt: lastSync ?? new Date().toISOString(),
    },
  };
}

function toArtist(row: ArtistRow, albums: AlbumDetail[]): Artist {
  const m = row.meta;
  return {
    id: row.id,
    name: m.name,
    sortName: m.sortName,
    genres: m.genres,
    overview: m.overview,
    albumCount: albums.length,
    trackCount: albums.reduce((n, a) => n + a.tracks.length, 0),
    // Lidarr's metadata has no photo for some artists; fall back to their newest album cover.
    imageUrl:
      m.imageUrl ??
      [...albums]
        .sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))
        .find((a) => a.coverUrl)?.coverUrl,
    fanartUrl: m.fanartUrl,
    logoUrl: m.logoUrl,
  };
}

function toAlbumDetail(row: AlbumRow, artist: ArtistRow, tracks: Track[], added: string[]): AlbumDetail {
  const m = row.meta;
  const year = m.releaseDate ? new Date(m.releaseDate).getUTCFullYear() : undefined;
  return {
    id: row.id,
    title: m.title,
    artistId: artist.id,
    artistName: artist.meta.name,
    year: year && year > 1000 ? year : undefined,
    releaseDate: m.releaseDate,
    albumType: m.albumType,
    secondaryTypes: m.secondaryTypes,
    genres: m.genres.length ? m.genres : artist.meta.genres.slice(0, 3),
    duration: tracks.reduce((sum, t) => sum + t.duration, 0),
    trackCount: tracks.length,
    totalTrackCount: m.totalTrackCount ?? tracks.length,
    coverUrl: m.coverUrl,
    addedAt: added.sort().at(-1),
    format: mostCommonFormat(tracks),
    overview: m.overview,
    tracks,
    discCount: new Set(tracks.map((t) => t.discNumber)).size,
  };
}

/** The most common format, so mixed-quality albums still get a sensible badge. */
function mostCommonFormat(tracks: Track[]): AudioFormat | undefined {
  const counts = new Map<string, { format: AudioFormat; n: number }>();
  for (const t of tracks) {
    const key = formatKey(t.format);
    const entry = counts.get(key) ?? { format: t.format, n: 0 };
    entry.n++;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.format;
}
```

**Step 4: Run the tests to verify they pass**

Run: `corepack pnpm -C apps/server exec vitest run src/catalog/build.test.ts`
Expected: PASS (7 tests).

**Step 5: Commit**

```bash
git add apps/server/src/catalog/build.ts apps/server/src/catalog/build.test.ts
git commit -m "Catalog: build library albums and tracks from rows, playing the best copy"
```

---

### Task 5: Lidarr as a catalog source

The mapping is moved from `Library.build()` in `library/library.ts` (lines ~157 to 265) into an adapter. Task 6 deletes the original.

**Files:**
- Create: `apps/server/src/catalog/lidarr.ts`
- Test: `apps/server/src/catalog/lidarr.test.ts`

**Step 1: Write the failing tests**

```ts
// apps/server/src/catalog/lidarr.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { LidarrClient } from '../lidarr/client.ts';
import type { LidarrAlbum, LidarrArtist, LidarrTrack, LidarrTrackFile } from '../lidarr/types.ts';
import { buildCatalog } from './build.ts';
import { LidarrSource } from './lidarr.ts';
import { CatalogStore } from './store.ts';
import { freshDb } from './testFixtures.ts';

const artist = (id: number, name: string, mbid: string, files: number): LidarrArtist => ({
  id,
  artistName: name,
  foreignArtistId: mbid,
  genres: ['trip hop'],
  images: [{ coverType: 'poster', url: `/MediaCover/${id}/poster.jpg?lastWrite=123` }],
  path: `/music/${name}`,
  statistics: { trackFileCount: files, trackCount: files, totalTrackCount: files, sizeOnDisk: 0, percentOfTracks: 100 },
});
const album = (id: number, artistId: number, mbid: string, title: string): LidarrAlbum => ({
  id,
  title,
  foreignAlbumId: mbid,
  monitored: true,
  artistId,
  releaseDate: '1998-04-20T00:00:00Z',
  albumType: 'Album',
  secondaryTypes: [],
  genres: [],
  duration: 0,
  images: [{ coverType: 'cover', url: `/MediaCover/Albums/${id}/cover.jpg` }],
  statistics: { trackFileCount: 0, trackCount: 11, totalTrackCount: 11, sizeOnDisk: 0, percentOfTracks: 0 },
});
const track = (id: number, albumId: number, rec: string | undefined, n: string, fileId: number): LidarrTrack => ({
  id,
  albumId,
  artistId: 1,
  title: `Song ${id}`,
  trackNumber: n,
  absoluteTrackNumber: Number(n),
  mediumNumber: 1,
  duration: 379_000,
  explicit: false,
  hasFile: fileId > 0,
  trackFileId: fileId,
  foreignRecordingId: rec,
});
const file = (id: number, ext: string): LidarrTrackFile => ({
  id,
  artistId: 1,
  albumId: 10,
  path: `/music/Massive Attack/Mezzanine/${id}.${ext}`,
  size: 1000 + id,
  dateAdded: '2026-10-01T10:00:00Z',
  mediaInfo: { audioCodec: ext === 'flac' ? 'FLAC' : 'MP3', audioBits: '16bit', audioSampleRate: '44.1kHz' },
});

function fakeLidarr() {
  const tracksForArtist = vi.fn(async (id: number) =>
    id === 1
      ? [
          track(100, 10, 'rec-1', '1', 1000),
          track(101, 10, 'rec-2', '2', 1001),
          track(102, 10, undefined, '3', 1002),
          track(103, 11, 'rec-3', '1', 0), // Protection: no file
        ]
      : [],
  );
  const client = {
    artists: async () => [artist(1, 'Massive Attack', 'art-1', 3), artist(2, 'Nobody', 'art-2', 0)],
    albums: async () => [album(10, 1, 'rg-1', 'Mezzanine'), album(11, 1, 'rg-2', 'Protection')],
    tracksForArtist,
    trackFilesForArtist: async (id: number) => (id === 1 ? [file(1000, 'flac'), file(1001, 'mp3'), file(1002, 'flac')] : []),
  } as unknown as LidarrClient;
  return { client, tracksForArtist };
}

describe('LidarrSource', () => {
  it('reports artists, albums, songs and files with Lidarr ids as preferred ids', async () => {
    const { client, tracksForArtist } = fakeLidarr();
    const sync = await new LidarrSource(client).sync();

    expect(tracksForArtist).toHaveBeenCalledTimes(1); // artists without files are skipped
    expect(sync.artists).toEqual([
      expect.objectContaining({ key: 'mb:art-1', preferredId: 1, name: 'Massive Attack', imageUrl: '/art/artist/1/poster?v=123' }),
    ]);
    expect(sync.albums).toEqual([
      expect.objectContaining({ key: 'mb:rg-1', preferredId: 10, artistKey: 'mb:art-1', coverUrl: '/art/album/10/cover' }),
    ]);
    expect(sync.tracks.map((t) => [t.key, t.preferredId, t.recordingId])).toEqual([
      ['mb:rg-1#rec-1', 100, 'rec-1'],
      ['mb:rg-1#rec-2', 101, 'rec-2'],
      ['mb:rg-1#track:102', 102, 'track:102'],
    ]);
    expect(sync.tracks[0]).toMatchObject({ duration: 379, trackNumber: 1, discNumber: 1 });
    expect(sync.copies[0]).toMatchObject({ ref: '1000', preferredId: 1000, trackKey: 'mb:rg-1#rec-1' });
    expect(sync.copies[0]!.format.lossless).toBe(true);
    expect(sync.lidarrAlbums!.map((a) => a.mbid)).toEqual(['rg-1', 'rg-2']);
  });

  it('keeps every Lidarr id unchanged through the catalog', async () => {
    const store = new CatalogStore(freshDb());
    store.applySync(store.ensureSource('lidarr', 'Lidarr'), await new LidarrSource(fakeLidarr().client).sync());
    const c = buildCatalog(store.load());
    expect(c.albums.get(10)!.tracks[0]).toMatchObject({
      id: 100,
      fileId: 1000,
      albumId: 10,
      artistId: 1,
      streamUrl: '/stream/1000',
      coverUrl: '/art/album/10/cover',
    });
    expect(c.albumsByMbid.get('rg-2')).toEqual({ lidarrId: 11, monitored: true, albumId: undefined });
  });

  it('gives a repeated recording on one album its own key', async () => {
    const { client } = fakeLidarr();
    (client as unknown as { tracksForArtist: () => Promise<LidarrTrack[]> }).tracksForArtist = async () => [
      track(100, 10, 'rec-1', '1', 1000),
      track(101, 10, 'rec-1', '2', 1001),
    ];
    const sync = await new LidarrSource(client).sync();
    expect(sync.tracks.map((t) => t.key)).toEqual(['mb:rg-1#rec-1', 'mb:rg-1#rec-1#2']);
  });
});
```

**Step 2: Run them to verify they fail**

Run: `corepack pnpm -C apps/server exec vitest run src/catalog/lidarr.test.ts`
Expected: FAIL, cannot resolve `./lidarr.ts`.

**Step 3: Implement**

```ts
// apps/server/src/catalog/lidarr.ts
import { formatFromTrackFile } from '../library/format.ts';
import type { LidarrClient } from '../lidarr/client.ts';
import type { LidarrImage, LidarrTrackFile } from '../lidarr/types.ts';
import { albumKeyFor, artistKeyFor, trackKeyFor } from './keys.ts';
import type { CatalogSource, SourceSync } from './types.ts';

/** Lidarr's library as a catalog source: validated MusicBrainz metadata, files as Lidarr imported them. */
export class LidarrSource implements CatalogSource {
  readonly kind = 'lidarr' as const;

  constructor(private readonly lidarr: LidarrClient) {}

  async sync(): Promise<SourceSync> {
    const [lArtists, lAlbums] = await Promise.all([this.lidarr.artists(), this.lidarr.albums()]);
    const withFiles = lArtists.filter((a) => (a.statistics?.trackFileCount ?? 0) > 0);
    const perArtist = await mapLimit(withFiles, 4, async (artist) => {
      const [tracks, files] = await Promise.all([
        this.lidarr.tracksForArtist(artist.id),
        this.lidarr.trackFilesForArtist(artist.id),
      ]);
      return { artist, tracks, files };
    });

    const albumsById = new Map(lAlbums.map((a) => [a.id, a]));
    const sync: SourceSync = {
      artists: [],
      albums: [],
      tracks: [],
      copies: [],
      lidarrAlbums: lAlbums.map((a) => ({ mbid: a.foreignAlbumId, lidarrId: a.id, monitored: a.monitored })),
    };

    for (const { artist: la, tracks, files } of perArtist) {
      const artistKey = artistKeyFor(la.foreignArtistId, la.artistName);
      const fileById = new Map<number, LidarrTrackFile>(files.map((f) => [f.id, f]));
      const albumsSeen = new Set<number>();
      const trackKeys = new Set<string>();

      for (const t of tracks) {
        const file = t.hasFile ? fileById.get(t.trackFileId) : undefined;
        const album = albumsById.get(t.albumId);
        if (!file || !album) continue;
        const albumKey = albumKeyFor(album.foreignAlbumId, la.artistName, album.title);
        if (!albumsSeen.has(album.id)) {
          albumsSeen.add(album.id);
          sync.albums.push({
            key: albumKey,
            preferredId: album.id,
            artistKey,
            mbid: album.foreignAlbumId || undefined,
            title: album.title,
            albumType: album.albumType,
            secondaryTypes: album.secondaryTypes ?? [],
            releaseDate: album.releaseDate,
            genres: album.genres ?? [],
            overview: album.overview || undefined,
            coverUrl: artUrl('album', album.id, 'cover', album.images),
            totalTrackCount: album.statistics?.totalTrackCount,
          });
        }
        const recordingId = t.foreignRecordingId || `track:${t.id}`;
        const key = uniqueKey(trackKeyFor(albumKey, recordingId), trackKeys);
        sync.tracks.push({
          key,
          preferredId: t.id,
          albumKey,
          recordingId,
          title: t.title,
          trackNumber: Number.parseInt(t.trackNumber, 10) || t.absoluteTrackNumber,
          discNumber: t.mediumNumber || 1,
          duration: Math.round(t.duration / 1000),
          explicit: t.explicit,
        });
        sync.copies.push({
          ref: String(file.id),
          preferredId: file.id,
          trackKey: key,
          path: file.path,
          size: file.size,
          format: formatFromTrackFile(file),
          addedAt: file.dateAdded,
        });
      }

      if (albumsSeen.size) {
        sync.artists.push({
          key: artistKey,
          preferredId: la.id,
          mbid: la.foreignArtistId || undefined,
          name: la.artistName,
          sortName: la.sortName || la.artistName,
          genres: la.genres ?? [],
          overview: la.overview || undefined,
          imageUrl: artUrl('artist', la.id, 'poster', la.images),
          fanartUrl: artUrl('artist', la.id, 'fanart', la.images),
          logoUrl: artUrl('artist', la.id, 'clearlogo', la.images),
        });
      }
    }
    return sync;
  }
}

/** The same recording twice on one album (rare): give the repeat its own key. */
function uniqueKey(base: string, seen: Set<string>): string {
  let key = base;
  for (let n = 2; seen.has(key); n++) key = `${base}#${n}`;
  seen.add(key);
  return key;
}

function artUrl(kind: 'artist' | 'album', id: number, type: string, images: LidarrImage[]): string | undefined {
  const img = images.find((i) => i.coverType === type);
  if (!img) return undefined;
  // Lidarr appends ?lastWrite=… to local artwork URLs; reuse it for cache busting.
  const version = img.url?.match(/lastWrite=(\d+)/)?.[1];
  return `/art/${kind}/${id}/${type}${version ? `?v=${version}` : ''}`;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}
```

**Step 4: Run the tests to verify they pass**

Run: `corepack pnpm -C apps/server exec vitest run src/catalog/lidarr.test.ts`
Expected: PASS (3 tests).

**Step 5: Commit**

```bash
git add apps/server/src/catalog/lidarr.ts apps/server/src/catalog/lidarr.test.ts
git commit -m "Catalog: Lidarr as a source adapter"
```

---

### Task 6: Build the Library from the catalog

**Files:**
- Modify: `apps/server/src/library/library.ts` (replace the whole file, below)
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/discover/requests.ts` (four spots)

**Step 1: Replace `apps/server/src/library/library.ts`**

Everything from `export const songKey` down to the end of the old file (`songKey`, `indexByName`, `indexByRecording`) and the query methods are unchanged; the snapshot now comes from the catalog. `artUrl`, `toArtist`, `toAlbumDetail`, `mapLimit`, `fromStored`, the JSON snapshot cache and `build()`'s Lidarr mapping are gone (moved in Tasks 4 and 5).

```ts
import type {
  Album,
  AlbumDetail,
  AlbumSort,
  Artist,
  ArtistDetail,
  LibraryStats,
  SearchResults,
  Track,
} from '@playarr/shared';
import { buildCatalog, type Catalog, type FileRecord, type LidarrAlbumRef } from '../catalog/build.ts';
import type { CatalogStore } from '../catalog/store.ts';
import type { CatalogSource } from '../catalog/types.ts';
import { albumKey, normalize, primaryArtist, scoreMatch } from './search.ts';

export type { FileRecord, LidarrAlbumRef };

interface Snapshot extends Catalog {
  albumIdByKey: Map<string, number>;
  trackByRecording: Map<string, Track>;
  trackByName: Map<string, Track>;
}

export class Library {
  private snapshot: Snapshot | null = null;
  private inflight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private listeners: ((library: Library) => void)[] = [];
  lastError: string | null = null;

  constructor(
    private readonly store: CatalogStore,
    /** Where the catalog comes from, each with its row in the sources table. */
    private readonly sources: { id: number; source: CatalogSource }[],
    private readonly log: { info: (msg: string) => void; error: (msg: string) => void },
  ) {}

  /** Called after every successful refresh. */
  onRefresh(listener: (library: Library) => void) {
    this.listeners.push(listener);
  }

  /** Serve the catalog saved by a previous run, so a restart doesn't wait on the sources. */
  loadStored(): boolean {
    if (!this.store.hasData()) return false;
    this.snapshot = toSnapshot(buildCatalog(this.store.load()));
    this.log.info(`Library loaded from the database: ${this.snapshot.stats.albums} albums`);
    return true;
  }

  /** Every artwork URL the library references (for cache warming). */
  artworkUrls(): string[] {
    const snap = this.snapshot;
    if (!snap) return [];
    const urls = [
      ...[...snap.albums.values()].map((a) => a.coverUrl),
      ...[...snap.artists.values()].flatMap((a) => [a.imageUrl, a.fanartUrl, a.logoUrl]),
    ];
    return [...new Set(urls.filter((u): u is string => !!u))];
  }

  startAutoRefresh(minutes: number) {
    this.timer = setInterval(() => void this.refresh().catch(() => {}), minutes * 60_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Sync every source into the catalog and rebuild. Concurrent callers share one refresh. */
  refresh(): Promise<void> {
    this.inflight ??= this.build()
      .then((snap) => {
        this.snapshot = snap;
        this.lastError = null;
        const s = snap.stats;
        this.log.info(`Library refreshed: ${s.artists} artists, ${s.albums} albums, ${s.tracks} tracks`);
        for (const listener of this.listeners) listener(this);
      })
      .catch((err: Error) => {
        this.lastError = err.message;
        this.log.error(`Library refresh failed: ${err.message}`);
        throw err;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async ready(): Promise<Snapshot> {
    if (!this.snapshot) await this.refresh();
    return this.snapshot!;
  }

  private async build(): Promise<Snapshot> {
    const results = await Promise.allSettled(
      this.sources.map(async ({ id, source }) => this.store.applySync(id, await source.sync())),
    );
    const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as Error] : []));
    // One unreachable source shouldn't hide the others: its last sync stays in the catalog.
    if (failures.length && failures.length === results.length) throw failures[0];
    for (const err of failures) this.log.error(`A source failed to sync: ${err.message}`);
    return toSnapshot(buildCatalog(this.store.load()));
  }

  async albumByMbid(mbid: string): Promise<LidarrAlbumRef | undefined> {
    return (await this.ready()).albumsByMbid.get(mbid);
  }

  // ── Unchanged from here: copy these methods verbatim from the old file ──────
  // trackByRecording, trackByName, albumIdByName, artistIdByMbid, artistByName,
  // refreshSoon, stats, artists, artist, artistTracks, albums, randomAlbums,
  // randomTracks, album, file, search
}

function toSnapshot(catalog: Catalog): Snapshot {
  return {
    ...catalog,
    albumIdByKey: new Map([...catalog.albums.values()].map((a) => [albumKey(a.artistName, a.title), a.id])),
    trackByRecording: indexByRecording(catalog.tracks),
    trackByName: indexByName(catalog.tracks),
  };
}

// ── Unchanged: copy verbatim from the old file ──────────────────────────────
// stripAlbum, bySortName, shuffle, songKey (exported), indexByName, indexByRecording
```

The two "copy verbatim" blocks are literal copies of the old code: same signatures, same bodies. Do not change them.

**Step 2: Wire it up in `apps/server/src/index.ts`**

Add the imports:

```ts
import { LidarrSource } from './catalog/lidarr.ts';
import { CatalogStore } from './catalog/store.ts';
```

Replace the `library` construction (it currently passes `lidarr`, a logger and `resolve(config.CACHE_DIR, 'library.json')`) and move `openDatabase` above it. The block from `const lidarr = …` to `const favorites = …` becomes:

```ts
const lidarr = new LidarrClient(config.LIDARR_URL, config.LIDARR_API_KEY);
const db = openDatabase(resolve(config.DATA_DIR));
const store = new CatalogStore(db);
// Phase 1: one Lidarr source, configured from .env. Settings manages sources from phase 2.
const library = new Library(store, [{ id: store.ensureSource('lidarr', 'Lidarr'), source: new LidarrSource(lidarr) }], {
  info: (m) => app.log.info(m),
  error: (m) => app.log.error(m),
});
const art = new LocalArt(lidarr, resolve(config.CACHE_DIR, 'art'));
// Keep every cover cached locally so browsing never waits on Lidarr.
library.onRefresh((lib) => void art.warm(lib.artworkUrls(), app.log));
const media = createMediaSource(config);
const favorites = new Favorites(db, library);
```

(Delete the old `const db = openDatabase(...)` line further down.)

At the bottom, replace:

```ts
// Serve the last saved snapshot immediately, then refresh from Lidarr in the background.
await library.loadCached();
```

with:

```ts
// Serve the catalog saved by the last run immediately, then sync the sources in the background.
library.loadStored();
```

**Step 3: Update `apps/server/src/discover/requests.ts`**

`LidarrAlbumRef` used to have one `id` doing two jobs (Lidarr's album id and the library album id) plus a `playable` flag. Now they're separate: `lidarrId` and `albumId` (set only when playable).

In `request()`:

```ts
    const known = await this.library.albumByMbid(mbid);
    if (known?.albumId !== undefined) {
      throw new RequestError('This album is already in your library', 409);
    }

    let albumId = known?.lidarrId ?? lookup.id;
```

In `availability()`:

```ts
    const known = await this.library.albumByMbid(mbid);
    if (known?.albumId !== undefined) return { state: 'available', albumId: known.albumId };
```

In `computeStatuses()`:

```ts
      const known = await this.library.albumByMbid(r.mbid);
      if (known?.albumId !== undefined) result.set(r.mbid, { state: 'available', albumId: known.albumId });
```

Then confirm nothing else uses the old fields:

Run: `grep -rn "\.playable\|known?\.id\|known\.id" apps/server/src`
Expected: no output.

**Step 4: Typecheck and run all server tests**

Run: `corepack pnpm -C apps/server typecheck && corepack pnpm -C apps/server test`
Expected: typecheck clean; all test files pass (the 3 existing files with 25 tests, plus the 4 new ones).

**Step 5: Check the production build still keeps `node:` prefixes**

Run: `corepack pnpm -C apps/server build && grep -c "node:sqlite" apps/server/dist/index.js`
Expected: build succeeds; count ≥ 1 (PLAN.md 2026-10-29: tsup once stripped it).

**Step 6: Commit**

```bash
git add apps/server/src/library/library.ts apps/server/src/index.ts apps/server/src/discover/requests.ts
git commit -m "Library is built from the SQLite catalog, with Lidarr as its first source"
```

---

### Task 7: Verify nothing changed for the user

**Step 1: Compare against the baseline**

Start the server as in Task 0 and wait for `Library refreshed`. Then:

```bash
mkdir -p /tmp/playarr-after && cd /tmp/playarr-after
# same commands as Task 0 step 2, writing here
api=http://localhost:4000/api
sorted='if type=="array" then sort_by(.id) else . end'
curl -s $api/artists | jq -S "$sorted" > artists.json
curl -s $api/albums | jq -S "$sorted" > albums.json
curl -s $api/favorites | jq -S . > favorites.json
curl -s $api/playlists | jq -S "$sorted" > playlists.json
curl -s $api/albums | jq -r '.[].id' | while read id; do curl -s $api/albums/$id; done | jq -S -s 'sort_by(.id)' > album-details.json
curl -s $api/artists | jq -r '.[].id' | while read id; do curl -s $api/artists/$id; done | jq -S -s 'sort_by(.id)' > artist-details.json
diff -r /tmp/playarr-baseline /tmp/playarr-after && echo IDENTICAL
```

Expected: `IDENTICAL`. If something differs, it is a bug in Tasks 4 to 6: fix it (test first) rather than accepting the diff. The one tolerated difference: the order of tracks inside `artist-details` for two albums with the same release date. Investigate anything else.

**Step 2: Restart and check the stored catalog serves immediately**

Stop the server, start it again, and in the first seconds:

```bash
curl -s localhost:4000/api/albums | jq length
```

Expected: the full album count before `Library refreshed` is logged (log shows `Library loaded from the database`).

**Step 3: Stream a file and check the range response**

```bash
id=$(curl -s localhost:4000/api/tracks/random?limit=1 | jq -r '.[0].fileId')
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' -H 'Range: bytes=0-1023' localhost:4000/stream/$id
```

Expected: `206 1024`.

**Step 4: Run the web smoke tests against the running server**

Run: `corepack pnpm -C apps/web test`
Expected: all pass.

Stop the server. No commit (nothing changed), unless a fix was needed: then commit the fix with its test.

---

### Task 8: Record the change in the docs

**Files:**
- Modify: `PLAN.md` (decisions log; Phase 1 note)
- Modify: `docs/plans/2026-10-30-sources-design.md` (Migration paragraph)

**Step 1: PLAN.md**

Add to the decisions log table (§12), keeping its style:

```
| 2026-10-30 | Catalog moved to SQLite (`sources`, `catalog_artists/albums/tracks`, `copies`), fed by source adapters; Lidarr is the first (design: `docs/plans/2026-10-30-sources-design.md`). New rows take the Lidarr id when it's free, so existing links, saved queues and offline songs keep their ids with no migration. The JSON snapshot `.cache/library.json` is no longer used (safe to delete). |
```

**Step 2: Design doc**

In `docs/plans/2026-10-30-sources-design.md`, replace the **Migration** paragraph with:

```
**Migration.** New catalog rows take the Lidarr id (artists, albums, tracks) or Lidarr track-file id (copies) as their Playarr id when it's free. On an existing install every id stays the same, so links, saved queues and the offline song cache need no migration. Catalog rows are never deleted and ids are never reused. On first start, the `.env` Lidarr settings become a Lidarr source.
```

**Step 3: Commit**

```bash
git add PLAN.md docs/plans/2026-10-30-sources-design.md
git commit -m "PLAN: catalog in SQLite, ids seeded from Lidarr"
```

---

## Later phases (separate plans)

Write each plan when the previous phase has landed:

2. **Settings shell and Lidarr source:** `/settings/:panel` route, gear entry points, Sources panel listing sources from `sources`, Lidarr URL and key moved from `.env` into `sources.settings` (seeded from `.env` once), write-only secrets, local-network guard on the settings API.
3. **Folder sources on this server:** scanner (size + mtime), tag reading, embedded and folder artwork route, same-physical-file detection against Lidarr copies, loose songs, partial albums with greyed tracks and "1 of 12", per-source path roots for `/stream`, `/host` mount in `docker/compose.yaml`.
4. **Matching:** MusicBrainz album lookup with scoring, Chromaprint and AcoustID, review list, `fixes` table.
5. **SSH and SFTP folder sources.**
6. **Network shares.**
