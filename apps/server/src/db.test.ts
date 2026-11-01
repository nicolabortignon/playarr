import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate, MIGRATION_COUNT } from './db.ts';

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
    migrate(db, MIGRATION_COUNT - 1);
    db.exec(`INSERT INTO plays (recording_id, played_at, hour, weekday, seconds) VALUES ('rec', '2026-01-01T00:00:00Z', 1, 1, 100)`);
    db.exec(`INSERT INTO mixes (key, period, data, generated_at) VALUES ('vibes', 'p', '{}', 'now')`);
    migrate(db);
    expect(db.prepare('SELECT id, name FROM profiles').all()).toEqual([{ id: 1, name: 'Home' }]);
    expect(db.prepare('SELECT profile_id FROM plays').get()).toEqual({ profile_id: 1 });
    expect(db.prepare('SELECT profile_id, key FROM mixes').get()).toEqual({ profile_id: 1, key: 'vibes' });
    // Another listener can play the same song at the same moment.
    expect(() =>
      db.exec(`INSERT INTO plays (recording_id, played_at, hour, weekday, seconds, profile_id) VALUES ('rec', '2026-01-01T00:00:00Z', 1, 1, 100, 2)`),
    ).not.toThrow();
  });
});
