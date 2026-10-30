# Sources, Phase 3: Folder Sources Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let Settings add folders on the server as catalog sources: scan them, read their tags, merge their songs with Lidarr's, stream and show artwork from them, and show partial albums (missing songs greyed out, "3 of 12" on album cards, loose songs grouped under their artist).

**Architecture:** A `FolderSource` adapter walks a folder, reads tags with `music-metadata` (cached per file by size and modified time in a new `folder_files` table) and maps files to the catalog with a pure `folderSync()` function. To merge with what's already there, `folderSync` looks names up in a `NameIndex` built from the catalog (artist names, album names, song titles, preferring MusicBrainz-keyed rows). Catalog rows now remember how trusted their metadata is (`meta_rank`: Lidarr 0, folder tags 2), so a folder scan never overwrites Lidarr's data. A `FileResolver` decides how to read each copy (Lidarr files through `MEDIA_SOURCE` + `PATH_MAP`, folder files from local disk inside the folder), used by streaming, song analysis and a new `/art/copy/:id` artwork route. A `source_tracks` table records which songs each source reported, so albums can list the songs nobody has a file for.

**Tech Stack:** Node 25, Fastify 5, `node:sqlite`, `music-metadata` 12 (new), zod 4, vitest 5; React 19, TanStack Query 5, Tailwind 4. pnpm via `corepack pnpm`.

**Design:** `docs/plans/2026-10-30-sources-design.md` (Scanning and matching; Loose songs; Partial albums; Artwork; Missing files; Rollout phase 3). Builds on Phases 1 and 2 (implemented): `apps/server/src/catalog/*`, `SourceManager`, `/api/settings/sources`, `SourcesPanel`.

## Decisions and deviations from the design

- **Same physical file seen twice:** the design said to detect a folder file that is also a Lidarr file and keep only the Lidarr copy. This plan doesn't detect it: both copies attach to the same song (by MusicBrainz id, or by artist/album/title through the name index), and best-copy choice plays the Lidarr one on a tie (it's first in the source order by default). Same result for the listener, no fragile path comparison across Docker mounts. The cost: Settings counts that song for both sources.
- **Song ids for untagged files** are `local:<hash of artist|title>` (stable across moves and rescans) instead of an audio fingerprint; fingerprints arrive with matching in phase 4.
- **Missing songs** come from Lidarr in this phase (Lidarr knows full track lists). Folder albums get full track lists once matched to MusicBrainz in phase 4. No Request button on missing songs yet.
- **Metadata precedence** (`meta_rank`) and **reported songs** (`source_tracks`) are additions the design implied but Phase 1 didn't build.
- **Sync order:** sources now sync one after the other, in Settings order, so a folder scan can match against what Lidarr just reported.

## Conventions

- Run everything from `/Users/bortignon/dev/playarr`.
- Server tests: `corepack pnpm -C apps/server test`; one file: `corepack pnpm -C apps/server exec vitest run src/catalog/folder.test.ts`.
- Server typecheck: `corepack pnpm -C apps/server typecheck`. Web: `corepack pnpm -C apps/web exec tsc --noEmit`; web build: `corepack pnpm -C apps/web exec vite build`.
- No live checks (no `.env`, no Lidarr); ffmpeg isn't installed locally. Tests use small FLAC files built in code (verified to parse with music-metadata 12.3.2).
- Commit after every task directly on `main`, staging only that task's files, then push: `git push origin main`. If the push fails (credentials), keep going and report it.

---

### Task 1: Dependency and shared types

**Files:**
- Modify: `apps/server/package.json`, `pnpm-lock.yaml` (via pnpm)
- Modify: `packages/shared/src/index.ts`

**Step 1: Add music-metadata**

Run: `corepack pnpm -C apps/server add music-metadata@^12.3.2`
Expected: `music-metadata` in `apps/server/package.json` dependencies.

**Step 2: Shared types**

In `packages/shared/src/index.ts`, add after `AlbumDetail`'s definition:

```ts
/** A song on an album that no source has a file for. */
export interface MissingTrack {
  recordingId: string;
  title: string;
  trackNumber: number;
  discNumber: number;
  duration: number; // seconds
}
```

and add a field to `AlbumDetail`:

```ts
  /** Songs on this album that aren't in the library (shown greyed out). */
  missingTracks: MissingTrack[];
```

In `SourceInfo`, change `settings` to:

```ts
  settings?: { url?: string; path?: string };
```

In `SourceInput`, change `settings` to:

```ts
  /** Lidarr: url and apiKey (leaving apiKey out keeps the saved one). Folder: path. */
  settings?: { url?: string; apiKey?: string; path?: string };
```

Append:

```ts
/** A folder on the server, for choosing a folder source. */
export interface FolderListing {
  /** null: the list of folders sources may use (FOLDER_ROOTS). */
  path: string | null;
  /** Where "up" goes; null: back to that list. */
  parent: string | null;
  folders: { name: string; path: string }[];
  /** Audio files directly in this folder. */
  audioFiles: number;
}
```

**Step 3: Typecheck**

Run: `corepack pnpm -C apps/server typecheck; corepack pnpm -C apps/web exec tsc --noEmit`
Expected: server fails in `catalog/build.ts` (`missingTracks` missing in `toAlbumDetail`). Fixed in Task 8; note it. Web clean.

**Step 4: Commit and push**

```bash
git add apps/server/package.json pnpm-lock.yaml packages/shared/src/index.ts
git commit -m "Folder sources: music-metadata dependency and shared types"
git push origin main
```

---

### Task 2: Database: metadata trust, reported songs, folder file cache

**Files:**
- Modify: `apps/server/src/db.ts`, `apps/server/src/db.test.ts`

**Step 1: Failing test** (add to `describe('migrate')`):

```ts
  it('adds metadata trust, reported songs and the folder file cache', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    for (const t of ['catalog_artists', 'catalog_albums', 'catalog_tracks']) expect(cols(t)).toContain('meta_rank');
    expect(cols('source_tracks')).toEqual(['source_id', 'track_id']);
    expect(cols('folder_files')).toEqual(['source_id', 'rel_path', 'size', 'mtime_ms', 'tags']);
  });
```

**Step 2:** Run `corepack pnpm -C apps/server exec vitest run src/db.test.ts`. Expected: FAIL.

**Step 3: Implement**: append to `MIGRATIONS`:

```ts
  // How trusted each catalog row's metadata is (lower wins: Lidarr 0, folder tags 2), which songs
  // each source reported in its last sync (to list missing songs), and folder scans' tag cache.
  `ALTER TABLE catalog_artists ADD COLUMN meta_rank INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE catalog_albums ADD COLUMN meta_rank INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE catalog_tracks ADD COLUMN meta_rank INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE source_tracks (
     source_id INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
     track_id  INTEGER NOT NULL REFERENCES catalog_tracks (id),
     PRIMARY KEY (source_id, track_id)
   );
   CREATE TABLE folder_files (
     source_id INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
     rel_path  TEXT NOT NULL,
     size      INTEGER NOT NULL,
     mtime_ms  INTEGER NOT NULL,
     tags      TEXT,
     PRIMARY KEY (source_id, rel_path)
   );`,
```

**Step 4:** Run the test. Expected: PASS (4 tests).

**Step 5: Commit and push**

```bash
git add apps/server/src/db.ts apps/server/src/db.test.ts
git commit -m "Database: metadata trust, reported songs, folder file cache"
git push origin main
```

---

### Task 3: Reading tags

**Files:**
- Create: `apps/server/src/catalog/tags.ts`
- Modify: `apps/server/src/catalog/testFixtures.ts`
- Test: `apps/server/src/catalog/tags.test.ts`

**Step 1: Test helpers** (append to `testFixtures.ts`):

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A tiny FLAC file (no audio frames) with Vorbis comments; music-metadata reads its tags and duration. */
export function flacBytes(tags: Record<string, string> = {}, seconds = 200): Buffer {
  const block = (type: number, body: Buffer, last: boolean) => {
    const header = Buffer.alloc(4);
    header[0] = (last ? 0x80 : 0) | type;
    header.writeUIntBE(body.length, 1, 3);
    return Buffer.concat([header, body]);
  };
  const streamInfo = Buffer.alloc(34);
  streamInfo.writeUInt16BE(4096, 0);
  streamInfo.writeUInt16BE(4096, 2);
  // 44.1 kHz, 2 channels, 16 bits, total samples.
  streamInfo.writeBigUInt64BE((44100n << 44n) | (1n << 41n) | (15n << 36n) | BigInt(44100 * seconds), 10);
  const vendor = Buffer.from('playarr-test');
  const comments = Object.entries(tags).map(([k, v]) => Buffer.from(`${k}=${v}`));
  const parts: Buffer[] = [Buffer.alloc(4), vendor, Buffer.alloc(4)];
  parts[0]!.writeUInt32LE(vendor.length);
  parts[2]!.writeUInt32LE(comments.length);
  for (const c of comments) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(c.length);
    parts.push(len, c);
  }
  return Buffer.concat([Buffer.from('fLaC'), block(0, streamInfo, false), block(4, Buffer.concat(parts), true)]);
}

/** A fresh temporary folder, and a function that deletes it. */
export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'playarr-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
```

(Merge the `node:fs`/`node:path` imports with the file's existing imports.)

**Step 2: Failing tests**

```ts
// apps/server/src/catalog/tags.test.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTags } from './tags.ts';
import { flacBytes, tempDir } from './testFixtures.ts';

let cleanup = () => {};
afterEach(() => cleanup());

