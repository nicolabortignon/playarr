# Sources, Phase 4b: Organizing Folder Files Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** For a writable folder source, propose moving files into `Artist/Album/NN Title.ext`, let the user review and apply all, some or none, and undo an apply.

**Architecture:** A pure `planMoves()` turns each file's place in the merged catalog (album artist, album, disc, track, title) into a target path and reports skips (already in place, two files aiming at the same path, a file already there). An `Organizer` applies chosen moves with `rename` inside the source folder only, moves cover images and other companions along when a folder's audio all goes to one place, removes emptied folders, records every move in a `file_moves` journal (undo reverses a batch), and updates the catalog in place (`copies`, `folder_files`, `folder_matches` follow the file), so copy ids, queues, offline songs and favorites keep working without a rescan. Settings shows "Organize files" for folder sources Playarr can write to.

**Tech Stack:** Node 25 (`node:fs/promises`), Fastify 5, `node:sqlite`, zod 4, vitest 5; React 19, TanStack Query 5. pnpm via `corepack pnpm`.

**Design:** `docs/plans/2026-10-30-sources-design.md` → "Organizing files (opt-in)" and decisions table. Builds on Phases 1–4.

## Decisions

- **Layout:** `Artist/Album/NN Title.ext`; `D-NN Title.ext` when the album has more than one disc; no track number → `Title.ext`; songs without a known album (catalog album key `loose:`) → `Artist/Title.ext`. Artist is the *album* artist. Extension lower-cased.
- **Names** are made safe: `/ \ : * ? " < > |` and control characters become `_`; leading dots, trailing dots and spaces removed; whitespace collapsed; each segment at most 120 characters; empty → `Unknown`.
- **Confident vs guess:** a move is *confident* when the song has a MusicBrainz recording id (not `local:`) and its album a MusicBrainz key (`mb:`); otherwise it's a guess, shown but unchecked by default.
- **Never overwrite, never leave the folder:** targets are built from safe segments under the source root and checked with `isInside`. If the target exists (and isn't the same file, e.g. a case-only rename on macOS), the move is skipped. A rename that fails (other drive: `EXDEV`, permissions) is skipped with its reason; nothing is copied-then-deleted.
- **Server decides targets:** the client sends only which files (by current relative path) to move; the server recomputes the plan and applies those entries.
- **Companions:** when every audio file of a folder moves to the same target folder, files there matching `.jpg .jpeg .png .webp .gif .cue .log .nfo .txt .m3u .m3u8` move too (skipped if the name is taken). Emptied folders are removed up to (not including) the root.
- **Undo** reverses one batch, newest move first, only where the file is still at its new place and the old place is free.
- **Writable:** checked with `access(root, W_OK)`; reported as `SourceInfo.writable` for folder sources.

## Conventions

- Run from `/Users/bortignon/dev/playarr`. Server tests: `corepack pnpm -C apps/server test`; one file: `corepack pnpm -C apps/server exec vitest run src/catalog/organize.test.ts`. Typecheck: `corepack pnpm -C apps/server typecheck`; web: `corepack pnpm -C apps/web exec tsc --noEmit`; web build: `corepack pnpm -C apps/web exec vite build`.
- Commit after every task on `main`, staging only that task's files. Don't push (the user pushes).

---

### Task 1: Shared types

**Files:** `packages/shared/src/index.ts`

Add to `SourceInfo`: `/** Folder sources: Playarr can write to the folder (needed to organize it). */ writable?: boolean;`

Append:

```ts
// ── Organizing folder files ─────────────────────────────────────────────────

export interface OrganizeMove {
  /** Current path, relative to the folder. Also the move's id. */
  from: string;
  to: string;
  artist: string;
  album?: string;
  /** Album and song known on MusicBrainz; guesses start unchecked. */
  confident: boolean;
}

export interface OrganizeSkip {
  from: string;
  to?: string;
  reason: string;
}

export interface OrganizePlan {
  writable: boolean;
  moves: OrganizeMove[];
  skipped: OrganizeSkip[];
  /** The newest batch that can still be undone. */
  lastBatch?: { id: number; files: number; at: string };
}

export interface OrganizeResult {
  batchId: number;
  moved: number;
  skipped: OrganizeSkip[];
}
```

Typecheck: server reports nothing new (optional field). Commit: `git add packages/shared/src/index.ts && git commit -m "Organize: shared types"`

---

### Task 2: Database: the move journal

**Files:** `apps/server/src/db.ts`, `apps/server/src/db.test.ts`

Test (in `describe('migrate')`):

```ts
  it('adds the file move journal', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const cols = (db.prepare('PRAGMA table_info(file_moves)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['id', 'batch', 'source_id', 'from_rel', 'to_rel', 'moved_at', 'undone_at']);
  });
```

Migration (append):

```ts
  // Files moved by "Organize files", so a batch can be undone.
  `CREATE TABLE file_moves (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     batch     INTEGER NOT NULL,
     source_id INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
     from_rel  TEXT NOT NULL,
     to_rel    TEXT NOT NULL,
     moved_at  TEXT NOT NULL,
     undone_at TEXT
   );
   CREATE INDEX file_moves_by_batch ON file_moves (source_id, batch);`,
```

Run (fail → pass). Commit: `git add apps/server/src/db.ts apps/server/src/db.test.ts && git commit -m "Database: file move journal"`

---

### Task 3: Planning moves

**Files:** Create `apps/server/src/catalog/organize.ts`; test `apps/server/src/catalog/organize.test.ts`

**Failing tests:**

```ts
// apps/server/src/catalog/organize.test.ts
import { describe, expect, it } from 'vitest';
import { planMoves, safeSegment, targetFor, type OrganizeFile } from './organize.ts';

const file = (rel: string, f: Partial<OrganizeFile> = {}): OrganizeFile => ({
  rel,
  artist: 'Massive Attack',
  album: 'Mezzanine',
  title: 'Angel',
  trackNumber: 1,
  discNumber: 1,
  multiDisc: false,
  confident: true,
  ...f,
});

describe('safeSegment', () => {
  it('makes names safe for every filesystem', () => {
    expect(safeSegment('AC/DC')).toBe('AC_DC');
    expect(safeSegment('What? Why: "Now" <here>|')).toBe('What_ Why_ _Now_ _here__');
    expect(safeSegment('...Hidden. ')).toBe('Hidden');
    expect(safeSegment('  a   b  ')).toBe('a b');
    expect(safeSegment('')).toBe('Unknown');
    expect(safeSegment('x'.repeat(300))).toHaveLength(120);
  });
});

describe('targetFor', () => {
  it('builds Artist/Album/NN Title.ext', () => {
    expect(targetFor(file('x/01.FLAC'))).toBe('Massive Attack/Mezzanine/01 Angel.flac');
  });
  it('adds the disc on multi-disc albums', () => {
    expect(targetFor(file('x.flac', { discNumber: 2, trackNumber: 3, multiDisc: true }))).toBe('Massive Attack/Mezzanine/2-03 Angel.flac');
  });
  it('leaves out a missing track number', () => {
    expect(targetFor(file('x.mp3', { trackNumber: 0 }))).toBe('Massive Attack/Mezzanine/Angel.mp3');
  });
  it('puts songs without an album under their artist', () => {
    expect(targetFor(file('x.mp3', { album: undefined }))).toBe('Massive Attack/Angel.mp3');
  });
});

describe('planMoves', () => {
  it('proposes moves and leaves files already in place alone', () => {
    const { moves, skipped } = planMoves([file('Massive Attack/Mezzanine/01 Angel.flac'), file('misc/angel.flac', { title: 'Teardrop', trackNumber: 3 })], () => false);
    expect(moves).toEqual([
      { from: 'misc/angel.flac', to: 'Massive Attack/Mezzanine/03 Teardrop.flac', artist: 'Massive Attack', album: 'Mezzanine', confident: true },
    ]);
    expect(skipped).toEqual([]);
  });

  it('skips a target that already exists', () => {
    const { moves, skipped } = planMoves([file('a.flac')], (rel) => rel === 'Massive Attack/Mezzanine/01 Angel.flac');
    expect(moves).toEqual([]);
    expect(skipped).toEqual([{ from: 'a.flac', to: 'Massive Attack/Mezzanine/01 Angel.flac', reason: 'A file is already there' }]);
  });

  it('lets one file have a target that two files want, preferring a confident one', () => {
    const { moves, skipped } = planMoves([file('b.flac', { confident: false }), file('a.mp3', {}), file('c.flac')], () => false);
    expect(moves.map((m) => m.from)).toEqual(['c.flac', 'a.mp3']);
    expect(skipped).toEqual([{ from: 'b.flac', to: 'Massive Attack/Mezzanine/01 Angel.flac', reason: 'Another file is going there' }]);
  });

  it('allows a case-only rename of the same file', () => {
    const { moves } = planMoves([file('massive attack/mezzanine/01 angel.flac')], (rel) => rel.toLowerCase() === 'massive attack/mezzanine/01 angel.flac');
    expect(moves).toHaveLength(1);
  });
});
```

(Note the third test: `a.mp3` and `c.flac` target different extensions, so both move; `b.flac` loses to `c.flac`, which is confident.)

**Implement:**

```ts
// apps/server/src/catalog/organize.ts
import type { OrganizeMove, OrganizeSkip } from '@playarr/shared';

/** A folder file and where the catalog says it belongs. */
export interface OrganizeFile {
  rel: string;
  artist: string;
  /** Undefined for songs without a known album. */
  album?: string;
  title: string;
  trackNumber: number;
  discNumber: number;
  multiDisc: boolean;
  confident: boolean;
}

const MAX_SEGMENT = 120;

/** A file or folder name that's safe on every common filesystem. */
export function safeSegment(name: string): string {
  const cleaned = name
    // biome-ignore lint: control characters are exactly what we strip
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, MAX_SEGMENT)
    .replace(/[\s.]+$/g, '');
  return cleaned || 'Unknown';
}

/** Where a file belongs: Artist/Album/NN Title.ext (D-NN on multi-disc albums), or Artist/Title.ext. */
export function targetFor(f: OrganizeFile): string {
  const ext = f.rel.split('.').pop()!.toLowerCase();
  const title = safeSegment(f.title);
  const artist = safeSegment(f.artist);
  if (!f.album) return `${artist}/${title}.${ext}`;
  const number = f.trackNumber > 0 ? String(f.trackNumber).padStart(2, '0') : '';
  const prefix = number ? `${f.multiDisc ? `${f.discNumber}-` : ''}${number} ` : '';
  return `${artist}/${safeSegment(f.album)}/${prefix}${title}.${ext}`;
}

/** The moves that would tidy these files, and the ones that can't happen. `exists`: is that relative path taken? */
export function planMoves(files: OrganizeFile[], exists: (rel: string) => boolean): { moves: OrganizeMove[]; skipped: OrganizeSkip[] } {
  const moves: OrganizeMove[] = [];
  const skipped: OrganizeSkip[] = [];
  const claimed = new Set<string>();
  // Confident files claim their targets first; then by path, for a stable order.
  const ordered = [...files].sort((a, b) => Number(b.confident) - Number(a.confident) || a.rel.localeCompare(b.rel));
  for (const f of ordered) {
    const to = targetFor(f);
    if (to === f.rel) continue;
    const key = to.toLowerCase();
    const sameFile = key === f.rel.toLowerCase(); // a case-only rename
    if (claimed.has(key)) {
      skipped.push({ from: f.rel, to, reason: 'Another file is going there' });
      continue;
    }
    if (!sameFile && exists(to)) {
      skipped.push({ from: f.rel, to, reason: 'A file is already there' });
      continue;
    }
    claimed.add(key);
    moves.push({ from: f.rel, to, artist: f.artist, album: f.album, confident: f.confident });
  }
  return { moves, skipped };
}
```

(If the project has no Biome, drop the `biome-ignore` comment.) Run: PASS (10). Commit: `git add apps/server/src/catalog/organize.ts apps/server/src/catalog/organize.test.ts && git commit -m "Organize: plan where folder files belong"`

---

### Task 4: Store: files to organize, renames in place, the journal

**Files:** `apps/server/src/catalog/store.ts`, `apps/server/src/catalog/store.test.ts`

**Failing tests** (append):

```ts
describe('CatalogStore: organizing', () => {
  function folderWithMezzanine() {
    const store = new CatalogStore(freshDb());
    const id = store.addSource('folder', 'Music', { path: '/music' });
    const sync = mezzanine();
    sync.copies = sync.copies.map((c, i) => ({ ...c, ref: `misc/${i}.flac`, path: `/music/misc/${i}.flac`, preferredId: undefined }));
    store.applySync(id, sync);
    return { store, id };
  }

  it('lists each folder file with where the catalog puts it', () => {
    const { store, id } = folderWithMezzanine();
    expect(store.organizeFiles(id, '/music')).toEqual([
      { rel: 'misc/0.flac', artist: 'Massive Attack', album: 'Mezzanine', title: 'Angel', trackNumber: 1, discNumber: 1, multiDisc: false, confident: true },
      { rel: 'misc/1.flac', artist: 'Massive Attack', album: 'Mezzanine', title: 'Risingson', trackNumber: 2, discNumber: 1, multiDisc: false, confident: true },
    ]);
  });

  it('follows a renamed file everywhere, keeping its copy id', () => {
    const { store, id } = folderWithMezzanine();
    const tags = { genres: [], duration: 1, format: { codec: 'FLAC', container: 'flac', lossless: true } };
    store.saveFolderFiles(id, [{ rel: 'misc/0.flac', size: 1, mtimeMs: 1, tags }], ['misc/0.flac', 'misc/1.flac']);
    store.saveMatches(id, [{ rel: 'misc/0.flac', groupKey: 'g', state: 'manual', size: 1, mtimeMs: 1 }]);
    const copyId = store.load().copies.find((c) => c.path === '/music/misc/0.flac')!.id;
    store.renameFolderFile(id, 'misc/0.flac', 'Massive Attack/Mezzanine/01 Angel.flac', '/music/Massive Attack/Mezzanine/01 Angel.flac');
    expect(store.load().copies.find((c) => c.id === copyId)!.path).toBe('/music/Massive Attack/Mezzanine/01 Angel.flac');
    expect(store.folderFiles(id).has('Massive Attack/Mezzanine/01 Angel.flac')).toBe(true);
    expect(store.matches(id).has('Massive Attack/Mezzanine/01 Angel.flac')).toBe(true);
  });

  it('journals moves by batch', () => {
    const { store, id } = folderWithMezzanine();
    const batch = store.nextMoveBatch();
    store.logMove(id, batch, 'a', 'b');
    store.logMove(id, batch, 'c', 'd');
    expect(store.lastMoveBatch(id)).toMatchObject({ id: batch, files: 2 });
    expect(store.movesOf(id, batch).map((m) => m.from)).toEqual(['a', 'c']);
    store.markUndone(store.movesOf(id, batch).map((m) => m.id));
    expect(store.lastMoveBatch(id)).toBeUndefined();
  });
});
```

**Implement** (import `relative` from `node:path` and `type OrganizeFile` from `./organize.ts`):

```ts
  /** Each audio file of a folder source with where the merged catalog puts it. */
  organizeFiles(sourceId: number, root: string): OrganizeFile[] {
    const rows = this.load();
    const tracks = new Map(rows.tracks.map((t) => [t.id, t]));
    const albums = new Map(rows.albums.map((a) => [a.id, a]));
    const artists = new Map(rows.artists.map((a) => [a.id, a]));
    const discsOf = new Map<number, Set<number>>();
    for (const t of rows.tracks) {
      const set = discsOf.get(t.albumId) ?? new Set<number>();
      set.add(t.meta.discNumber);
      discsOf.set(t.albumId, set);
    }
    return rows.copies
      .filter((c) => c.sourceId === sourceId)
      .flatMap((c) => {
        const track = tracks.get(c.trackId);
        const album = track && albums.get(track.albumId);
        const artist = album && artists.get(album.artistId);
        if (!track || !album || !artist) return [];
        const loose = album.key.startsWith('loose:');
        return [
          {
            rel: relative(root, c.path).split('\\').join('/'),
            artist: artist.meta.name,
            album: loose ? undefined : album.meta.title,
            title: track.meta.title,
            trackNumber: track.meta.trackNumber,
            discNumber: track.meta.discNumber,
            multiDisc: (discsOf.get(album.id)?.size ?? 1) > 1,
            confident: !track.recordingId.startsWith('local:') && album.key.startsWith('mb:'),
          },
        ];
      })
      .sort((a, b) => a.rel.localeCompare(b.rel));
  }

  /** A folder file was moved: its copy, tag cache and match follow it (the copy keeps its id). */
  renameFolderFile(sourceId: number, fromRel: string, toRel: string, toPath: string) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE copies SET source_ref = ?, path = ? WHERE source_id = ? AND source_ref = ?').run(toRel, toPath, sourceId, fromRel);
      this.db.prepare('UPDATE folder_files SET rel_path = ? WHERE source_id = ? AND rel_path = ?').run(toRel, sourceId, fromRel);
      this.db.prepare('UPDATE folder_matches SET rel_path = ? WHERE source_id = ? AND rel_path = ?').run(toRel, sourceId, fromRel);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  nextMoveBatch(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(batch), 0) + 1 AS next FROM file_moves').get() as { next: number }).next;
  }

  logMove(sourceId: number, batch: number, fromRel: string, toRel: string) {
    this.db
      .prepare('INSERT INTO file_moves (batch, source_id, from_rel, to_rel, moved_at) VALUES (?, ?, ?, ?, ?)')
      .run(batch, sourceId, fromRel, toRel, new Date().toISOString());
  }

  movesOf(sourceId: number, batch: number): { id: number; from: string; to: string }[] {
    return this.db
      .prepare('SELECT id, from_rel AS "from", to_rel AS "to" FROM file_moves WHERE source_id = ? AND batch = ? AND undone_at IS NULL ORDER BY id')
      .all(sourceId, batch) as { id: number; from: string; to: string }[];
  }

  markUndone(ids: number[]) {
    const now = new Date().toISOString();
    const mark = this.db.prepare('UPDATE file_moves SET undone_at = ? WHERE id = ?');
    for (const id of ids) mark.run(now, id);
  }

  /** The newest batch with moves left to undo. */
  lastMoveBatch(sourceId: number): { id: number; files: number; at: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT batch AS id, COUNT(*) AS files, MAX(moved_at) AS at FROM file_moves
         WHERE source_id = ? AND undone_at IS NULL GROUP BY batch ORDER BY batch DESC LIMIT 1`,
      )
      .get(sourceId) as { id: number; files: number; at: string } | undefined;
    return row ?? undefined;
  }
