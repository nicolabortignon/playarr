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
];

export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'playarr.db'));
  db.exec('PRAGMA journal_mode = WAL');
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[i]!);
    db.exec(`PRAGMA user_version = ${i + 1}`);
    db.exec('COMMIT');
  }
  return db;
}
