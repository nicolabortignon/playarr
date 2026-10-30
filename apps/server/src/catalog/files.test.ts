import { describe, expect, it } from 'vitest';
import type { MediaSource } from '../media/index.ts';
import { FileAccessError, FileResolver } from './files.ts';
import { isInside } from './paths.ts';
import { CatalogStore } from './store.ts';
import { FLAC, freshDb } from './testFixtures.ts';

const remote = { kind: 'ssh' } as MediaSource;
const local = { kind: 'local' } as MediaSource;

function setup() {
  const store = new CatalogStore(freshDb());
  const lidarr = store.addSource('lidarr', 'Lidarr');
  const folder = store.addSource('folder', 'Music', { path: '/host/Music' });
  const files = new FileResolver(store, { media: remote, pathMap: [['/data/media/music', '/volume2/music']] }, local);
  const record = (sourceId: number, path: string) => ({ id: 1, sourceId, path, size: 1, format: FLAC });
  return { files, lidarr, folder, record };
}

describe('isInside', () => {
  it('compares whole path segments', () => {
    expect(isInside('/host/Music/a.flac', '/host/Music')).toBe(true);
    expect(isInside('/host/Music', '/host/Music/')).toBe(true);
    expect(isInside('/host/Musicals/a.flac', '/host/Music')).toBe(false);
    expect(isInside('/host/Music/../secret', '/host/Music')).toBe(false);
    expect(isInside('/anything', '/')).toBe(true);
  });
});

describe('FileResolver', () => {
  it('reads Lidarr files through the media source and path map', () => {
    const { files, lidarr, record } = setup();
    expect(files.resolve(record(lidarr, '/data/media/music/A/1.flac'))).toEqual({ media: remote, path: '/volume2/music/A/1.flac' });
  });

  it('refuses Lidarr files outside the mapped folders', () => {
    const { files, lidarr, record } = setup();
    expect(() => files.resolve(record(lidarr, '/etc/passwd'))).toThrow(FileAccessError);
  });

  it('reads folder files from local disk, inside the folder only', () => {
    const { files, folder, record } = setup();
    expect(files.resolve(record(folder, '/host/Music/A/1.flac'))).toEqual({ media: local, path: '/host/Music/A/1.flac' });
    expect(() => files.resolve(record(folder, '/host/Music/../../etc/passwd'))).toThrow(FileAccessError);
  });

  it('answers 404 for a removed source', () => {
    const { files, record } = setup();
    expect(() => files.resolve(record(99, '/x'))).toThrow(expect.objectContaining({ status: 404 }));
  });
});