```

Also delete `file_moves` rows in `removeSource`. Run: PASS. Commit: `git add apps/server/src/catalog/store.ts apps/server/src/catalog/store.test.ts && git commit -m "Catalog store: files to organize, renames in place, move journal"`

---

### Task 5: The Organizer (apply, companions, cleanup, undo)

**Files:** Create `apps/server/src/catalog/organizer.ts`; test `apps/server/src/catalog/organizer.test.ts`

**Failing tests:**

```ts
// apps/server/src/catalog/organizer.test.ts
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Organizer } from './organizer.ts';
import { CatalogStore } from './store.ts';
import { flacBytes, freshDb, mezzanine, tempDir } from './testFixtures.ts';

let cleanup = () => {};
afterEach(() => cleanup());

function setup() {
  const t = tempDir();
  cleanup = t.cleanup;
  const put = (rel: string, bytes: Buffer = flacBytes()) => {
    mkdirSync(dirname(join(t.dir, rel)), { recursive: true });
    writeFileSync(join(t.dir, rel), bytes);
  };
  put('misc/a.flac');
  put('misc/b.flac');
  put('misc/cover.jpg', Buffer.from([1, 2, 3]));
  const store = new CatalogStore(freshDb());
  const id = store.addSource('folder', 'Music', { path: t.dir });
  const sync = mezzanine();
  sync.copies = [
    { ...sync.copies[0]!, ref: 'misc/a.flac', path: join(t.dir, 'misc/a.flac'), preferredId: undefined },
    { ...sync.copies[1]!, ref: 'misc/b.flac', path: join(t.dir, 'misc/b.flac'), preferredId: undefined },
  ];
  store.applySync(id, sync);
  return { dir: t.dir, put, store, id, organizer: new Organizer(store) };
}

