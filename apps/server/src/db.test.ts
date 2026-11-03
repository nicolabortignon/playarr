import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from './db.ts';

/** How many migrations ran before the one adding listener profiles. */
const PROFILES_MIGRATION = 15;
/** How many migrations ran before the one turning profiles into accounts. */
const ACCOUNTS_MIGRATION = 18;
/** How many migrations ran before the one re-dating folders added to a library that already had music. */
const LATE_FOLDERS_MIGRATION = 19;
/** How many migrations ran before the one moving albums a later folder added songs to to the front. */
const BUMP_ALBUMS_MIGRATION = 20;

describe('migrate', () => {
  it('creates the catalog tables', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (t) => t.name,
    );
    expect(tables).toEqual(
      expect.arrayContaining(['sources', 'catalog_artists', 'catalog_albums', 'catalog_tracks', 'copies']),
    );
  });

  it('is idempotent', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });

  it('adds sync errors to sources and an app settings table', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const columns = (db.prepare('PRAGMA table_info(sources)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain('last_error');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'app_settings'").get()).toBeTruthy();
  });

  it('adds metadata trust, reported songs and the folder file cache', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    for (const t of ['catalog_artists', 'catalog_albums', 'catalog_tracks']) expect(cols(t)).toContain('meta_rank');
    expect(cols('source_tracks')).toEqual(['source_id', 'track_id']);
    expect(cols('folder_files')).toEqual(['source_id', 'rel_path', 'size', 'mtime_ms', 'tags']);
  });

  it('adds folder matches and the release cache', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('folder_matches')).toEqual([
      'source_id', 'rel_path', 'group_key', 'state', 'overlay', 'candidates', 'score', 'file_size', 'file_mtime', 'updated_at',
    ]);
    expect(cols('mb_releases')).toEqual(['release_id', 'data', 'fetched_at']);
  });

  it('adds the file move journal', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const cols = (db.prepare('PRAGMA table_info(file_moves)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['id', 'batch', 'source_id', 'from_rel', 'to_rel', 'moved_at', 'undone_at']);
  });

  it('gives the history and mixes so far to the first listener profile', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, PROFILES_MIGRATION);
    db.exec(`INSERT INTO plays (recording_id, played_at, hour, weekday, seconds) VALUES ('rec', '2026-01-01T00:00:00Z', 1, 1, 100)`);
    db.exec(`INSERT INTO mixes (key, period, data, generated_at) VALUES ('vibes', 'p', '{}', 'now')`);
    migrate(db, PROFILES_MIGRATION + 1);
    expect(db.prepare('SELECT id, name FROM profiles').all()).toEqual([{ id: 1, name: 'Home' }]);
    expect(db.prepare('SELECT profile_id FROM plays').get()).toEqual({ profile_id: 1 });
    expect(db.prepare('SELECT profile_id, key FROM mixes').get()).toEqual({ profile_id: 1, key: 'vibes' });
    // Another listener can play the same song at the same moment.
    expect(() =>
      db.exec(`INSERT INTO plays (recording_id, played_at, hour, weekday, seconds, profile_id) VALUES ('rec', '2026-01-01T00:00:00Z', 1, 1, 100, 2)`),
    ).not.toThrow();
  });

  it('adds mix maps and cue points, both kept by recording', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    // [name, part of the primary key, required]
    const cols = (t: string) =>
      (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; pk: number; notnull: number }[]).map((c) => [
        c.name,
        c.pk > 0,
        c.notnull === 1,
      ]);
    expect(cols('mix_maps')).toEqual([
      ['recording_id', true, false],
      ['version', false, true],
      ['data', false, false],
      ['error', false, false],
      ['analyzed_at', false, true],
    ]);
    expect(cols('cue_points')).toEqual([
      ['recording_id', true, false],
      ['mix_in', false, false],
      ['mix_out', false, false],
      ['updated_at', false, true],
    ]);
  });

  it('turns profiles into accounts, keeping ids, history, mixes and ListenBrainz links', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, ACCOUNTS_MIGRATION);
    db.exec(`INSERT INTO profiles (id, name, created_at) VALUES (2, 'Zoë B.', 'now'), (3, 'home', 'now')`);
    db.exec(`INSERT INTO plays (recording_id, played_at, hour, weekday, seconds, profile_id) VALUES ('rec', '2026-01-01T00:00:00Z', 1, 1, 100, 2)`);
    db.exec(`INSERT INTO mixes (profile_id, key, period, data, generated_at) VALUES (2, 'vibes', 'p', '{}', 'now')`);
    db.exec(`INSERT INTO app_settings (key, value) VALUES ('listenbrainz:2', '{"enabled":true}')`);
    db.exec(`INSERT INTO favorites (recording_id, title, artist_name, album_title, created_at) VALUES ('rec', 'Angel', 'Massive Attack', 'Mezzanine', 'now')`);
    db.exec(`INSERT INTO playlists (name, created_at, updated_at) VALUES ('Road trip', 'now', 'now')`);
    migrate(db);
    expect(db.prepare('SELECT id, username, name, role, can_request, all_sources, password_hash FROM accounts ORDER BY id').all()).toEqual([
      { id: 1, username: 'home', name: 'Home', role: 'admin', can_request: 1, all_sources: 1, password_hash: null },
      { id: 2, username: 'zoe-b', name: 'Zoë B.', role: 'member', can_request: 1, all_sources: 1, password_hash: null },
      { id: 3, username: 'home-2', name: 'home', role: 'member', can_request: 1, all_sources: 1, password_hash: null },
    ]);
    expect(db.prepare('SELECT account_id FROM plays').get()).toEqual({ account_id: 2 });
    expect(db.prepare('SELECT account_id, key FROM mixes').get()).toEqual({ account_id: 2, key: 'vibes' });
    expect(db.prepare(`SELECT value FROM app_settings WHERE key = 'listenbrainz:2'`).get()).toEqual({ value: '{"enabled":true}' });
    // Favorites so far are the owner's; playlists so far stay visible to everyone.
    expect(db.prepare('SELECT account_id, recording_id FROM favorites').all()).toEqual([{ account_id: 1, recording_id: 'rec' }]);
    expect(db.prepare('SELECT account_id, shared FROM playlists').all()).toEqual([{ account_id: 1, shared: 1 }]);
    // Two accounts can favorite the same song; a username is taken once.
    expect(() =>
      db.exec(`INSERT INTO favorites (account_id, recording_id, title, artist_name, album_title, created_at) VALUES (2, 'rec', 'Angel', 'Massive Attack', 'Mezzanine', 'now')`),
    ).not.toThrow();
    expect(() => db.exec(`UPDATE accounts SET username = 'home' WHERE id = 2`)).toThrow();
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('sessions')).toEqual(['id', 'account_id', 'token_hash', 'device', 'platform', 'created_at', 'last_seen_at']);
    expect(cols('setup_codes')).toEqual(['code_hash', 'account_id', 'expires_at', 'created_at']);
    expect(cols('account_sources')).toEqual(['account_id', 'source_id']);
  });

  it('re-dates a folder added to a library that already had music by when it was added, and its new albums', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, LATE_FOLDERS_MIGRATION);
    db.exec(`
      INSERT INTO sources (id, kind, name, position, created_at) VALUES
        (1, 'folder', 'Music', 0, '2026-10-01T09:00:00.000Z'),
        (2, 'lidarr', 'Lidarr', 1, '2026-10-01T09:05:00.000Z'),
        (3, 'folder', '00s Hits', 2, '2026-11-03T18:00:00.000Z');
      INSERT INTO catalog_artists (id, key, meta, updated_at) VALUES (1, 'a', '{}', 'now');
      INSERT INTO catalog_albums (id, key, artist_id, meta, updated_at, added_at) VALUES
        (1, 'old', 1, '{}', 'now', '2020-01-01T00:00:00.000Z'),
        (2, 'lidarr', 1, '{}', 'now', '2026-10-02T00:00:00.000Z'),
        (3, 'hits', 1, '{}', 'now', '2026-10-29T17:25:00.000Z');
      INSERT INTO catalog_tracks (id, key, album_id, recording_id, meta, updated_at) VALUES
        (1, 't1', 1, 'r1', '{}', 'now'), (2, 't2', 2, 'r2', '{}', 'now'), (3, 't3', 2, 'r3', '{}', 'now'), (4, 't4', 3, 'r4', '{}', 'now');
      INSERT INTO copies (source_id, source_ref, track_id, path, size, format, added_at, updated_at) VALUES
        (1, 'old.flac', 1, '/m/old.flac', 1, '{}', '2020-01-01T00:00:00.000Z', 'now'),
        (2, '9000', 2, '/l/a.flac', 1, '{}', '2026-10-02T00:00:00.000Z', 'now'),
        (3, 'hits/a.flac', 3, '/h/a.flac', 1, '{}', '2026-10-29T17:25:00.000Z', 'now'),
        (3, 'hits/b.flac', 4, '/h/b.flac', 1, '{}', '2026-10-29T17:25:00.000Z', 'now'),
        (3, 'hits/c.flac', 4, '/h/c.flac', 1, '{}', '2026-11-03T19:00:00.000Z', 'now');
    `);
    migrate(db, BUMP_ALBUMS_MIGRATION);
    const copies = db.prepare('SELECT source_ref, added_at FROM copies ORDER BY id').all();
    expect(copies).toEqual([
      // The library's first music keeps its files' own times; Lidarr's dates are Lidarr's.
      { source_ref: 'old.flac', added_at: '2020-01-01T00:00:00.000Z' },
      { source_ref: '9000', added_at: '2026-10-02T00:00:00.000Z' },
      // The folder added later: new to the library when it was added; files found later keep their date.
      { source_ref: 'hits/a.flac', added_at: '2026-11-03T18:00:00.000Z' },
      { source_ref: 'hits/b.flac', added_at: '2026-11-03T18:00:00.000Z' },
      { source_ref: 'hits/c.flac', added_at: '2026-11-03T19:00:00.000Z' },
    ]);
    // An album only the late folder has is new; one Lidarr already had keeps its date.
    expect(db.prepare('SELECT id, added_at FROM catalog_albums ORDER BY id').all()).toEqual([
      { id: 1, added_at: '2020-01-01T00:00:00.000Z' },
      { id: 2, added_at: '2026-10-02T00:00:00.000Z' },
      { id: 3, added_at: '2026-11-03T18:00:00.000Z' },
    ]);
  });

  it('moves the albums a folder added later has songs on to when it was added, Lidarr’s included', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, BUMP_ALBUMS_MIGRATION);
    db.exec(`
      INSERT INTO sources (id, kind, name, position, created_at) VALUES
        (1, 'folder', 'Music', 0, '2026-10-01T09:00:00.000Z'),
        (2, 'lidarr', 'Lidarr', 1, '2026-10-01T09:05:00.000Z'),
        (3, 'folder', '00s Hits', 2, '2026-11-03T18:00:00.000Z');
      INSERT INTO catalog_artists (id, key, meta, updated_at) VALUES (1, 'a', '{}', 'now');
      INSERT INTO catalog_albums (id, key, artist_id, meta, updated_at, added_at) VALUES
        (1, 'old', 1, '{}', 'now', '2020-01-01T00:00:00.000Z'),
        (2, 'parachutes', 1, '{}', 'now', '2025-05-01T00:00:00.000Z'),
        (3, 'loose', 1, '{}', 'now', '2026-11-03T18:00:00.000Z');
      INSERT INTO catalog_tracks (id, key, album_id, recording_id, meta, updated_at) VALUES
        (1, 't1', 1, 'r1', '{}', 'now'), (2, 't2', 2, 'r2', '{}', 'now'), (3, 't3', 2, 'r3', '{}', 'now'), (4, 't4', 3, 'r4', '{}', 'now');
      INSERT INTO copies (source_id, source_ref, track_id, path, size, format, added_at, updated_at) VALUES
        (1, 'old.flac', 1, '/m/old.flac', 1, '{}', '2020-01-01T00:00:00.000Z', 'now'),
        (2, '9000', 2, '/l/a.flac', 1, '{}', '2025-05-01T00:00:00.000Z', 'now'),
        (3, 'hits/yellow.mp3', 3, '/h/yellow.mp3', 1, '{}', '2026-11-03T18:00:00.000Z', 'now'),
        (3, 'hits/b.mp3', 4, '/h/b.mp3', 1, '{}', '2026-11-03T18:00:00.000Z', 'now');
    `);
    migrate(db);
    expect(db.prepare('SELECT id, added_at FROM catalog_albums ORDER BY id').all()).toEqual([
      { id: 1, added_at: '2020-01-01T00:00:00.000Z' },
      // Lidarr's Parachutes got Yellow from 00s Hits.
      { id: 2, added_at: '2026-11-03T18:00:00.000Z' },
      { id: 3, added_at: '2026-11-03T18:00:00.000Z' },
    ]);
  });
});
