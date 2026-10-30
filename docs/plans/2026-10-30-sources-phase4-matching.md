# Sources, Phase 4: Matching Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Identify folder music that isn't tagged with MusicBrainz ids: match albums on MusicBrainz by names, track titles and durations, fall back to audio fingerprints (Chromaprint + AcoustID), and let the user review doubtful matches in Settings. Matched albums get full track lists (missing songs greyed out) and their songs keep their favorites and playlist entries.

**Architecture:** Matching never touches files. A `Matcher` (server) works through a background queue of folder album groups (files sharing an album tag, or a folder). For each group it searches MusicBrainz releases, scores each candidate by aligning files to its tracks (`scoreRelease`: title similarity, duration, position), and stores one row per file in `folder_matches` (`auto`, `review`, `unmatched`, `manual`, `ignored`) with an *overlay*: the MusicBrainz ids, titles and positions to lay over the file's own tags. `FolderSource` applies overlays before `folderSync`, so a matched file behaves exactly like a MusicBrainz-tagged one; for matched releases `folderSync` also reports the release's other tracks (missing songs). Releases are cached in `mb_releases`. When a song's id changes from `local:<hash>` to a MusicBrainz recording, `CatalogStore.applySync` moves its favorites, playlist entries and analysis to the new id. Settings shows "N to review" per folder source and a review dialog; an AcoustID key is set in Settings.

**Tech Stack:** Node 25, Fastify 5, `node:sqlite`, vitest 5; MusicBrainz web service (existing throttled client), AcoustID v2 API, `fpcalc` (Chromaprint; Alpine package `chromaprint`, verified to provide `/usr/bin/fpcalc`); React 19, TanStack Query 5. pnpm via `corepack pnpm`.

**Design:** `docs/plans/2026-10-30-sources-design.md` (Metadata decisions; Scanning and matching → Match; Review list; Testing). Builds on Phases 1 to 3 (implemented): `apps/server/src/catalog/*` (`folder.ts`, `folderSource.ts`, `store.ts`, `tags.ts`, `sources.ts`), `discover/musicbrainz.ts`, `components/SourcesPanel.tsx`.

## Decisions