describe('Organizer', () => {
  it('plans moves for a writable folder', () => {
    const { organizer, id } = setup();
    const plan = organizer.plan(id);
    expect(plan.writable).toBe(true);
    expect(plan.moves.map((m) => [m.from, m.to])).toEqual([
      ['misc/a.flac', 'Massive Attack/Mezzanine/01 Angel.flac'],
      ['misc/b.flac', 'Massive Attack/Mezzanine/02 Risingson.flac'],
    ]);
  });

  it('moves the chosen files, their cover, and removes the emptied folder', async () => {
    const { organizer, id, dir, store } = setup();
    const result = await organizer.apply(id, ['misc/a.flac', 'misc/b.flac']);
    expect(result).toMatchObject({ moved: 2, skipped: [] });
    expect(readdirSync(join(dir, 'Massive Attack/Mezzanine')).sort()).toEqual(['01 Angel.flac', '02 Risingson.flac', 'cover.jpg']);
    expect(existsSync(join(dir, 'misc'))).toBe(false);
    expect(store.load().copies.map((c) => c.path).sort()).toEqual([
      join(dir, 'Massive Attack/Mezzanine/01 Angel.flac'),
      join(dir, 'Massive Attack/Mezzanine/02 Risingson.flac'),
    ]);
  });

  it('moves only what was chosen, and leaves companions when the folder keeps audio', async () => {
    const { organizer, id, dir } = setup();
    await organizer.apply(id, ['misc/a.flac']);
    expect(existsSync(join(dir, 'Massive Attack/Mezzanine/01 Angel.flac'))).toBe(true);
    expect(existsSync(join(dir, 'misc/b.flac'))).toBe(true);
    expect(existsSync(join(dir, 'misc/cover.jpg'))).toBe(true);
  });

  it('ignores files the plan doesn’t propose', async () => {
    const { organizer, id } = setup();
    expect((await organizer.apply(id, ['../../etc/passwd'])).moved).toBe(0);
  });

  it('never overwrites a file that appeared since planning', async () => {
    const { organizer, id, put } = setup();
    put('Massive Attack/Mezzanine/01 Angel.flac', Buffer.from('mine'));
    const result = await organizer.apply(id, ['misc/a.flac']);
    expect(result.moved).toBe(0);
    expect(result.skipped[0]).toMatchObject({ from: 'misc/a.flac', reason: 'A file is already there' });
  });

  it('undoes a batch', async () => {
    const { organizer, id, dir, store } = setup();
    const { batchId } = await organizer.apply(id, ['misc/a.flac', 'misc/b.flac']);
    expect(organizer.plan(id).lastBatch).toMatchObject({ id: batchId, files: 3 });
    const undone = await organizer.undo(id, batchId);
    expect(undone.restored).toBe(3);
    expect(readdirSync(join(dir, 'misc')).sort()).toEqual(['a.flac', 'b.flac', 'cover.jpg']);
    expect(existsSync(join(dir, 'Massive Attack'))).toBe(false);
    expect(store.load().copies.map((c) => c.path).sort()).toEqual([join(dir, 'misc/a.flac'), join(dir, 'misc/b.flac')]);
    expect(organizer.plan(id).lastBatch).toBeUndefined();
  });
});
```

**Implement:**

```ts
// apps/server/src/catalog/organizer.ts
import type { OrganizePlan, OrganizeResult, OrganizeSkip } from '@playarr/shared';
import { accessSync, constants, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rmdir } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { isAudioFile } from './folderSource.ts';
import { planMoves } from './organize.ts';
import { isInside } from './paths.ts';
import type { CatalogStore } from './store.ts';

