import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Ordered schema migrations; each runs once, tracked with SQLite's user_version. */
const MIGRATIONS = [
  `CREATE TABLE favorites (
     recording_id TEXT PRIMARY KEY,
     track_id     INTEGER,
     title        TEXT NOT NULL,
     artist_name  TEXT NOT NULL,
     album_title  TEXT NOT NULL,
     created_at   TEXT NOT NULL
   )`,
  `CREATE TABLE playlists (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     name        TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL
   );
   CREATE TABLE playlist_items (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     playlist_id  INTEGER NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
     position     INTEGER NOT NULL,
     recording_id TEXT NOT NULL,
     title        TEXT NOT NULL,
     artist_name  TEXT NOT NULL,
     album_title  TEXT NOT NULL,
     added_at     TEXT NOT NULL
   );
   CREATE INDEX playlist_items_by_position ON playlist_items (playlist_id, position);`,
  // What each song sounds like (measured from the audio) and how it's tagged (ListenBrainz).
  `CREATE TABLE track_features (
     recording_id TEXT PRIMARY KEY,
     version      INTEGER NOT NULL,
     features     TEXT,
     error        TEXT,
     analyzed_at  TEXT NOT NULL
   );
   CREATE TABLE track_meta (
     recording_id TEXT PRIMARY KEY,
     tags         TEXT NOT NULL,
     year         INTEGER,
     fetched_at   TEXT NOT NULL
   );`,
  // The cover a playlist was given: frozen until the user picks another (JSON CoverSnapshot).
  `ALTER TABLE playlists ADD COLUMN cover_snapshot TEXT;`,
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
  // Sources managed in Settings: the last sync error, and app-wide flags (e.g. ".env seeded").
  `ALTER TABLE sources ADD COLUMN last_error TEXT;
   CREATE TABLE app_settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
];

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
