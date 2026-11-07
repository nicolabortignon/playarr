import type { AudioFormat } from '@playarr/shared';
import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { albumKey as albumNameKey, normalize } from '../library/search.ts';
import { songNameKey } from './keys.ts';
import type { MbReleaseInfo } from './mbRelease.ts';
import type { OrganizeFile } from './organize.ts';
import type { MatchRecord, TagInfo } from './tags.ts';
import type {
  KnownTrack,
  LidarrAlbumState,
  NameIndex,
  SourceAlbum,
  SourceArtist,
  SourceCopy,
  SourceKind,
  SourceSync,
  SourceTrack,
} from './types.ts';

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
/** A source as Settings manages it. `settings` holds secrets: never send it to the browser as is. */
export interface SourceRecord extends SourceRow {
  settings: Record<string, unknown>;
  lastError?: string;
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
  /** When the album first entered the library: the earliest date any of its copies ever had. */
  addedAt?: string;
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
  /** Songs each source reported in its last sync (with or without a file). */
  sourceTracks: { sourceId: number; trackId: number }[];
}

type CatalogTable = 'catalog_artists' | 'catalog_albums' | 'catalog_tracks';

/** How a sync's copies are dated (SourceSync.addedAt), and whether files may keep their own times. */
interface CopyDating {
  mode: 'source' | 'firstSeen';
  /** The library's first music: the first sync of a source while no other source has any copy. */
  ownTimes: boolean;
}

