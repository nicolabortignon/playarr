import { describe, expect, it } from 'vitest';
import { albumKey, normalize } from '../library/search.ts';
import { songNameKey } from './keys.ts';
import { CatalogStore } from './store.ts';
import { freshDb, mezzanine } from './testFixtures.ts';

function setup() {
  const store = new CatalogStore(freshDb());
  const sourceId = store.ensureSource('lidarr', 'Lidarr');
  return { store, sourceId };
}

describe('CatalogStore', () => {
  it('creates one source per kind with ensureSource', () => {
    const { store, sourceId } = setup();
    expect(store.ensureSource('lidarr', 'Lidarr')).toBe(sourceId);
    expect(store.addSource('folder', 'Music')).not.toBe(sourceId);
    expect(store.load().sources.map((s) => [s.kind, s.position])).toEqual([
      ['lidarr', 0],
      ['folder', 1],
    ]);
  });

  it('uses the preferred ids on first sight', () => {
    const { store, sourceId } = setup();
    store.applySync(sourceId, mezzanine());
    const rows = store.load();
    expect(rows.artists.map((a) => a.id)).toEqual([7]);
    expect(rows.albums.map((a) => [a.id, a.artistId])).toEqual([[70, 7]]);
    expect(rows.tracks.map((t) => t.id).sort()).toEqual([700, 701]);
    expect(rows.copies.map((c) => [c.id, c.trackId]).sort()).toEqual([
      [9000, 700],
      [9001, 701],
    ]);
    expect(store.hasData()).toBe(true);
  });

  it('keeps ids when the source later reports different ones', () => {
    const { store, sourceId } = setup();
    store.applySync(sourceId, mezzanine());
    const resync = mezzanine();
    resync.albums[0]!.preferredId = 99; // e.g. the album was removed and re-added in Lidarr
    resync.albums[0]!.title = 'Mezzanine (Remastered)';
    store.applySync(sourceId, resync);
    const [album] = store.load().albums;
    expect(album!.id).toBe(70);
    expect(album!.meta.title).toBe('Mezzanine (Remastered)');
  });

  it('allocates a fresh id when the preferred one is taken', () => {
    const { store, sourceId } = setup();
    store.applySync(sourceId, mezzanine());
    const more = mezzanine();
    more.albums.push({ ...more.albums[0]!, key: 'mb:rg-9', mbid: 'rg-9', title: 'Heligoland', preferredId: 70 });
    store.applySync(sourceId, more);
    expect(store.load().albums.find((a) => a.key === 'mb:rg-9')!.id).toBe(71);
  });

  it('removes copies the source no longer has, but keeps the song row', () => {
    const { store, sourceId } = setup();
    store.applySync(sourceId, mezzanine());
    const fewer = mezzanine();
    fewer.copies = fewer.copies.slice(0, 1);
    store.applySync(sourceId, fewer);
    const rows = store.load();
    expect(rows.copies.map((c) => c.id)).toEqual([9000]);
    expect(rows.tracks).toHaveLength(2);
  });

  it('never reuses a copy id', () => {
    const { store, sourceId } = setup();
    store.applySync(sourceId, mezzanine());
    const fewer = mezzanine();
    fewer.copies = fewer.copies.slice(0, 1);
    store.applySync(sourceId, fewer);
    const added = mezzanine();
    added.copies = [added.copies[0]!, { ...added.copies[1]!, ref: 'new-file', preferredId: undefined }];
    store.applySync(sourceId, added);
    expect(store.load().copies.map((c) => c.id).sort()).toEqual([9000, 9002]);
  });

  it("stores Lidarr's album list on the source", () => {
    const { store, sourceId } = setup();
    store.applySync(sourceId, mezzanine());
    const [source] = store.load().sources;
    expect(source!.state.lidarrAlbums).toHaveLength(2);
    expect(source!.lastSyncAt).toBeTruthy();
  });

  it('applies nothing when a sync refers to something unknown', () => {
    const { store, sourceId } = setup();
    const broken = mezzanine();
    broken.copies.push({ ...broken.copies[0]!, ref: 'x', preferredId: undefined, trackKey: 'mb:nope#nope' });
    expect(() => store.applySync(sourceId, broken)).toThrow(/unknown track/);
    expect(store.hasData()).toBe(false);
    expect(store.load().artists).toEqual([]);
  });
});

describe('CatalogStore: managing sources', () => {
  it('lists sources with their settings and sync errors', () => {
    const store = new CatalogStore(freshDb());
    const id = store.addSource('lidarr', 'Lidarr', { url: 'http://lidarr:8686', apiKey: 'k' });
    store.setSyncError(id, 'Cannot reach Lidarr');
    expect(store.source(id)).toMatchObject({
      kind: 'lidarr',
      enabled: true,
      settings: { url: 'http://lidarr:8686', apiKey: 'k' },
      lastError: 'Cannot reach Lidarr',
    });
    store.setSyncError(id, null);
    expect(store.source(id)!.lastError).toBeUndefined();
  });

  it('updates name, enabled and settings', () => {
    const store = new CatalogStore(freshDb());
    const id = store.addSource('lidarr', 'Lidarr');
    store.updateSource(id, { name: 'Home', enabled: false, settings: { url: 'http://nas:8686' } });
    expect(store.source(id)).toMatchObject({ name: 'Home', enabled: false, settings: { url: 'http://nas:8686' } });
  });

  it('removes a source with its copies, keeping catalog rows', () => {
    const store = new CatalogStore(freshDb());
    const id = store.ensureSource('lidarr', 'Lidarr');
    store.applySync(id, mezzanine());
    store.removeSource(id);
    const rows = store.load();
    expect(rows.sources).toEqual([]);
    expect(rows.copies).toEqual([]);
    expect(rows.tracks).toHaveLength(2);
  });

  it('reorders sources and rejects an incomplete order', () => {
    const store = new CatalogStore(freshDb());
    const a = store.addSource('lidarr', 'A');
    const b = store.addSource('folder', 'B');
    store.reorderSources([b, a]);
    expect(store.listSources().map((s) => s.id)).toEqual([b, a]);
    expect(() => store.reorderSources([a])).toThrow(/every source/);
  });

  it('counts the songs and albums each source has', () => {
    const store = new CatalogStore(freshDb());
    const id = store.ensureSource('lidarr', 'Lidarr');
    store.applySync(id, mezzanine());
    expect(store.sourceCounts().get(id)).toEqual({ songs: 2, albums: 1 });
  });

  it('keeps app settings', () => {
    const store = new CatalogStore(freshDb());
    expect(store.appSetting('x')).toBeUndefined();
    store.setAppSetting('x', '1');
    store.setAppSetting('x', '2');
    expect(store.appSetting('x')).toBe('2');
  });
});

