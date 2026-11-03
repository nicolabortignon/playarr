import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { usernameFrom } from './accounts/username.ts';

/** SQL, or a function for the steps SQL can't do alone. */
type Migration = string | ((db: DatabaseSync) => void);

/** Ordered schema migrations; each runs once, tracked with SQLite's user_version. */
const MIGRATIONS: Migration[] = [
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
  // When each album first entered the library (the earliest date of any of its copies, ever).
  `ALTER TABLE catalog_albums ADD COLUMN added_at TEXT;`,
  // Re-date folder files by when they arrived on disk (birth time) rather than their modification time,
  // which copies keep from wherever they came from; albums recompute from their copies on the next sync.
  `UPDATE copies SET added_at = NULL WHERE source_id IN (SELECT id FROM sources WHERE kind = 'folder');
   UPDATE catalog_albums SET added_at = NULL;`,
  // Listening history (what the generated mixes learn from) and the mixes as last generated.
  `CREATE TABLE plays (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     recording_id TEXT NOT NULL,
     track_id     INTEGER,
     artist_id    INTEGER,
     album_id     INTEGER,
     played_at    TEXT NOT NULL,
     hour         INTEGER NOT NULL,
     weekday      INTEGER NOT NULL,
     seconds      INTEGER NOT NULL,
     skipped      INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX plays_by_time ON plays (played_at);
   CREATE INDEX plays_by_recording ON plays (recording_id);
   CREATE TABLE mixes (
     key          TEXT PRIMARY KEY,
     period       TEXT NOT NULL,
     variant      INTEGER NOT NULL DEFAULT 0,
     data         TEXT NOT NULL,
     generated_at TEXT NOT NULL
   );`,
  // A report can arrive twice (sent as the app closed, then again on the next launch): one play per
  // song per start time.
  `DELETE FROM plays WHERE id NOT IN (SELECT MIN(id) FROM plays GROUP BY recording_id, played_at);
   CREATE UNIQUE INDEX plays_unique ON plays (recording_id, played_at);`,
  // Sending plays to ListenBrainz: NULL waiting, 1 sent, 2 not to be sent (too short, or unknown).
  `ALTER TABLE plays ADD COLUMN listenbrainz INTEGER;`,
  // Lyrics found for each song (or that none were found), from its file or LRCLIB.
  `CREATE TABLE lyrics (
     recording_id TEXT PRIMARY KEY,
     data         TEXT,
     fetched_at   TEXT NOT NULL
   );`,
  // Listener profiles: each has their own history, mixes and stats. The history so far is the first one's.
  `CREATE TABLE profiles (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     name       TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   INSERT INTO profiles (id, name, created_at) VALUES (1, 'Home', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
   ALTER TABLE plays ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1;
   DROP INDEX plays_unique;
   CREATE UNIQUE INDEX plays_unique ON plays (profile_id, recording_id, played_at);
   CREATE INDEX plays_by_profile ON plays (profile_id, played_at);
   CREATE TABLE mixes_by_profile (
     profile_id   INTEGER NOT NULL DEFAULT 1,
     key          TEXT NOT NULL,
     period       TEXT NOT NULL,
     variant      INTEGER NOT NULL DEFAULT 0,
     data         TEXT NOT NULL,
     generated_at TEXT NOT NULL,
     PRIMARY KEY (profile_id, key)
   );
   INSERT INTO mixes_by_profile (profile_id, key, period, variant, data, generated_at) SELECT 1, key, period, variant, data, generated_at FROM mixes;
   DROP TABLE mixes;
   ALTER TABLE mixes_by_profile RENAME TO mixes;`,
  // Each song's mix map (beat grid, key, intro and outro: JSON MixMap) for beatmatched transitions,
  // and the mix points set by hand. Cue points are kept by recording, not file, so they survive the
  // song being matched again or replaced by a better copy.
  `CREATE TABLE mix_maps (
     recording_id TEXT PRIMARY KEY,
     version      INTEGER NOT NULL,
     data         TEXT,
     error        TEXT,
     analyzed_at  TEXT NOT NULL
   );
   CREATE TABLE cue_points (
     recording_id TEXT PRIMARY KEY,
     mix_in       REAL,
     mix_out      REAL,
     updated_at   TEXT NOT NULL
   );`,
  // Each song's loudness (EBU R128, LUFS) and peak, for even volume, with the file it was measured from
  // (its size and time tell when it changed) and the exact length it decodes to (the levelled stream's).
  `CREATE TABLE track_loudness (
     recording_id TEXT PRIMARY KEY,
     file_id      INTEGER NOT NULL,
     version      INTEGER NOT NULL,
     lufs         REAL,
     peak         REAL,
     samples      INTEGER,
     size         INTEGER,
     mtime_ms     REAL,
     error        TEXT,
     analyzed_at  TEXT NOT NULL
   );
   CREATE INDEX track_loudness_by_file ON track_loudness (file_id);`,
  // Accounts replace listener profiles, keeping their ids (plays, mixes and ListenBrainz links stay
  // theirs). See accountsMigration.
  accountsMigration,
  // A folder added to a library that already had music was dated by its files' times; date it by when it
  // was added, as new folders now are. See lateFoldersMigration.
  lateFoldersMigration,
];