const COMPANION = /\.(jpe?g|png|webp|gif|cue|log|nfo|txt|m3u8?)$/i;

export class OrganizeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Moves a folder source's files into Artist/Album/NN Title.ext, within the folder, with undo. */
export class Organizer {
  constructor(private readonly store: CatalogStore) {}

  plan(sourceId: number): OrganizePlan {
    const root = this.root(sourceId);
    const { moves, skipped } = planMoves(this.store.organizeFiles(sourceId, root), (rel) => existsSync(join(root, rel)));
    return { writable: isWritable(root), moves, skipped, lastBatch: this.store.lastMoveBatch(sourceId) };
  }

  async apply(sourceId: number, fromRels: string[]): Promise<OrganizeResult> {
    const root = this.root(sourceId);
    if (!isWritable(root)) throw new OrganizeError('Playarr can’t write to this folder', 409);
    const wanted = new Set(fromRels);
    const plan = this.plan(sourceId).moves.filter((m) => wanted.has(m.from));
    const batchId = this.store.nextMoveBatch();
    const skipped: OrganizeSkip[] = [];
    const movedFrom = new Map<string, string>(); // from dir → target dir ('' if mixed)
    let moved = 0;

    for (const m of plan) {
      const result = await this.move(root, m.from, m.to);
      if (result !== true) {
        skipped.push({ from: m.from, to: m.to, reason: result });
        continue;
      }
      this.store.renameFolderFile(sourceId, m.from, m.to, join(root, m.to));
      this.store.logMove(sourceId, batchId, m.from, m.to);
      moved++;
      const fromDir = posix.dirname(m.from);
      const toDir = posix.dirname(m.to);
      const seen = movedFrom.get(fromDir);
      movedFrom.set(fromDir, seen === undefined || seen === toDir ? toDir : '');
    }

    // Covers and the like follow when all of a folder's audio went to one place.
    for (const [fromDir, toDir] of movedFrom) {
      if (!toDir) continue;
      const names = await readdir(join(root, fromDir)).catch((): string[] => []);
      if (names.some(isAudioFile)) continue;
      for (const name of names.filter((n) => COMPANION.test(n))) {
        const from = posix.join(fromDir, name);
        const to = posix.join(toDir, name);
        if ((await this.move(root, from, to)) === true) {
          this.store.logMove(sourceId, batchId, from, to);
          moved++;
        }
      }
      await this.removeEmpty(root, fromDir);
    }
    return { batchId, moved, skipped };
  }

