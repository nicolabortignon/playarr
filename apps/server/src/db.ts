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
];

export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'playarr.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[i]!);
    db.exec(`PRAGMA user_version = ${i + 1}`);
    db.exec('COMMIT');
  }
  return db;
}
