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
