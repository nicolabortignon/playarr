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
  const files = new FileResolver(store, { media: remote, pathMap: [['/data/media/music', '/volume2/music']] }, {
    get: () => ({ media: local }) as never,
  });
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

  it('reads folder files through their filesystem, inside the folder only', () => {
    const { files, folder, record } = setup();
    expect(files.resolve(record(folder, '/host/Music/A/1.flac'))).toEqual({ media: local, path: '/host/Music/A/1.flac' });
    expect(() => files.resolve(record(folder, '/host/Music/../../etc/passwd'))).toThrow(FileAccessError);
  });

  it('answers 404 for a removed source', () => {
    const { files, record } = setup();
    expect(() => files.resolve(record(99, '/x'))).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe('FileResolver.probe', () => {
  function probing(folder: { connects?: boolean; dir?: boolean; entries?: number }, lidarrRoots: { answers: boolean }) {
    const store = new CatalogStore(freshDb());
    const lidarr = store.addSource('lidarr', 'Lidarr');
    const music = store.addSource('folder', 'Music', { path: '/host/Music' });
    const checked: string[] = [];
    const fs = {
      media: { check: async () => (folder.connects === false ? Promise.reject(new Error('Host is down')) : undefined) },
      stat: async () => (folder.dir === false ? null : { size: 0, mtimeMs: 0, dir: true }),
      readdir: async () => Array.from({ length: folder.entries ?? 1 }, (_, i) => ({ name: `${i}`, dir: true, file: false })),
    };
    const media = {
      kind: 'ssh',
      check: async (root?: string) => {
        checked.push(root ?? '');
        if (!lidarrRoots.answers) throw new Error('Connection refused');
      },
    } as unknown as MediaSource;
    const files = new FileResolver(
      store,
      { media, pathMap: [['/data/a', '/volume1/a'], ['/data/b', '/volume1/b']] },
      { get: (id: number) => (id === music ? (fs as never) : undefined) },
    );
    return { files, lidarr, music, checked };
  }

  it('finds a folder there when its connection works and its folder has something in it', async () => {
    const { files, music } = probing({}, { answers: true });
    await expect(files.probe(music)).resolves.toBeUndefined();
  });

  it('finds a folder away when its host doesn’t answer, its folder is gone, or it’s empty (an unmounted disk)', async () => {
    const away: [Parameters<typeof probing>[0], string][] = [
      [{ connects: false }, 'Host is down'],
      [{ dir: false }, '/host/Music isn’t there'],
      [{ entries: 0 }, '/host/Music is empty'],
    ];
    for (const [folder, said] of away) {
      const { files, music } = probing(folder, { answers: true });
      await expect(files.probe(music)).rejects.toThrow(said);
    }
  });

  it('asks Lidarr’s media source for each of its music folders', async () => {
    const up = probing({}, { answers: true });
    await expect(up.files.probe(up.lidarr)).resolves.toBeUndefined();
    expect(up.checked).toEqual(['/volume1/a', '/volume1/b']);
    const down = probing({}, { answers: false });
    await expect(down.files.probe(down.lidarr)).rejects.toThrow('Connection refused');
  });

  it('has nothing to ask about a removed source, or Lidarr’s files without a path map', async () => {
    const { files } = probing({}, { answers: true });
    expect(files.probe(99)).toBeUndefined();
    const store = new CatalogStore(freshDb());
    const lidarr = store.addSource('lidarr', 'Lidarr');
    expect(new FileResolver(store, { media: remote, pathMap: [] }, { get: () => undefined }).probe(lidarr)).toBeUndefined();
  });
});
