import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalFolderFs, type FolderFs } from './folderFs.ts';
import { FolderSource } from './folderSource.ts';
import { CatalogStore } from './store.ts';
import { readTags } from './tags.ts';
import { FLAC, flacBytes, freshDb, tempDir } from './testFixtures.ts';

let cleanup = () => {};
afterEach(() => cleanup());

function setup() {
  const t = tempDir();
  cleanup = t.cleanup;
  const put = (rel: string, bytes: Buffer) => {
    mkdirSync(dirname(join(t.dir, rel)), { recursive: true });
    writeFileSync(join(t.dir, rel), bytes);
  };
  put('Massive Attack/Mezzanine/01 Angel.flac', flacBytes({ TITLE: 'Angel', ALBUM: 'Mezzanine', ALBUMARTIST: 'Massive Attack' }));
  put('Burial/Archangel.flac', flacBytes());
  put('.hidden/secret.flac', flacBytes());
  put('notes.txt', Buffer.from('hello'));
  put('broken.mp3', Buffer.from('not audio'));
  const store = new CatalogStore(freshDb());
  const sourceId = store.addSource('folder', 'Music', { path: t.dir });
  const read = vi.fn((path: string) => readTags(path));
  const source = new FolderSource({ sourceId, root: t.dir, store, fs: new LocalFolderFs(), readTags: read });
  return { dir: t.dir, put, store, sourceId, read, source };
}