  async undo(sourceId: number, batchId: number): Promise<{ restored: number; skipped: OrganizeSkip[] }> {
    const root = this.root(sourceId);
    const moves = this.store.movesOf(sourceId, batchId).reverse();
    const done: number[] = [];
    const skipped: OrganizeSkip[] = [];
    const dirs = new Set<string>();
    for (const m of moves) {
      const result = await this.move(root, m.to, m.from);
      if (result !== true) {
        skipped.push({ from: m.to, to: m.from, reason: result });
        continue;
      }
      this.store.renameFolderFile(sourceId, m.to, m.from, join(root, m.from));
      done.push(m.id);
      dirs.add(posix.dirname(m.to));
    }
    this.store.markUndone(done);
    for (const dir of dirs) await this.removeEmpty(root, dir);
    return { restored: done.length, skipped };
  }

  /** Rename within the folder; true, or why not. Never overwrites. */
  private async move(root: string, fromRel: string, toRel: string): Promise<true | string> {
    const from = join(root, fromRel);
    const to = join(root, toRel);
    if (!isInside(from, root) || !isInside(to, root)) return 'Outside the folder';
    const caseOnly = fromRel.toLowerCase() === toRel.toLowerCase();
    if (!caseOnly && existsSync(to)) return 'A file is already there';
    if (!existsSync(from)) return 'The file is gone';
    try {
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'EXDEV' ? 'On a different drive' : code === 'EACCES' || code === 'EPERM' ? 'Not allowed to move it' : (err as Error).message;
    }
  }