- **Overlay, not a parallel catalog:** a match is "the tags this file should have had". One code path (`folderSync`) maps tagged and matched files alike.
- **Thresholds:** album score ≥ 0.85 with every file ≥ 0.6 → applied automatically; ≥ 0.5 → review (top 3 candidates kept); else fingerprints, else unmatched. Scores: 0.6 × title similarity + 0.3 × duration closeness (1 within 3 s, 0 beyond 15 s, 0.5 if unknown) + 0.1 × same disc and position; album score = mean over files × (tracks / files when there are more files than tracks).
- **Fingerprints** run only when names didn't give an automatic match, only for local folder files, and only with an AcoustID key and `fpcalc` available. A fingerprint result ≥ 0.8 sets the recording and its most "original" release group (studio album first); if fewer than half a group's files match, the group stays as names left it.
- **Re-matching:** a file is matched again when its size or modified time changes, unless the match is `manual` or `ignored` (user decisions stick). "Match again" in Settings clears automatic results for a source.
- **Metadata trust:** MusicBrainz data from a match is rank 1 (between Lidarr 0 and plain tags 2), set per album and track.
- **Song id changes:** favorites, playlist items and song analysis follow a song from `local:<hash>` to its MusicBrainz recording id. Saved queues and offline songs keep working (copy ids don't change).
- **Rate limits:** MusicBrainz ~1 request/s through the existing shared queue (Discover searches wait behind matching on a big first scan; acceptable for now); AcoustID 3 requests/s.
- **Fixes table:** the design's "fixes" are the `manual`/`ignored` rows of `folder_matches` (keyed by source + relative path). Organizing files (phase 4b) will move these rows with the files.

## Conventions

- Run everything from `/Users/bortignon/dev/playarr`.
- Server tests: `corepack pnpm -C apps/server test`; one file: `corepack pnpm -C apps/server exec vitest run src/catalog/match.test.ts`.
- Typecheck: `corepack pnpm -C apps/server typecheck`; web: `corepack pnpm -C apps/web exec tsc --noEmit`; web build: `corepack pnpm -C apps/web exec vite build`.
- No network in tests: MusicBrainz and AcoustID are faked; `fpcalc` isn't installed locally.
- Commit after every task directly on `main`, staging only that task's files; then `git push origin main` (if it fails on credentials, carry on and report).

---

### Task 1: Shared types

**Files:** Modify `packages/shared/src/index.ts`

Add to `SourceInfo`:

```ts
  /** Folder sources: album groups waiting for the user's review. */
  review: number;
  /** Folder sources: album groups still being matched. */
  matching: number;
```

Append:

```ts
// ── Matching: identifying folder music on MusicBrainz ───────────────────────

export interface ReviewFile {
  rel: string;
  title: string;
  trackNumber: number;
  discNumber: number;
  duration: number;
}

export interface ReviewCandidate {
  releaseId: string;
  title: string;
  artistName: string;
  year?: number;
  /** 0..1 */
  score: number;
  tracks: { disc: number; position: number; title: string; duration: number }[];
  /** File (rel) → index in `tracks` it was matched to. */
  matches: Record<string, number>;
}

export interface ReviewGroup {
  groupKey: string;
  artistName: string;
  albumTitle?: string;
  files: ReviewFile[];
  candidates: ReviewCandidate[];
}

export interface ReviewAction {
  groupKey: string;
  /** A candidate to use; null: leave this group unmatched for good. */
  releaseId?: string | null;
  /** Look for other candidates. */
  search?: { artist: string; album: string };
}

export interface MatchingSettings {
  /** An AcoustID key is saved (the key itself is never sent). */
  acoustid: boolean;
  /** fpcalc (Chromaprint) is installed, so fingerprints can be computed. */
  fingerprints: boolean;
}
```

Typecheck: server fails in `catalog/sources.ts` (`review`/`matching` missing in `toInfo`): fixed in Task 9. Web clean.

Commit: `git add packages/shared/src/index.ts && git commit -m "Matching: shared types" && git push origin main`

---

### Task 2: Database

**Files:** Modify `apps/server/src/db.ts`, `apps/server/src/db.test.ts`

**Test** (add to `describe('migrate')`):

```ts
  it('adds folder matches and the release cache', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('folder_matches')).toEqual([
      'source_id', 'rel_path', 'group_key', 'state', 'overlay', 'candidates', 'score', 'file_size', 'file_mtime', 'updated_at',
    ]);
    expect(cols('mb_releases')).toEqual(['release_id', 'data', 'fetched_at']);
  });
```

Run, see it fail, then append to `MIGRATIONS`:

```ts
  // Matching folder files to MusicBrainz: one row per file (the overlay to lay over its tags),
  // and fetched releases (track lists) so matches and missing songs need no refetching.
  `CREATE TABLE folder_matches (
     source_id  INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
     rel_path   TEXT NOT NULL,
     group_key  TEXT NOT NULL,
     state      TEXT NOT NULL,
     overlay    TEXT,
     candidates TEXT,
     score      REAL,
     file_size  INTEGER NOT NULL,
     file_mtime INTEGER NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (source_id, rel_path)
   );
   CREATE INDEX folder_matches_by_group ON folder_matches (source_id, group_key);
   CREATE TABLE mb_releases (
     release_id TEXT PRIMARY KEY,
     data       TEXT NOT NULL,
     fetched_at TEXT NOT NULL
   );`,
```

Run: PASS (5 tests). Commit: `git add apps/server/src/db.ts apps/server/src/db.test.ts && git commit -m "Database: folder matches and release cache" && git push origin main`

---

### Task 3: Title similarity and release scoring

**Files:** Create `apps/server/src/catalog/match.ts`; test `apps/server/src/catalog/match.test.ts`

**Step 1: Failing tests**

```ts
// apps/server/src/catalog/match.test.ts
import { describe, expect, it } from 'vitest';
import { scoreRelease, titleSimilarity, verdict, type FileFacts } from './match.ts';
import type { MbReleaseInfo } from './mbRelease.ts';

const release: MbReleaseInfo = {
  id: 'rel-1',
  title: 'Mezzanine',
  artistName: 'Massive Attack',
  artistId: 'art-1',
  releaseGroup: { id: 'rg-1', title: 'Mezzanine', primaryType: 'Album', secondaryTypes: [], firstReleaseDate: '1998-04-17' },
  tracks: [
    { disc: 1, position: 1, title: 'Angel', length: 379, recordingId: 'rec-1' },
    { disc: 1, position: 2, title: 'Risingson', length: 299, recordingId: 'rec-2' },
    { disc: 1, position: 3, title: 'Teardrop', length: 330, recordingId: 'rec-3' },
  ],
};
const file = (rel: string, title: string, trackNumber: number, duration: number): FileFacts => ({
  rel, title, trackNumber, discNumber: 1, duration,
});

describe('titleSimilarity', () => {
  it('ignores case, accents, punctuation and remaster notes', () => {
    expect(titleSimilarity('Teardrop', 'teardrop')).toBe(1);
    expect(titleSimilarity('Angel (2019 Remaster)', 'Angel')).toBe(1);
    expect(titleSimilarity('Risingson', 'Risinsgon')).toBeGreaterThan(0.7);
    expect(titleSimilarity('Angel', 'Teardrop')).toBeLessThan(0.3);
  });
});

describe('scoreRelease', () => {
  it('matches a complete album automatically', () => {
    const s = scoreRelease([file('01.flac', 'Angel', 1, 380), file('02.flac', 'Risingson', 2, 298), file('03.flac', 'Teardrop', 3, 331)], release);
    expect(s.score).toBeGreaterThan(0.95);
    expect(s.alignment.map((a) => [a.rel, a.track.recordingId])).toEqual(
      expect.arrayContaining([['01.flac', 'rec-1'], ['02.flac', 'rec-2'], ['03.flac', 'rec-3']]),
    );
    expect(verdict(s)).toBe('auto');
  });

  it('matches part of an album automatically', () => {
    expect(verdict(scoreRelease([file('a.flac', 'Teardrop', 0, 330)], release))).toBe('auto');
  });

  it('asks for review when durations disagree', () => {
    const s = scoreRelease([file('01.flac', 'Angel', 0, 200), file('02.flac', 'Risingson', 0, 120)], release);
    expect(verdict(s)).toBe('review');
  });

  it('rejects a different album', () => {
    const s = scoreRelease([file('01.flac', 'Glory Box', 11, 301), file('02.flac', 'Roads', 6, 305)], release);
    expect(verdict(s)).toBe('unmatched');
  });

  it('penalizes more files than the release has tracks', () => {
    const files = [1, 2, 3, 4, 5, 6].map((n) => file(`${n}.flac`, ['Angel', 'Risingson', 'Teardrop'][n % 3]!, n, 300));
    expect(scoreRelease(files, release).score).toBeLessThan(0.6);
  });

  it('has no verdict without a candidate', () => {
    expect(verdict(undefined)).toBe('unmatched');
  });
});
```

**Step 2:** Run; expect FAIL.

**Step 3: Implement** (`mbRelease.ts` types come in Task 4; create the type file now with just the interfaces, Task 4 adds the parser):

```ts
// apps/server/src/catalog/mbRelease.ts
/** A MusicBrainz release (one edition of an album) with its track list, as matching uses it. */
export interface MbTrack {
  disc: number;
  position: number;
  title: string;
  length: number; // seconds, 0 if unknown
  recordingId: string;
}

export interface MbReleaseInfo {
  id: string;
  title: string;
  date?: string;
  artistName: string;
  artistId?: string;
  releaseGroup: { id: string; title: string; primaryType?: string; secondaryTypes: string[]; firstReleaseDate?: string };
  tracks: MbTrack[];
}
```

```ts
// apps/server/src/catalog/match.ts
import { normalize } from '../library/search.ts';
import type { MbReleaseInfo, MbTrack } from './mbRelease.ts';

/** What matching knows about a file: from its tags, else its name. */
export interface FileFacts {
  rel: string;
  title: string;
  trackNumber: number;
  discNumber: number;
  duration: number;
}

export interface Alignment {
  rel: string;
  track: MbTrack;
  score: number;
}

export interface ReleaseScore {
  release: MbReleaseInfo;
  score: number;
  alignment: Alignment[];
}

export const AUTO_SCORE = 0.85;
export const REVIEW_SCORE = 0.5;
export const MIN_FILE_SCORE = 0.6;

const VERSION_NOTE = /\s*[([][^)\]]*(remaster|album version|explicit|bonus track|mono|stereo)[^)\]]*[)\]]/gi;

/** 0..1, ignoring case, accents, punctuation and notes like "(2019 Remaster)". */
export function titleSimilarity(a: string, b: string): number {
  const x = normalize(a.replace(VERSION_NOTE, ''));
  const y = normalize(b.replace(VERSION_NOTE, ''));
  if (!x || !y) return 0;
  if (x === y) return 1;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

export function fileTrackScore(f: FileFacts, t: MbTrack): number {
  const title = titleSimilarity(f.title, t.title);
  const diff = f.duration > 0 && t.length > 0 ? Math.abs(f.duration - t.length) : undefined;
  const duration = diff === undefined ? 0.5 : diff <= 3 ? 1 : diff >= 15 ? 0 : 1 - (diff - 3) / 12;
  const position = f.trackNumber > 0 && f.trackNumber === t.position && f.discNumber === t.disc ? 1 : 0;
  return 0.6 * title + 0.3 * duration + 0.1 * position;
}

/** Pair each file with at most one track (best pairs first) and score the release. */
export function scoreRelease(files: FileFacts[], release: MbReleaseInfo): ReleaseScore {
  const pairs = files
    .flatMap((f) => release.tracks.map((t) => ({ f, t, s: fileTrackScore(f, t) })))
    .sort((a, b) => b.s - a.s);
  const usedFiles = new Set<string>();
  const usedTracks = new Set<MbTrack>();
  const alignment: Alignment[] = [];
  for (const p of pairs) {
    if (usedFiles.has(p.f.rel) || usedTracks.has(p.t)) continue;
    usedFiles.add(p.f.rel);
    usedTracks.add(p.t);
    alignment.push({ rel: p.f.rel, track: p.t, score: p.s });
  }
  const mean = alignment.reduce((sum, a) => sum + a.score, 0) / Math.max(files.length, 1);
  // More files than tracks: some of them can't be on this release.
  const fit = files.length > release.tracks.length ? release.tracks.length / files.length : 1;
  return { release, score: mean * fit, alignment };
}

export function verdict(best: ReleaseScore | undefined): 'auto' | 'review' | 'unmatched' {
  if (!best) return 'unmatched';
  if (best.score >= AUTO_SCORE && best.alignment.every((a) => a.score >= MIN_FILE_SCORE)) return 'auto';
  return best.score >= REVIEW_SCORE ? 'review' : 'unmatched';
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}
```

**Step 4:** Run; PASS (7 tests). If a threshold-sensitive case fails, check the arithmetic in a comment before changing either the test or the weights; don't loosen thresholds silently.

Commit: `git add apps/server/src/catalog/match.ts apps/server/src/catalog/match.test.ts apps/server/src/catalog/mbRelease.ts && git commit -m "Matching: title similarity and release scoring" && git push origin main`

---

### Task 4: MusicBrainz releases

**Files:** Modify `apps/server/src/catalog/mbRelease.ts`, `apps/server/src/discover/musicbrainz.ts`; test `apps/server/src/catalog/mbRelease.test.ts`

**Test** (shape verified against the live API on 2026-10-30):

```ts
// apps/server/src/catalog/mbRelease.test.ts
import { describe, expect, it } from 'vitest';
import { toReleaseInfo, type MbReleaseRaw } from './mbRelease.ts';

const raw: MbReleaseRaw = {
  id: '0d33ef7a-1f5d-4365-b807-b412271b99c3',
  title: 'Mezzanine',
  date: '1998-05-12',
  'artist-credit': [{ name: 'Massive Attack', artist: { id: '10adbe5e-a2c0-4bf3-8249-2b4cbf6e6ca8', name: 'Massive Attack' } }],
  'release-group': { id: '6f9f6899-c0d3-311d-ae87-a10ae6bc53a9', title: 'Mezzanine', 'primary-type': 'Album', 'secondary-types': null, 'first-release-date': '1998-04-17' },
  media: [
    {
      position: 1,
      tracks: [
        { position: 1, title: 'Angel', length: 380533, recording: { id: '8e74dd9d-e5a3-4acd-918a-c36a0f8cda84', title: 'Angel', length: 378866 } },
        { position: 2, title: 'Risingson', length: null, recording: { id: '02011500-814c-461c-b3a6-f24fe68ee5a1', title: 'Risingson', length: 298800 } },
      ],
    },
  ],
};

describe('toReleaseInfo', () => {
  it('flattens a release with its tracks', () => {
    expect(toReleaseInfo(raw)).toEqual({
      id: raw.id,
      title: 'Mezzanine',
      date: '1998-05-12',
      artistName: 'Massive Attack',
      artistId: '10adbe5e-a2c0-4bf3-8249-2b4cbf6e6ca8',
      releaseGroup: { id: '6f9f6899-c0d3-311d-ae87-a10ae6bc53a9', title: 'Mezzanine', primaryType: 'Album', secondaryTypes: [], firstReleaseDate: '1998-04-17' },
      tracks: [
        { disc: 1, position: 1, title: 'Angel', length: 381, recordingId: '8e74dd9d-e5a3-4acd-918a-c36a0f8cda84' },
        { disc: 1, position: 2, title: 'Risingson', length: 299, recordingId: '02011500-814c-461c-b3a6-f24fe68ee5a1' },
      ],
    });
  });
});
```

**Implement** — append to `mbRelease.ts`:

```ts
import { creditName, type MbArtistCredit } from '../discover/musicbrainz.ts';

/** /ws/2/release/:id?inc=recordings+artist-credits+release-groups (only the fields used). */
export interface MbReleaseRaw {
  id: string;
  title: string;
  date?: string;
  'artist-credit'?: MbArtistCredit[];
  'release-group': {
    id: string;
    title: string;
    'primary-type'?: string;
    'secondary-types'?: string[] | null;
    'first-release-date'?: string;
  };
  media: {
    position: number;
    tracks: { position: number; title: string; length: number | null; recording: { id: string; title: string; length: number | null } }[];
  }[];
}

export function toReleaseInfo(raw: MbReleaseRaw): MbReleaseInfo {
  const rg = raw['release-group'];
  return {
    id: raw.id,
    title: raw.title,
    date: raw.date || undefined,
    artistName: creditName(raw['artist-credit']),
    artistId: raw['artist-credit']?.[0]?.artist.id,
    releaseGroup: {
      id: rg.id,
      title: rg.title,
      primaryType: rg['primary-type'],
      secondaryTypes: rg['secondary-types'] ?? [],
      firstReleaseDate: rg['first-release-date'] || undefined,
    },
    tracks: raw.media.flatMap((m) =>
      m.tracks.map((t) => ({
        disc: m.position,
        position: t.position,
        title: t.title,
        length: Math.round((t.length ?? t.recording.length ?? 0) / 1000),
        recordingId: t.recording.id,
      })),
    ),
  };
}
```

(`JSON.parse(JSON.stringify(...))` isn't needed: the test uses `toEqual`, which ignores `undefined` fields.)

In `discover/musicbrainz.ts`, add a hit type and two methods to the class:

```ts
export interface MbReleaseHit {
  id: string;
  score: number;
  title: string;
  'track-count': number;
  date?: string;
  'release-group'?: { id: string; 'primary-type'?: string; 'secondary-types'?: string[] | null };
  'artist-credit'?: MbArtistCredit[];
}
```

```ts
  /** Releases (editions) by album title and artist, best match first. */
  searchReleases(artistName: string, albumTitle: string, signal?: AbortSignal) {
    const query = `release:"${luceneEscape(albumTitle)}" AND artist:"${luceneEscape(artistName)}"`;
    return this.get<{ releases: MbReleaseHit[] }>(`/release?query=${encodeURIComponent(query)}&limit=10`, signal).then(
      (r) => r.releases,
    );
  }

  /** One release with its track list. */
  release(releaseMbid: string, signal?: AbortSignal) {
    return this.get<MbReleaseRaw>(
      `/release/${encodeURIComponent(releaseMbid)}?inc=recordings+artist-credits+release-groups`,
      signal,
    );
  }
```

(import `type MbReleaseRaw` from `../catalog/mbRelease.ts`.)

Run the test: PASS. Typecheck (only the Task 1 error remains). Commit: `git add apps/server/src/catalog/mbRelease.ts apps/server/src/catalog/mbRelease.test.ts apps/server/src/discover/musicbrainz.ts && git commit -m "MusicBrainz: release search and track lists" && git push origin main`

---

### Task 5: Fingerprints and AcoustID

**Files:** Create `apps/server/src/catalog/acoustid.ts`; test `apps/server/src/catalog/acoustid.test.ts`

**Test:**

```ts
// apps/server/src/catalog/acoustid.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcoustId } from './acoustid.ts';

afterEach(() => vi.restoreAllMocks());

describe('AcoustId', () => {
  it('is off without a key', () => {
    expect(new AcoustId(() => undefined).enabled).toBe(false);
  });

  it('returns the best recording with its release groups', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ok',
          results: [
            { score: 0.4, recordings: [{ id: 'rec-x' }] },
            {
              score: 0.93,
              recordings: [
                {
                  id: 'rec-1',
                  title: 'Angel',
                  artists: [{ id: 'art-1', name: 'Massive Attack' }],
                  releasegroups: [{ id: 'rg-1', title: 'Mezzanine', type: 'Album' }, { id: 'rg-9', title: 'Collected', type: 'Album', secondarytypes: ['Compilation'] }],
                },
              ],
            },
          ],
        }),
      ),
    );
    const match = await new AcoustId(() => 'KEY').lookup({ duration: 379.6, fingerprint: 'AQAA' });
    expect(match).toEqual({
      score: 0.93,
      recordingId: 'rec-1',
      title: 'Angel',
      artistName: 'Massive Attack',
      artistId: 'art-1',
      releaseGroups: [
        { id: 'rg-1', title: 'Mezzanine', type: 'Album', secondaryTypes: [] },
        { id: 'rg-9', title: 'Collected', type: 'Album', secondaryTypes: ['Compilation'] },
      ],
    });
    const body = String(fetchMock.mock.calls[0]![1]!.body);
    expect(body).toContain('client=KEY');
    expect(body).toContain('duration=380');
    expect(body).toContain('meta=recordings+releasegroups');
  });

  it('reports API errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'error', error: { message: 'invalid API key' } })));
    await expect(new AcoustId(() => 'BAD').lookup({ duration: 1, fingerprint: 'x' })).rejects.toThrow(/invalid API key/);
  });
});
```

**Implement:**

```ts
// apps/server/src/catalog/acoustid.ts
import { execFile } from 'node:child_process';

export interface Fingerprint {
  duration: number;
  fingerprint: string;
}

export interface AcoustIdMatch {
  score: number;
  recordingId: string;
  title?: string;
  artistName?: string;
  artistId?: string;
  releaseGroups: { id: string; title: string; type?: string; secondaryTypes: string[] }[];
}

/** AcoustID lookups (https://acoustid.org/webservice): at most 3 requests per second. */
export class AcoustId {
  private last = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly key: () => string | undefined) {}

  get enabled(): boolean {
    return !!this.key();
  }

  lookup(fp: Fingerprint): Promise<AcoustIdMatch | null> {
    const run = async () => {
      const wait = this.last + 350 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      const body = new URLSearchParams({
        client: this.key() ?? '',
        meta: 'recordings releasegroups',
        duration: String(Math.round(fp.duration)),
        fingerprint: fp.fingerprint,
      });
      const res = await fetch('https://api.acoustid.org/v2/lookup', { method: 'POST', body, signal: AbortSignal.timeout(15_000) });
      const data = (await res.json()) as {
        status: string;
        error?: { message: string };
        results?: {
          score: number;
          recordings?: {
            id: string;
            title?: string;
            artists?: { id: string; name: string }[];
            releasegroups?: { id: string; title: string; type?: string; secondarytypes?: string[] }[];
          }[];
        }[];
      };
      if (data.status !== 'ok') throw new Error(`AcoustID: ${data.error?.message ?? `HTTP ${res.status}`}`);
      const best = (data.results ?? []).filter((r) => r.recordings?.length).sort((a, b) => b.score - a.score)[0];
      const rec = best?.recordings?.[0];
      if (!best || !rec) return null;
      return {
        score: best.score,
        recordingId: rec.id,
        title: rec.title,
        artistName: rec.artists?.map((a) => a.name).join(', ') || undefined,
        artistId: rec.artists?.[0]?.id,
        releaseGroups: (rec.releasegroups ?? []).map((g) => ({ id: g.id, title: g.title, type: g.type, secondaryTypes: g.secondarytypes ?? [] })),
      };
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }
}

/** A Chromaprint fingerprint of a local file via fpcalc; null if it can't be computed. */
export function fpcalc(bin = 'fpcalc'): (path: string) => Promise<Fingerprint | null> {
  return (path) =>
    new Promise((resolve) => {
      execFile(bin, ['-json', path], { timeout: 60_000, maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const json = JSON.parse(stdout) as { duration?: number; fingerprint?: string };
          resolve(json.fingerprint && json.duration ? { duration: json.duration, fingerprint: json.fingerprint } : null);
        } catch {
          resolve(null);
        }
      });
    });
}

/** Whether fpcalc runs at all. */
export function hasFpcalc(bin = 'fpcalc'): Promise<boolean> {
  return new Promise((resolve) => execFile(bin, ['-version'], { timeout: 5000 }, (err) => resolve(!err)));
}
```

The test also passes `toEqual` with `artistName` etc. The `undefined` fields don't matter to `toEqual`. Run: PASS (3). Commit: `git add apps/server/src/catalog/acoustid.ts apps/server/src/catalog/acoustid.test.ts && git commit -m "Matching: AcoustID lookups and fpcalc fingerprints" && git push origin main`

---

### Task 6: Store: matches, release cache, per-row trust, song id moves

**Files:** Modify `apps/server/src/catalog/types.ts`, `apps/server/src/catalog/tags.ts`, `apps/server/src/catalog/store.ts`; test additions in `apps/server/src/catalog/store.test.ts`

**Step 1: Types**

`tags.ts`: add `releaseId?: string;` to `TagInfo` (after `releaseGroupMbid`), and:

```ts
/** What a match lays over a file's own tags. */
export type MatchOverlay = Partial<
  Pick<TagInfo, 'title' | 'album' | 'albumArtist' | 'albumArtistMbid' | 'trackNumber' | 'discNumber' | 'year' | 'recordingMbid' | 'releaseGroupMbid' | 'releaseId'>
>;

export type MatchState = 'auto' | 'manual' | 'review' | 'unmatched' | 'ignored';

export interface MatchRecord {
  rel: string;
  groupKey: string;
  state: MatchState;
  overlay?: MatchOverlay;
  /** Review: candidate release ids, best first. */
  candidates?: string[];
  score?: number;
  /** The file version this was decided for. */
  size: number;
  mtimeMs: number;
}
```

`types.ts`: add `metaRank?: number;` (doc: "Overrides the sync's rank for this row") to `SourceArtist`, `SourceAlbum` and `SourceTrack`.

**Step 2: Failing tests** (append to `store.test.ts`):

```ts
describe('CatalogStore: matching', () => {
  it('saves, reads and clears matches, keeping user decisions', () => {
    const store = new CatalogStore(freshDb());
    const id = store.addSource('folder', 'Music', { path: '/m' });
    store.saveMatches(id, [
      { rel: 'a.flac', groupKey: 'g', state: 'auto', overlay: { recordingMbid: 'rec-1' }, score: 0.9, size: 1, mtimeMs: 1 },
      { rel: 'b.flac', groupKey: 'g', state: 'manual', overlay: { recordingMbid: 'rec-2' }, size: 1, mtimeMs: 1 },
      { rel: 'c.flac', groupKey: 'h', state: 'review', candidates: ['rel-1', 'rel-2'], score: 0.6, size: 1, mtimeMs: 1 },
    ]);
    expect(store.matches(id).get('c.flac')).toMatchObject({ state: 'review', candidates: ['rel-1', 'rel-2'] });
    expect(store.matchCounts().get(id)).toEqual({ review: 1 });
    store.clearMatches(id);
    expect([...store.matches(id).keys()]).toEqual(['b.flac']);
  });

  it('caches releases', () => {
    const store = new CatalogStore(freshDb());
    const release = { id: 'rel-1', title: 'X', artistName: 'Y', releaseGroup: { id: 'rg', title: 'X', secondaryTypes: [] }, tracks: [] };
    expect(store.cachedRelease('rel-1')).toBeUndefined();
    store.saveRelease(release);
    expect(store.cachedRelease('rel-1')).toEqual(release);
  });

  it('lets a row carry its own trust', () => {
    const store = new CatalogStore(freshDb());
    const lidarr = store.addSource('lidarr', 'Lidarr');
    const folder = store.addSource('folder', 'Music');
    const matched = mezzanine();
    matched.metaRank = 2;
    matched.albums[0]!.metaRank = 1;
    matched.albums[0]!.title = 'Mezzanine (from MusicBrainz)';
    matched.copies = matched.copies.map((c) => ({ ...c, ref: `f/${c.ref}`, preferredId: undefined }));
    store.applySync(folder, matched);
    const plain = mezzanine();
    plain.metaRank = 2;
    plain.albums[0]!.title = 'mezzanine';
    plain.copies = matched.copies;
    store.applySync(folder, plain); // rank 2 can't overwrite rank 1
    expect(store.load().albums[0]!.meta.title).toBe('Mezzanine (from MusicBrainz)');
    store.applySync(lidarr, mezzanine()); // rank 0 can
    expect(store.load().albums[0]!.meta.title).toBe('Mezzanine');
    expect(JSON.stringify(store.load().albums[0]!.meta)).not.toContain('metaRank');
  });

  it('moves favorites, playlist entries and analysis when a song gets its real id', () => {
    const db = freshDb();
    const store = new CatalogStore(db);
    const folder = store.addSource('folder', 'Music');
    const local = mezzanine();
    local.tracks = local.tracks.map((t) => ({ ...t, key: `name:x#local:${t.recordingId}`, recordingId: `local:${t.recordingId}`, preferredId: undefined }));
    local.copies = local.copies.map((c) => ({ ...c, trackKey: `name:x#local:${c.trackKey.split('#')[1]}`, preferredId: undefined }));
    store.applySync(folder, local);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO favorites (recording_id, title, artist_name, album_title, created_at) VALUES (?, ?, ?, ?, ?)').run('local:rec-1', 'Angel', 'Massive Attack', 'Mezzanine', now);
    db.prepare('INSERT INTO playlists (name, created_at, updated_at) VALUES (?, ?, ?)').run('P', now, now);
    db.prepare('INSERT INTO playlist_items (playlist_id, position, recording_id, title, artist_name, album_title, added_at) VALUES (1, 0, ?, ?, ?, ?, ?)').run('local:rec-1', 'Angel', 'Massive Attack', 'Mezzanine', now);
    db.prepare('INSERT INTO track_features (recording_id, version, features, analyzed_at) VALUES (?, 1, ?, ?)').run('local:rec-1', '{}', now);

    const matched = mezzanine();
    matched.copies = local.copies.map((c, i) => ({ ...c, trackKey: matched.tracks.find((t) => t.recordingId === `rec-${i + 1}`)!.key }));
    store.applySync(folder, matched);

    const one = (sql: string) => db.prepare(sql).get() as { recording_id: string };
    expect(one('SELECT recording_id FROM favorites').recording_id).toBe('rec-1');
    expect(one('SELECT recording_id FROM playlist_items').recording_id).toBe('rec-1');
    expect(one('SELECT recording_id FROM track_features').recording_id).toBe('rec-1');
  });
});
```

(Check the `mezzanine()` fixture's copy order before relying on `rec-${i + 1}`: its copies are `9000 → rec-1`, `9001 → rec-2`.)

**Step 3:** Run; FAIL.

**Step 4: Implement** in `store.ts` (import `type { MatchRecord }` and `type { MbReleaseInfo }` from `./tags.ts` and `./mbRelease.ts`):

- In `applySync`, use per-row ranks and keep `metaRank` out of the stored metadata: change the three loops' destructuring to include `metaRank`, e.g. `for (const { key, preferredId, metaRank, ...meta } of sync.artists)` and pass `metaRank ?? rank`.
- Song id moves, inside `applySync`'s transaction. Before the copies loop:

```ts
      // Which song each of this source's files belonged to, to follow songs whose id changes.
      const before = new Map(
        (
          this.db
            .prepare('SELECT c.source_ref AS ref, t.recording_id AS rec FROM copies c JOIN catalog_tracks t ON t.id = c.track_id WHERE c.source_id = ?')
            .all(sourceId) as { ref: string; rec: string }[]
        ).map((r) => [r.ref, r.rec]),
      );
      const recordingOf = new Map(sync.tracks.map((t) => [t.key, t.recordingId]));
      const moves = new Map<string, string>();