describe('FolderSource', () => {
  it('finds audio files, skipping hidden ones, other files and unreadable audio', async () => {
    const { source, read } = setup();
    const sync = await source.sync();
    expect(sync.copies.map((c) => c.ref)).toEqual(['Burial/Archangel.flac', 'Massive Attack/Mezzanine/01 Angel.flac']);
    expect(read).toHaveBeenCalledTimes(3); // the two FLACs and broken.mp3
  });

  it('only reads files that changed since the last scan', async () => {
    const { source, read, dir } = setup();
    await source.sync();
    read.mockClear();
    await source.sync();
    expect(read).not.toHaveBeenCalled();
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, 'Burial/Archangel.flac'), later, later);
    await source.sync();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('forgets files that were deleted', async () => {
    const { source, dir, store, sourceId } = setup();
    await source.sync();
    rmSync(join(dir, 'Burial/Archangel.flac'));
    const sync = await source.sync();
    expect(sync.copies.map((c) => c.ref)).toEqual(['Massive Attack/Mezzanine/01 Angel.flac']);
    expect(store.folderFiles(sourceId).has('Burial/Archangel.flac')).toBe(false);
  });

  it('fails when the folder is gone, so the last scan stays in the catalog', async () => {
    const { store, sourceId } = setup();
    const source = new FolderSource({ sourceId, root: '/nonexistent/playarr', store, fs: new LocalFolderFs() });
    await expect(source.sync()).rejects.toThrow(/Folder not found/);
  });

  it('lays matches over tags and tells the matcher a scan happened', async () => {
    const { store, sourceId, dir } = setup();
    store.saveRelease({
      id: 'rel-1',
      title: 'Mezzanine',
      artistName: 'Massive Attack',
      artistId: 'art-1',
      releaseGroup: { id: 'rg-1', title: 'Mezzanine', primaryType: 'Album', secondaryTypes: [] },
      tracks: [
        { disc: 1, position: 1, title: 'Angel', length: 200, recordingId: 'rec-1' },
        { disc: 1, position: 2, title: 'Risingson', length: 299, recordingId: 'rec-2' },
      ],
    });
    const onScanned = vi.fn();
    const source = new FolderSource({ sourceId, root: dir, store, fs: new LocalFolderFs(), onScanned });
    await source.sync(); // fills the tag cache
    store.saveMatches(sourceId, [
      {
        rel: 'Massive Attack/Mezzanine/01 Angel.flac',
        groupKey: 'g',
        state: 'auto',
        overlay: { recordingMbid: 'rec-1', releaseGroupMbid: 'rg-1', releaseId: 'rel-1', album: 'Mezzanine', albumArtistMbid: 'art-1' },
        size: 0,
        mtimeMs: 0,
      },
    ]);
    const sync = await source.sync();
    expect(sync.copies.find((c) => c.ref.endsWith('Angel.flac'))!.trackKey).toBe('mb:rg-1#rec-1');
    expect(sync.tracks.map((t) => t.key)).toContain('mb:rg-1#rec-2'); // the rest of the release, missing
    expect(onScanned).toHaveBeenCalledWith(sourceId);
  });

  it('rebuilds from the last scan without touching the folder or the matcher', async () => {
    const { store, sourceId, dir } = setup();
    store.saveRelease({
      id: 'rel-1',
      title: 'Mezzanine',
      artistName: 'Massive Attack',
      artistId: 'art-1',
      releaseGroup: { id: 'rg-1', title: 'Mezzanine', primaryType: 'Album', secondaryTypes: [] },
      tracks: [{ disc: 1, position: 1, title: 'Angel', length: 200, recordingId: 'rec-1' }],
    });
    const onScanned = vi.fn();
    const fs = new LocalFolderFs();
    const source = new FolderSource({ sourceId, root: dir, store, fs, onScanned });
    const scanned = await source.sync();
    onScanned.mockClear();
    const listAudio = vi.spyOn(fs, 'listAudio');
    store.saveMatches(sourceId, [
      {
        rel: 'Massive Attack/Mezzanine/01 Angel.flac',
        groupKey: 'g',
        state: 'auto',
        overlay: { recordingMbid: 'rec-1', releaseGroupMbid: 'rg-1', releaseId: 'rel-1', album: 'Mezzanine', albumArtistMbid: 'art-1' },
        size: 0,
        mtimeMs: 0,
      },
    ]);
    const rebuilt = source.cached();
    expect(listAudio).not.toHaveBeenCalled();
    expect(onScanned).not.toHaveBeenCalled();
    expect(rebuilt.copies.map((c) => [c.ref, c.path])).toEqual(scanned.copies.map((c) => [c.ref, c.path]));
    expect(rebuilt.copies.find((c) => c.ref.endsWith('Angel.flac'))!.trackKey).toBe('mb:rg-1#rec-1'); // the new match
  });

  it('gives a compilation’s song matched to its own album that album’s length and year, not the compilation’s', () => {
    const store = new CatalogStore(freshDb());
    const sourceId = store.addSource('folder', '00s Hits', { path: '/hits' });
    const va = { albumArtist: 'Various Artists', album: '00s Hits - 100 Top Songs', trackTotal: 100, year: 2025 };
    const tags = (t: object) => ({ genres: [], duration: 189, format: FLAC, ...va, ...t });
    const files = ['10. Madonna - 4 Minutes.mp3', '94. Madonna - Music.mp3'];
    store.saveFolderFiles(
      sourceId,
      [
        { rel: files[0]!, size: 1, mtimeMs: 1, tags: tags({ artist: 'Madonna', title: '4 Minutes', trackNumber: 10 }) },
        { rel: files[1]!, size: 1, mtimeMs: 1, tags: tags({ artist: 'Madonna', title: 'Music', trackNumber: 94 }) },
      ],
      files,
    );
    const matched = (rel: string, overlay: object) => ({ rel, groupKey: rel, state: 'auto' as const, overlay, size: 1, mtimeMs: 1 });
    store.saveMatches(sourceId, [
      matched(files[0]!, { album: 'Hard Candy', albumArtist: 'Madonna', releaseGroupMbid: 'rg-hc', recordingMbid: 'rec-4m', trackNumber: 2, trackTotal: 12, year: 2008 }),
      // By its sound: no length nor year known.
      matched(files[1]!, { album: 'Music', albumArtist: 'Madonna', releaseGroupMbid: 'rg-m', recordingMbid: 'rec-m' }),
    ]);
    const sync = new FolderSource({ sourceId, root: '/hits', store, fs: new LocalFolderFs() }).cached();
    expect(sync.albums.find((a) => a.title === 'Hard Candy')).toMatchObject({ totalTrackCount: 12, releaseDate: '2008-01-01T00:00:00Z' });
    const music = sync.albums.find((a) => a.title === 'Music')!;
    expect(music.totalTrackCount).toBeUndefined();
    expect(music.releaseDate).toBeUndefined();
  });

  it('scans a folder on another machine through its filesystem alone', async () => {
    const store = new CatalogStore(freshDb());
    const sourceId = store.addSource('folder', 'NAS', { path: '/volume1/music', access: 'ssh', host: 'nas', user: 'me' });
    const fs: FolderFs = {
      kind: 'ssh',
      media: { kind: 'ssh' } as FolderFs['media'],
      concurrency: 3,
      stat: async (p) => (p === '/volume1/music' ? { size: 0, mtimeMs: 0, dir: true } : null),
      readdir: async () => [],
      listAudio: async () => [{ rel: 'Burial/Archangel.flac', path: '/volume1/music/Burial/Archangel.flac', size: 1200, mtimeMs: 1 }],
      readTags: vi.fn(async () => ({ title: 'Archangel', artist: 'Burial', genres: [], duration: 238, format: FLAC })),
      picture: async () => null,
      readFile: async () => Buffer.alloc(0),
      close: async () => {},
    };
    const sync = await new FolderSource({ sourceId, root: '/volume1/music', store, fs }).sync();
    expect(sync.copies.map((c) => c.ref)).toEqual(['Burial/Archangel.flac']);
    expect(sync.copies[0]!.path).toBe('/volume1/music/Burial/Archangel.flac');
    expect(fs.readTags).toHaveBeenCalledWith('/volume1/music/Burial/Archangel.flac', 1200);
  });
});