/** A date as a canonical ISO string (so dates from different sources compare correctly as text), or null. */
function isoDate(value: string | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** What a source has (see sourceCounts). */
export interface SourceCounts {
  songs: number;
  albums: number;
  complete: number;
  incomplete: number;
  unknown: number;
  songsComplete: number;
  songsIncomplete: number;
  songsUnknown: number;
}

/** A folder source's songs by how matching went (see matchCounts). */
export interface MatchCounts {
  matched: number;
  review: number;
  ignored: number;
}

/** A catalog row as it is now, to tell whether a sync changes it. */
interface StoredRow {
  id: number;
  meta_rank: number;
  meta: string;
  [column: string]: string | number;
}

/** A copy as it is now, with the song it belongs to. */
interface StoredCopy {
  id: number;
  source_ref: string;
  track_id: number;
  path: string;
  size: number;
  format: string;
  added_at: string | null;
  recording_id: string;
}

/** A catalog table's rows a sync may touch, by key; with every id the table has, when it was read whole. */
interface StoredRows {
  byKey: Map<string, StoredRow>;
  ids?: Set<number>;
}

/** From how many rows a sync reads a whole catalog table at once rather than row by row (one read is ~4x faster per row). */
const READ_WHOLE_TABLE = 1000;

/**
 * What a source's sync holds, as one SHA-1: two syncs with the same digest are the same sync. A sync is never changed
 * once a source has handed it over.
 */
export function syncDigest(sync: SourceSync): string {
  const hash = createHash('sha1');
  for (const part of [sync.artists, sync.albums, sync.tracks, sync.copies, sync.lidarrAlbums ?? null, sync.metaRank ?? 0, sync.addedAt ?? 'source']) {
    hash.update(JSON.stringify(part)).update('\n');
  }
  return hash.digest('base64');
}

/** The catalog in SQLite: what each source reported, with permanent Playarr ids. */
export class CatalogStore {
  /** Statements prepared once: preparing costs more than running a small one, and a sync runs hundreds of thousands. */
  private readonly statements = new Map<string, StatementSync>();
  /**
   * Goes up whenever what the library is built from changes: catalog rows, copies, the songs sources report, or the
   * sources themselves (added, removed, changed, moved, their state). The library rebuilds only when it has moved.
   */
  private catalogGeneration = 0;
  /** Each source's last sync applied, and the generation right after: a sync with the same digest, on a catalog still at that generation, would change nothing. */
  private readonly applied = new Map<number, { digest: string; generation: number }>();
  /** Goes up with each folder source's match decisions; `releases` with every MusicBrainz release saved. Folder scans read both. */
  private readonly matchGenerations = new Map<number, number>();
  private releaseGeneration = 0;

  constructor(private readonly db: DatabaseSync) {}

  get generation(): number {
    return this.catalogGeneration;
  }

  /** How many times this folder source's match decisions, or any saved release, have changed (in this run). */
  matchGeneration(sourceId: number): string {
    return `${this.matchGenerations.get(sourceId) ?? 0}.${this.releaseGeneration}`;
  }

  /** Whether the catalog holds this sync of the source as it applied it, untouched since (see applySync). */
  holds(sourceId: number, digest: string): boolean {
    const last = this.applied.get(sourceId);
    return last?.digest === digest && last.generation === this.catalogGeneration;
  }

  private sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (!statement) this.statements.set(text, (statement = this.db.prepare(text)));
    return statement;
  }

  private changed() {
    this.catalogGeneration++;
  }

  private matchesChanged(sourceId: number) {
    this.matchGenerations.set(sourceId, (this.matchGenerations.get(sourceId) ?? 0) + 1);
  }

  addSource(kind: SourceKind, name: string, settings: Record<string, unknown> = {}): number {
    const { next } = this.sql('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM sources').get() as {
      next: number;
    };
    const res = this.sql('INSERT INTO sources (kind, name, position, settings, created_at) VALUES (?, ?, ?, ?, ?)').run(
      kind,
      name,
      next,
      JSON.stringify(settings),
      new Date().toISOString(),
    );
    this.changed();
    return Number(res.lastInsertRowid);
  }

  /** The first source of this kind, created if there is none. */
  ensureSource(kind: SourceKind, name: string): number {
    const row = this.sql('SELECT id FROM sources WHERE kind = ? ORDER BY position LIMIT 1').get(kind) as
      | { id: number }
      | undefined;
    return row?.id ?? this.addSource(kind, name);
  }

  hasData(): boolean {
    return !!this.sql('SELECT 1 FROM copies LIMIT 1').get();
  }

  listSources(): SourceRecord[] {
    const rows = this.sql(
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
    if (patch.name !== undefined) this.sql('UPDATE sources SET name = ? WHERE id = ?').run(patch.name, id);
    if (patch.enabled !== undefined) {
      this.sql('UPDATE sources SET enabled = ? WHERE id = ?').run(patch.enabled ? 1 : 0, id);
    }
    if (patch.settings !== undefined) {
      this.sql('UPDATE sources SET settings = ? WHERE id = ?').run(JSON.stringify(patch.settings), id);
    }
    this.changed();
  }

  /** Delete a source and its copies. Catalog rows stay, so their ids are never reused. */
  removeSource(id: number) {
    this.db.exec('BEGIN');
    try {
      this.sql('DELETE FROM copies WHERE source_id = ?').run(id);
      this.sql('DELETE FROM source_tracks WHERE source_id = ?').run(id);
      this.sql('DELETE FROM folder_files WHERE source_id = ?').run(id);
      this.sql('DELETE FROM folder_matches WHERE source_id = ?').run(id);
      this.sql('DELETE FROM file_moves WHERE source_id = ?').run(id);
      this.sql('DELETE FROM sources WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.applied.delete(id);
    this.matchesChanged(id);
    this.changed();
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
      const update = this.sql('UPDATE sources SET position = ? WHERE id = ?');
      ids.forEach((id, i) => update.run(i, id));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    // At the same trust, the source lower down wins: every source applies its next sync again, in the new order.
    this.changed();
  }

  /** When each source last synced, by id: what the library's stats say it was refreshed at. */
  syncTimes(): Map<number, string | undefined> {
    const rows = this.sql('SELECT id, last_sync_at FROM sources').all() as { id: number; last_sync_at: string | null }[];
    return new Map(rows.map((r) => [r.id, r.last_sync_at ?? undefined]));
  }

  setSyncError(id: number, error: string | null) {
    this.sql('UPDATE sources SET last_error = ? WHERE id = ?').run(error, id);
  }

  /**
   * The songs and albums each source has, its albums by how much of them it has: complete or incomplete
   * when the album's length is known (Lidarr's, a MusicBrainz match's, or the files' track total),
   * unidentified otherwise, loose songs included (one album per artist). Its songs too, by the same
   * album they're on; a folder's song waiting for a match is unidentified whatever its album, so a folder
   * has as many unidentified songs as songs not matched, and those left as tagged on albums of unknown length.
   */
  sourceCounts(): Map<number, SourceCounts> {
    const rows = this.sql(
        `WITH size AS (
           SELECT a.id AS album_id,
             MAX(COUNT(t.id), IFNULL(json_extract(a.meta, '$.totalTrackCount'), 0)) AS total,
             json_extract(a.meta, '$.totalTrackCount') IS NOT NULL AND IFNULL(json_extract(a.meta, '$.albumType') <> 'Loose', 1) AS known
           FROM catalog_albums a JOIN catalog_tracks t ON t.album_id = a.id
           GROUP BY a.id
         ), have AS (
           SELECT c.source_id AS id, t.album_id, COUNT(DISTINCT c.track_id) AS songs,
             COUNT(DISTINCT CASE WHEN m.state IN ('review', 'unmatched') THEN c.track_id END) AS waiting
           FROM copies c JOIN catalog_tracks t ON t.id = c.track_id
           LEFT JOIN folder_matches m ON m.source_id = c.source_id AND m.rel_path = c.source_ref
           GROUP BY c.source_id, t.album_id
         )
         SELECT h.id, SUM(h.songs) AS songs, COUNT(*) AS albums,
           SUM(s.known AND h.songs >= s.total) AS complete,
           SUM(s.known AND h.songs < s.total) AS incomplete,
           SUM(NOT s.known) AS unknown,
           SUM(IIF(s.known AND h.songs >= s.total, h.songs - h.waiting, 0)) AS songsComplete,
           SUM(IIF(s.known AND h.songs < s.total, h.songs - h.waiting, 0)) AS songsIncomplete,
           SUM(IIF(s.known, h.waiting, h.songs)) AS songsUnknown
         FROM have h JOIN size s ON s.album_id = h.album_id
         GROUP BY h.id`,
      )
      .all() as {
        id: number;
        songs: number;
        albums: number;
        complete: number;
        incomplete: number;
        unknown: number;
        songsComplete: number;
        songsIncomplete: number;
        songsUnknown: number;
      }[];
    return new Map(rows.map(({ id, ...counts }) => [id, counts]));
  }

  appSetting(key: string): string | undefined {
    const row = this.sql('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setAppSetting(key: string, value: string) {
    this.sql('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /**
   * Replace what this source has with `sync`, all or nothing, writing only what differs from what the catalog holds;
   * true when anything changed. Comparing first is what lets a refresh that finds nothing new leave the catalog (and
   * the library built from it) alone. A sync with the same digest as the source's last one, on a catalog nothing has
   * written to since, would change nothing: it isn't even compared (an `unchanged` sync comes without its rows).
   */
  applySync(sourceId: number, sync: SourceSync): boolean {
    const now = new Date().toISOString();
    const digest = sync.digest ?? syncDigest(sync);
    if (this.holds(sourceId, digest)) {
      this.sql('UPDATE sources SET last_sync_at = ? WHERE id = ?').run(now, sourceId);
      return false;
    }
    // Only a source that has just been told the catalog holds its last sync says so (FolderSource): another write
    // came in between. Its last sync stays, and the next refresh reads the source in full.
    if (sync.unchanged) throw new Error('The library changed during the scan; it will be read again on the next refresh');
    const rank = sync.metaRank ?? 0;
    let wrote = false;
    this.db.exec('BEGIN');
    try {
      const artists = this.storedRows('catalog_artists', sync.artists.map((a) => a.key), []);
      const artistIds = new Map<string, number>();
      for (const { key, preferredId, metaRank, ...meta } of sync.artists) {
        const row = this.upsert('catalog_artists', artists, key, preferredId, {}, meta, now, metaRank ?? rank);
        artistIds.set(key, row.id);
        wrote ||= row.wrote;
      }
      const albums = this.storedRows('catalog_albums', sync.albums.map((a) => a.key), ['artist_id']);
      const albumIds = new Map<string, number>();
      for (const { key, preferredId, artistKey, metaRank, ...meta } of sync.albums) {
        const artistId = artistIds.get(artistKey);
        if (artistId === undefined) throw new Error(`Album ${key} refers to unknown artist ${artistKey}`);
        const row = this.upsert('catalog_albums', albums, key, preferredId, { artist_id: artistId }, meta, now, metaRank ?? rank);
        albumIds.set(key, row.id);
        wrote ||= row.wrote;
      }
      const tracks = this.storedRows('catalog_tracks', sync.tracks.map((t) => t.key), ['album_id', 'recording_id']);
      const trackIds = new Map<string, number>();
      // Each song's album as the catalog has it: a more trusted source's, where that one keeps the row.
      const albumOf = new Map<number, number>();
      for (const { key, preferredId, albumKey, recordingId, metaRank, ...meta } of sync.tracks) {
        const albumId = albumIds.get(albumKey);
        if (albumId === undefined) throw new Error(`Track ${key} refers to unknown album ${albumKey}`);
        const row = this.upsert(
          'catalog_tracks',
          tracks,
          key,
          preferredId,
          { album_id: albumId, recording_id: recordingId },
          meta,
          now,
          metaRank ?? rank,
        );
        trackIds.set(key, row.id);
        albumOf.set(row.id, tracks.byKey.get(key)!.album_id as number);
        wrote ||= row.wrote;
      }
      // This source's files as they are, with the song each belonged to, to follow songs whose id changes.
      const stored = new Map(
        (
          this.sql(
            `SELECT c.id, c.source_ref, c.track_id, c.path, c.size, c.format, c.added_at, t.recording_id
             FROM copies c JOIN catalog_tracks t ON t.id = c.track_id WHERE c.source_id = ?`,
          ).all(sourceId) as unknown as StoredCopy[]
        ).map((c) => [c.source_ref, c]),
      );
      // The songs this source had a file of, so a song new to it moves its album to the front.
      const had = new Set([...stored.values()].map((c) => c.track_id));
      const recordingOf = new Map(sync.tracks.map((t) => [t.key, t.recordingId]));
      const moves = new Map<string, string>();
      // Each file the source reports, by id, with its song and the date it's kept with.
      const seen = new Map<number, { trackId: number; addedAt: string | null }>();
      const dating: CopyDating = {
        mode: sync.addedAt ?? 'source',
        // A folder added to a library that already has music is new to it, whenever its files arrived on disk.
        ownTimes: !this.sql('SELECT 1 FROM copies LIMIT 1').get(),
      };
      for (const copy of sync.copies) {
        const trackId = trackIds.get(copy.trackKey);
        if (trackId === undefined) throw new Error(`Copy ${copy.ref} refers to unknown track ${copy.trackKey}`);
        const was = stored.get(copy.ref)?.recording_id;
        const is = recordingOf.get(copy.trackKey);
        if (was && is && was !== is && was.startsWith('local:') && !is.startsWith('local:')) moves.set(was, is);
        const row = this.upsertCopy(sourceId, stored, copy, trackId, now, dating);
        seen.set(row.id, { trackId, addedAt: row.addedAt });
        wrote ||= row.wrote;
      }
      for (const [from, to] of moves) this.moveRecording(from, to);
      // The songs this source reports, including ones it has no file for (missing songs).
      const reported = new Set(trackIds.values());
      const before = new Set(
        (this.sql('SELECT track_id FROM source_tracks WHERE source_id = ?').all(sourceId) as { track_id: number }[]).map((r) => r.track_id),
      );
      const unreport = this.sql('DELETE FROM source_tracks WHERE source_id = ? AND track_id = ?');
      for (const trackId of before) if (!reported.has(trackId)) wrote = unreport.run(sourceId, trackId).changes > 0 || wrote;
      const report = this.sql('INSERT OR IGNORE INTO source_tracks (source_id, track_id) VALUES (?, ?)');
      for (const trackId of reported) if (!before.has(trackId)) wrote = report.run(sourceId, trackId).changes > 0 || wrote;
      // Files the source no longer has. Catalog rows stay, so their ids are never reused.
      const remove = this.sql('DELETE FROM copies WHERE id = ?');
      for (const { id } of stored.values()) if (!seen.has(id)) wrote = remove.run(id).changes > 0 || wrote;
      // An album is dated by when it last got a song: its earliest copy at first, then the date of each
      // song new to a source (a folder added later with one of its songs). A file replaced for a song
      // the source already had (upgrades, organizing) never makes an old album look new.
      const albumsHere = new Set([...seen.values()].map((c) => albumOf.get(c.trackId)!));
      const undated = (this.sql('SELECT id FROM catalog_albums WHERE added_at IS NULL').all() as { id: number }[]).filter((a) =>
        albumsHere.has(a.id),
      );
      if (undated.length) {
        const dated = this.sql(
          `UPDATE catalog_albums SET added_at = first.added_at
           FROM (
             SELECT t.album_id AS id, MIN(c.added_at) AS added_at FROM copies c JOIN catalog_tracks t ON t.id = c.track_id
             GROUP BY t.album_id
           ) AS first
           WHERE catalog_albums.id = first.id AND catalog_albums.added_at IS NULL AND first.added_at IS NOT NULL
             AND catalog_albums.id IN (SELECT value FROM json_each(?))`,
        ).run(JSON.stringify(undated.map((a) => a.id)));
        wrote ||= dated.changes > 0;
      }
      // Each album's newest file of a song new to this source: the album moves up to it.
      const latest = new Map<number, string>();
      for (const { trackId, addedAt } of seen.values()) {
        if (had.has(trackId) || !addedAt) continue;
        const albumId = albumOf.get(trackId)!;
        if (addedAt > (latest.get(albumId) ?? '')) latest.set(albumId, addedAt);
      }
      const bump = this.sql(`UPDATE catalog_albums SET added_at = ? WHERE id = ? AND IFNULL(added_at, '') < ?`);
      for (const [albumId, addedAt] of latest) wrote = bump.run(addedAt, albumId, addedAt).changes > 0 || wrote;
      const state = JSON.stringify({ lidarrAlbums: sync.lidarrAlbums } satisfies SourceState);
      const stateWas = (this.sql('SELECT state FROM sources WHERE id = ?').get(sourceId) as { state: string | null } | undefined)?.state;
      if (state !== stateWas) {
        this.sql('UPDATE sources SET state = ? WHERE id = ?').run(state, sourceId);
        wrote = true;
      }
      this.sql('UPDATE sources SET last_sync_at = ? WHERE id = ?').run(now, sourceId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    if (wrote) this.changed();
    this.applied.set(sourceId, { digest, generation: this.catalogGeneration });
    return wrote;
  }

  load(): CatalogRows {
    const all = <T>(sql: string) => this.sql(sql).all() as T[];
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
      albums: all<{ id: number; key: string; artist_id: number; meta: string; added_at: string | null }>(
        'SELECT id, key, artist_id, meta, added_at FROM catalog_albums',
      ).map((r) => ({
        id: r.id,
        key: r.key,
        artistId: r.artist_id,
        meta: JSON.parse(r.meta) as AlbumInfo,
        ...(r.added_at ? { addedAt: r.added_at } : {}),
      })),
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
      sourceTracks: all<{ source_id: number; track_id: number }>('SELECT source_id, track_id FROM source_tracks').map(
        (r) => ({ sourceId: r.source_id, trackId: r.track_id }),
      ),
    };
  }

  /** The last scan's view of a folder source's files, by path relative to the folder. */
  folderFiles(sourceId: number): Map<string, { size: number; mtimeMs: number; tags: TagInfo | null }> {
    const rows = this.sql('SELECT rel_path, size, mtime_ms, tags FROM folder_files WHERE source_id = ?')
      .all(sourceId) as { rel_path: string; size: number; mtime_ms: number; tags: string | null }[];
    return new Map(
      rows.map((r) => [r.rel_path, { size: r.size, mtimeMs: r.mtime_ms, tags: r.tags ? (JSON.parse(r.tags) as TagInfo) : null }]),
    );
  }

  /** One song with its album, artist and every copy (for Show metadata). */
  trackDetails(trackId: number):
    | {
        track: { id: number; recordingId: string; meta: TrackInfo };
        album: { id: number; meta: AlbumInfo };
        artist: { id: number; meta: ArtistInfo };
        copies: (CopyRow & { ref: string })[];
      }
    | undefined {
    const t = this.sql('SELECT id, album_id, recording_id, meta FROM catalog_tracks WHERE id = ?').get(trackId) as
      | { id: number; album_id: number; recording_id: string; meta: string }
      | undefined;
    if (!t) return undefined;
    const a = this.sql('SELECT id, artist_id, meta FROM catalog_albums WHERE id = ?').get(t.album_id) as
      | { id: number; artist_id: number; meta: string }
      | undefined;
    const ar = a && (this.sql('SELECT id, meta FROM catalog_artists WHERE id = ?').get(a.artist_id) as { id: number; meta: string } | undefined);
    if (!a || !ar) return undefined;
    const copies = (
      this.sql('SELECT id, source_id, source_ref, path, size, format, added_at FROM copies WHERE track_id = ?')
        .all(trackId) as { id: number; source_id: number; source_ref: string; path: string; size: number; format: string; added_at: string | null }[]
    ).map((c) => ({
      id: c.id,
      sourceId: c.source_id,
      trackId,
      ref: c.source_ref,
      path: c.path,
      size: c.size,
      format: JSON.parse(c.format) as AudioFormat,
      ...(c.added_at ? { addedAt: c.added_at } : {}),
    }));
    return {
      track: { id: t.id, recordingId: t.recording_id, meta: JSON.parse(t.meta) as TrackInfo },
      album: { id: a.id, meta: JSON.parse(a.meta) as AlbumInfo },
      artist: { id: ar.id, meta: JSON.parse(ar.meta) as ArtistInfo },
      copies,
    };
  }

  /** One folder file's cached tags, and how it was matched. */
  folderFileDetails(sourceId: number, rel: string): { tags: TagInfo | null; match?: { state: string; score?: number } } | undefined {
    const file = this.sql('SELECT tags FROM folder_files WHERE source_id = ? AND rel_path = ?').get(sourceId, rel) as
      | { tags: string | null }
      | undefined;
    const match = this.sql('SELECT state, score FROM folder_matches WHERE source_id = ? AND rel_path = ?').get(sourceId, rel) as
      | { state: string; score: number | null }
      | undefined;
    if (!file && !match) return undefined;
    return {
      tags: file?.tags ? (JSON.parse(file.tags) as TagInfo) : null,
      ...(match ? { match: { state: match.state, ...(match.score !== null ? { score: match.score } : {}) } } : {}),
    };
  }

  /** Save newly read files and forget files that are no longer `present`. */
  saveFolderFiles(
    sourceId: number,
    changed: { rel: string; size: number; mtimeMs: number; tags: TagInfo | null }[],
    present: string[],
  ) {
    const keep = new Set(present);
    const gone = (this.sql('SELECT rel_path FROM folder_files WHERE source_id = ?').all(sourceId) as { rel_path: string }[])
      .map((r) => r.rel_path)
      .filter((rel) => !keep.has(rel));
    if (!changed.length && !gone.length) return;
    this.db.exec('BEGIN');
    try {
      const save = this.sql(
        `INSERT INTO folder_files (source_id, rel_path, size, mtime_ms, tags) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (source_id, rel_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, tags = excluded.tags`,
      );
      for (const f of changed) save.run(sourceId, f.rel, f.size, f.mtimeMs, f.tags ? JSON.stringify(f.tags) : null);
      const remove = this.sql('DELETE FROM folder_files WHERE source_id = ? AND rel_path = ?');
      for (const rel of gone) remove.run(sourceId, rel);
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
      a.key.startsWith('loose:')
        ? 9
        : a.meta.albumType === 'Album' && !a.meta.secondaryTypes.length
          ? 0
          : a.meta.albumType === 'EP'
            ? 1
            : a.meta.albumType === 'Single'
              ? 2
              : 3;
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

  /** A song got its real id: its favorites, playlist entries, analysis and plays follow it. */
  private moveRecording(from: string, to: string) {
    this.sql(
        `INSERT OR IGNORE INTO favorites (account_id, recording_id, track_id, title, artist_name, album_title, created_at)
         SELECT account_id, ?, track_id, title, artist_name, album_title, created_at FROM favorites WHERE recording_id = ?`,
      )
      .run(to, from);
    this.sql('DELETE FROM favorites WHERE recording_id = ?').run(from);
    this.sql('UPDATE playlist_items SET recording_id = ? WHERE recording_id = ?').run(to, from);
    this.sql(
        `INSERT OR IGNORE INTO track_features (recording_id, version, features, error, analyzed_at)
         SELECT ?, version, features, error, analyzed_at FROM track_features WHERE recording_id = ?`,
      )
      .run(to, from);
    this.sql('DELETE FROM track_features WHERE recording_id = ?').run(from);
    // Its listening history too, or a matched song would lose its plays to the mixes. (Its track id may
    // change with the match: the history keeps the recording, which is what the mixes go by.)
    this.sql('UPDATE OR IGNORE plays SET recording_id = ?, track_id = NULL WHERE recording_id = ?').run(to, from);
    this.sql('DELETE FROM plays WHERE recording_id = ?').run(from);
  }

  /** A folder source's match decisions, by path relative to the folder. */
  matches(sourceId: number): Map<string, MatchRecord> {
    const rows = this.sql(
        'SELECT rel_path, group_key, state, overlay, candidates, score, file_size, file_mtime FROM folder_matches WHERE source_id = ?',
      )
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
    const save = this.sql(
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
    this.matchesChanged(sourceId);
  }

  /** Forget the matches of these files, user decisions included (Show metadata → Match again). */
  forgetMatches(sourceId: number, rels: string[]) {
    const forget = this.sql('DELETE FROM folder_matches WHERE source_id = ? AND rel_path = ?');
    for (const rel of rels) forget.run(sourceId, rel);
    this.matchesChanged(sourceId);
  }

  /** Which source and song a file (copy) belongs to. */
  copy(fileId: number): { sourceId: number; ref: string; trackId: number } | undefined {
    const row = this.sql('SELECT source_id, source_ref, track_id FROM copies WHERE id = ?').get(fileId) as
      | { source_id: number; source_ref: string; track_id: number }
      | undefined;
    return row ? { sourceId: row.source_id, ref: row.source_ref, trackId: row.track_id } : undefined;
  }

  /** Forget automatic results (user decisions stay), so the source is matched again. */
  clearMatches(sourceId: number) {
    this.sql("DELETE FROM folder_matches WHERE source_id = ? AND state NOT IN ('manual', 'ignored')").run(sourceId);
    this.matchesChanged(sourceId);
  }

  /**
   * Songs per folder source: matched (on MusicBrainz, automatically or by the user's pick, named by the
   * user, or already identified by their tags), waiting for review (to choose a match, or found nowhere
   * on MusicBrainz), and left as their tags describe them. Counted from the files the folder has now,
   * a song once however many files it has, as sourceCounts counts them.
   */
  matchCounts(): Map<number, MatchCounts> {
    const rows = this.sql(
        `SELECT c.source_id AS id,
           COUNT(DISTINCT CASE
             WHEN m.state IN ('auto', 'manual') THEN c.track_id
             WHEN m.state IS NULL AND json_extract(f.tags, '$.recordingMbid') IS NOT NULL
               AND json_extract(f.tags, '$.releaseGroupMbid') IS NOT NULL THEN c.track_id
           END) AS matched,
           COUNT(DISTINCT CASE WHEN m.state IN ('review', 'unmatched') THEN c.track_id END) AS review,
           COUNT(DISTINCT CASE WHEN m.state = 'ignored' THEN c.track_id END) AS ignored
         FROM copies c
         JOIN sources s ON s.id = c.source_id AND s.kind = 'folder'
         LEFT JOIN folder_matches m ON m.source_id = c.source_id AND m.rel_path = c.source_ref
         LEFT JOIN folder_files f ON f.source_id = c.source_id AND f.rel_path = c.source_ref
         GROUP BY c.source_id`,
      )
      .all() as { id: number; matched: number; review: number; ignored: number }[];
    return new Map(rows.map(({ id, ...counts }) => [id, counts]));
  }

  cachedRelease(releaseId: string): MbReleaseInfo | undefined {
    const row = this.sql('SELECT data FROM mb_releases WHERE release_id = ?').get(releaseId) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as MbReleaseInfo) : undefined;
  }

  saveRelease(release: MbReleaseInfo) {
    this.sql('INSERT OR REPLACE INTO mb_releases (release_id, data, fetched_at) VALUES (?, ?, ?)')
      .run(release.id, JSON.stringify(release), new Date().toISOString());
    this.releaseGeneration++;
  }

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
      this.sql('UPDATE copies SET source_ref = ?, path = ? WHERE source_id = ? AND source_ref = ?')
        .run(toRel, toPath, sourceId, fromRel);
      this.sql('UPDATE folder_files SET rel_path = ? WHERE source_id = ? AND rel_path = ?')
        .run(toRel, sourceId, fromRel);
      this.sql('UPDATE folder_matches SET rel_path = ? WHERE source_id = ? AND rel_path = ?')
        .run(toRel, sourceId, fromRel);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.matchesChanged(sourceId);
    this.changed();
  }

  nextMoveBatch(): number {
    return (this.sql('SELECT COALESCE(MAX(batch), 0) + 1 AS next FROM file_moves').get() as { next: number }).next;
  }

  logMove(sourceId: number, batch: number, fromRel: string, toRel: string) {
    this.sql('INSERT INTO file_moves (batch, source_id, from_rel, to_rel, moved_at) VALUES (?, ?, ?, ?, ?)')
      .run(batch, sourceId, fromRel, toRel, new Date().toISOString());
  }

  /** A batch's moves not undone yet, in the order they happened. */
  movesOf(sourceId: number, batch: number): { id: number; from: string; to: string }[] {
    return this.sql(
        'SELECT id, from_rel AS "from", to_rel AS "to" FROM file_moves WHERE source_id = ? AND batch = ? AND undone_at IS NULL ORDER BY id',
      )
      .all(sourceId, batch) as { id: number; from: string; to: string }[];
  }

  markUndone(ids: number[]) {
    const now = new Date().toISOString();
    const mark = this.sql('UPDATE file_moves SET undone_at = ? WHERE id = ?');
    for (const id of ids) mark.run(now, id);
  }

  /** The newest batch with moves left to undo. */
  lastMoveBatch(sourceId: number): { id: number; files: number; at: string } | undefined {
    const row = this.sql(
        `SELECT batch AS id, COUNT(*) AS files, MAX(moved_at) AS at FROM file_moves
         WHERE source_id = ? AND undone_at IS NULL GROUP BY batch ORDER BY batch DESC LIMIT 1`,
      )
      .get(sourceId) as { id: number; files: number; at: string } | undefined;
    return row ?? undefined;
  }

  /**
   * The rows of a catalog table with these keys, as they are now: for a big sync the whole table in one read (with
   * every id taken, so ids are checked without asking), for a small one row by row.
   */
  private storedRows(table: CatalogTable, keys: string[], columns: string[]): StoredRows {
    const select = `SELECT id, key, meta_rank, meta${columns.map((c) => `, ${c}`).join('')} FROM ${table}`;
    if (keys.length >= READ_WHOLE_TABLE) {
      const rows = this.sql(select).all() as unknown as (StoredRow & { key: string })[];
      return { byKey: new Map(rows.map((r) => [r.key, r])), ids: new Set(rows.map((r) => r.id)) };
    }
    const one = this.sql(`${select} WHERE key = ?`);
    const byKey = new Map<string, StoredRow>();
    for (const key of keys) {
      const row = one.get(key) as unknown as StoredRow | undefined;
      if (row) byKey.set(key, row);
    }
    return { byKey };
  }

  /**
   * Insert or update a catalog row by key, writing only when it differs; returns its id. Metadata changes only if
   * `rank` is at least as trusted.
   */
  private upsert(
    table: CatalogTable,
    stored: StoredRows,
    key: string,
    preferredId: number | undefined,
    columns: Record<string, string | number>,
    meta: object,
    now: string,
    rank: number,
  ): { id: number; wrote: boolean } {
    const names = Object.keys(columns);
    const values = Object.values(columns);
    const json = JSON.stringify(meta);
    const existing = stored.byKey.get(key);
    if (existing) {
      if (rank > existing.meta_rank) return { id: existing.id, wrote: false };
      if (rank === existing.meta_rank && json === existing.meta && names.every((n) => existing[n] === columns[n])) {
        return { id: existing.id, wrote: false };
      }
      const sets = [...names.map((n) => `${n} = ?`), 'meta = ?', 'meta_rank = ?', 'updated_at = ?'].join(', ');
      this.sql(`UPDATE ${table} SET ${sets} WHERE id = ?`).run(...values, json, rank, now, existing.id);
      stored.byKey.set(key, { ...existing, ...columns, meta: json, meta_rank: rank });
      return { id: existing.id, wrote: true };
    }
    const cols = ['id', 'key', ...names, 'meta', 'meta_rank', 'updated_at'];
    const res = this.sql(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
      this.freeId(table, preferredId, stored.ids),
      key,
      ...values,
      json,
      rank,
      now,
    );
    const id = Number(res.lastInsertRowid);
    stored.byKey.set(key, { id, ...columns, meta: json, meta_rank: rank });
    stored.ids?.add(id);
    return { id, wrote: true };
  }

  /** Insert or update one of a source's files, writing only when it differs; returns its id and the date it's kept with. */
  private upsertCopy(
    sourceId: number,
    stored: Map<string, StoredCopy>,
    copy: SourceCopy,
    trackId: number,
    now: string,
    dating: CopyDating,
  ): { id: number; addedAt: string | null; wrote: boolean } {
    const own = isoDate(copy.addedAt);
    const existing = stored.get(copy.ref);
    // Folders: when Playarr first found the file (its own time only when it's the library's first music,
    // never ahead of now).
    // Lidarr: when Lidarr imported it.
    const addedAt =
      dating.mode === 'source'
        ? own
        : existing
          ? (existing.added_at ?? own ?? now)
          : dating.ownTimes && own && own < now
            ? own
            : now;
    const format = JSON.stringify(copy.format);
    if (existing) {
      if (
        existing.track_id === trackId &&
        existing.path === copy.path &&
        existing.size === copy.size &&
        existing.format === format &&
        existing.added_at === addedAt
      ) {
        return { id: existing.id, addedAt, wrote: false };
      }
      this.sql('UPDATE copies SET track_id = ?, path = ?, size = ?, format = ?, added_at = ?, updated_at = ? WHERE id = ?').run(
        trackId,
        copy.path,
        copy.size,
        format,
        addedAt,
        now,
        existing.id,
      );
      stored.set(copy.ref, { ...existing, track_id: trackId, path: copy.path, size: copy.size, format, added_at: addedAt });
      return { id: existing.id, addedAt, wrote: true };
    }
    const res = this.sql(
      `INSERT INTO copies (id, source_id, source_ref, track_id, path, size, format, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(this.freeId('copies', copy.preferredId), sourceId, copy.ref, trackId, copy.path, copy.size, format, addedAt, now);
    const id = Number(res.lastInsertRowid);
    stored.set(copy.ref, { id, source_ref: copy.ref, track_id: trackId, path: copy.path, size: copy.size, format, added_at: addedAt, recording_id: '' });
    return { id, addedAt, wrote: true };
  }

  /** The preferred id if no row has it, else null so AUTOINCREMENT picks one never used before. */
  private freeId(table: CatalogTable | 'copies', preferred: number | undefined, taken?: Set<number>): number | null {
    if (preferred === undefined) return null;
    if (taken) return taken.has(preferred) ? null : preferred;
    return this.sql(`SELECT 1 FROM ${table} WHERE id = ?`).get(preferred) ? null : preferred;
  }
}