```

  in the copies loop, after resolving `trackId`:

```ts
        const was = before.get(copy.ref);
        const now = recordingOf.get(copy.trackKey);
        if (was && now && was !== now && was.startsWith('local:') && !now.startsWith('local:')) moves.set(was, now);
```

  and after the loop: `for (const [from, to] of moves) this.moveRecording(from, to);`

- Add:

```ts
  /** A song got its real id: its favorites, playlist entries and analysis follow it. */
  private moveRecording(from: string, to: string) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO favorites (recording_id, track_id, title, artist_name, album_title, created_at)
         SELECT ?, track_id, title, artist_name, album_title, created_at FROM favorites WHERE recording_id = ?`,
      )
      .run(to, from);
    this.db.prepare('DELETE FROM favorites WHERE recording_id = ?').run(from);
    this.db.prepare('UPDATE playlist_items SET recording_id = ? WHERE recording_id = ?').run(to, from);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO track_features (recording_id, version, features, error, analyzed_at)
         SELECT ?, version, features, error, analyzed_at FROM track_features WHERE recording_id = ?`,
      )
      .run(to, from);
    this.db.prepare('DELETE FROM track_features WHERE recording_id = ?').run(from);
  }

  matches(sourceId: number): Map<string, MatchRecord> {
    const rows = this.db
      .prepare('SELECT rel_path, group_key, state, overlay, candidates, score, file_size, file_mtime FROM folder_matches WHERE source_id = ?')
      .all(sourceId) as {
      rel_path: string;
      group_key: string;
      state: MatchRecord['state'];
      overlay: string | null;
      candidates: string | null;
      score: number | null;
      file_size: number;
      file_mtime: number;
    }[];
    return new Map(
      rows.map((r) => [
        r.rel_path,
        {
          rel: r.rel_path,
          groupKey: r.group_key,
          state: r.state,
          overlay: r.overlay ? JSON.parse(r.overlay) : undefined,
          candidates: r.candidates ? JSON.parse(r.candidates) : undefined,
          score: r.score ?? undefined,
          size: r.file_size,
          mtimeMs: r.file_mtime,
        },
      ]),
    );
  }

  saveMatches(sourceId: number, records: MatchRecord[]) {
    const now = new Date().toISOString();
    const save = this.db.prepare(
      `INSERT INTO folder_matches (source_id, rel_path, group_key, state, overlay, candidates, score, file_size, file_mtime, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_id, rel_path) DO UPDATE SET group_key = excluded.group_key, state = excluded.state,
         overlay = excluded.overlay, candidates = excluded.candidates, score = excluded.score,
         file_size = excluded.file_size, file_mtime = excluded.file_mtime, updated_at = excluded.updated_at`,
    );
    this.db.exec('BEGIN');
    try {
      for (const r of records) {
        save.run(
          sourceId,
          r.rel,
          r.groupKey,
          r.state,
          r.overlay ? JSON.stringify(r.overlay) : null,
          r.candidates ? JSON.stringify(r.candidates) : null,
          r.score ?? null,
          r.size,
          r.mtimeMs,
          now,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Forget automatic results (user decisions stay), so the source is matched again. */
  clearMatches(sourceId: number) {
    this.db.prepare("DELETE FROM folder_matches WHERE source_id = ? AND state NOT IN ('manual', 'ignored')").run(sourceId);
  }

  /** Album groups waiting for review, per source. */
  matchCounts(): Map<number, { review: number }> {
    const rows = this.db
      .prepare("SELECT source_id AS id, COUNT(DISTINCT group_key) AS review FROM folder_matches WHERE state = 'review' GROUP BY source_id")
      .all() as { id: number; review: number }[];
    return new Map(rows.map((r) => [r.id, { review: r.review }]));
  }

  cachedRelease(releaseId: string): MbReleaseInfo | undefined {
    const row = this.db.prepare('SELECT data FROM mb_releases WHERE release_id = ?').get(releaseId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as MbReleaseInfo) : undefined;
  }

  saveRelease(release: MbReleaseInfo) {
    this.db
      .prepare('INSERT OR REPLACE INTO mb_releases (release_id, data, fetched_at) VALUES (?, ?, ?)')
      .run(release.id, JSON.stringify(release), new Date().toISOString());
  }
```

- In `removeSource`, also `DELETE FROM folder_matches WHERE source_id = ?`.

**Step 5:** Run the store tests, then all server tests: PASS.

Commit: `git add apps/server/src/catalog/types.ts apps/server/src/catalog/tags.ts apps/server/src/catalog/store.ts apps/server/src/catalog/store.test.ts && git commit -m "Catalog store: matches, release cache, per-row trust, songs keep favorites when matched" && git push origin main`

---

### Task 7: folderSync uses overlays' releases: full track lists, MusicBrainz metadata

**Files:** Modify `apps/server/src/catalog/folder.ts`, `apps/server/src/catalog/folder.test.ts`

**Step 1: Failing tests** (append inside `describe('folderSync')`; import `type MbReleaseInfo` from `./mbRelease.ts`):

```ts
  const mbMezzanine: MbReleaseInfo = {
    id: 'rel-1',
    title: 'Mezzanine',
    artistName: 'Massive Attack',
    artistId: 'art-1',
    releaseGroup: { id: 'rg-1', title: 'Mezzanine', primaryType: 'Album', secondaryTypes: [], firstReleaseDate: '1998-04-17' },
    tracks: [
      { disc: 1, position: 1, title: 'Angel', length: 379, recordingId: 'rec-1' },
      { disc: 1, position: 2, title: 'Risingson', length: 299, recordingId: 'rec-2' },
    ],
  };

  it('describes a file from its tags or its name', () => {
    expect(describeFile('Portishead/1994 - Dummy/03 - Sour Times.flac', { genres: [], duration: 250, format: FLAC })).toEqual({
      artistName: 'Portishead',
      albumTitle: 'Dummy',
      title: 'Sour Times',
      trackNumber: 3,
      discNumber: 1,
      duration: 250,
    });
  });

  it('reports the rest of a matched release as missing songs, with MusicBrainz metadata', () => {
    const sync = folderSync(
      [
        entry('x/01.flac', {
          title: 'Angel',
          album: 'Mezzanine',
          albumArtist: 'Massive Attack',
          albumArtistMbid: 'art-1',
          recordingMbid: 'rec-1',
          releaseGroupMbid: 'rg-1',
          releaseId: 'rel-1',
          trackNumber: 1,
        }),
      ],
      EMPTY,
      new Map([['rel-1', mbMezzanine]]),
    );
    expect(sync.albums[0]).toMatchObject({ key: 'mb:rg-1', title: 'Mezzanine', releaseDate: '1998-04-17', totalTrackCount: 2, metaRank: 1 });
    expect(sync.tracks.map((t) => [t.key, t.metaRank])).toEqual([
      ['mb:rg-1#rec-1', 1],
      ['mb:rg-1#rec-2', 1],
    ]);
    expect(sync.copies).toHaveLength(1);
  });
```

(Add `describeFile` to the `./folder.ts` import.)

**Step 2:** Run; FAIL.

**Step 3: Implement** in `folder.ts`:

- Export a `describeFile(rel, tags)` returning `{ artistName, albumTitle?, title, trackNumber, discNumber, duration }` using exactly the existing fallback rules (album artist → artist → folder artist → 'Unknown artist'; album tag → cleaned folder album; title tag → title from file name; track tag → number from file name; disc tag → 1), and use it inside `folderSync` instead of the inline computations (behaviour unchanged; the existing tests prove it).
- Add a third parameter `releases: Map<string, MbReleaseInfo> = new Map()` (import `type MbReleaseInfo` from `./mbRelease.ts`; export `MATCHED_META_RANK = 1`).
- When an entry's `tags.releaseId` is in `releases`: give the album entry `metaRank: MATCHED_META_RANK`, title = release group title, `albumType = primaryType ?? 'Album'`, `secondaryTypes`, `releaseDate = firstReleaseDate` (as given), `totalTrackCount = release.tracks.length`, and remember `albumKey → release`; give the song's track entry `metaRank: MATCHED_META_RANK`.
- After the loop, for each remembered `albumKey → release`, push a track entry (with `metaRank: MATCHED_META_RANK`) for every release track whose key `trackKeyFor(albumKey, track.recordingId)` isn't in `tracks` yet: `{ key, albumKey, recordingId, title, trackNumber: position, discNumber: disc, duration: length, explicit: false }`.

**Step 4:** Run the folder tests, then all server tests: PASS.

Commit: `git add apps/server/src/catalog/folder.ts apps/server/src/catalog/folder.test.ts && git commit -m "Folder mapping: matched releases bring full track lists and MusicBrainz metadata" && git push origin main`

---

### Task 8: The Matcher

**Files:** Create `apps/server/src/catalog/matcher.ts`; test `apps/server/src/catalog/matcher.test.ts`

**Step 1: Failing tests**

```ts
// apps/server/src/catalog/matcher.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { MbReleaseHit } from '../discover/musicbrainz.ts';
import type { AcoustIdMatch } from './acoustid.ts';
import { groupFiles, Matcher } from './matcher.ts';
import type { MbReleaseInfo } from './mbRelease.ts';
import { CatalogStore } from './store.ts';
import type { TagInfo } from './tags.ts';
import { FLAC, freshDb } from './testFixtures.ts';

const release: MbReleaseInfo = {
  id: 'rel-1',
  title: 'Mezzanine',
  artistName: 'Massive Attack',
  artistId: 'art-1',
  releaseGroup: { id: 'rg-1', title: 'Mezzanine', primaryType: 'Album', secondaryTypes: [], firstReleaseDate: '1998-04-17' },
  tracks: [
    { disc: 1, position: 1, title: 'Angel', length: 379, recordingId: 'rec-1' },
    { disc: 1, position: 2, title: 'Risingson', length: 299, recordingId: 'rec-2' },
  ],
};
const hit: MbReleaseHit = { id: 'rel-1', score: 100, title: 'Mezzanine', 'track-count': 2 };
const tags = (t: Partial<TagInfo>): TagInfo => ({ genres: [], duration: 300, format: FLAC, ...t });

function setup(files: Record<string, Partial<TagInfo>>, opts: { hits?: MbReleaseHit[]; acoustid?: AcoustIdMatch | null } = {}) {
  const store = new CatalogStore(freshDb());
  const sourceId = store.addSource('folder', 'Music', { path: '/music' });
  store.saveFolderFiles(
    sourceId,
    Object.entries(files).map(([rel, t]) => ({ rel, size: 100, mtimeMs: 1, tags: tags(t) })),
    Object.keys(files),
  );
  const mb = {
    searchReleases: vi.fn(async () => opts.hits ?? [hit]),
    release: vi.fn(async () => release),
  };
  const acoustid = { enabled: opts.acoustid !== undefined, lookup: vi.fn(async () => opts.acoustid ?? null) };
  const fingerprint = vi.fn(async () => ({ duration: 379, fingerprint: 'AQAA' }));
  const onMatched = vi.fn();
  const matcher = new Matcher({ store, mb, acoustid, fingerprint, onMatched, log: { warn: () => {} } });
  return { store, sourceId, mb, acoustid, fingerprint, onMatched, matcher };
}

const mezzanineFiles = {
  'Massive Attack/Mezzanine/01 Angel.flac': { duration: 380 },
  'Massive Attack/Mezzanine/02 Risingson.flac': { duration: 298 },
};

describe('groupFiles', () => {
  it('groups files by album, and loose files by folder; skips files already identified', () => {
    const groups = groupFiles('/music', [
      { rel: 'A/B/1.flac', size: 1, mtimeMs: 1, tags: tags({}) },
      { rel: 'A/B/2.flac', size: 1, mtimeMs: 1, tags: tags({}) },
      { rel: 'A/x.flac', size: 1, mtimeMs: 1, tags: tags({}) },
      { rel: 'A/C/1.flac', size: 1, mtimeMs: 1, tags: tags({ recordingMbid: 'r', releaseGroupMbid: 'g' }) },
    ], new Map());
    expect(groups.map((g) => [g.artistName, g.albumTitle, g.files.map((f) => f.rel)])).toEqual([
      ['A', 'B', ['A/B/1.flac', 'A/B/2.flac']],
      ['A', undefined, ['A/x.flac']],
    ]);
    expect(groups[0]!.files[0]!.path).toBe('/music/A/B/1.flac');
  });
});

describe('Matcher', () => {
  it('matches an album automatically and lays MusicBrainz ids over the files', async () => {
    const { matcher, store, sourceId, onMatched } = setup(mezzanineFiles);
    await matcher.matchSource(sourceId);
    const m = store.matches(sourceId).get('Massive Attack/Mezzanine/01 Angel.flac')!;
    expect(m).toMatchObject({ state: 'auto', overlay: { recordingMbid: 'rec-1', releaseGroupMbid: 'rg-1', releaseId: 'rel-1', trackNumber: 1, album: 'Mezzanine', albumArtistMbid: 'art-1', year: 1998 } });
    expect(store.cachedRelease('rel-1')).toBeDefined();
    expect(onMatched).toHaveBeenCalled();
  });

  it('does nothing the second time', async () => {
    const { matcher, sourceId, mb } = setup(mezzanineFiles);
    await matcher.matchSource(sourceId);
    mb.searchReleases.mockClear();
    await matcher.matchSource(sourceId);
    expect(mb.searchReleases).not.toHaveBeenCalled();
  });

  it('asks for review when unsure', async () => {
    const { matcher, store, sourceId } = setup({
      'Massive Attack/Mezzanine/01 Angel.flac': { duration: 200 },
      'Massive Attack/Mezzanine/02 Risingson.flac': { duration: 120 },
    });
    await matcher.matchSource(sourceId);
    expect(store.matches(sourceId).get('Massive Attack/Mezzanine/01 Angel.flac')).toMatchObject({ state: 'review', candidates: ['rel-1'] });
    expect(store.matchCounts().get(sourceId)).toEqual({ review: 1 });
  });

  it('falls back to fingerprints for loose songs', async () => {
    const { matcher, store, sourceId, fingerprint } = setup(
      { 'Massive Attack/Angel.flac': {} },
      {
        hits: [],
        acoustid: {
          score: 0.95,
          recordingId: 'rec-1',
          title: 'Angel',
          artistName: 'Massive Attack',
          artistId: 'art-1',
          releaseGroups: [
            { id: 'rg-9', title: 'Collected', type: 'Album', secondaryTypes: ['Compilation'] },
            { id: 'rg-1', title: 'Mezzanine', type: 'Album', secondaryTypes: [] },
          ],
        },
      },
    );
    await matcher.matchSource(sourceId);
    expect(fingerprint).toHaveBeenCalledWith('/music/Massive Attack/Angel.flac');
    expect(store.matches(sourceId).get('Massive Attack/Angel.flac')).toMatchObject({
      state: 'auto',
      overlay: { recordingMbid: 'rec-1', releaseGroupMbid: 'rg-1', album: 'Mezzanine', title: 'Angel' },
    });
  });

  it('leaves files unmatched when nothing fits', async () => {
    const { matcher, store, sourceId } = setup({ 'Someone/Demo/01 Song.flac': {} }, { hits: [] });
    await matcher.matchSource(sourceId);
    expect(store.matches(sourceId).get('Someone/Demo/01 Song.flac')!.state).toBe('unmatched');
  });

  it('applies the release the user picked, and can leave a group unmatched for good', async () => {
    const { matcher, store, sourceId } = setup({
      'Massive Attack/Mezzanine/01 Angel.flac': { duration: 200 },
      'Massive Attack/Mezzanine/02 Risingson.flac': { duration: 120 },
    });
    await matcher.matchSource(sourceId);
    const groupKey = store.matches(sourceId).get('Massive Attack/Mezzanine/01 Angel.flac')!.groupKey;
    await matcher.applyRelease(sourceId, groupKey, 'rel-1');
    expect(store.matches(sourceId).get('Massive Attack/Mezzanine/02 Risingson.flac')).toMatchObject({ state: 'manual', overlay: { recordingMbid: 'rec-2' } });
    matcher.ignore(sourceId, groupKey);
    expect(store.matches(sourceId).get('Massive Attack/Mezzanine/01 Angel.flac')!.state).toBe('ignored');
  });

  it('describes review groups with scored candidates', async () => {
    const { matcher, store, sourceId } = setup({
      'Massive Attack/Mezzanine/01 Angel.flac': { duration: 200 },
      'Massive Attack/Mezzanine/02 Risingson.flac': { duration: 120 },
    });
    await matcher.matchSource(sourceId);
    const [group] = matcher.reviewGroups(sourceId);
    expect(group).toMatchObject({ artistName: 'Massive Attack', albumTitle: 'Mezzanine', files: [{ title: 'Angel' }, { title: 'Risingson' }] });
    expect(group!.candidates[0]).toMatchObject({ releaseId: 'rel-1', title: 'Mezzanine', year: 1998 });
    expect(group!.candidates[0]!.matches['Massive Attack/Mezzanine/01 Angel.flac']).toBe(0);
    expect(store.matchCounts().get(sourceId)).toEqual({ review: 1 });
  });
});
```

**Step 2:** Run; FAIL.

**Step 3: Implement**

```ts
// apps/server/src/catalog/matcher.ts
import type { ReviewCandidate, ReviewGroup } from '@playarr/shared';
import { join } from 'node:path';
import type { MbReleaseHit } from '../discover/musicbrainz.ts';
import { normalize } from '../library/search.ts';
import type { AcoustIdMatch, Fingerprint } from './acoustid.ts';
import { describeFile } from './folder.ts';
import { scoreRelease, verdict, type FileFacts, type ReleaseScore } from './match.ts';
import type { MbReleaseInfo } from './mbRelease.ts';
import type { CatalogStore } from './store.ts';
import type { MatchOverlay, MatchRecord, TagInfo } from './tags.ts';

export interface GroupFile extends FileFacts {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface FileGroup {
  key: string;
  artistName: string;
  albumTitle?: string;
  files: GroupFile[];
}

export interface MatcherDeps {
  store: CatalogStore;
  mb: {
    searchReleases(artist: string, album: string): Promise<MbReleaseHit[]>;
    release(id: string): Promise<MbReleaseInfo>;
  };
  acoustid?: { enabled: boolean; lookup(fp: Fingerprint): Promise<AcoustIdMatch | null> };
  fingerprint?: (path: string) => Promise<Fingerprint | null>;
  /** Matches changed: rebuild the library (debounced by the caller). */
  onMatched: () => void;
  log: { warn: (msg: string) => void };
}

const SEARCH_MIN_SCORE = 70;
const CANDIDATES = 3;
const FINGERPRINT_MIN_SCORE = 0.8;

/** Files by album (album tag, else folder). Skips files already identified by their tags. */
export function groupFiles(
  root: string,
  files: { rel: string; size: number; mtimeMs: number; tags: TagInfo | null }[],
  matches: Map<string, MatchRecord>,
  include: (rel: string, size: number, mtimeMs: number, match?: MatchRecord) => boolean = (rel, size, mtimeMs, match) =>
    !match || (match.state !== 'manual' && match.state !== 'ignored' && (match.size !== size || match.mtimeMs !== mtimeMs)),
): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const f of files) {
    if (!f.tags || (f.tags.recordingMbid && f.tags.releaseGroupMbid)) continue;
    if (!include(f.rel, f.size, f.mtimeMs, matches.get(f.rel))) continue;
    const d = describeFile(f.rel, f.tags);
    const key = d.albumTitle
      ? `${normalize(d.artistName)}|${normalize(d.albumTitle)}`
      : `dir:${f.rel.split('/').slice(0, -1).join('/')}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { key, artistName: d.artistName, albumTitle: d.albumTitle, files: [] }));
    group.files.push({ rel: f.rel, path: join(root, f.rel), size: f.size, mtimeMs: f.mtimeMs, ...pick(d) });
  }
  return [...groups.values()];
}

const pick = (d: ReturnType<typeof describeFile>): Omit<FileFacts, 'rel'> => ({
  title: d.title,
  trackNumber: d.trackNumber,
  discNumber: d.discNumber,
  duration: d.duration,
});

/** Identifies folder music on MusicBrainz in the background, one album group at a time. */
export class Matcher {
  private readonly queue = new Set<number>();
  private running = false;
  private readonly pending = new Map<number, number>();

  constructor(private readonly deps: MatcherDeps) {}

  /** Match whatever is new in this source (after a scan). */
  enqueue(sourceId: number) {
    this.queue.add(sourceId);
    void this.run();
  }

  /** Album groups still waiting to be matched. */
  pendingGroups(sourceId: number): number {
    return this.pending.get(sourceId) ?? 0;
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.size) {
        const id = this.queue.values().next().value!;
        this.queue.delete(id);
        await this.matchSource(id);
      }
    } finally {
      this.running = false;
    }
  }

  async matchSource(sourceId: number) {
    const groups = this.groups(sourceId);
    this.pending.set(sourceId, groups.length);
    let unsaved = 0;
    for (const group of groups) {
      try {
        this.deps.store.saveMatches(sourceId, await this.matchGroup(group));
        unsaved++;
      } catch (err) {
        // Left without a row: tried again after the next scan.
        this.deps.log.warn(`Matching “${group.albumTitle ?? group.key}” failed: ${(err as Error).message}`);
      }
      this.pending.set(sourceId, Math.max(0, this.pendingGroups(sourceId) - 1));
      if (unsaved >= 10) {
        this.deps.onMatched();
        unsaved = 0;
      }
    }
    if (unsaved) this.deps.onMatched();
  }

  /** Use this release for a group (from the review list). */
  async applyRelease(sourceId: number, groupKey: string, releaseId: string) {
    const group = this.groupByKey(sourceId, groupKey);
    if (!group) throw new Error('That album isn’t waiting for review any more');
    const scored = scoreRelease(group.files, await this.release(releaseId));
    this.deps.store.saveMatches(sourceId, this.fromAlignment(group, scored, 'manual'));
    this.deps.onMatched();
  }

  /** Leave a group as its tags and names describe it, and never match it again. */
  ignore(sourceId: number, groupKey: string) {
    const group = this.groupByKey(sourceId, groupKey);
    if (!group) return;
    this.deps.store.saveMatches(sourceId, group.files.map((f) => this.record(group, f, 'ignored')));
    this.deps.onMatched();
  }

  /** Search MusicBrainz again with other names; the group's candidates are replaced. */
  async search(sourceId: number, groupKey: string, artist: string, album: string) {
    const group = this.groupByKey(sourceId, groupKey);
    if (!group) throw new Error('That album isn’t waiting for review any more');
    const scored = await this.candidates(group, artist, album);
    const ids = scored.slice(0, CANDIDATES).map((s) => s.release.id);
    this.deps.store.saveMatches(
      sourceId,
      group.files.map((f) => ({ ...this.record(group, f, 'review'), candidates: ids, score: scored[0]?.score })),
    );
  }

  reviewGroups(sourceId: number): ReviewGroup[] {
    const matches = this.deps.store.matches(sourceId);
    const review = [...matches.values()].filter((m) => m.state === 'review');
    const keys = [...new Set(review.map((m) => m.groupKey))];
    return keys.flatMap((key) => {
      const group = this.groupByKey(sourceId, key);
      if (!group) return [];
      const ids = review.find((m) => m.groupKey === key)?.candidates ?? [];
      const candidates = ids.flatMap((id) => {
        const release = this.deps.store.cachedRelease(id);
        return release ? [toCandidate(scoreRelease(group.files, release))] : [];
      });
      return [
        {
          groupKey: key,
          artistName: group.artistName,
          albumTitle: group.albumTitle,
          files: group.files.map(({ rel, title, trackNumber, discNumber, duration }) => ({ rel, title, trackNumber, discNumber, duration })),
          candidates,
        },
      ];
    });
  }

  private groups(sourceId: number): FileGroup[] {
    const root = (this.deps.store.source(sourceId)?.settings as { path?: string } | undefined)?.path;
    if (!root) return [];
    return groupFiles(root, this.files(sourceId), this.deps.store.matches(sourceId));
  }

  /** A group with all its files, whatever their state. */
  private groupByKey(sourceId: number, groupKey: string): FileGroup | undefined {
    const root = (this.deps.store.source(sourceId)?.settings as { path?: string } | undefined)?.path;
    if (!root) return undefined;
    return groupFiles(root, this.files(sourceId), this.deps.store.matches(sourceId), () => true).find((g) => g.key === groupKey);
  }

  private files(sourceId: number) {
    return [...this.deps.store.folderFiles(sourceId)].map(([rel, f]) => ({ rel, ...f }));
  }

  private async matchGroup(group: FileGroup): Promise<MatchRecord[]> {
    const scored = group.albumTitle ? await this.candidates(group, group.artistName, group.albumTitle) : [];
    const best = scored[0];
    const outcome = verdict(best);
    if (outcome === 'auto') return this.fromAlignment(group, best!, 'auto');
    const byFingerprint = await this.byFingerprint(group);
    if (byFingerprint) return byFingerprint;
    if (outcome === 'review') {
      const ids = scored.slice(0, CANDIDATES).map((s) => s.release.id);
      return group.files.map((f) => ({ ...this.record(group, f, 'review'), candidates: ids, score: best!.score }));
    }
    return group.files.map((f) => this.record(group, f, 'unmatched'));
  }

  private async candidates(group: FileGroup, artist: string, album: string): Promise<ReleaseScore[]> {
    const hits = (await this.deps.mb.searchReleases(artist, album)).filter((h) => h.score >= SEARCH_MIN_SCORE).slice(0, CANDIDATES);
    const scored: ReleaseScore[] = [];
    for (const h of hits) scored.push(scoreRelease(group.files, await this.release(h.id)));
    return scored.sort((a, b) => b.score - a.score);
  }

  private async release(id: string): Promise<MbReleaseInfo> {
    const cached = this.deps.store.cachedRelease(id);
    if (cached) return cached;
    const release = await this.deps.mb.release(id);
    this.deps.store.saveRelease(release);
    return release;
  }

  private async byFingerprint(group: FileGroup): Promise<MatchRecord[] | null> {
    const { acoustid, fingerprint } = this.deps;
    if (!acoustid?.enabled || !fingerprint) return null;
    const records: MatchRecord[] = [];
    let found = 0;
    for (const f of group.files) {
      const fp = await fingerprint(f.path);
      const m = fp && (await acoustid.lookup(fp));
      const rg = m && m.score >= FINGERPRINT_MIN_SCORE ? originalReleaseGroup(m.releaseGroups) : undefined;
      if (!m || !rg) {
        records.push(this.record(group, f, 'unmatched'));
        continue;
      }
      found++;
      const overlay: MatchOverlay = {
        recordingMbid: m.recordingId,
        title: m.title,
        albumArtist: m.artistName,
        albumArtistMbid: m.artistId,
        releaseGroupMbid: rg.id,
        album: rg.title,
      };
      records.push({ ...this.record(group, f, 'auto'), overlay, score: m.score });
    }
    // Mostly unknown to AcoustID: keep the group as names left it.
    return found * 2 >= group.files.length ? records : null;
  }

  private fromAlignment(group: FileGroup, scored: ReleaseScore, state: 'auto' | 'manual'): MatchRecord[] {
    const { release } = scored;
    const year = Number(release.releaseGroup.firstReleaseDate?.slice(0, 4)) || undefined;
    const byRel = new Map(scored.alignment.map((a) => [a.rel, a]));
    return group.files.map((f) => {
      const a = byRel.get(f.rel);
      if (!a) return this.record(group, f, state === 'manual' ? 'ignored' : 'unmatched');
      const overlay: MatchOverlay = {
        recordingMbid: a.track.recordingId,
        title: a.track.title,
        trackNumber: a.track.position,
        discNumber: a.track.disc,
        album: release.releaseGroup.title,
        albumArtist: release.artistName,
        albumArtistMbid: release.artistId,
        releaseGroupMbid: release.releaseGroup.id,
        releaseId: release.id,
        year,
      };
      return { ...this.record(group, f, state), overlay, score: a.score };
    });
  }

  private record(group: FileGroup, f: GroupFile, state: MatchRecord['state']): MatchRecord {
    return { rel: f.rel, groupKey: group.key, state, size: f.size, mtimeMs: f.mtimeMs };
  }
}

/** Studio album first, then EP, single, soundtrack/compilation, live. */
function originalReleaseGroup(groups: AcoustIdMatch['releaseGroups']) {
  const rank = (g: AcoustIdMatch['releaseGroups'][number]) =>
    g.secondaryTypes.includes('Live') ? 6 : g.secondaryTypes.length ? 4 : g.type === 'Album' ? 0 : g.type === 'EP' ? 1 : g.type === 'Single' ? 3 : 5;
  return [...groups].sort((a, b) => rank(a) - rank(b))[0];
}

function toCandidate(s: ReleaseScore): ReviewCandidate {
  const { release } = s;
  return {
    releaseId: release.id,
    title: release.releaseGroup.title,
    artistName: release.artistName,
    year: Number(release.releaseGroup.firstReleaseDate?.slice(0, 4)) || undefined,
    score: Math.round(s.score * 100) / 100,
    tracks: release.tracks.map((t) => ({ disc: t.disc, position: t.position, title: t.title, duration: t.length })),
    matches: Object.fromEntries(s.alignment.map((a) => [a.rel, release.tracks.indexOf(a.track)])),
  };
}
```

**Step 4:** Run; PASS (8 tests). Commit: `git add apps/server/src/catalog/matcher.ts apps/server/src/catalog/matcher.test.ts && git commit -m "Matcher: names, then fingerprints, then review; user decisions stick" && git push origin main`

---

### Task 9: FolderSource applies matches; SourceManager reports review and progress

**Files:** Modify `apps/server/src/catalog/folderSource.ts`, `apps/server/src/catalog/folderSource.test.ts`, `apps/server/src/catalog/sources.ts`, `apps/server/src/catalog/sources.test.ts`

**Step 1: Failing tests**

`folderSource.test.ts` (inside `describe('FolderSource')`):

```ts
  it('lays matches over tags and tells the matcher a scan happened', async () => {
    const { store, sourceId, dir } = setup();
    store.saveRelease({
      id: 'rel-1',
      title: 'Mezzanine',
      artistName: 'Massive Attack',
      artistId: 'art-1',
      releaseGroup: { id: 'rg-1', title: 'Mezzanine', primaryType: 'Album', secondaryTypes: [] },
      tracks: [
        { disc: 1, position: 1, title: 'Angel', length: 200, recordingId: 'rec-1' },
        { disc: 1, position: 2, title: 'Risingson', length: 299, recordingId: 'rec-2' },
      ],
    });
    const onScanned = vi.fn();
    const source = new FolderSource({ sourceId, root: dir, store, onScanned });
    await source.sync(); // fills the tag cache
    store.saveMatches(sourceId, [
      {
        rel: 'Massive Attack/Mezzanine/01 Angel.flac',
        groupKey: 'g',
        state: 'auto',
        overlay: { recordingMbid: 'rec-1', releaseGroupMbid: 'rg-1', releaseId: 'rel-1', album: 'Mezzanine', albumArtistMbid: 'art-1' },
        size: 0,
        mtimeMs: 0,
      },
    ]);
    const sync = await source.sync();
    expect(sync.copies.find((c) => c.ref.endsWith('Angel.flac'))!.trackKey).toBe('mb:rg-1#rec-1');
    expect(sync.tracks.map((t) => t.key)).toContain('mb:rg-1#rec-2'); // the rest of the release, missing
    expect(onScanned).toHaveBeenCalledWith(sourceId);
  });
```

`sources.test.ts` (inside the `folders` describe):

```ts
    it('reports review and matching progress for folder sources', () => {
      const { dir, store, manager, cleanup } = withFolders();
      try {
        const music = manager.add({ kind: 'folder', settings: { path: join(dir, 'Music') } });
        store.saveMatches(music.id, [{ rel: 'a.flac', groupKey: 'g', state: 'review', candidates: [], size: 1, mtimeMs: 1 }]);
        manager.useMatcher({ pendingGroups: () => 3, enqueue: () => {} });
        expect(manager.list({ includeSettings: true, syncing: false })[0]).toMatchObject({ review: 1, matching: 3 });
      } finally {
        cleanup();
      }
    });
```

**Step 2:** Run both; FAIL.

**Step 3: Implement**

`folderSource.ts`:
- Options gain `onScanned?: (sourceId: number) => void`.
- In `sync()`, after collecting `entries` and saving the cache:

```ts
    const matches = store.matches(sourceId);
    const releases = new Map<string, MbReleaseInfo>();
    for (const e of entries) {
      const m = matches.get(e.rel);
      if (!m?.overlay || (m.state !== 'auto' && m.state !== 'manual')) continue;
      e.tags = { ...e.tags, ...m.overlay };
      const id = m.overlay.releaseId;
      const release = id && !releases.has(id) ? store.cachedRelease(id) : undefined;
      if (release) releases.set(release.id, release);
    }
    const sync = folderSync(entries, store.nameIndex(), releases);
    this.opts.onScanned?.(sourceId);
    return sync;
```

(import `type MbReleaseInfo` from `./mbRelease.ts`).

`sources.ts`:
- Add a field and setter:

```ts
  private matcher?: { pendingGroups(sourceId: number): number; enqueue(sourceId: number): void };

  /** Folder scans hand new files to the matcher; Settings shows its progress. */
  useMatcher(matcher: { pendingGroups(sourceId: number): number; enqueue(sourceId: number): void }) {
    this.matcher = matcher;
  }
```

- In `active()`, pass `onScanned: (id) => this.matcher?.enqueue(id)` to `new FolderSource({...})`.
- `list()`: `const matchCounts = this.store.matchCounts();` and pass `review: matchCounts.get(s.id)?.review ?? 0, matching: this.matcher?.pendingGroups(s.id) ?? 0` into `toInfo` (add both parameters; set the two `SourceInfo` fields). Do the same in `info(id)`.

**Step 4:** Run all server tests and typecheck (clean now: fixes Task 1's error). Commit: `git add apps/server/src/catalog/folderSource.ts apps/server/src/catalog/folderSource.test.ts apps/server/src/catalog/sources.ts apps/server/src/catalog/sources.test.ts && git commit -m "Folder sources apply matches; Settings sees review and matching progress" && git push origin main`

---

### Task 10: Review and matching API; wiring

**Files:** Modify `apps/server/src/routes/settings.ts`, `apps/server/src/routes/settings.test.ts`, `apps/server/src/config.ts`, `apps/server/src/index.ts`, `docker/Dockerfile`

**Step 1: Failing tests** (`settings.test.ts`). Extend `setup()` to accept and pass a matcher and matching settings:

```ts
function setup(matcher = fakeMatcher()) {
  const store = new CatalogStore(freshDb());
  const sources = new SourceManager(store, new LidarrClient(), { info: () => {} });
  const library = { refresh: vi.fn(async () => {}), reload: vi.fn(), refreshing: false };
  const app = Fastify();
  settingsRoutes(app, { sources, library, matcher, store, fingerprints: true });
  return { app, store, library, matcher };
}

function fakeMatcher() {
  return {
    reviewGroups: vi.fn(() => [{ groupKey: 'g', artistName: 'A', files: [], candidates: [] }]),
    applyRelease: vi.fn(async () => {}),
    ignore: vi.fn(),
    search: vi.fn(async () => {}),
    enqueue: vi.fn(),
  };
}
```

and add:

```ts
  it('lists and resolves review groups from the home network', async () => {
    const { app, matcher } = setup();
    expect((await app.inject({ method: 'GET', url: '/api/settings/sources/1/review', remoteAddress: AWAY })).statusCode).toBe(403);
    const list = await app.inject({ method: 'GET', url: '/api/settings/sources/1/review', remoteAddress: HOME });
    expect(list.json()).toEqual([{ groupKey: 'g', artistName: 'A', files: [], candidates: [] }]);
    const apply = await app.inject({ method: 'POST', url: '/api/settings/sources/1/review', payload: { groupKey: 'g', releaseId: 'rel-1' }, remoteAddress: HOME });
    expect(apply.statusCode).toBe(204);
    expect(matcher.applyRelease).toHaveBeenCalledWith(1, 'g', 'rel-1');
    await app.inject({ method: 'POST', url: '/api/settings/sources/1/review', payload: { groupKey: 'g', releaseId: null }, remoteAddress: HOME });
    expect(matcher.ignore).toHaveBeenCalledWith(1, 'g');
    await app.inject({ method: 'POST', url: '/api/settings/sources/1/review', payload: { groupKey: 'g', search: { artist: 'A', album: 'B' } }, remoteAddress: HOME });
    expect(matcher.search).toHaveBeenCalledWith(1, 'g', 'A', 'B');
  });

  it('matches a source again on request', async () => {
    const { app, matcher, store } = setup();
    const id = store.addSource('folder', 'Music', { path: '/m' });
    store.saveMatches(id, [{ rel: 'a', groupKey: 'g', state: 'auto', size: 1, mtimeMs: 1 }]);
    const res = await app.inject({ method: 'POST', url: `/api/settings/sources/${id}/rematch`, remoteAddress: HOME });
    expect(res.statusCode).toBe(202);
    expect(store.matches(id).size).toBe(0);
    expect(matcher.enqueue).toHaveBeenCalledWith(id);
  });

  it('saves the AcoustID key without ever sending it back', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: '/api/settings/matching', remoteAddress: HOME })).json()).toEqual({ acoustid: false, fingerprints: true });
    const put = await app.inject({ method: 'PUT', url: '/api/settings/matching', payload: { acoustidKey: 'secret' }, remoteAddress: HOME });
    expect(put.json()).toEqual({ acoustid: true, fingerprints: true });
    expect(put.body).not.toContain('secret');
    expect((await app.inject({ method: 'PUT', url: '/api/settings/matching', payload: { acoustidKey: 'x' }, remoteAddress: AWAY })).statusCode).toBe(403);
  });
```

**Step 2:** Run; FAIL.

**Step 3: Implement** in `routes/settings.ts`:

- deps gain `matcher: Pick<Matcher, 'reviewGroups' | 'applyRelease' | 'ignore' | 'search' | 'enqueue'>`, `store: Pick<CatalogStore, 'clearMatches' | 'appSetting' | 'setAppSetting'>`, `fingerprints: boolean`.
- Schemas:

```ts
const reviewInput = z.object({
  groupKey: z.string().min(1),
  releaseId: z.string().min(1).nullable().optional(),
  search: z.object({ artist: z.string().trim().min(1).max(200), album: z.string().trim().min(1).max(200) }).optional(),
});
const matchingInput = z.object({ acoustidKey: z.string().trim().max(100) });
const ACOUSTID_KEY = 'acoustid.key';
```

- Routes (all with `editable`; the review list shows the server's file names, so GET is local-only too):

```ts
  app.get<Id>('/api/settings/sources/:id/review', editable, (req) => matcher.reviewGroups(Number(req.params.id)));

  app.post<Id>('/api/settings/sources/:id/review', editable, (req, reply) =>
    handle(reply, async () => {
      const id = Number(req.params.id);
      const action = parse(reviewInput, req.body);
      try {
        if (action.search) await matcher.search(id, action.groupKey, action.search.artist, action.search.album);
        else if (action.releaseId === null) matcher.ignore(id, action.groupKey);
        else if (action.releaseId) await matcher.applyRelease(id, action.groupKey, action.releaseId);
        else throw new SourceError('Choose a release, search, or leave it unmatched', 400);
      } catch (err) {
        if (err instanceof SourceError) throw err;
        throw new SourceError((err as Error).message, 409);
      }
      return reply.code(204).send();
    }),
  );

  app.post<Id>('/api/settings/sources/:id/rematch', editable, (req, reply) =>
    handle(reply, () => {
      const id = Number(req.params.id);
      deps.store.clearMatches(id);
      matcher.enqueue(id);
      return reply.code(202).send({});
    }),
  );

  const matchingSettings = (): MatchingSettings => ({ acoustid: !!deps.store.appSetting(ACOUSTID_KEY), fingerprints: deps.fingerprints });

  app.get('/api/settings/matching', editable, () => matchingSettings());

  app.put('/api/settings/matching', editable, (req, reply) =>
    handle(reply, () => {
      deps.store.setAppSetting(ACOUSTID_KEY, parse(matchingInput, req.body).acoustidKey);
      return matchingSettings();
    }),
  );
```

(import `type MatchingSettings` from `@playarr/shared`, `type Matcher` from `../catalog/matcher.ts`, `type CatalogStore` from `../catalog/store.ts`; export `ACOUSTID_KEY` so `index.ts` reads the same key.)

`config.ts`: add `FPCALC_PATH: z.string().default('fpcalc'),` next to `FFMPEG_PATH`.

`index.ts`:
- Move the `MusicBrainz` construction above the sources/library block.
- After the store and manager exist:

```ts
const fingerprints = await hasFpcalc(config.FPCALC_PATH);
const matcher = new Matcher({
  store,
  mb: {
    searchReleases: (artist, album) => musicbrainz.searchReleases(artist, album),
    release: async (id) => toReleaseInfo(await musicbrainz.release(id)),
  },
  acoustid: new AcoustId(() => store.appSetting(ACOUSTID_KEY) || undefined),
  fingerprint: fingerprints ? fpcalc(config.FPCALC_PATH) : undefined,
  onMatched: () => library.refreshSoon(),
  log: { warn: (m) => app.log.warn(m) },
});
sources.useMatcher(matcher);
```

  (`library` is declared after; `onMatched` only runs later, so referencing it in the closure is fine. Imports: `AcoustId, fpcalc, hasFpcalc` from `./catalog/acoustid.ts`, `Matcher` from `./catalog/matcher.ts`, `toReleaseInfo` from `./catalog/mbRelease.ts`, `ACOUSTID_KEY` from `./routes/settings.ts`.)
- `settingsRoutes(app, { sources, library, matcher, store, fingerprints });`

`docker/Dockerfile`: runtime stage `RUN apk add --no-cache ffmpeg chromaprint` (comment: "chromaprint provides fpcalc, for identifying songs by their sound").

**Step 4:** `corepack pnpm -C apps/server typecheck && corepack pnpm -C apps/server test && corepack pnpm -C apps/server build`: clean; PASS; builds.

Commit: `git add apps/server/src/routes/settings.ts apps/server/src/routes/settings.test.ts apps/server/src/config.ts apps/server/src/index.ts docker/Dockerfile && git commit -m "Server: review and matching API, matcher wired in, fpcalc in the image" && git push origin main`

---

### Task 11: Web: review and matching in Settings

**Files:** Modify `apps/web/src/lib/api.ts`, `apps/web/src/lib/queries.ts`, `apps/web/src/components/SourcesPanel.tsx`; create `apps/web/src/components/ReviewDialog.tsx`

**Step 1: API and queries**

`api.ts` (add `ReviewGroup`, `ReviewAction`, `MatchingSettings` to the type import):

```ts
  review: (id: number) => get<ReviewGroup[]>(`/api/settings/sources/${id}/review`),
  reviewAction: (id: number, action: ReviewAction) =>
    request<void>(`/api/settings/sources/${id}/review`, { method: 'POST', body: JSON.stringify(action) }),
  rematchSource: (id: number) => request<void>(`/api/settings/sources/${id}/rematch`, { method: 'POST' }),
  matching: () => get<MatchingSettings>('/api/settings/matching'),
  saveMatching: (acoustidKey: string) =>
    request<MatchingSettings>('/api/settings/matching', { method: 'PUT', body: JSON.stringify({ acoustidKey }) }),
```

`queries.ts` (add `ReviewAction` to the type import):

```ts
export const useReview = (id: number | null) =>
  useQuery({ queryKey: ['review', id], queryFn: () => api.review(id!), enabled: id !== null });

export function useReviewAction(id: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: ReviewAction) => api.reviewAction(id, action),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['review', id] });
      void client.invalidateQueries({ queryKey: ['sources'] });
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });
}

export const useMatching = () => useQuery({ queryKey: ['matching'], queryFn: api.matching });

export function useSaveMatching() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.saveMatching,
    onSuccess: (data) => client.setQueryData(['matching'], data),
    onError: (err: Error) => toast(err.message, 'error'),
  });
}
```

and in `useSourceActions` add:

```ts
    rematch: useMutation({ mutationFn: api.rematchSource, onSuccess: changed, onError: fail }),
```

Also make `useSources` poll while matching: `refetchInterval: (q) => (q.state.data?.sources.some((s) => s.syncing || s.matching > 0) ? 2000 : 30_000)`.

**Step 2: `components/ReviewDialog.tsx`**

```tsx
import type { ReviewGroup } from '@playarr/shared';
import { Check, Search } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { cn } from '../lib/cn';
import { formatTime } from '../lib/format';
import { useReview, useReviewAction } from '../lib/queries';
import { Dialog } from './Dialog';

/** Settings → Sources → "N to review": confirm, pick or search the album for doubtful matches. */
export function ReviewDialog({ sourceId, onClose }: { sourceId: number | null; onClose: () => void }) {
  const { data: groups } = useReview(sourceId);
  const group = groups?.[0];
  return (
    <Dialog open={sourceId !== null} onClose={onClose} title="Review matches" wide>
      {!groups ? (
        <div className="m-5 h-40 animate-pulse rounded-lg bg-paper/5" />
      ) : !group ? (
        <p className="p-5 text-[15px] text-paper-dim">Nothing left to review.</p>
      ) : (
        <ReviewGroupView key={group.groupKey} sourceId={sourceId!} group={group} remaining={groups.length} />
      )}
    </Dialog>
  );
}

function ReviewGroupView({ sourceId, group, remaining }: { sourceId: number; group: ReviewGroup; remaining: number }) {
  const action = useReviewAction(sourceId);
  const [chosen, setChosen] = useState(group.candidates[0]?.releaseId);
  const [artist, setArtist] = useState(group.artistName);
  const [album, setAlbum] = useState(group.albumTitle ?? '');
  useEffect(() => setChosen(group.candidates[0]?.releaseId), [group.candidates]);
  const candidate = group.candidates.find((c) => c.releaseId === chosen);

  const search = (e: FormEvent) => {
    e.preventDefault();
    action.mutate({ groupKey: group.groupKey, search: { artist, album } });
  };

  return (
    <div className="space-y-6 p-5">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <div className="font-mono text-[11px] tracking-[0.2em] text-muted uppercase">Your files say</div>
          <div className="truncate text-[17px] text-paper">
            {group.albumTitle ?? 'No album'} <span className="text-muted">· {group.artistName}</span>
          </div>
        </div>
        <span className="shrink-0 font-mono text-[12px] text-muted">{remaining} to review</span>
      </div>

      {group.candidates.length > 0 ? (
        <div role="radiogroup" aria-label="Albums on MusicBrainz" className="space-y-1">
          {group.candidates.map((c) => (
            <button
              key={c.releaseId}
              type="button"
              role="radio"
              aria-checked={c.releaseId === chosen}
              onClick={() => setChosen(c.releaseId)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition',
                c.releaseId === chosen ? 'border-accent bg-accent/5' : 'border-line hover:bg-paper/[0.03]',
              )}
            >
              <span className="min-w-0 flex-1 truncate text-[15px] text-paper">
                {c.title} <span className="text-muted">· {c.artistName}{c.year ? ` · ${c.year}` : ''}</span>
              </span>
              <span className="font-mono text-[12px] text-muted">{Math.round(c.score * 100)}% · {c.tracks.length} tracks</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">No albums found on MusicBrainz for these names. Try other names below.</p>
      )}

      {candidate && (
        <table className="w-full text-[14px]">
          <thead>
            <tr className="font-mono text-[11px] tracking-[0.15em] text-muted uppercase">
              <th className="pb-2 text-left font-normal">Your file</th>
              <th className="pb-2 text-left font-normal">On MusicBrainz</th>
            </tr>
          </thead>
          <tbody>
            {group.files.map((f) => {
              const t = candidate.tracks[candidate.matches[f.rel] ?? -1];
              return (
                <tr key={f.rel} className="border-t border-line">
                  <td className="py-1.5 pr-3 text-paper-dim">
                    {f.title} <span className="font-mono text-[12px] text-muted">{formatTime(f.duration)}</span>
                  </td>
                  <td className="py-1.5 text-paper">
                    {t ? (
                      <>
                        {t.position}. {t.title} <span className="font-mono text-[12px] text-muted">{formatTime(t.duration)}</span>
                      </>
                    ) : (
                      <span className="text-muted">not on this album</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <form onSubmit={search} className="flex flex-wrap items-end gap-2">
        <input value={artist} onChange={(e) => setArtist(e.target.value)} aria-label="Artist" placeholder="Artist" className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-ink-900 px-3 text-[14px] text-paper outline-none focus:border-accent" />
        <input value={album} onChange={(e) => setAlbum(e.target.value)} aria-label="Album" placeholder="Album" className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-ink-900 px-3 text-[14px] text-paper outline-none focus:border-accent" />
        <button type="submit" disabled={action.isPending || !artist || !album} className="inline-flex h-10 items-center gap-2 rounded-full border border-line px-4 text-[14px] text-paper hover:bg-paper/5 disabled:opacity-50">
          <Search className="size-4" /> Search
        </button>
      </form>

      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
        <button
          type="button"
          disabled={action.isPending}
          onClick={() => action.mutate({ groupKey: group.groupKey, releaseId: null })}
          className="inline-flex h-10 items-center rounded-full border border-line px-5 text-[14px] text-paper hover:bg-paper/5 disabled:opacity-50"
        >
          Leave unmatched
        </button>
        <button
          type="button"
          disabled={action.isPending || !chosen}
          onClick={() => chosen && action.mutate({ groupKey: group.groupKey, releaseId: chosen })}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-accent px-5 text-[14px] font-medium text-accent-ink disabled:opacity-50"
        >
          <Check className="size-4" /> Use this album
        </button>
      </div>
    </div>
  );
}
```

**Step 3: `SourcesPanel.tsx`**

- State: `const [reviewing, setReviewing] = useState<number | null>(null);` in `SourcesPanel`; render `<ReviewDialog sourceId={reviewing} onClose={() => setReviewing(null)} />`; pass `onReview={() => setReviewing(s.id)}` to `SourceRow`.
- `SourceStatus`: when not syncing and `s.matching > 0`, show `Matching… ${plural(s.matching, 'album')} left` in `text-accent` (before the error check).
- In `SourceRow`, below `<SourceStatus />`, for folder sources with `s.review > 0` and `canEdit`:

```tsx
        {s.kind === 'folder' && s.review > 0 && canEdit && (
          <button type="button" onClick={onReview} className="mt-1 text-[13px] text-accent hover:underline">
            {plural(s.review, 'album')} to review
          </button>
        )}
```

- For folder sources, add an `IconButton` "Match again" (`RotateCw` icon) calling `actions.rematch.mutate(s.id)`.
- Add a `MatchingSection` after the sources list (only when `canEdit` and at least one folder source exists):

```tsx
function MatchingSection() {
  const { data } = useMatching();
  const save = useSaveMatching();
  const [replacing, setReplacing] = useState(false);
  const [key, setKey] = useState('');
  if (!data) return null;
  const editing = replacing || !data.acoustid;
  return (
    <section className="mt-12 max-w-prose">
      <h2 className="mb-2 font-mono text-[11px] tracking-[0.2em] text-muted uppercase">Identifying songs</h2>
      <p className="mb-4 text-sm text-muted">
        Playarr matches folder albums on MusicBrainz by their names, track titles and lengths. For songs whose names don’t help,
        it can identify them by their sound with AcoustID. A free key comes from{' '}
        <a href="https://acoustid.org/new-application" target="_blank" rel="noreferrer" className="text-accent hover:underline">
          acoustid.org
        </a>
        .
      </p>
      {!data.fingerprints && (
        <p className="mb-4 text-sm text-paper-dim">Fingerprints need fpcalc (Chromaprint) on the server. The Docker image includes it.</p>
      )}
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(key, { onSuccess: () => { setReplacing(false); setKey(''); } });
          }}
          className="flex gap-2"
        >
          <input value={key} onChange={(e) => setKey(e.target.value)} aria-label="AcoustID key" placeholder="AcoustID application key" autoComplete="off" spellCheck={false} className={cn(INPUT, 'font-mono')} />
          <button type="submit" disabled={!key || save.isPending} className={PRIMARY}>Save</button>
        </form>
      ) : (
        <div className="flex items-center gap-3 text-[14px]">
          <span className="font-mono text-paper-dim">AcoustID key saved</span>
          <button type="button" onClick={() => setReplacing(true)} className="text-accent hover:underline">Replace</button>
        </div>
      )}
    </section>
  );
}
```

(imports: `RotateCw` from lucide-react, `ReviewDialog`, `useMatching`, `useSaveMatching`.)

**Step 4:** `corepack pnpm -C apps/web exec tsc --noEmit && corepack pnpm -C apps/web exec vite build`: clean; builds.

Commit: `git add apps/web/src/lib/api.ts apps/web/src/lib/queries.ts apps/web/src/components/SourcesPanel.tsx apps/web/src/components/ReviewDialog.tsx && git commit -m "Web: review matches and set the AcoustID key in Settings" && git push origin main`

---

### Task 12: Docs

**Files:** `PLAN.md`, `README.md`, `.env.example`

- PLAN.md decisions log:

```
| 2026-10-30 | Matching (phase 4): a match is an overlay on a file's tags (`folder_matches`), so matched and tagged files share one mapping. MusicBrainz release search → align files to tracks (0.6 title + 0.3 duration + 0.1 position; ≥0.85 auto, ≥0.5 review) → else Chromaprint/AcoustID (≥0.8, studio album preferred) → else unmatched. Matched releases bring full track lists (missing songs). manual/ignored decisions stick; files are re-matched when they change. When a song's id goes from `local:` to a MusicBrainz recording, favorites, playlist items and analysis follow it. AcoustID key in Settings; fpcalc from Alpine's chromaprint in the image. Matching shares MusicBrainz's 1 req/s queue with Discover. |
```

- README "Key design points" → extend the Folder sources bullet: `Untagged albums are matched on MusicBrainz automatically (and by their sound with an AcoustID key); doubtful matches wait for you in Settings.`
- `.env.example`: after `FFMPEG_PATH=ffmpeg` add `FPCALC_PATH=fpcalc` with comment `# Chromaprint's fpcalc, for identifying songs by their sound (optional)`.

Commit: `git add PLAN.md README.md .env.example && git commit -m "Docs: matching" && git push origin main`

---

## Not verified by this plan

- Matching quality on a real collection (thresholds may need tuning; compilations and "Various Artists").
- Real AcoustID and fpcalc (no key, no binary locally).
- The review dialog in a browser.
- Discover search latency while a big first match runs (shared MusicBrainz queue).