export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'playarr.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** Run the migrations this database hasn't had yet (up to `upTo`, for tests of a migration). */
export function migrate(db: DatabaseSync, upTo = MIGRATIONS.length) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let i = version; i < upTo; i++) {
    const step = MIGRATIONS[i]!;
    db.exec('BEGIN');
    try {
      if (typeof step === 'string') db.exec(step);
      else step(db);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * Profiles become accounts: a username from each profile's name, a password once set up, a role (the
 * first profile is the owner, an admin), the right to request albums, and which sources it may hear
 * (all, or those in account_sources). Favorites and playlists get an owner: the owner has the favorites
 * so far, and the playlists so far stay visible to everyone by being shared. Sessions (tokens stored as
 * SHA-256) and setup codes get tables of their own.
 */
function accountsMigration(db: DatabaseSync) {
  db.exec(`
    ALTER TABLE profiles RENAME TO accounts;
    ALTER TABLE accounts ADD COLUMN username TEXT;
    ALTER TABLE accounts ADD COLUMN password_hash TEXT;
    ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
    ALTER TABLE accounts ADD COLUMN can_request INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE accounts ADD COLUMN all_sources INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE plays RENAME COLUMN profile_id TO account_id;
    ALTER TABLE mixes RENAME COLUMN profile_id TO account_id;
    DROP INDEX plays_by_profile;
    CREATE INDEX plays_by_account ON plays (account_id, played_at);
  `);
  // Every install has had a profile since they were added; a database without one gets the owner back.
  if (!db.prepare('SELECT 1 FROM accounts').get()) {
    db.prepare(`INSERT INTO accounts (id, name, created_at) VALUES (1, 'Home', ?)`).run(new Date().toISOString());
  }
  const rows = db.prepare('SELECT id, name FROM accounts ORDER BY id').all() as { id: number; name: string }[];
  const taken = new Set<string>();
  const setUsername = db.prepare('UPDATE accounts SET username = ? WHERE id = ?');
  for (const { id, name } of rows) {
    const username = usernameFrom(name, taken);
    taken.add(username);
    setUsername.run(username, id);
  }
  const owner = rows[0]!.id;
  db.prepare(`UPDATE accounts SET role = 'admin' WHERE id = ?`).run(owner);
  db.exec(`
    CREATE UNIQUE INDEX accounts_by_username ON accounts (username);
    CREATE TABLE favorites_by_account (
      account_id   INTEGER NOT NULL,
      recording_id TEXT NOT NULL,
      track_id     INTEGER,
      title        TEXT NOT NULL,
      artist_name  TEXT NOT NULL,
      album_title  TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      PRIMARY KEY (account_id, recording_id)
    );
  `);
  db.prepare(
    `INSERT INTO favorites_by_account (account_id, recording_id, track_id, title, artist_name, album_title, created_at)
     SELECT ?, recording_id, track_id, title, artist_name, album_title, created_at FROM favorites`,
  ).run(owner);
  db.exec(`
    DROP TABLE favorites;
    ALTER TABLE favorites_by_account RENAME TO favorites;
    ALTER TABLE playlists ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE playlists ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE account_sources (
      account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      source_id  INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
      PRIMARY KEY (account_id, source_id)
    );
    CREATE TABLE sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id   INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      token_hash   TEXT NOT NULL UNIQUE,
      device       TEXT NOT NULL,
      platform     TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE INDEX sessions_by_account ON sessions (account_id);
    CREATE TABLE setup_codes (
      code_hash  TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare('UPDATE playlists SET account_id = ?, shared = 1').run(owner);
}

/**
 * Files of a folder added after another source already had music are dated by when the folder was added,
 * not by when they arrived on disk (only the library's first music keeps its files' own times). Albums
 * holding those files are re-dated from their copies, so one only that folder has shows as new, while one
 * another source already had keeps its date.
 */
function lateFoldersMigration(db: DatabaseSync) {
  const late = db
    .prepare(
      `SELECT c.id, c.track_id AS trackId, s.created_at AS createdAt
       FROM copies c JOIN sources s ON s.id = c.source_id
       WHERE s.kind = 'folder' AND c.added_at < s.created_at
         AND EXISTS (
           SELECT 1 FROM sources o JOIN copies oc ON oc.source_id = o.id WHERE o.id <> s.id AND o.created_at < s.created_at
         )`,
    )
    .all() as { id: number; trackId: number; createdAt: string }[];
  const redate = db.prepare('UPDATE copies SET added_at = ? WHERE id = ?');
  for (const c of late) redate.run(c.createdAt, c.id);
  const albumOf = db.prepare('SELECT album_id AS id FROM catalog_tracks WHERE id = ?');
  const albumIds = new Set(late.map((c) => (albumOf.get(c.trackId) as { id: number }).id));
  const recompute = db.prepare(
    `UPDATE catalog_albums SET added_at = (
       SELECT MIN(c.added_at) FROM copies c JOIN catalog_tracks t ON t.id = c.track_id WHERE t.album_id = catalog_albums.id
     ) WHERE id = ?`,
  );
  for (const id of albumIds) recompute.run(id);
}
