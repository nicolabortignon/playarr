import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FolderSource } from './folderSource.ts';
import { CatalogStore } from './store.ts';
import { readTags } from './tags.ts';
import { flacBytes, freshDb, tempDir } from './testFixtures.ts';

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
  const read = vi.fn(readTags);
  const source = new FolderSource({ sourceId, root: t.dir, store, readTags: read });
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
    const source = new FolderSource({ sourceId, root: '/nonexistent/playarr', store });
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
    const source = new FolderSource({ sourceId, root: dir, store, onScanned });
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
});