  /** Remove `rel` and its parents while empty, stopping at the root. */
  private async removeEmpty(root: string, rel: string) {
    let dir = rel;
    while (dir && dir !== '.') {
      if ((await readdir(join(root, dir)).catch(() => ['?'])).length) return;
      await rmdir(join(root, dir)).catch(() => {});
      dir = posix.dirname(dir);
    }
  }

  private root(sourceId: number): string {
    const source = this.store.source(sourceId);
    const root = source?.kind === 'folder' ? (source.settings as { path?: string }).path : undefined;
    if (!root) throw new OrganizeError('Not a folder source', 404);
    return root;
  }
}
```

Run: PASS (6). If the undo count differs (the cover counts as a move: 3), keep the test's expectation and fix the code, not the other way round. Commit: `git add apps/server/src/catalog/organizer.ts apps/server/src/catalog/organizer.test.ts && git commit -m "Organizer: move files with their covers, clean up, undo"`

---

### Task 6: API, writable flag, wiring

**Files:** `apps/server/src/routes/settings.ts`, `apps/server/src/routes/settings.test.ts`, `apps/server/src/catalog/sources.ts`, `apps/server/src/index.ts`

**Tests** (`settings.test.ts`): pass a real `Organizer` in `setup()` (`new Organizer(store)`), and add:

```ts
  it('plans, applies and undoes organizing from the home network only', async () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.dir, 'misc'));
      writeFileSync(join(t.dir, 'misc/a.flac'), flacBytes());
      const { app, store, library } = setup();
      const id = store.addSource('folder', 'Music', { path: t.dir });
      const sync = mezzanine();
      sync.copies = [{ ...sync.copies[0]!, ref: 'misc/a.flac', path: join(t.dir, 'misc/a.flac'), preferredId: undefined }];
      store.applySync(id, sync);

      expect((await app.inject({ method: 'GET', url: `/api/settings/sources/${id}/organize`, remoteAddress: AWAY })).statusCode).toBe(403);
      const plan = (await app.inject({ method: 'GET', url: `/api/settings/sources/${id}/organize`, remoteAddress: HOME })).json();
      expect(plan.moves).toEqual([expect.objectContaining({ from: 'misc/a.flac', to: 'Massive Attack/Mezzanine/01 Angel.flac' })]);

      const applied = await app.inject({ method: 'POST', url: `/api/settings/sources/${id}/organize`, payload: { moves: ['misc/a.flac'] }, remoteAddress: HOME });
      expect(applied.json()).toMatchObject({ moved: 1 });
      expect(library.reload).toHaveBeenCalled();

      const undone = await app.inject({ method: 'POST', url: `/api/settings/sources/${id}/organize/undo`, payload: { batchId: applied.json().batchId }, remoteAddress: HOME });
      expect(undone.json()).toMatchObject({ restored: 1 });
    } finally {
      t.cleanup();
    }
  });
```

(imports: `mkdirSync`, `writeFileSync` from `node:fs`; `join` from `node:path`; `flacBytes`, `mezzanine`, `tempDir` from `../catalog/testFixtures.ts`; `Organizer` from `../catalog/organizer.ts`.)

**Implement** in `routes/settings.ts`: deps gain `organizer: Organizer`; schemas `const organizeInput = z.object({ moves: z.array(z.string()).max(10_000) }); const undoInput = z.object({ batchId: z.number().int() });`. Map `OrganizeError` like `SourceError` in `handle` (`if (err instanceof OrganizeError) return reply.code(err.status).send({ error: err.message });`). Routes (all `editable`; GET too, it reveals file names):

```ts
  app.get<Id>('/api/settings/sources/:id/organize', editable, (req, reply) => handle(reply, () => organizer.plan(Number(req.params.id))));

  app.post<Id>('/api/settings/sources/:id/organize', editable, (req, reply) =>
    handle(reply, async () => {
      const result = await organizer.apply(Number(req.params.id), parse(organizeInput, req.body).moves);
      library.reload();
      return result;
    }),
  );

  app.post<Id>('/api/settings/sources/:id/organize/undo', editable, (req, reply) =>
    handle(reply, async () => {
      const result = await organizer.undo(Number(req.params.id), parse(undoInput, req.body).batchId);
      library.reload();
      return result;
    }),
  );
