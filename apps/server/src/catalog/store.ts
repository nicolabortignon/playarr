import type { AudioFormat } from '@playarr/shared';
import { relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
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

/** The catalog in SQLite: what each source reported, with permanent Playarr ids. */
export class CatalogStore {
  constructor(private readonly db: DatabaseSync) {}

  addSource(kind: SourceKind, name: string, settings: Record<string, unknown> = {}): number {
    const { next } = this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM sources').get() as {
      next: number;
    };
    const res = this.db
      .prepare('INSERT INTO sources (kind, name, position, settings, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(kind, name, next, JSON.stringify(settings), new Date().toISOString());
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
      this.db.prepare('DELETE FROM source_tracks WHERE source_id = ?').run(id);
      this.db.prepare('DELETE FROM folder_files WHERE source_id = ?').run(id);
      this.db.prepare('DELETE FROM folder_matches WHERE source_id = ?').run(id);
      this.db.prepare('DELETE FROM file_moves WHERE source_id = ?').run(id);
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

  /** Replace what this source has with `sync`, all or nothing. */
  applySync(sourceId: number, sync: SourceSync) {
    const now = new Date().toISOString();
    const rank = sync.metaRank ?? 0;
    this.db.exec('BEGIN');
    try {
      const artistIds = new Map<string, number>();
      for (const { key, preferredId, metaRank, ...meta } of sync.artists) {
        artistIds.set(key, this.upsert('catalog_artists', key, preferredId, {}, meta, now, metaRank ?? rank));
      }
      const albumIds = new Map<string, number>();
      for (const { key, preferredId, artistKey, metaRank, ...meta } of sync.albums) {
        const artistId = artistIds.get(artistKey);
        if (artistId === undefined) throw new Error(`Album ${key} refers to unknown artist ${artistKey}`);
        albumIds.set(
          key,
          this.upsert('catalog_albums', key, preferredId, { artist_id: artistId }, meta, now, metaRank ?? rank),
        );
      }
      const trackIds = new Map<string, number>();
      for (const { key, preferredId, albumKey, recordingId, metaRank, ...meta } of sync.tracks) {
        const albumId = albumIds.get(albumKey);
        if (albumId === undefined) throw new Error(`Track ${key} refers to unknown album ${albumKey}`);
        trackIds.set(
          key,
          this.upsert(
            'catalog_tracks',
            key,
            preferredId,
            { album_id: albumId, recording_id: recordingId },
            meta,
            now,
            metaRank ?? rank,
          ),
        );
      }
      // Which song each of this source's files belonged to, to follow songs whose id changes.
      const before = new Map(
        (
          this.db
            .prepare(
              'SELECT c.source_ref AS ref, t.recording_id AS rec FROM copies c JOIN catalog_tracks t ON t.id = c.track_id WHERE c.source_id = ?',
            )
            .all(sourceId) as { ref: string; rec: string }[]
        ).map((r) => [r.ref, r.rec]),
      );
      const recordingOf = new Map(sync.tracks.map((t) => [t.key, t.recordingId]));
      const moves = new Map<string, string>();
      const seen = new Set<number>();
      for (const copy of sync.copies) {
        const trackId = trackIds.get(copy.trackKey);
        if (trackId === undefined) throw new Error(`Copy ${copy.ref} refers to unknown track ${copy.trackKey}`);
        const was = before.get(copy.ref);
        const is = recordingOf.get(copy.trackKey);
        if (was && is && was !== is && was.startsWith('local:') && !is.startsWith('local:')) moves.set(was, is);
        seen.add(this.upsertCopy(sourceId, copy, trackId, now));
      }
      for (const [from, to] of moves) this.moveRecording(from, to);
      // The songs this source reports, including ones it has no file for (missing songs).
      this.db.prepare('DELETE FROM source_tracks WHERE source_id = ?').run(sourceId);
      const report = this.db.prepare('INSERT OR IGNORE INTO source_tracks (source_id, track_id) VALUES (?, ?)');
      for (const trackId of new Set(trackIds.values())) report.run(sourceId, trackId);
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
      sourceTracks: all<{ source_id: number; track_id: number }>('SELECT source_id, track_id FROM source_tracks').map(
        (r) => ({ sourceId: r.source_id, trackId: r.track_id }),
      ),
    };
  }

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

  /** A folder source's match decisions, by path relative to the folder. */
  matches(sourceId: number): Map<string, MatchRecord> {
    const rows = this.db
      .prepare(
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
      .prepare(
        "SELECT source_id AS id, COUNT(DISTINCT group_key) AS review FROM folder_matches WHERE state = 'review' GROUP BY source_id",
      )
      .all() as { id: number; review: number }[];
    return new Map(rows.map((r) => [r.id, { review: r.review }]));
  }

  cachedRelease(releaseId: string): MbReleaseInfo | undefined {
    const row = this.db.prepare('SELECT data FROM mb_releases WHERE release_id = ?').get(releaseId) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as MbReleaseInfo) : undefined;
  }

  saveRelease(release: MbReleaseInfo) {
    this.db
      .prepare('INSERT OR REPLACE INTO mb_releases (release_id, data, fetched_at) VALUES (?, ?, ?)')
      .run(release.id, JSON.stringify(release), new Date().toISOString());
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
      this.db
        .prepare('UPDATE copies SET source_ref = ?, path = ? WHERE source_id = ? AND source_ref = ?')
        .run(toRel, toPath, sourceId, fromRel);
      this.db
        .prepare('UPDATE folder_files SET rel_path = ? WHERE source_id = ? AND rel_path = ?')
        .run(toRel, sourceId, fromRel);
      this.db
        .prepare('UPDATE folder_matches SET rel_path = ? WHERE source_id = ? AND rel_path = ?')
        .run(toRel, sourceId, fromRel);
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

  /** A batch's moves not undone yet, in the order they happened. */
  movesOf(sourceId: number, batch: number): { id: number; from: string; to: string }[] {
    return this.db
      .prepare(
        'SELECT id, from_rel AS "from", to_rel AS "to" FROM file_moves WHERE source_id = ? AND batch = ? AND undone_at IS NULL ORDER BY id',
      )
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