describe('CatalogStore: several sources', () => {
  function folderSyncOf(title: string) {
    const s = mezzanine();
    s.metaRank = 2;
    s.albums[0]!.title = title;
    s.copies = s.copies.map((c) => ({ ...c, ref: `folder/${c.ref}`, preferredId: undefined }));
    return s;
  }

  it('keeps the most trusted metadata', () => {
    const store = new CatalogStore(freshDb());
    const lidarr = store.addSource('lidarr', 'Lidarr');
    const folder = store.addSource('folder', 'Music');
    store.applySync(lidarr, mezzanine());
    store.applySync(folder, folderSyncOf('mezzanine (rip)'));
    expect(store.load().albums[0]!.meta.title).toBe('Mezzanine');
    // The other way round: Lidarr arriving later takes over.
    const store2 = new CatalogStore(freshDb());
    const l2 = store2.addSource('lidarr', 'Lidarr');
    const f2 = store2.addSource('folder', 'Music');
    store2.applySync(f2, folderSyncOf('mezzanine (rip)'));
    store2.applySync(l2, mezzanine());
    expect(store2.load().albums[0]!.meta.title).toBe('Mezzanine');
  });

  it('records the songs each source reported, with or without files', () => {
    const store = new CatalogStore(freshDb());
    const id = store.addSource('lidarr', 'Lidarr');
    const sync = mezzanine();
    sync.tracks.push({ ...sync.tracks[0]!, key: 'mb:rg-1#rec-3', preferredId: 702, recordingId: 'rec-3', title: 'Teardrop', trackNumber: 3 });
    store.applySync(id, sync);
    expect(store.load().sourceTracks.map((s) => s.trackId).sort()).toEqual([700, 701, 702]);
    store.applySync(id, mezzanine());
    expect(store.load().sourceTracks.map((s) => s.trackId).sort()).toEqual([700, 701]);
  });

  it('caches folder files and forgets the ones that are gone', () => {
    const store = new CatalogStore(freshDb());
    const id = store.addSource('folder', 'Music');
    const tags = { genres: [], duration: 200, format: { codec: 'FLAC', container: 'flac', lossless: true } };
    store.saveFolderFiles(id, [
      { rel: 'a.flac', size: 1, mtimeMs: 10, tags },
      { rel: 'b.mp3', size: 2, mtimeMs: 20, tags: null },
    ], ['a.flac', 'b.mp3']);
    expect(store.folderFiles(id).get('a.flac')).toEqual({ size: 1, mtimeMs: 10, tags });
    expect(store.folderFiles(id).get('b.mp3')!.tags).toBeNull();
    store.saveFolderFiles(id, [], ['a.flac']);
    expect([...store.folderFiles(id).keys()]).toEqual(['a.flac']);
    store.removeSource(id);
    expect(store.folderFiles(id).size).toBe(0);
  });

  it('indexes the catalog by name, preferring MusicBrainz rows', () => {
    const store = new CatalogStore(freshDb());
    const folder = store.addSource('folder', 'Music');
    const lidarr = store.addSource('lidarr', 'Lidarr');
    // A folder album under name keys first, then the same album from Lidarr under MusicBrainz keys.
    const named = mezzanine();
    named.metaRank = 2;
    named.artists[0] = { ...named.artists[0]!, key: 'name:massive attack', mbid: undefined, preferredId: undefined };
    named.albums[0] = { ...named.albums[0]!, key: 'name:x', artistKey: 'name:massive attack', mbid: undefined, preferredId: undefined };
    named.tracks = named.tracks.map((t) => ({ ...t, key: `name:x#${t.recordingId}`, albumKey: 'name:x', preferredId: undefined }));
    named.copies = named.copies.map((c) => ({ ...c, trackKey: `name:x#${c.trackKey.split('#')[1]}`, preferredId: undefined }));
    store.applySync(folder, named);
    store.applySync(lidarr, mezzanine());

    const index = store.nameIndex();
    expect(index.artists.get(normalize('Massive Attack'))!.key).toBe('mb:art-1');
    expect(index.albums.get(albumKey('Massive Attack', 'Mezzanine'))!.key).toBe('mb:rg-1');
    expect(index.tracks.get(`mb:rg-1|${normalize('Angel')}`)).toMatchObject({ key: 'mb:rg-1#rec-1', recordingId: 'rec-1' });
    expect(index.songs.get(songNameKey('Massive Attack', 'Angel'))).toMatchObject({ albumKey: 'mb:rg-1', albumTitle: 'Mezzanine' });
  });
});

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