```

`sources.ts` → `toInfo`: for folder sources add `writable: isWritable(path)` (import from `./organizer.ts`; only when `path` is set; leave undefined for Lidarr).

`index.ts`: `const organizer = new Organizer(store);` and pass `organizer` to `settingsRoutes`.

Typecheck, all tests, build: clean/pass. Commit: `git add apps/server/src/routes/settings.ts apps/server/src/routes/settings.test.ts apps/server/src/catalog/sources.ts apps/server/src/index.ts && git commit -m "Organize API: plan, apply and undo, local network only"`

---

### Task 7: Web: Organize dialog

**Files:** `apps/web/src/lib/api.ts`, `apps/web/src/lib/queries.ts`, create `apps/web/src/components/OrganizeDialog.tsx`, modify `apps/web/src/components/SourcesPanel.tsx`

**API** (add `OrganizePlan`, `OrganizeResult` to imports):

```ts
  organizePlan: (id: number) => get<OrganizePlan>(`/api/settings/sources/${id}/organize`),
  organize: (id: number, moves: string[]) =>
    request<OrganizeResult>(`/api/settings/sources/${id}/organize`, { method: 'POST', body: JSON.stringify({ moves }) }),
  undoOrganize: (id: number, batchId: number) =>
    request<{ restored: number }>(`/api/settings/sources/${id}/organize/undo`, { method: 'POST', body: JSON.stringify({ batchId }) }),
```

**Queries:**

```ts
export const useOrganizePlan = (id: number | null) =>
  useQuery({ queryKey: ['organize', id], queryFn: () => api.organizePlan(id!), enabled: id !== null, staleTime: 0 });