function file(name: string, bytes: Buffer) {
  const t = tempDir();
  cleanup = t.cleanup;
  const path = join(t.dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe('readTags', () => {
  it('reads tags, MusicBrainz ids and the audio format', async () => {
    const path = file(
      '01.flac',
      flacBytes({
        TITLE: 'Angel',
        ARTIST: 'Massive Attack',
        ALBUMARTIST: 'Massive Attack',
        ALBUM: 'Mezzanine',
        TRACKNUMBER: '1',
        TRACKTOTAL: '11',
        DISCNUMBER: '1',
        DATE: '1998',
        GENRE: 'Trip Hop',
        MUSICBRAINZ_TRACKID: 'rec-1',
        MUSICBRAINZ_RELEASEGROUPID: 'rg-1',
        MUSICBRAINZ_ALBUMARTISTID: 'art-1',
      }),
    );
    expect(await readTags(path)).toEqual({
      title: 'Angel',
      artist: 'Massive Attack',
      albumArtist: 'Massive Attack',
      album: 'Mezzanine',
      trackNumber: 1,
      trackTotal: 11,
      discNumber: 1,
      year: 1998,
      genres: ['Trip Hop'],
      duration: 200,
      recordingMbid: 'rec-1',
      releaseGroupMbid: 'rg-1',
      albumArtistMbid: 'art-1',
      format: { codec: 'FLAC', container: 'flac', bits: 16, sampleRate: 44100, channels: 2, lossless: true },
    });
  });

  it('reads a file without tags', async () => {
    const tags = await readTags(file('x.flac', flacBytes()));
    expect(tags).toMatchObject({ genres: [], duration: 200, format: { codec: 'FLAC' } });
    expect(tags!.title).toBeUndefined();
  });

  it('returns null for a file that is not audio', async () => {
    expect(await readTags(file('broken.mp3', Buffer.from('not audio at all')))).toBeNull();
  });
});
```

**Step 3:** Run `corepack pnpm -C apps/server exec vitest run src/catalog/tags.test.ts`. Expected: FAIL (no `tags.ts`).

**Step 4: Implement**

```ts
// apps/server/src/catalog/tags.ts
import type { AudioFormat } from '@playarr/shared';
import { parseFile } from 'music-metadata';
import { extname } from 'node:path';

/** What a folder file says about itself. Stored as JSON in folder_files. */
export interface TagInfo {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  trackNumber?: number;
  trackTotal?: number;
  discNumber?: number;
  year?: number;
  genres: string[];
  duration: number; // seconds
  recordingMbid?: string;
  releaseGroupMbid?: string;
  artistMbid?: string;
  albumArtistMbid?: string;
  format: AudioFormat;
}

const LOSSLESS = new Set(['FLAC', 'ALAC', 'PCM', 'WAV', 'AIFF', 'WAVPACK']);

/** Tags and format of an audio file; null if it isn't readable audio. */
export async function readTags(path: string): Promise<TagInfo | null> {
  const { format: f, common: c } = await parseFile(path, { skipCovers: true });
  if (!f.codec && !f.duration) return null;
  const container = extname(path).slice(1).toLowerCase();
  const codec = codecName(f.codec, container);
  const tags: TagInfo = {
    title: c.title || undefined,
    artist: c.artist || undefined,
    albumArtist: c.albumartist || undefined,
    album: c.album || undefined,
    trackNumber: c.track.no ?? undefined,
    trackTotal: c.track.of ?? undefined,
    discNumber: c.disk.no ?? undefined,
    year: c.year || undefined,
    genres: c.genre ?? [],
    duration: Math.round(f.duration ?? 0),
    recordingMbid: c.musicbrainz_recordingid || undefined,
    releaseGroupMbid: c.musicbrainz_releasegroupid || undefined,
    artistMbid: c.musicbrainz_artistid?.[0] || undefined,
    albumArtistMbid: c.musicbrainz_albumartistid?.[0] || undefined,
    format: {
      codec,
      container,
      bits: f.bitsPerSample || undefined,
      sampleRate: f.sampleRate || undefined,
      bitrate: f.bitrate ? Math.round(f.bitrate / 1000) : undefined,
      channels: f.numberOfChannels || undefined,
      lossless: f.lossless ?? LOSSLESS.has(codec),
    },
  };
  // Drop undefined fields so the stored JSON (and test expectations) stay small.
  return JSON.parse(JSON.stringify(tags)) as TagInfo;
}

/** music-metadata says "MPEG 1 Layer 3"; the app's format badges expect "MP3". */
function codecName(codec: string | undefined, container: string): string {
  const c = (codec ?? '').toLowerCase();
  if (c.includes('layer 3')) return 'MP3';
  if (c.includes('flac')) return 'FLAC';
  if (c.includes('alac')) return 'ALAC';
  if (c.includes('aac') || c.includes('mp4a')) return 'AAC';
  if (c.includes('opus')) return 'OPUS';
  if (c.includes('vorbis')) return 'VORBIS';
  if (c.includes('pcm')) return 'PCM';
  return (codec || container).toUpperCase();
}
```

**Step 5:** Run the test. Expected: PASS (3 tests). If `channels`/`bitrate` differ from the expectation (bitrate is 0 for frame-less fixtures, so it's dropped), adjust only the expectation, not the code.

**Step 6: Commit and push**

```bash
git add apps/server/src/catalog/tags.ts apps/server/src/catalog/tags.test.ts apps/server/src/catalog/testFixtures.ts
git commit -m "Folder sources: read tags and audio format with music-metadata"
git push origin main
```

---

### Task 4: Store: metadata trust, reported songs, folder cache, name index

**Files:**
- Modify: `apps/server/src/catalog/types.ts`, `apps/server/src/catalog/keys.ts`, `apps/server/src/catalog/store.ts`
- Modify: `apps/server/src/catalog/store.test.ts`

**Step 1: Types and a song key**

In `types.ts`, add to `SourceSync`:

```ts
  /** How much this source's metadata is trusted: lower wins (Lidarr 0, folder tags 2). Default 0. */
  metaRank?: number;
```

and append:

```ts
/** A song already in the catalog, as the name index finds it. */
export interface KnownTrack {
  key: string;
  recordingId: string;
  albumKey: string;
  albumTitle: string;
  artistKey: string;
  artistName: string;
}

/** The catalog by name, so untagged folder files can join what's already there. */
export interface NameIndex {
  /** normalize(artist name) → artist */
  artists: Map<string, { key: string; name: string }>;
  /** albumKey(artist, title) from library/search.ts → album */
  albums: Map<string, { key: string; title: string }>;
  /** `${album key}|${normalize(title)}` → song on that album */
  tracks: Map<string, KnownTrack>;
  /** songNameKey(artist, title) → the song on its most "original" album (studio album first) */
  songs: Map<string, KnownTrack>;
}
```

In `keys.ts`, append:

```ts
/** A song by artist and title, ignoring case, accents and punctuation. */
export const songNameKey = (artistName: string, title: string) => `${normalize(artistName)}|${normalize(title)}`;
```

**Step 2: Failing tests** (append to `store.test.ts`; add `albumKey`/`normalize` from `../library/search.ts` and `songNameKey` from `./keys.ts` to the imports):

```ts
describe('CatalogStore: several sources', () => {
  function folderSyncOf(title: string) {
    const s = mezzanine();
    s.metaRank = 2;
    s.albums[0]!.title = title;
    s.copies = s.copies.map((c) => ({ ...c, ref: `folder/${c.ref}`, preferredId: undefined }));
    return s;
  }

  it('keeps the most trusted metadata', () => {
    const store = new CatalogStore(freshDb());
    const lidarr = store.addSource('lidarr', 'Lidarr');
    const folder = store.addSource('folder', 'Music');
    store.applySync(lidarr, mezzanine());
    store.applySync(folder, folderSyncOf('mezzanine (rip)'));
    expect(store.load().albums[0]!.meta.title).toBe('Mezzanine');
    // The other way round: Lidarr arriving later takes over.
    const store2 = new CatalogStore(freshDb());
    const l2 = store2.addSource('lidarr', 'Lidarr');
    const f2 = store2.addSource('folder', 'Music');
    store2.applySync(f2, folderSyncOf('mezzanine (rip)'));
    store2.applySync(l2, mezzanine());
    expect(store2.load().albums[0]!.meta.title).toBe('Mezzanine');
  });

  it('records the songs each source reported, with or without files', () => {
    const store = new CatalogStore(freshDb());
    const id = store.addSource('lidarr', 'Lidarr');
    const sync = mezzanine();
    sync.tracks.push({ ...sync.tracks[0]!, key: 'mb:rg-1#rec-3', preferredId: 702, recordingId: 'rec-3', title: 'Teardrop', trackNumber: 3 });
    store.applySync(id, sync);
    expect(store.load().sourceTracks.map((s) => s.trackId).sort()).toEqual([700, 701, 702]);
    store.applySync(id, mezzanine());
    expect(store.load().sourceTracks.map((s) => s.trackId).sort()).toEqual([700, 701]);
  });

  it('caches folder files and forgets the ones that are gone', () => {
    const store = new CatalogStore(freshDb());
    const id = store.addSource('folder', 'Music');
    const tags = { genres: [], duration: 200, format: { codec: 'FLAC', container: 'flac', lossless: true } };
    store.saveFolderFiles(id, [
      { rel: 'a.flac', size: 1, mtimeMs: 10, tags },
      { rel: 'b.mp3', size: 2, mtimeMs: 20, tags: null },
    ], ['a.flac', 'b.mp3']);
    expect(store.folderFiles(id).get('a.flac')).toEqual({ size: 1, mtimeMs: 10, tags });
    expect(store.folderFiles(id).get('b.mp3')!.tags).toBeNull();
    store.saveFolderFiles(id, [], ['a.flac']);
    expect([...store.folderFiles(id).keys()]).toEqual(['a.flac']);
    store.removeSource(id);
    expect(store.folderFiles(id).size).toBe(0);
  });

  it('indexes the catalog by name, preferring MusicBrainz rows', () => {
    const store = new CatalogStore(freshDb());
    const folder = store.addSource('folder', 'Music');
    const lidarr = store.addSource('lidarr', 'Lidarr');
    // A folder album under name keys first, then the same album from Lidarr under MusicBrainz keys.
    const named = mezzanine();
    named.metaRank = 2;
    named.artists[0] = { ...named.artists[0]!, key: 'name:massive attack', mbid: undefined, preferredId: undefined };
    named.albums[0] = { ...named.albums[0]!, key: 'name:x', artistKey: 'name:massive attack', mbid: undefined, preferredId: undefined };
    named.tracks = named.tracks.map((t) => ({ ...t, key: `name:x#${t.recordingId}`, albumKey: 'name:x', preferredId: undefined }));
    named.copies = named.copies.map((c) => ({ ...c, trackKey: `name:x#${c.trackKey.split('#')[1]}`, preferredId: undefined }));
    store.applySync(folder, named);
    store.applySync(lidarr, mezzanine());

    const index = store.nameIndex();
    expect(index.artists.get(normalize('Massive Attack'))!.key).toBe('mb:art-1');
    expect(index.albums.get(albumKey('Massive Attack', 'Mezzanine'))!.key).toBe('mb:rg-1');
    expect(index.tracks.get(`mb:rg-1|${normalize('Angel')}`)).toMatchObject({ key: 'mb:rg-1#rec-1', recordingId: 'rec-1' });
    expect(index.songs.get(songNameKey('Massive Attack', 'Angel'))).toMatchObject({ albumKey: 'mb:rg-1', albumTitle: 'Mezzanine' });
  });
});
```

**Step 3:** Run `corepack pnpm -C apps/server exec vitest run src/catalog/store.test.ts`. Expected: FAIL.

**Step 4: Implement** in `store.ts`:

Imports: add `import { albumKey as albumNameKey, normalize } from '../library/search.ts';`, `import { songNameKey } from './keys.ts';`, `import type { TagInfo } from './tags.ts';` and `KnownTrack`, `NameIndex` to the `./types.ts` import.

Add to `CatalogRows`:

```ts
  /** Songs each source reported in its last sync (with or without a file). */
  sourceTracks: { sourceId: number; trackId: number }[];
```

and to `load()`'s returned object:

```ts
      sourceTracks: all<{ source_id: number; track_id: number }>('SELECT source_id, track_id FROM source_tracks').map(
        (r) => ({ sourceId: r.source_id, trackId: r.track_id }),
      ),
```

In `applySync`: pass the rank to every `upsert` call (`const rank = sync.metaRank ?? 0;` at the top, then add `rank` as the last argument of the three `upsert` calls), and after the copies loop, before removing unseen copies:

```ts
      // The songs this source reports, including ones it has no file for (missing songs).
      this.db.prepare('DELETE FROM source_tracks WHERE source_id = ?').run(sourceId);
      const report = this.db.prepare('INSERT OR IGNORE INTO source_tracks (source_id, track_id) VALUES (?, ?)');
      for (const trackId of new Set(trackIds.values())) report.run(sourceId, trackId);
```

Replace `upsert` so metadata only changes when the incoming source is at least as trusted:

```ts
  /** Insert or update a catalog row by key; returns its id. Metadata changes only if `rank` is at least as trusted. */
  private upsert(
    table: CatalogTable,
    key: string,
    preferredId: number | undefined,
    columns: Record<string, string | number>,
    meta: object,
    now: string,
    rank: number,
  ): number {
    const names = Object.keys(columns);
    const values = Object.values(columns);
    const existing = this.db.prepare(`SELECT id, meta_rank FROM ${table} WHERE key = ?`).get(key) as
      | { id: number; meta_rank: number }
      | undefined;
    if (existing) {
      if (rank <= existing.meta_rank) {
        const sets = [...names.map((n) => `${n} = ?`), 'meta = ?', 'meta_rank = ?', 'updated_at = ?'].join(', ');
        this.db
          .prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`)
          .run(...values, JSON.stringify(meta), rank, now, existing.id);
      }
      return existing.id;
    }
    const cols = ['id', 'key', ...names, 'meta', 'meta_rank', 'updated_at'];
    const res = this.db
      .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(this.freeId(table, preferredId), key, ...values, JSON.stringify(meta), rank, now);
    return Number(res.lastInsertRowid);
  }
```

In `removeSource`, before deleting the source row:

```ts
      this.db.prepare('DELETE FROM source_tracks WHERE source_id = ?').run(id);
      this.db.prepare('DELETE FROM folder_files WHERE source_id = ?').run(id);
```

Add the folder cache and the name index:

```ts
  /** The last scan's view of a folder source's files, by path relative to the folder. */
  folderFiles(sourceId: number): Map<string, { size: number; mtimeMs: number; tags: TagInfo | null }> {
    const rows = this.db
      .prepare('SELECT rel_path, size, mtime_ms, tags FROM folder_files WHERE source_id = ?')
      .all(sourceId) as { rel_path: string; size: number; mtime_ms: number; tags: string | null }[];
    return new Map(
      rows.map((r) => [r.rel_path, { size: r.size, mtimeMs: r.mtime_ms, tags: r.tags ? (JSON.parse(r.tags) as TagInfo) : null }]),
    );
  }

  /** Save newly read files and forget files that are no longer `present`. */
  saveFolderFiles(
    sourceId: number,
    changed: { rel: string; size: number; mtimeMs: number; tags: TagInfo | null }[],
    present: string[],
  ) {
    this.db.exec('BEGIN');
    try {
      const save = this.db.prepare(
        `INSERT INTO folder_files (source_id, rel_path, size, mtime_ms, tags) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (source_id, rel_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, tags = excluded.tags`,
      );
      for (const f of changed) save.run(sourceId, f.rel, f.size, f.mtimeMs, f.tags ? JSON.stringify(f.tags) : null);
      const keep = new Set(present);
      const remove = this.db.prepare('DELETE FROM folder_files WHERE source_id = ? AND rel_path = ?');
      for (const rel of this.folderFiles(sourceId).keys()) if (!keep.has(rel)) remove.run(sourceId, rel);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The catalog by name. MusicBrainz-keyed rows win over name-keyed ones; songs prefer studio albums. */
  nameIndex(): NameIndex {
    const rows = this.load();
    const artists = new Map(rows.artists.map((a) => [a.id, a]));
    const albums = new Map(rows.albums.map((a) => [a.id, a]));
    const index: NameIndex = { artists: new Map(), albums: new Map(), tracks: new Map(), songs: new Map() };
    const better = (key: string, current?: { key: string }) => !current || (key.startsWith('mb:') && !current.key.startsWith('mb:'));

    for (const a of rows.artists) {
      const k = normalize(a.meta.name);
      if (better(a.key, index.artists.get(k))) index.artists.set(k, { key: a.key, name: a.meta.name });
    }
    const albumRank = (a: (typeof rows.albums)[number]) =>
      a.key.startsWith('loose:') ? 9 : a.meta.albumType === 'Album' && !a.meta.secondaryTypes.length ? 0 : a.meta.albumType === 'EP' ? 1 : a.meta.albumType === 'Single' ? 2 : 3;
    for (const al of rows.albums) {
      const artist = artists.get(al.artistId);
      if (!artist || al.key.startsWith('loose:')) continue;
      const k = albumNameKey(artist.meta.name, al.meta.title);
      if (better(al.key, index.albums.get(k))) index.albums.set(k, { key: al.key, title: al.meta.title });
    }
    const songRank = new Map<string, number>();
    for (const t of rows.tracks) {
      const album = albums.get(t.albumId);
      const artist = album && artists.get(album.artistId);
      if (!album || !artist) continue;
      const known: KnownTrack = {
        key: t.key,
        recordingId: t.recordingId,
        albumKey: album.key,
        albumTitle: album.meta.title,
        artistKey: artist.key,
        artistName: artist.meta.name,
      };
      const tk = `${album.key}|${normalize(t.meta.title)}`;
      if (!index.tracks.has(tk)) index.tracks.set(tk, known);
      if (album.key.startsWith('loose:')) continue;
      const sk = songNameKey(artist.meta.name, t.meta.title);
      const rank = albumRank(album) * 10 + (album.key.startsWith('mb:') ? 0 : 5);
      if (!index.songs.has(sk) || rank < songRank.get(sk)!) {
        index.songs.set(sk, known);
        songRank.set(sk, rank);
      }
    }
    return index;
  }
```

**Step 5:** Run the store tests, then all server tests. Expected: store tests PASS; the whole suite passes except `build.ts` typecheck-level issues don't affect vitest (vitest doesn't typecheck). If any Phase 1/2 test fails, fix before committing.

**Step 6: Commit and push**

```bash
git add apps/server/src/catalog/types.ts apps/server/src/catalog/keys.ts apps/server/src/catalog/store.ts apps/server/src/catalog/store.test.ts
git commit -m "Catalog store: metadata trust, reported songs, folder cache, name index"
git push origin main
```

---

### Task 5: Mapping folder files to the catalog

**Files:**
- Create: `apps/server/src/catalog/folder.ts`
- Test: `apps/server/src/catalog/folder.test.ts`

**Step 1: Failing tests**

```ts
// apps/server/src/catalog/folder.test.ts
import { describe, expect, it } from 'vitest';
import { FOLDER_META_RANK, folderSync, type FolderEntry } from './folder.ts';
import { CatalogStore } from './store.ts';
import type { TagInfo } from './tags.ts';
import { FLAC, freshDb, mezzanine } from './testFixtures.ts';
import type { NameIndex } from './types.ts';

const EMPTY: NameIndex = { artists: new Map(), albums: new Map(), tracks: new Map(), songs: new Map() };

function entry(rel: string, tags: Partial<TagInfo> = {}): FolderEntry {
  return {
    rel,
    path: `/music/${rel}`,
    size: 1000,
    mtimeMs: Date.UTC(2026, 9, 1),
    tags: { genres: [], duration: 200, format: FLAC, ...tags },
  };
}

function lidarrIndex() {
  const store = new CatalogStore(freshDb());
  store.applySync(store.addSource('lidarr', 'Lidarr'), mezzanine());
  return store.nameIndex();
}

describe('folderSync', () => {
  it('uses MusicBrainz ids from tags', () => {
    const sync = folderSync(
      [
        entry('Massive Attack/Mezzanine/01 Angel.flac', {
          title: 'Angel',
          albumArtist: 'Massive Attack',
          album: 'Mezzanine',
          trackNumber: 1,
          trackTotal: 11,
          recordingMbid: 'rec-1',
          releaseGroupMbid: 'rg-1',
          albumArtistMbid: 'art-1',
        }),
      ],
      EMPTY,
    );
    expect(sync.metaRank).toBe(FOLDER_META_RANK);
    expect(sync.artists).toEqual([expect.objectContaining({ key: 'mb:art-1', name: 'Massive Attack' })]);
    expect(sync.albums).toEqual([expect.objectContaining({ key: 'mb:rg-1', title: 'Mezzanine', totalTrackCount: 11 })]);
    expect(sync.tracks).toEqual([expect.objectContaining({ key: 'mb:rg-1#rec-1', recordingId: 'rec-1', trackNumber: 1 })]);
    expect(sync.copies).toEqual([
      expect.objectContaining({
        ref: 'Massive Attack/Mezzanine/01 Angel.flac',
        path: '/music/Massive Attack/Mezzanine/01 Angel.flac',
        trackKey: 'mb:rg-1#rec-1',
        addedAt: '2026-10-01T00:00:00.000Z',
      }),
    ]);
  });

  it('falls back to folder and file names', () => {
    const sync = folderSync([entry('Portishead/1994 - Dummy/03 - Sour Times.flac')], EMPTY);
    expect(sync.artists[0]).toMatchObject({ name: 'Portishead' });
    expect(sync.albums[0]).toMatchObject({ title: 'Dummy', albumType: 'Album' });
    expect(sync.albums[0]!.key.startsWith('name:')).toBe(true);
    expect(sync.tracks[0]).toMatchObject({ title: 'Sour Times', trackNumber: 3, discNumber: 1 });
    expect(sync.tracks[0]!.recordingId).toMatch(/^local:/);
  });

  it('gives untagged songs a stable id', () => {
    const a = folderSync([entry('Portishead/Dummy/03 Sour Times.flac')], EMPTY);
    const b = folderSync([entry('Elsewhere/Portishead/Dummy/Sour Times.flac')], EMPTY);
    expect(b.tracks[0]!.recordingId).toBe(a.tracks[0]!.recordingId);
  });

  it('groups songs without an album as loose songs of their artist', () => {
    const sync = folderSync([entry('Burial/Archangel.flac')], EMPTY);
    expect(sync.albums[0]).toMatchObject({ title: 'Loose songs', albumType: 'Loose' });
    expect(sync.albums[0]!.key).toBe(`loose:${sync.artists[0]!.key}`);
  });

  it('joins untagged files to the library by name', () => {
    const sync = folderSync([entry('Massive Attack/Mezzanine/01 Angel.flac')], lidarrIndex());
    expect(sync.artists[0]!.key).toBe('mb:art-1');
    expect(sync.albums[0]!.key).toBe('mb:rg-1');
    expect(sync.tracks[0]).toMatchObject({ key: 'mb:rg-1#rec-1', recordingId: 'rec-1' });
    expect(sync.copies[0]!.trackKey).toBe('mb:rg-1#rec-1');
  });

  it('files a loose song under the album the library has it on', () => {
    const sync = folderSync([entry('Massive Attack/Angel.flac')], lidarrIndex());
    expect(sync.albums.map((a) => a.key)).toEqual(['mb:rg-1']);
    expect(sync.copies[0]!.trackKey).toBe('mb:rg-1#rec-1');
  });

  it('collects genres and the release year', () => {
    const sync = folderSync(
      [
        entry('A/B/1.flac', { album: 'B', albumArtist: 'A', genres: ['Rock', 'Indie'], year: 2001 }),
        entry('A/B/2.flac', { album: 'B', albumArtist: 'A', genres: ['Rock', 'Shoegaze', 'Noise'] }),
      ],
      EMPTY,
    );
    expect(sync.albums).toHaveLength(1);
    expect(sync.albums[0]).toMatchObject({ genres: ['Rock', 'Indie', 'Shoegaze'], releaseDate: '2001-01-01T00:00:00Z' });
  });
});
```

**Step 2:** Run `corepack pnpm -C apps/server exec vitest run src/catalog/folder.test.ts`. Expected: FAIL.

**Step 3: Implement**

```ts
// apps/server/src/catalog/folder.ts
import { createHash } from 'node:crypto';
import { albumKey as albumNameKey, normalize } from '../library/search.ts';
import { albumKeyFor, artistKeyFor, songNameKey, trackKeyFor } from './keys.ts';
import type { TagInfo } from './tags.ts';
import type { KnownTrack, NameIndex, SourceAlbum, SourceArtist, SourceSync, SourceTrack } from './types.ts';

export interface FolderEntry {
  /** Path relative to the folder source, with "/" separators. */
  rel: string;
  /** Absolute path. */
  path: string;
  size: number;
  mtimeMs: number;
  tags: TagInfo;
}

/** Folder tags are trusted less than Lidarr's metadata (lower wins). */
export const FOLDER_META_RANK = 2;
export const LOOSE_TITLE = 'Loose songs';

/**
 * A folder's files as catalog rows. Tags come first, then folder and file names
 * ("Artist/Album/01 Title.flac"). Untagged files join existing artists, albums and songs by name.
 */
export function folderSync(entries: FolderEntry[], index: NameIndex): SourceSync {
  const artists = new Map<string, SourceArtist>();
  const albums = new Map<string, SourceAlbum>();
  const tracks = new Map<string, SourceTrack>();
  const sync: SourceSync = { artists: [], albums: [], tracks: [], copies: [], metaRank: FOLDER_META_RANK };

  for (const e of [...entries].sort((a, b) => a.rel.localeCompare(b.rel))) {
    const t = e.tags;
    const parts = e.rel.split('/');
    const fileName = parts.at(-1)!;
    const dirs = parts.slice(0, -1);
    const folderArtist = dirs.length >= 2 ? dirs.at(-2) : dirs[0];
    const folderAlbum = dirs.length >= 2 ? cleanFolderAlbum(dirs.at(-1)!) : undefined;

    let artistName = t.albumArtist || t.artist || folderArtist || 'Unknown artist';
    const albumTitle = t.album || folderAlbum;
    const title = t.title || titleFromFile(fileName);
    let artistKey = t.albumArtistMbid
      ? `mb:${t.albumArtistMbid}`
      : (index.artists.get(normalize(artistName))?.key ?? artistKeyFor(undefined, artistName));

    let albumKey: string;
    let albumName: string;
    let known: KnownTrack | undefined;
    if (albumTitle) {
      albumName = albumTitle;
      albumKey = t.releaseGroupMbid
        ? `mb:${t.releaseGroupMbid}`
        : (index.albums.get(albumNameKey(artistName, albumTitle))?.key ?? albumKeyFor(undefined, artistName, albumTitle));
      known = index.tracks.get(`${albumKey}|${normalize(title)}`);
    } else {
      // A loose song: file it under the album the library already has it on, else under "Loose songs".
      known = index.songs.get(songNameKey(artistName, title));
      if (known) {
        artistKey = known.artistKey;
        artistName = known.artistName;
        albumKey = known.albumKey;
        albumName = known.albumTitle;
      } else {
        albumKey = `loose:${artistKey}`;
        albumName = LOOSE_TITLE;
      }
    }

    const recordingId = t.recordingMbid || known?.recordingId || `local:${hash(songNameKey(artistName, title))}`;
    const trackKey = known?.key ?? trackKeyFor(albumKey, recordingId);

    if (!artists.has(artistKey)) {
      artists.set(artistKey, { key: artistKey, mbid: t.albumArtistMbid, name: artistName, sortName: artistName, genres: [] });
    }
    let album = albums.get(albumKey);
    if (!album) {
      album = {
        key: albumKey,
        artistKey,
        mbid: albumTitle ? t.releaseGroupMbid : undefined,
        title: albumName,
        albumType: albumKey.startsWith('loose:') ? 'Loose' : 'Album',
        secondaryTypes: [],
        releaseDate: t.year ? `${t.year}-01-01T00:00:00Z` : undefined,
        genres: [],
      };
      albums.set(albumKey, album);
    }
    album.releaseDate ??= t.year ? `${t.year}-01-01T00:00:00Z` : undefined;
    for (const g of t.genres) if (album.genres.length < 3 && !album.genres.includes(g)) album.genres.push(g);
    if (t.trackTotal && (album.totalTrackCount ?? 0) < t.trackTotal) album.totalTrackCount = t.trackTotal;

    if (!tracks.has(trackKey)) {
      tracks.set(trackKey, {
        key: trackKey,
        albumKey,
        recordingId,
        title,
        trackNumber: t.trackNumber ?? trackNumberFromFile(fileName),
        discNumber: t.discNumber ?? 1,
        duration: t.duration,
        explicit: false,
      });
    }
    sync.copies.push({
      ref: e.rel,
      trackKey,
      path: e.path,
      size: e.size,
      format: t.format,
      addedAt: new Date(e.mtimeMs).toISOString(),
    });
  }

  sync.artists = [...artists.values()];
  sync.albums = [...albums.values()];
  sync.tracks = [...tracks.values()];
  return sync;
}

const stem = (fileName: string) => fileName.replace(/\.[^.]+$/, '');

/** "03 - Sour Times.flac" → "Sour Times". */
function titleFromFile(fileName: string): string {
  const name = stem(fileName);
  return name.replace(/^\d{1,3}\s*[-._)]?\s*/, '').trim() || name;
}

function trackNumberFromFile(fileName: string): number {
  return Number(stem(fileName).match(/^(\d{1,3})/)?.[1] ?? 0);
}

/** "1994 - Dummy" or "Dummy (1994) [FLAC]" → "Dummy". */
function cleanFolderAlbum(name: string): string {
  const cleaned = name
    .replace(/^\(?\d{4}\)?\s*[-–.]\s*/, '')
    .replace(/(\s*[([](\d{4}|flac|mp3|320|v0|web|cd|vinyl|24bit[^)\]]*)[)\]])+\s*$/i, '')
    .trim();
  return cleaned || name;
}

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);
```

**Step 4:** Run the tests. Expected: PASS (7 tests).

**Step 5: Commit and push**

```bash
git add apps/server/src/catalog/folder.ts apps/server/src/catalog/folder.test.ts
git commit -m "Folder sources: map files to artists, albums and songs, joining the library by name"
git push origin main
```

---

### Task 6: The folder scanner

**Files:**
- Create: `apps/server/src/catalog/folderSource.ts`
- Test: `apps/server/src/catalog/folderSource.test.ts`

**Step 1: Failing tests**

```ts
// apps/server/src/catalog/folderSource.test.ts
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FolderSource } from './folderSource.ts';
import { CatalogStore } from './store.ts';
import { readTags } from './tags.ts';
import { flacBytes, freshDb, tempDir } from './testFixtures.ts';

let cleanup = () => {};
afterEach(() => cleanup());

function setup() {
  const t = tempDir();
  cleanup = t.cleanup;
  const put = (rel: string, bytes: Buffer) => {
    mkdirSync(dirname(join(t.dir, rel)), { recursive: true });
    writeFileSync(join(t.dir, rel), bytes);
  };
  put('Massive Attack/Mezzanine/01 Angel.flac', flacBytes({ TITLE: 'Angel', ALBUM: 'Mezzanine', ALBUMARTIST: 'Massive Attack' }));
  put('Burial/Archangel.flac', flacBytes());
  put('.hidden/secret.flac', flacBytes());
  put('notes.txt', Buffer.from('hello'));
  put('broken.mp3', Buffer.from('not audio'));
  const store = new CatalogStore(freshDb());
  const sourceId = store.addSource('folder', 'Music', { path: t.dir });
  const read = vi.fn(readTags);
  const source = new FolderSource({ sourceId, root: t.dir, store, readTags: read });
  return { dir: t.dir, put, store, sourceId, read, source };
}

describe('FolderSource', () => {
  it('finds audio files, skipping hidden ones, other files and unreadable audio', async () => {
    const { source, read } = setup();
    const sync = await source.sync();
    expect(sync.copies.map((c) => c.ref)).toEqual(['Burial/Archangel.flac', 'Massive Attack/Mezzanine/01 Angel.flac']);
    expect(read).toHaveBeenCalledTimes(3); // the two FLACs and broken.mp3
  });

  it('only reads files that changed since the last scan', async () => {
    const { source, read, dir } = setup();
    await source.sync();
    read.mockClear();
    await source.sync();
    expect(read).not.toHaveBeenCalled();
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, 'Burial/Archangel.flac'), later, later);
    await source.sync();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('forgets files that were deleted', async () => {
    const { source, dir, store, sourceId } = setup();
    await source.sync();
    rmSync(join(dir, 'Burial/Archangel.flac'));
    const sync = await source.sync();
    expect(sync.copies.map((c) => c.ref)).toEqual(['Massive Attack/Mezzanine/01 Angel.flac']);
    expect(store.folderFiles(sourceId).has('Burial/Archangel.flac')).toBe(false);
  });

  it('fails when the folder is gone, so the last scan stays in the catalog', async () => {
    const { store, sourceId } = setup();
    const source = new FolderSource({ sourceId, root: '/nonexistent/playarr', store });
    await expect(source.sync()).rejects.toThrow(/Folder not found/);
  });
});
```

**Step 2:** Run it. Expected: FAIL.

**Step 3: Implement**

```ts
// apps/server/src/catalog/folderSource.ts
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { folderSync, type FolderEntry } from './folder.ts';
import type { CatalogStore } from './store.ts';
import { readTags, type TagInfo } from './tags.ts';
import type { CatalogSource, SourceSync } from './types.ts';

export const AUDIO_EXTENSIONS = new Set(['flac', 'mp3', 'm4a', 'm4b', 'aac', 'ogg', 'oga', 'opus', 'wav', 'aif', 'aiff']);

export const isAudioFile = (name: string) => AUDIO_EXTENSIONS.has(name.split('.').pop()?.toLowerCase() ?? '');

interface FoundFile {
  rel: string;
  path: string;
  size: number;
  mtimeMs: number;
}

/** A folder on this server as a catalog source. Tags are re-read only for files that changed. */
export class FolderSource implements CatalogSource {
  readonly kind = 'folder' as const;

  constructor(
    private readonly opts: {
      sourceId: number;
      root: string;
      store: CatalogStore;
      readTags?: (path: string) => Promise<TagInfo | null>;
      concurrency?: number;
    },
  ) {}

  async sync(): Promise<SourceSync> {
    const { sourceId, root, store } = this.opts;
    const read = this.opts.readTags ?? readTags;
    // A missing folder usually means a drive or mount is offline: fail, so the last scan stays.
    if (!(await stat(root).catch(() => null))?.isDirectory()) throw new Error(`Folder not found: ${root}`);

    const files = await listAudioFiles(root);
    const cache = store.folderFiles(sourceId);
    const changed: { rel: string; size: number; mtimeMs: number; tags: TagInfo | null }[] = [];
    const entries: FolderEntry[] = [];
    await forEachLimit(files, this.opts.concurrency ?? 8, async (f) => {
      const cached = cache.get(f.rel);
      let tags: TagInfo | null;
      if (cached && cached.size === f.size && cached.mtimeMs === f.mtimeMs) {
        tags = cached.tags;
      } else {
        tags = await read(f.path).catch(() => null);
        changed.push({ ...f, tags });
      }
      if (tags) entries.push({ ...f, tags });
    });
    store.saveFolderFiles(sourceId, changed, files.map((f) => f.rel));
    return folderSync(entries, store.nameIndex());
  }
}

/** Audio files under `root`, skipping hidden files and folders, not following symlinks. */
export async function listAudioFiles(root: string): Promise<FoundFile[]> {
  const found: FoundFile[] = [];
  async function walk(dir: string, rel: string) {
    const items = await readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const path = join(dir, item.name);
      const itemRel = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(path, itemRel);
      else if (item.isFile() && isAudioFile(item.name)) {
        const s = await stat(path).catch(() => null);
        if (s) found.push({ rel: itemRel, path, size: s.size, mtimeMs: Math.floor(s.mtimeMs) });
      }
    }
  }
  await walk(root, '');
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}
```

**Step 4:** Run the tests. Expected: PASS (4 tests).

**Step 5: Commit and push**

```bash
git add apps/server/src/catalog/folderSource.ts apps/server/src/catalog/folderSource.test.ts
git commit -m "Folder sources: scanner with a per-file tag cache"
git push origin main
```

---

### Task 7: Library syncs sources one after the other, in order

**Files:**
- Modify: `apps/server/src/library/library.ts`, `apps/server/src/library/library.test.ts`

**Step 1: Failing test** (add to `library.test.ts`):

```ts
  it('syncs sources in order, so later ones see what earlier ones reported', async () => {
    const store = new CatalogStore(freshDb());
    const a = store.addSource('lidarr', 'Lidarr');
    const b = store.addSource('folder', 'Drive');
    const seen: number[] = [];
    const later: CatalogSource = {
      kind: 'folder',
      sync: async () => {
        seen.push(store.load().copies.length);
        return { artists: [], albums: [], tracks: [], copies: [] };
      },
    };
    const library = new Library(store, () => [{ id: a, source: ok }, { id: b, source: later }], log);
    await library.refresh();
    expect(seen).toEqual([2]);
  });
```

**Step 2:** Run `corepack pnpm -C apps/server exec vitest run src/library/library.test.ts`. Expected: FAIL (`seen` is `[0]`: sources run in parallel).

**Step 3: Implement**: replace the body of `build()`:

```ts
  private async build(): Promise<Snapshot> {
    const sources = this.sources();
    const failures: Error[] = [];
    // In Settings order: later sources match their files against what earlier ones reported.
    for (const { id, source } of sources) {
      try {
        this.store.applySync(id, await source.sync());
        this.store.setSyncError(id, null);
      } catch (err) {
        this.store.setSyncError(id, (err as Error).message);
        failures.push(err as Error);
      }
    }
    // One unreachable source shouldn't hide the others: its last sync stays in the catalog.
    if (failures.length && failures.length === sources.length) throw failures[0];
    for (const err of failures) this.log.error(`A source failed to sync: ${err.message}`);
    return toSnapshot(buildCatalog(this.store.load()));
  }
```

**Step 4:** Run the tests. Expected: PASS (4 tests).

**Step 5: Commit and push**

```bash
git add apps/server/src/library/library.ts apps/server/src/library/library.test.ts
git commit -m "Library: sync sources one after the other, in Settings order"
git push origin main
```

---

### Task 8: Missing songs and folder artwork in the built catalog

**Files:**
- Modify: `apps/server/src/catalog/build.ts`, `apps/server/src/catalog/build.test.ts`

**Step 1: Failing tests** (add inside `describe('buildCatalog')`):

```ts
  it('lists the songs a source reports without a file', () => {
    const { store } = lidarrOnly();
    const sync = mezzanine();
    sync.tracks.push({ ...sync.tracks[1]!, key: 'mb:rg-1#rec-3', preferredId: 702, recordingId: 'rec-3', title: 'Teardrop', trackNumber: 3, duration: 330 });
    store.applySync(1, sync);
    const album = buildCatalog(store.load()).albums.get(70)!;
    expect(album.missingTracks).toEqual([{ recordingId: 'rec-3', title: 'Teardrop', trackNumber: 3, discNumber: 1, duration: 330 }]);
    expect(album.trackCount).toBe(2);
    // No longer reported: no longer missing.
    store.applySync(1, mezzanine());
    expect(buildCatalog(store.load()).albums.get(70)!.missingTracks).toEqual([]);
  });

  it('draws folder albums without artwork from their files', () => {
    const db = freshDb();
    const store = new CatalogStore(db);
    const folder = store.addSource('folder', 'Music');
    const sync = mezzanine();
    sync.copies = sync.copies.map((c) => ({ ...c, preferredId: undefined }));
    store.applySync(folder, sync);
    const album = buildCatalog(store.load()).albums.get(70)!;
    const first = album.tracks[0]!;
    expect(album.coverUrl).toBe(`/art/copy/${first.fileId}`);
    expect(first.coverUrl).toBe(album.coverUrl);
  });
```

Also add `missingTracks: []` to the `toMatchObject` of the first test ('builds albums and tracks the way the API returns them').

**Step 2:** Run `corepack pnpm -C apps/server exec vitest run src/catalog/build.test.ts`. Expected: FAIL.

**Step 3: Implement** in `build.ts`:

- Import `MissingTrack` from `@playarr/shared`.
- After building `copiesByTrack`, add:

```ts
  const kindOf = new Map(rows.sources.map((s) => [s.id, s.kind]));
  // Songs an enabled source reported but nobody has a file for.
  const reported = new Set(rows.sourceTracks.filter((st) => position.has(st.sourceId)).map((st) => st.trackId));
  const missingByAlbum = new Map<number, MissingTrack[]>();
  for (const t of rows.tracks) {
    if (!reported.has(t.id) || copiesByTrack.has(t.id)) continue;
    const list = missingByAlbum.get(t.albumId) ?? [];
    list.push({
      recordingId: t.recordingId,
      title: t.meta.title,
      trackNumber: t.meta.trackNumber,
      discNumber: t.meta.discNumber,
      duration: t.meta.duration,
    });
    missingByAlbum.set(t.albumId, list);
  }
```

- In the albums loop, replace `albums.set(albumId, toAlbumDetail(row, artist, entry.tracks, entry.added));` with:

```ts
    const missing = (missingByAlbum.get(albumId) ?? []).sort(
      (a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber,
    );
    const first = entry.tracks[0]!;
    // Folder albums have no artwork URL of their own: draw it from the first song's file.
    const fallbackCover = kindOf.get(files.get(first.fileId)!.sourceId) === 'folder' ? `/art/copy/${first.fileId}` : undefined;
    const detail = toAlbumDetail(row, artist, entry.tracks, entry.added, missing, fallbackCover);
    for (const t of entry.tracks) t.coverUrl ??= detail.coverUrl;
    albums.set(albumId, detail);
```

- Change `toAlbumDetail`'s signature and three fields:

```ts
function toAlbumDetail(
  row: AlbumRow,
  artist: ArtistRow,
  tracks: Track[],
  added: string[],
  missingTracks: MissingTrack[],
  fallbackCover: string | undefined,
): AlbumDetail {
```

```ts
    totalTrackCount: Math.max(m.totalTrackCount ?? 0, tracks.length + missingTracks.length),
    coverUrl: m.coverUrl ?? fallbackCover,
```

and add `missingTracks,` after `tracks,` in the returned object.

**Step 4:** Run all server tests and typecheck: `corepack pnpm -C apps/server test && corepack pnpm -C apps/server typecheck`. Expected: PASS, clean (this fixes the Task 1 type error).

**Step 5: Commit and push**

```bash
git add apps/server/src/catalog/build.ts apps/server/src/catalog/build.test.ts
git commit -m "Catalog: missing songs on albums, folder album artwork from files"
git push origin main
```

---

### Task 9: Lidarr reports the songs it has no file for

**Files:**
- Modify: `apps/server/src/catalog/lidarr.ts`, `apps/server/src/catalog/lidarr.test.ts`

**Step 1: Failing test** (add to `describe('LidarrSource')`):

```ts
  it('reports missing songs of albums it has files for', async () => {
    const { client } = fakeLidarr();
    (client as unknown as { tracksForArtist: () => Promise<LidarrTrack[]> }).tracksForArtist = async () => [
      track(100, 10, 'rec-1', '1', 1000),
      track(104, 10, 'rec-4', '4', 0), // Mezzanine, no file
      track(103, 11, 'rec-3', '1', 0), // Protection: no files at all
    ];
    const sync = await new LidarrSource(client).sync();
    expect(sync.metaRank).toBe(0);
    expect(sync.albums.map((a) => a.key)).toEqual(['mb:rg-1']);
    expect(sync.tracks.map((t) => t.recordingId)).toEqual(['rec-1', 'rec-4']);
    expect(sync.copies.map((c) => c.trackKey)).toEqual(['mb:rg-1#rec-1']);
  });
```

**Step 2:** Run `corepack pnpm -C apps/server exec vitest run src/catalog/lidarr.test.ts`. Expected: FAIL.

**Step 3: Implement**: in `sync()`, set `metaRank: 0` in the initial `sync` object, and replace the per-artist `for (const t of tracks)` loop with a version that first finds the albums with at least one file, then reports every track of those albums:

```ts
      const owned = new Set(
        tracks.filter((t) => t.hasFile && fileById.has(t.trackFileId)).map((t) => t.albumId),
      );
      for (const t of tracks) {
        const album = albumsById.get(t.albumId);
        if (!album || !owned.has(album.id)) continue;
        const file = t.hasFile ? fileById.get(t.trackFileId) : undefined;
        const albumKey = albumKeyFor(album.foreignAlbumId, la.artistName, album.title);
        if (!albumsSeen.has(album.id)) {
          // … unchanged: push the album …
        }
        const recordingId = t.foreignRecordingId || `track:${t.id}`;
        const key = uniqueKey(trackKeyFor(albumKey, recordingId), trackKeys);
        sync.tracks.push({ /* … unchanged … */ });
        if (file) {
          sync.copies.push({ /* … unchanged … */ });
        }
      }
```

(Keep the album and track objects exactly as they are; only the loop condition, the `owned` set and the `if (file)` around the copy change.)

**Step 4:** Run the Lidarr tests, then all server tests. Expected: PASS.

**Step 5: Commit and push**

```bash
git add apps/server/src/catalog/lidarr.ts apps/server/src/catalog/lidarr.test.ts
git commit -m "Lidarr source: report missing songs of owned albums"
git push origin main
```

---

### Task 10: Reading each copy from the right place

**Files:**
- Create: `apps/server/src/catalog/paths.ts`, `apps/server/src/catalog/files.ts`
- Test: `apps/server/src/catalog/files.test.ts`
- Modify: `apps/server/src/routes/stream.ts`, `apps/server/src/analysis/analyzer.ts`

**Step 1: Failing tests**

```ts
// apps/server/src/catalog/files.test.ts
import { describe, expect, it } from 'vitest';
import type { MediaSource } from '../media/index.ts';
import { FileAccessError, FileResolver } from './files.ts';
import { isInside } from './paths.ts';
import { CatalogStore } from './store.ts';
import { FLAC, freshDb } from './testFixtures.ts';

const remote = { kind: 'ssh' } as MediaSource;
const local = { kind: 'local' } as MediaSource;

function setup() {
  const store = new CatalogStore(freshDb());
  const lidarr = store.addSource('lidarr', 'Lidarr');
  const folder = store.addSource('folder', 'Music', { path: '/host/Music' });
  const files = new FileResolver(store, { media: remote, pathMap: [['/data/media/music', '/volume2/music']] }, local);
  const record = (sourceId: number, path: string) => ({ id: 1, sourceId, path, size: 1, format: FLAC });
  return { files, lidarr, folder, record };
}

describe('isInside', () => {
  it('compares whole path segments', () => {
    expect(isInside('/host/Music/a.flac', '/host/Music')).toBe(true);
    expect(isInside('/host/Music', '/host/Music/')).toBe(true);
    expect(isInside('/host/Musicals/a.flac', '/host/Music')).toBe(false);
    expect(isInside('/host/Music/../secret', '/host/Music')).toBe(false);
    expect(isInside('/anything', '/')).toBe(true);
  });
});

describe('FileResolver', () => {
  it('reads Lidarr files through the media source and path map', () => {
    const { files, lidarr, record } = setup();
    expect(files.resolve(record(lidarr, '/data/media/music/A/1.flac'))).toEqual({ media: remote, path: '/volume2/music/A/1.flac' });
  });

  it('refuses Lidarr files outside the mapped folders', () => {
    const { files, lidarr, record } = setup();
    expect(() => files.resolve(record(lidarr, '/etc/passwd'))).toThrow(FileAccessError);
  });

  it('reads folder files from local disk, inside the folder only', () => {
    const { files, folder, record } = setup();
    expect(files.resolve(record(folder, '/host/Music/A/1.flac'))).toEqual({ media: local, path: '/host/Music/A/1.flac' });
    expect(() => files.resolve(record(folder, '/host/Music/../../etc/passwd'))).toThrow(FileAccessError);
  });

  it('answers 404 for a removed source', () => {
    const { files, record } = setup();
    expect(() => files.resolve(record(99, '/x'))).toThrow(expect.objectContaining({ status: 404 }));
  });
});
```

**Step 2:** Run it. Expected: FAIL.

**Step 3: Implement**

```ts
// apps/server/src/catalog/paths.ts
import { posix } from 'node:path';

/** True if `path` is `root` or inside it, comparing whole segments after normalizing ("..", "//"). */
export function isInside(path: string, root: string): boolean {
  const p = posix.normalize(path);
  const r = posix.normalize(root).replace(/(.)\/+$/, '$1');
  return p === r || p.startsWith(r === '/' ? '/' : `${r}/`);
}
```

```ts
// apps/server/src/catalog/files.ts
import { posix } from 'node:path';
import { mapPath, type MediaSource } from '../media/index.ts';
import type { FileRecord } from './build.ts';
import { isInside } from './paths.ts';
import type { CatalogStore } from './store.ts';

export class FileAccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface ResolvedFile {
  media: MediaSource;
  path: string;
}

/**
 * Where a copy's bytes are and how to read them: Lidarr files through MEDIA_SOURCE and PATH_MAP,
 * folder files from local disk. Never outside the configured folders.
 */
export class FileResolver {
  constructor(
    private readonly store: CatalogStore,
    private readonly lidarr: { media: MediaSource; pathMap: [string, string][] },
    private readonly local: MediaSource,
  ) {}

  resolve(file: FileRecord): ResolvedFile {
    const source = this.store.source(file.sourceId);
    if (!source) throw new FileAccessError('This file’s source was removed', 404);
    if (source.kind === 'folder') {
      const root = (source.settings as { path?: string }).path;
      const path = posix.normalize(file.path);
      if (!root || !isInside(path, root)) throw new FileAccessError('File is outside the source folder', 403);
      return { media: this.local, path };
    }
    const path = mapPath(file.path, this.lidarr.pathMap);
    const roots = this.lidarr.pathMap.map(([, to]) => to);
    if (roots.length && !roots.some((root) => isInside(path, root))) {
      throw new FileAccessError('File is outside the configured music folders', 403);
    }
    return { media: this.lidarr.media, path };
  }
}
```

**Step 4:** Run the tests. Expected: PASS (5 tests).

**Step 5: Use it for streaming.** In `routes/stream.ts`: deps become `{ library: Library; files: FileResolver }` (remove `config`, `media` and the `Config`/`mapPath`/`MediaSource` imports; import `FileAccessError`, `FileResolver` from `../catalog/files.ts`). Replace the block from `const path = mapPath(...)` through the roots check with:

```ts
      let media: MediaSource;
      let path: string;
      try {
        ({ media, path } = deps.files.resolve(file));
      } catch (err) {
        if (!(err instanceof FileAccessError)) throw err;
        req.log.warn({ path: file.path }, err.message);
        return reply.code(err.status).send({ error: err.message });
      }
```

(keep importing `MediaUnavailableError` and `type MediaSource` from `../media/index.ts`; the rest of the handler uses `media` and `path` unchanged).

**Step 6: Use it for song analysis.** In `analysis/analyzer.ts`: replace the constructor's `private readonly media: MediaSource` with `private readonly files: FileResolver` (import `type FileResolver` from `../catalog/files.ts`; drop the `mapPath`/`MediaSource` import), remove `pathMap` from `opts`, make the "can analyze" getter return `this.opts.enabled`, and replace the path/roots/pcm lines in `analyze()` with:

```ts
      const { media, path } = this.files.resolve(file);
      if (!media.pcm) throw new Error('This source can’t decode audio for analysis');
      const pcm = await media.pcm(path, { sampleRate: SAMPLE_RATE, maxSeconds: MAX_SECONDS });
```

**Step 7:** Typecheck: `corepack pnpm -C apps/server typecheck`. Expected: errors only in `index.ts` (wiring, Task 14). Run all server tests: PASS.

**Step 8: Commit and push**

```bash
git add apps/server/src/catalog/paths.ts apps/server/src/catalog/files.ts apps/server/src/catalog/files.test.ts apps/server/src/routes/stream.ts apps/server/src/analysis/analyzer.ts
git commit -m "Read each copy from its source: Lidarr through PATH_MAP, folders from local disk"
git push origin main
```

---

### Task 11: Artwork from folder files

**Files:**
- Create: `apps/server/src/catalog/folderArt.ts`
- Test: `apps/server/src/catalog/folderArt.test.ts`
- Modify: `apps/server/src/routes/art.ts`

**Step 1: Failing tests**

```ts
// apps/server/src/catalog/folderArt.test.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyCover } from './folderArt.ts';
import { flacBytes, tempDir } from './testFixtures.ts';

let cleanup = () => {};
afterEach(() => cleanup());

describe('copyCover', () => {
  it('uses a cover image next to the file', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    writeFileSync(join(t.dir, '01.flac'), flacBytes());
    writeFileSync(join(t.dir, 'Folder.JPG'), Buffer.from([0xff, 0xd8, 0xff]));
    expect(await copyCover(join(t.dir, '01.flac'))).toEqual({ body: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg' });
  });

  it('prefers cover over folder images', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    writeFileSync(join(t.dir, '01.flac'), flacBytes());
    writeFileSync(join(t.dir, 'folder.jpg'), Buffer.from([1]));
    writeFileSync(join(t.dir, 'cover.png'), Buffer.from([2]));
    expect(await copyCover(join(t.dir, '01.flac'))).toEqual({ body: Buffer.from([2]), mime: 'image/png' });
  });

  it('returns null when there is no artwork', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    writeFileSync(join(t.dir, '01.flac'), flacBytes());
    expect(await copyCover(join(t.dir, '01.flac'))).toBeNull();
  });
});
```

**Step 2:** Run it. Expected: FAIL.

**Step 3: Implement**

```ts
// apps/server/src/catalog/folderArt.ts
import { parseFile } from 'music-metadata';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const NAMES = ['cover', 'folder', 'front', 'album'];
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** A folder file's artwork: the picture embedded in it, else cover/folder/front/album.(jpg|png|webp) beside it. */
export async function copyCover(path: string): Promise<{ body: Buffer; mime: string } | null> {
  try {
    const picture = (await parseFile(path, { duration: false })).common.picture?.[0];
    if (picture) return { body: Buffer.from(picture.data), mime: picture.format };
  } catch {
    // unreadable tags: try the folder
  }
  const dir = dirname(path);
  const names = await readdir(dir).catch((): string[] => []);
  for (const want of NAMES) {
    const hit = names.find((n) => new RegExp(`^${want}\\.(jpe?g|png|webp)$`, 'i').test(n));
    if (hit) return { body: await readFile(join(dir, hit)), mime: MIME[hit.split('.').pop()!.toLowerCase()]! };
  }
  return null;
}
```

**Step 4:** Run the tests. Expected: PASS (3 tests).

**Step 5: Route.** In `routes/art.ts`:

- Imports: `import { copyCover } from '../catalog/folderArt.ts';`, `import type { FileResolver } from '../catalog/files.ts';`, `import type { Library } from '../library/library.ts';`.
- `artRoutes`' deps become `{ art: LocalArt; cacheDir: string; library: Pick<Library, 'file'>; files: FileResolver }`.
- Add this route inside `artRoutes`, before the `'/art/:kind/:id/:type'` route:

```ts
  // Artwork drawn from a folder file (embedded picture or an image beside it).
  app.get<{ Params: { id: string }; Querystring: { size?: string } }>('/art/copy/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const file = Number.isInteger(id) ? await deps.library.file(id) : undefined;
    if (!file) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'Unknown file' });
    let path: string;
    try {
      const resolved = deps.files.resolve(file);
      if (resolved.media.kind !== 'local') throw new Error('not local');
      path = resolved.path;
    } catch {
      return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'No artwork' });
    }
    const requested = Number(req.query.size);
    const size = requested > 0 ? (SIZES.find((s) => s >= requested) ?? SIZES.at(-1)) : undefined;
    const key = createHash('sha1').update(`copy/${id}/${file.size}/${size ?? 'orig'}`).digest('hex');
    const cached = join(dir, key);
    try {
      const body = await readFile(cached);
      const mime = (await readFile(`${cached}.mime`, 'utf8').catch(() => null)) ?? 'image/webp';
      return reply.header('Cache-Control', 'public, max-age=86400').type(mime).send(body);
    } catch {
      // cache miss
    }
    const original = await copyCover(path);
    if (!original) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'No artwork' });
    const out = size
      ? {
          body: await sharp(original.body).resize(size, size, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(),
          mime: 'image/webp',
        }
      : original;
    await mkdir(dir, { recursive: true });
    await writeFile(`${cached}.tmp`, out.body);
    await writeFile(`${cached}.mime`, out.mime);
    await rename(`${cached}.tmp`, cached);
    return reply.header('Cache-Control', 'public, max-age=86400').type(out.mime).send(out.body);
  });
```

**Step 6:** Typecheck (errors only in `index.ts` expected); run all server tests: PASS.

**Step 7: Commit and push**

```bash
git add apps/server/src/catalog/folderArt.ts apps/server/src/catalog/folderArt.test.ts apps/server/src/routes/art.ts
git commit -m "Artwork for folder albums: embedded pictures and cover images beside the files"
git push origin main
```

---

### Task 12: Which folders may be used; browsing them

**Files:**
- Modify: `apps/server/src/config.ts`, `apps/server/src/catalog/paths.ts`
- Test: `apps/server/src/catalog/paths.test.ts`

**Step 1: Config.** In `config.ts`, add to the schema:

```ts
  // Folders that folder sources may use and Settings may browse (comma-separated absolute paths).
  // The Docker image sets /host, where a broad read-only mount of the host goes.
  FOLDER_ROOTS: z.string().default('/'),
```

add `folderRoots: string[]` to the `Config` type, and compute it in `loadConfig`:

```ts
  const folderRoots = parsed.data.FOLDER_ROOTS.split(',')
    .map((r) => r.trim())
    .filter((r) => r.startsWith('/'))
    .map((r) => posix.normalize(r).replace(/(.)\/+$/, '$1'));
  return { ...parsed.data, pathMap, folderRoots: folderRoots.length ? folderRoots : ['/'] };
```

(import `posix` from `node:path`).

**Step 2: Failing tests**

```ts
// apps/server/src/catalog/paths.test.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkFolder, listFolders } from './paths.ts';
import { flacBytes, tempDir } from './testFixtures.ts';

let cleanup = () => {};
afterEach(() => cleanup());

function tree() {
  const t = tempDir();
  cleanup = t.cleanup;
  mkdirSync(join(t.dir, 'Music/Portishead'), { recursive: true });
  mkdirSync(join(t.dir, 'Music/.cache'));
  mkdirSync(join(t.dir, 'Other'));
  writeFileSync(join(t.dir, 'Music/a.flac'), flacBytes());
  writeFileSync(join(t.dir, 'Music/notes.txt'), 'x');
  return t.dir;
}

describe('checkFolder', () => {
  it('accepts an existing folder inside a root', () => {
    const dir = tree();
    expect(checkFolder(`${dir}/Music/`, [dir])).toBe(`${dir}/Music`);
  });
  it('rejects relative, missing, outside and file paths', () => {
    const dir = tree();
    expect(() => checkFolder('Music', [dir])).toThrow(/absolute/);
    expect(() => checkFolder(`${dir}/Nope`, [dir])).toThrow(/doesn’t exist/);
    expect(() => checkFolder(`${dir}/Other`, [`${dir}/Music`])).toThrow(/outside/);
    expect(() => checkFolder(`${dir}/Music/a.flac`, [dir])).toThrow(/not a folder/);
  });
});

describe('listFolders', () => {
  it('lists the roots when no path is given', async () => {
    expect(await listFolders(undefined, ['/a', '/b'])).toEqual({
      path: null,
      parent: null,
      folders: [
        { name: '/a', path: '/a' },
        { name: '/b', path: '/b' },
      ],
      audioFiles: 0,
    });
  });
  it('lists subfolders and counts audio files, skipping hidden folders', async () => {
    const dir = tree();
    expect(await listFolders(`${dir}/Music`, [dir])).toEqual({
      path: `${dir}/Music`,
      parent: dir,
      folders: [{ name: 'Portishead', path: `${dir}/Music/Portishead` }],
      audioFiles: 1,
    });
  });
  it('goes back to the roots list from a root', async () => {
    const dir = tree();
    expect((await listFolders(dir, [dir])).parent).toBeNull();
  });
  it('refuses folders outside the roots', async () => {
    const dir = tree();
    await expect(listFolders('/etc', [dir])).rejects.toThrow(/outside/);
  });
});
```

**Step 3:** Run `corepack pnpm -C apps/server exec vitest run src/catalog/paths.test.ts`. Expected: FAIL.

**Step 4: Implement**: append to `paths.ts` (and extend its imports):

```ts
import type { FolderListing } from '@playarr/shared';
import type { Dirent } from 'node:fs';
import { statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isAudioFile } from './folderSource.ts';

/** Validate a folder source path: absolute, inside a root, an existing folder. Returns it normalized. */
export function checkFolder(path: string, roots: string[]): string {
  if (!path.startsWith('/')) throw new Error('The folder must be an absolute path');
  const normalized = posix.normalize(path).replace(/(.)\/+$/, '$1');
  if (!roots.some((r) => isInside(normalized, r))) {
    throw new Error(`That folder is outside the folders Playarr may use (${roots.join(', ')})`);
  }
  const s = (() => {
    try {
      return statSync(normalized);
    } catch {
      return null;
    }
  })();
  if (!s) throw new Error('That folder doesn’t exist');
  if (!s.isDirectory()) throw new Error('That path is not a folder');
  return normalized;
}

/** A folder's subfolders, for the folder picker. Without a path: the roots. */
export async function listFolders(path: string | undefined, roots: string[]): Promise<FolderListing> {
  if (!path) return { path: null, parent: null, folders: roots.map((r) => ({ name: r, path: r })), audioFiles: 0 };
  const dir = checkFolder(path, roots);
  const items = await readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
  const folders = items
    .filter((i) => i.isDirectory() && !i.name.startsWith('.'))
    .map((i) => ({ name: i.name, path: posix.join(dir, i.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const audioFiles = items.filter((i) => i.isFile() && isAudioFile(i.name)).length;
  const atRoot = roots.includes(dir);
  return { path: dir, parent: atRoot ? null : posix.dirname(dir), folders, audioFiles };
}
```

**Step 5:** Run the tests. Expected: PASS (6 tests). (Temp dirs on macOS live under `/var/folders/…`, a symlink to `/private/var/…`; the tests compare the paths as given, without resolving symlinks, so they pass.)

**Step 6: Commit and push**

```bash
git add apps/server/src/config.ts apps/server/src/catalog/paths.ts apps/server/src/catalog/paths.test.ts
git commit -m "Folder roots: validate folder sources and browse folders"
git push origin main
```

---

### Task 13: SourceManager handles folder sources

**Files:**
- Modify: `apps/server/src/catalog/sources.ts`, `apps/server/src/catalog/sources.test.ts`

**Step 1: Failing tests** (append inside `describe('SourceManager')`; import `tempDir` from `./testFixtures.ts`, `mkdirSync` from `node:fs`, `join` from `node:path`):

```ts
  describe('folders', () => {
    function withFolders() {
      const t = tempDir();
      mkdirSync(join(t.dir, 'Music'));
      mkdirSync(join(t.dir, 'More'));
      const store = new CatalogStore(freshDb());
      const lidarr = new LidarrClient();
      const manager = new SourceManager(store, lidarr, { info: () => {} }, [t.dir]);
      return { ...t, store, lidarr, manager };
    }

    it('adds folders inside the allowed roots, several of them', () => {
      const { dir, manager, cleanup } = withFolders();
      try {
        expect(manager.add({ kind: 'folder', settings: { path: join(dir, 'Music') } })).toMatchObject({
          kind: 'folder',
          name: 'Music',
          settings: { path: join(dir, 'Music') },
        });
        expect(manager.add({ kind: 'folder', name: 'Extra', settings: { path: join(dir, 'More') } }).name).toBe('Extra');
      } finally {
        cleanup();
      }
    });

    it('rejects folders that are missing or outside the roots', () => {
      const { dir, manager, cleanup } = withFolders();
      try {
        expect(() => manager.add({ kind: 'folder', settings: { path: join(dir, 'Nope') } })).toThrow(SourceError);
        expect(() => manager.add({ kind: 'folder', settings: { path: '/etc' } })).toThrow(/outside/);
        expect(() => manager.add({ kind: 'folder' })).toThrow(/needs a folder/);
      } finally {
        cleanup();
      }
    });

    it('turns enabled sources into adapters in Settings order', () => {
      const { dir, store, manager, cleanup } = withFolders();
      try {
        const music = manager.add({ kind: 'folder', settings: { path: join(dir, 'Music') } });
        manager.add({ kind: 'lidarr', settings: { url: 'http://lidarr:8686', apiKey: 'k' } });
        expect(manager.active().map((a) => a.source.kind)).toEqual(['folder', 'lidarr']);
        store.updateSource(music.id, { enabled: false });
        expect(manager.active().map((a) => a.source.kind)).toEqual(['lidarr']);
      } finally {
        cleanup();
      }
    });

    it('browses only inside the roots', async () => {
      const { dir, manager, cleanup } = withFolders();
      try {
        expect((await manager.listFolders(dir)).folders.map((f) => f.name)).toEqual(['More', 'Music']);
        await expect(manager.listFolders('/etc')).rejects.toThrow(SourceError);
      } finally {
        cleanup();
      }
    });
  });
```

Also update the existing test 'only accepts Lidarr sources for now' to:

```ts
  it('rejects unknown kinds', () => {
    expect(() => setup().manager.add({ kind: 'cloud' as never })).toThrow(/Unknown source kind/);
  });
```

**Step 2:** Run `corepack pnpm -C apps/server exec vitest run src/catalog/sources.test.ts`. Expected: FAIL.

**Step 3: Implement** in `sources.ts`:

- Imports: `import { basename } from 'node:path';`, `import type { FolderListing } from '@playarr/shared';`, `import { FolderSource } from './folderSource.ts';`, `import { checkFolder, listFolders } from './paths.ts';`.
- `interface FolderSettings { path?: string }`.
- Constructor: add a fourth parameter `private readonly folderRoots: string[] = ['/'],`.
- Replace `active()`:

```ts
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
```

- Replace `add()`:

```ts
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
```

- In `update()`, compute `settings` per kind:

```ts
    const { url, apiKey, path } = input.settings ?? {};
    let settings: Record<string, unknown> | undefined;
    if (input.settings && source.kind === 'folder') {
      settings = path ? { ...source.settings, path: this.checkFolder(path) } : undefined;
    } else if (input.settings) {
      settings = { ...source.settings, ...(url ? { url: trimUrl(url) } : {}), ...(apiKey ? { apiKey } : {}) };
    }
```

- Add:

```ts
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
```

- In `toInfo`, include the folder path: `settings: { url: (s.settings as LidarrSettings).url, path: (s.settings as FolderSettings).path }`.

**Step 4:** Run the tests. Expected: PASS.

**Step 5: Commit and push**

```bash
git add apps/server/src/catalog/sources.ts apps/server/src/catalog/sources.test.ts
git commit -m "Source manager: folder sources, in Settings order"
git push origin main
```

---

### Task 14: Folder browsing API; wiring

**Files:**
- Modify: `apps/server/src/routes/settings.ts`, `apps/server/src/routes/settings.test.ts`, `apps/server/src/index.ts`

**Step 1: Failing tests** (add to `describe('settings routes')`):

```ts
  it('browses folders from the home network only', async () => {
    const { app } = setup();
    const away = await app.inject({ method: 'GET', url: '/api/settings/folders', remoteAddress: AWAY });
    expect(away.statusCode).toBe(403);
    const home = await app.inject({ method: 'GET', url: '/api/settings/folders', remoteAddress: HOME });
    expect(home.json()).toMatchObject({ path: null, folders: [{ path: '/' }] });
  });

  it('accepts a folder path', async () => {
    const res = await setup().app.inject({
      method: 'POST',
      url: '/api/settings/sources',
      payload: { kind: 'folder', settings: { path: '/definitely/not/here' } },
      remoteAddress: HOME,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/doesn’t exist/);
  });
```

**Step 2:** Run `corepack pnpm -C apps/server exec vitest run src/routes/settings.test.ts`. Expected: FAIL.

**Step 3: Implement** in `routes/settings.ts`:

- Add `path: z.string().trim().max(4096).optional()` to the `settings` object of `sourceInput`.
- Add the route (browsing reveals the server's folder names, so it's local-only too):

```ts
  app.get<{ Querystring: { path?: string } }>('/api/settings/folders', editable, (req, reply) =>
    handle(reply, () => sources.listFolders(req.query.path || undefined)),
  );
```

**Step 4: Wire `index.ts`**

- Imports: `import { FileResolver } from './catalog/files.ts';`, `import { LocalMediaSource } from './media/local.ts';`.
- Pass the roots to the manager: `new SourceManager(store, lidarr, { info: (m) => app.log.info(m) }, config.folderRoots)`.
- After `const media = createMediaSource(config);`:

```ts
// Lidarr's files through MEDIA_SOURCE + PATH_MAP; folder sources are always on this server's disk.
const files = new FileResolver(store, { media, pathMap: config.pathMap }, new LocalMediaSource(config.FFMPEG_PATH));
```

- Analyzer: `new Analyzer(db, library, files, { enabled: config.ANALYSIS === 'on', log: app.log })`.
- Routes: `artRoutes(app, { art, cacheDir: resolve(config.CACHE_DIR), library, files });` and `streamRoutes(app, { library, files });`.

**Step 5:** Typecheck, test, build:

Run: `corepack pnpm -C apps/server typecheck && corepack pnpm -C apps/server test && corepack pnpm -C apps/server build`
Expected: clean; all pass; build succeeds.

**Step 6: Smoke-check a folder source end to end (no Lidarr needed)**

Write one fixture file with tsx (the fixture helper is TypeScript), then start the built server against it:

```bash
rm -rf /tmp/playarr-p3 && mkdir -p /tmp/playarr-p3/music/Portishead/Dummy
cd /Users/bortignon/dev/playarr/apps/server && corepack pnpm exec tsx -e "
import { writeFileSync } from 'node:fs';
import { flacBytes } from './src/catalog/testFixtures.ts';
writeFileSync('/tmp/playarr-p3/music/Portishead/Dummy/03 Sour Times.flac', flacBytes({ TITLE: 'Sour Times', ALBUM: 'Dummy', ALBUMARTIST: 'Portishead', TRACKNUMBER: '3' }));
"
cd /tmp/playarr-p3
DATA_DIR=$PWD/data CACHE_DIR=$PWD/cache PORT=4098 FOLDER_ROOTS=$PWD node --disable-warning=ExperimentalWarning /Users/bortignon/dev/playarr/apps/server/dist/index.js &
sleep 3
curl -s -X POST localhost:4098/api/settings/sources -H 'Content-Type: application/json' -d "{\"kind\":\"folder\",\"settings\":{\"path\":\"$PWD/music\"}}"
sleep 2
curl -s localhost:4098/api/albums | jq '.[] | {title, artistName, trackCount}'
id=$(curl -s localhost:4098/api/albums | jq '.[0].id'); fid=$(curl -s localhost:4098/api/albums/$id | jq '.tracks[0].fileId')
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' -H 'Range: bytes=0-3' localhost:4098/stream/$fid
kill %1
```

Expected: the folder source is created (201 body with `kind: "folder"`); albums list `Dummy` by `Portishead` with 1 track; the stream answers `206 4`.

**Step 7: Commit and push**

```bash
git add apps/server/src/routes/settings.ts apps/server/src/routes/settings.test.ts apps/server/src/index.ts
git commit -m "Server: folder browsing API and folder sources wired in"
git push origin main
```

---

### Task 15: Web: missing songs, partial albums, loose songs

**Files:**
- Modify: `apps/web/src/components/TrackList.tsx`, `apps/web/src/pages/Album.tsx`, `apps/web/src/components/Cards.tsx`, `apps/web/src/pages/Artist.tsx`

**Step 1: `TrackList` shows missing songs in place, greyed out**

- Import `MissingTrack` from `@playarr/shared`.
- Add a prop: `/** Songs on the album that aren't in the library, shown greyed out in their place. */ missing?: MissingTrack[];`.
- At the top of the component, build the rows:

```tsx
  type Row = { track: Track; index: number } | { missing: MissingTrack };
  const disc = (r: Row) => ('track' in r ? r.track.discNumber : r.missing.discNumber);
  const num = (r: Row) => ('track' in r ? r.track.trackNumber : r.missing.trackNumber);
  const rows: Row[] = tracks.map((track, index) => ({ track, index }));
  if (missing?.length) {
    rows.push(...missing.map((m) => ({ missing: m })));
    rows.sort((a, b) => disc(a) - disc(b) || num(a) - num(b));
  }
```

- Change the loop from `tracks.map((t, i) => …)` to `rows.map((row, r) => …)`: compute `discStart` from `rows[r - 1]` with `disc()`, and render a missing row when `'missing' in row`; otherwise set `const t = row.track; const i = row.index;` and keep the existing row JSX exactly as it is (it uses `t` and `i`, and `playTracks(tracks, i)` still indexes the playable list). Keys: `` `${t.id}-${i}` `` for tracks, `` `missing-${row.missing.recordingId}-${r}` `` for missing rows. The missing row:

```tsx
              <li
                className="grid grid-cols-[2rem_1fr_auto] items-center gap-3 rounded-md px-3 py-2 opacity-40 md:gap-4"
                title="Not in your library"
              >
                <span className="text-center font-mono text-sm text-muted tabular">{row.missing.trackNumber}</span>
                <span className="truncate text-[15px] text-paper">{row.missing.title}</span>
                <span className="font-mono text-[13px] text-muted tabular">{formatTime(row.missing.duration)}</span>
              </li>
```

**Step 2: `Album.tsx`**: pass the missing songs:

```tsx
          <TrackList tracks={album.tracks} missing={album.missingTracks} showDiscs={album.discCount > 1} />
```

**Step 3: `Cards.tsx`**: in `AlbumCard`, after the year inside the artist line:

```tsx
            {album.trackCount < album.totalTrackCount && (
              <span className="font-mono text-[12px]">
                {' '}
                · {album.trackCount} of {album.totalTrackCount}
              </span>
            )}
```

**Step 4: `Artist.tsx`**: add a fifth group `{ title: 'Loose songs', albums: [] }` at the end of `groups`, and as the first check in the loop:

```tsx
    if (a.albumType === 'Loose') groups[4]!.albums.push(a);
    else if (secondary.includes('soundtrack')) groups[1]!.albums.push(a);
```

(the rest of the chain unchanged).

**Step 5:** `corepack pnpm -C apps/web exec tsc --noEmit && corepack pnpm -C apps/web exec vite build`. Expected: clean; build succeeds.

**Step 6: Commit and push**

```bash
git add apps/web/src/components/TrackList.tsx apps/web/src/pages/Album.tsx apps/web/src/components/Cards.tsx apps/web/src/pages/Artist.tsx
git commit -m "Web: missing songs greyed out, partial album marker, loose songs group"
git push origin main
```

---

### Task 16: Web: add folder sources in Settings

**Files:**
- Modify: `apps/web/src/lib/api.ts`, `apps/web/src/lib/queries.ts`, `apps/web/src/components/SourcesPanel.tsx`

**Step 1: API and query**

`api.ts` (add `FolderListing` to the type import):

```ts
  folders: (path?: string) =>
    get<FolderListing>(`/api/settings/folders${path ? `?path=${encodeURIComponent(path)}` : ''}`),
```

`queries.ts`:

```ts
export const useFolders = (path: string | undefined) =>
  useQuery({ queryKey: ['folders', path ?? ''], queryFn: () => api.folders(path), retry: false });
```

**Step 2: `SourcesPanel.tsx`**

- Imports: add `Folder` to lucide-react; `useFolders` from `../lib/queries`.
- `SourceRow`: icon by kind: `{s.kind === 'folder' ? <FolderOpen className="size-5" /> : <Server className="size-5" />}`; details: `[s.settings?.url ?? s.settings?.path, …]`.
- `SourceDialog`: `kind` state becomes `'lidarr' | 'folder' | null`. Show `FolderForm` when editing a folder source or `kind === 'folder'`, `LidarrForm` when editing a Lidarr source or `kind === 'lidarr'`:

```tsx
  const formKind = editing?.kind ?? kind;
  …
      {formKind === 'lidarr' ? (
        <LidarrForm key={editing?.id ?? 'new'} source={editing} onDone={onClose} />
      ) : formKind === 'folder' ? (
        <FolderForm key={editing?.id ?? 'new'} source={editing} onDone={onClose} />
      ) : (
        /* the two KindOptions, unchanged except: */
      )}
```

and the Folder `KindOption` becomes enabled: `detail="Music in a folder on this server. Playarr only reads it."` with `onClick={() => setKind('folder')}` (no `disabled`).

- Add:

```tsx
function FolderForm({ source, onDone }: { source?: SourceInfo; onDone: () => void }) {
  const actions = useSourceActions();
  const [name, setName] = useState(source?.name ?? '');
  const [path, setPath] = useState<string | undefined>(source?.settings?.path);
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const pending = actions.add.isPending || actions.update.isPending;

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!path) return;
    const input = { name: name.trim() || undefined, enabled, settings: { path } };
    if (source) actions.update.mutate({ id: source.id, input }, { onSuccess: onDone });
    else actions.add.mutate({ kind: 'folder', ...input }, { onSuccess: onDone });
  };

  return (
    <form onSubmit={save} className="space-y-4 p-5">
      <div>
        <span className="mb-1.5 block font-mono text-[11px] tracking-[0.2em] text-muted uppercase">Folder</span>
        <FolderBrowser value={path} onChange={setPath} />
      </div>
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={path?.split('/').pop() || 'Music'}
          className={INPUT}
          maxLength={80}
        />
      </Field>
      {source && (
        <label className="flex items-center gap-2 text-sm text-paper-dim">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Use this source
        </label>
      )}
      <p className="text-[13px] text-muted">Playarr only reads this folder. Songs appear after the first scan.</p>
      <div className="flex justify-end pt-2">
        <button type="submit" disabled={!path || pending} className={PRIMARY}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function FolderBrowser({ value, onChange }: { value?: string; onChange: (path: string) => void }) {
  const [at, setAt] = useState<string | undefined>(value);
  const { data, error } = useFolders(at);
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 font-mono text-[12px] text-paper-dim">
        {data && data.path !== null && (
          <button
            type="button"
            onClick={() => setAt(data.parent ?? undefined)}
            className="rounded px-1.5 text-muted hover:bg-paper/8 hover:text-paper"
            aria-label="Up one folder"
          >
            ..
          </button>
        )}
        <span className="truncate">{data?.path ?? 'Folders Playarr may use'}</span>
      </div>
      <ul className="max-h-60 overflow-y-auto py-1">
        {data?.folders.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => setAt(f.path)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[14px] text-paper hover:bg-paper/5"
            >
              <Folder className="size-4 shrink-0 text-muted" />
              <span className="truncate">{f.name}</span>
            </button>
          </li>
        ))}
        {data && data.folders.length === 0 && <li className="px-3 py-2 text-[13px] text-muted">No folders inside.</li>}
      </ul>
      {error && <p className="px-3 py-2 text-[13px] text-red-300/80">{(error as Error).message}</p>}
      {data?.path && (
        <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2">
          <span className="text-[12px] text-muted">
            {plural(data.audioFiles, 'audio file')} here{value === data.path ? ' · selected' : ''}
          </span>
          <button type="button" onClick={() => onChange(data.path!)} className="text-[13px] text-accent hover:underline">
            Use this folder
          </button>
        </div>
      )}
    </div>
  );
}
```

- Update the panel's empty-state text to `No sources yet. Add Lidarr or a folder to start your library.`

**Step 3:** `corepack pnpm -C apps/web exec tsc --noEmit && corepack pnpm -C apps/web exec vite build`. Expected: clean; build succeeds.

**Step 4: Commit and push**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/queries.ts apps/web/src/components/SourcesPanel.tsx
git commit -m "Web: add folder sources in Settings, with a folder browser"
git push origin main
```

---

### Task 17: Docker and docs

**Files:**
- Modify: `docker/Dockerfile`, `docker/compose.yaml`, `.env.example`, `README.md`, `PLAN.md`

**Step 1: Dockerfile**: add `FOLDER_ROOTS=/host` to the runtime `ENV` list (after `CACHE_DIR=/cache \`).

**Step 2: compose.yaml**: under `volumes:` add:

```yaml
      # Folders to offer as sources in Settings → Sources: mount a broad host folder read-only at /host.
      # - /volume1:/host:ro
```

**Step 3: .env.example**: append:

```
# Folders that folder sources may use and Settings may browse (comma-separated absolute paths).
# Default: the whole disk when running natively; the Docker image uses /host.
FOLDER_ROOTS=
```

**Step 4: README.md**

- In "Key design points", add a bullet: `- **Folder sources.** Besides Lidarr, any folder on the server can be a source. Playarr reads its tags (falling back to "Artist/Album/01 Title" names), merges the songs with Lidarr's, and never modifies the files.`
- In the Docker example, add `-v "$HOME/Music:/host:ro" \` and a sentence after it: `Anything under /host can then be added in Settings → Sources → Folder.`

**Step 5: PLAN.md decisions log (§12)**

```
| 2026-10-30 | Folder sources (phase 3): tags read with music-metadata, cached per file by size + mtime (`folder_files`); untagged files fall back to "Artist/Album/NN Title" and join existing artists/albums/songs by name (MusicBrainz-keyed rows preferred). Catalog rows keep the most trusted metadata (`meta_rank`: Lidarr 0, folder 2). No same-file detection: duplicate copies merge into one song and the tie goes to source order. Untagged songs get `local:<hash>` ids until fingerprints (phase 4). Missing songs come from Lidarr's track lists (`source_tracks`); folder albums get full track lists after matching. Sources sync one after the other in Settings order. Folder sources are limited to `FOLDER_ROOTS` (Docker: `/host`). |
```

**Step 6: Commit and push**

```bash
git add docker/Dockerfile docker/compose.yaml .env.example README.md PLAN.md
git commit -m "Docs and Docker: folder sources and FOLDER_ROOTS"
git push origin main
```

---

## Not verified by this plan

- Scanning a real, large collection (performance of a full walk every 10 minutes; tag reading of MP3/M4A/OGG files in the wild).
- Merging a real folder with a real Lidarr library (name matching quality, compilations, "Various Artists").
- The Settings folder browser and the album pages in a browser.
- Docker on the NAS with a `/host` mount.