export function useOrganizeActions(id: number) {
  const client = useQueryClient();
  const done = () => void client.invalidateQueries(); // paths and covers changed everywhere
  return {
    apply: useMutation({
      mutationFn: (moves: string[]) => api.organize(id, moves),
      onSuccess: (r) => {
        toast(`Moved ${plural(r.moved, 'file')}${r.skipped.length ? `; ${r.skipped.length} skipped` : ''}`);
        done();
      },
      onError: (err: Error) => toast(err.message, 'error'),
    }),
    undo: useMutation({
      mutationFn: (batchId: number) => api.undoOrganize(id, batchId),
      onSuccess: (r) => {
        toast(`Put ${plural(r.restored, 'file')} back`);
        done();
      },
      onError: (err: Error) => toast(err.message, 'error'),
    }),
  };
}
```

(import `plural` from `./format` in `queries.ts` if not already.)

**`components/OrganizeDialog.tsx`:**

```tsx
import type { OrganizeMove } from '@playarr/shared';
import { ArrowRight, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { plural } from '../lib/format';
import { useOrganizeActions, useOrganizePlan } from '../lib/queries';
import { Dialog } from './Dialog';

/** Settings → Sources → Organize files: review proposed moves, apply some or all, undo. */
export function OrganizeDialog({ sourceId, onClose }: { sourceId: number | null; onClose: () => void }) {
  const { data: plan, isPending } = useOrganizePlan(sourceId);
  return (
    <Dialog open={sourceId !== null} onClose={onClose} title="Organize files" wide>
      {isPending || !plan ? (
        <div className="m-5 h-40 animate-pulse rounded-lg bg-paper/5" />
      ) : (
        <OrganizeBody key={sourceId} sourceId={sourceId!} moves={plan.moves} skipped={plan.skipped} writable={plan.writable} lastBatch={plan.lastBatch} />
      )}
    </Dialog>
  );
}

function OrganizeBody({
  sourceId,
  moves,
  skipped,
  writable,
  lastBatch,
}: {
  sourceId: number;
  moves: OrganizeMove[];
  skipped: { from: string; to?: string; reason: string }[];
  writable: boolean;
  lastBatch?: { id: number; files: number; at: string };
}) {
  const actions = useOrganizeActions(sourceId);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  useEffect(() => setChosen(new Set(moves.filter((m) => m.confident).map((m) => m.from))), [moves]);
  const albums = useMemo(() => {
    const groups = new Map<string, OrganizeMove[]>();
    for (const m of moves) {
      const key = `${m.artist} · ${m.album ?? 'No album'}`;
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    return [...groups];
  }, [moves]);
  const toggle = (from: string) =>
    setChosen((s) => {
      const next = new Set(s);
      if (next.has(from)) next.delete(from);
      else next.add(from);
      return next;
    });

  if (!writable) {
    return (
      <p className="p-5 text-[15px] text-paper-dim">
        Playarr can’t write to this folder, so it can’t move files. In Docker, mount the folder you want organized read-write
        (the broad /host mount stays read-only).
      </p>
    );
  }

  return (
    <div className="space-y-5 p-5">
      <p className="text-sm text-muted">
        Files move into Artist/Album/NN Title, inside this folder only. Nothing is overwritten, tags aren’t changed, and you can
        undo. Moves Playarr is less sure about start unchecked.
      </p>
      {lastBatch && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-4 py-3 text-sm">
          <span className="text-paper-dim">
            Last change: {plural(lastBatch.files, 'file')} moved {new Date(lastBatch.at).toLocaleString()}
          </span>
          <button
            type="button"
            disabled={actions.undo.isPending}
            onClick={() => actions.undo.mutate(lastBatch.id)}
            className="inline-flex items-center gap-1.5 text-accent hover:underline disabled:opacity-50"
          >
            <Undo2 className="size-4" /> Undo
          </button>
        </div>
      )}
      {moves.length === 0 ? (
        <p className="text-[15px] text-paper-dim">Everything is already where it belongs.</p>
      ) : (
        <>
          <div className="flex items-center justify-between text-[13px] text-muted">
            <span>
              {chosen.size} of {plural(moves.length, 'move')} selected
            </span>
            <span className="flex gap-3">
              <button type="button" onClick={() => setChosen(new Set(moves.map((m) => m.from)))} className="text-accent hover:underline">
                All
              </button>
              <button type="button" onClick={() => setChosen(new Set())} className="text-accent hover:underline">
                None
              </button>
            </span>
          </div>
          <div className="max-h-[50dvh] space-y-5 overflow-y-auto pr-1">
            {albums.map(([title, list]) => (
              <section key={title}>
                <h3 className="mb-1.5 font-mono text-[11px] tracking-[0.15em] text-muted uppercase">{title}</h3>
                <ul className="space-y-0.5">
                  {list.map((m) => (
                    <li key={m.from}>
                      <label className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-1.5 hover:bg-paper/[0.03]">
                        <input type="checkbox" checked={chosen.has(m.from)} onChange={() => toggle(m.from)} className="mt-1" />
                        <span className="min-w-0 flex-1 font-mono text-[12px] leading-relaxed">
                          <span className="block truncate text-muted" title={m.from}>{m.from}</span>
                          <span className="flex items-center gap-1.5 truncate text-paper" title={m.to}>
                            <ArrowRight className="size-3 shrink-0 text-accent" />
                            {m.to}
                          </span>
                        </span>
                        {!m.confident && <span className="shrink-0 font-mono text-[10px] tracking-wider text-muted uppercase">Guess</span>}
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
      {skipped.length > 0 && (
        <details className="text-[13px] text-muted">
          <summary className="cursor-pointer">{plural(skipped.length, 'file')} can’t move</summary>
          <ul className="mt-2 space-y-1 font-mono text-[12px]">
            {skipped.map((s) => (
              <li key={s.from}>
                {s.from} · <span className="text-paper-dim">{s.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {moves.length > 0 && (
        <div className="flex justify-end border-t border-line pt-4">
          <button
            type="button"
            disabled={chosen.size === 0 || actions.apply.isPending}
            onClick={() => actions.apply.mutate([...chosen])}
            className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-[14px] font-medium text-accent-ink disabled:opacity-50"
          >
            {actions.apply.isPending ? 'Moving…' : `Move ${plural(chosen.size, 'file')}`}
          </button>
        </div>
      )}
    </div>
  );
}
```

**`SourcesPanel.tsx`:** state `const [organizing, setOrganizing] = useState<number | null>(null);`, render `<OrganizeDialog sourceId={organizing} onClose={() => setOrganizing(null)} />`, pass `onOrganize={() => setOrganizing(s.id)}` to `SourceRow`, and in the row's actions, for folder sources: `<IconButton label="Organize files" onClick={onOrganize}><FolderTree className="size-4" /></IconButton>` (lucide `FolderTree`). When `s.writable === false`, keep the button (the dialog explains why it can't move files).

Typecheck and build: clean. Commit: `git add apps/web/src/lib/api.ts apps/web/src/lib/queries.ts apps/web/src/components/OrganizeDialog.tsx apps/web/src/components/SourcesPanel.tsx && git commit -m "Web: organize folder files from Settings, with undo"`

---

### Task 8: Docs

**Files:** `PLAN.md`, `README.md`, `docker/compose.yaml`

- PLAN.md decisions log: `| 2026-10-30 | Organizing files (phase 4b): opt-in per folder source, review-then-apply. Layout Artist/Album/NN Title.ext (D-NN on multi-disc, Artist/Title.ext without an album), safe names, renames within the folder only, never overwrite, companions (covers, cue, log) follow when a folder's audio all moves, emptied folders removed, every move journaled (file_moves) and undoable per batch. The catalog follows renamed files in place, so copy ids, queues and offline songs survive. Server computes targets; the client only picks which files. |`
- README: under the Folder sources bullet add `Optionally, Playarr can tidy a folder into Artist/Album/NN Title: it proposes the moves, you choose which to apply, and every change can be undone.`
- `docker/compose.yaml`: under the `/host` comment add `# Folders you want Playarr to organize must be mounted read-write, e.g. - /volume1/music-inbox:/host/inbox`.

Commit: `git add PLAN.md README.md docker/compose.yaml && git commit -m "Docs: organizing folder files"`

---

## Not verified by this plan

- Real collections: odd characters, very long names, many files per apply.
- Case-only renames on case-insensitive filesystems (the test is logic-only).
- Network shares and Docker bind mounts (renames across mounts give `EXDEV`, reported as skipped).
- The dialog in a browser.
