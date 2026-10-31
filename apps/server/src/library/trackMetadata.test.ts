import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { CatalogStore } from '../catalog/store.ts';
import { FLAC, freshDb, mezzanine } from '../catalog/testFixtures.ts';
import type { Library } from './library.ts';
import { metadataRoutes } from '../routes/metadata.ts';
import { trackMetadata } from './trackMetadata.ts';

/** Mezzanine from Lidarr, and Angel again in an SSH folder (tagged, matched). */
function setup() {
  const store = new CatalogStore(freshDb());
  const lidarr = store.addSource('lidarr', 'Lidarr', { url: 'http://lidarr', apiKey: 'secret-key' });
  store.applySync(lidarr, mezzanine());
  const folder = store.addSource('folder', 'NAS', { access: 'ssh', host: 'nas', user: 'me', password: 'pw', path: '/volume1/music' });
  const sync = mezzanine();
  sync.addedAt = 'firstSeen';
  sync.copies = [{ ...sync.copies[0]!, ref: 'Massive Attack/01 Angel.mp3', preferredId: undefined, path: '/volume1/music/Massive Attack/01 Angel.mp3', format: { ...FLAC, codec: 'MP3', container: 'mp3', lossless: false, bitrate: 320 } }];
  store.applySync(folder, sync);
  store.saveFolderFiles(
    folder,
    [{ rel: 'Massive Attack/01 Angel.mp3', size: 1, mtimeMs: 1, tags: { title: 'Angel', album: 'Mezzanine', genres: ['trip hop'], duration: 379, format: FLAC } }],
    ['Massive Attack/01 Angel.mp3'],
  );
  store.saveMatches(folder, [{ rel: 'Massive Attack/01 Angel.mp3', groupKey: 'g', state: 'auto', size: 1, mtimeMs: 1, score: 0.93 }]);
  const library = { track: async (id: number) => (id === 700 ? { fileId: 9000 } : undefined) } as unknown as Library;
  return { store, library };
}

describe('trackMetadata', () => {
  it('describes a song with every copy, the playing one first, and folder tags and match', async () => {
    const { store, library } = setup();
    const meta = await trackMetadata(
      { store, library, pathMap: [['/music', '/data/music']], features: () => ({ bpm: 96, pulse: 0.8, loudness: 0.5, dynamics: 0.4, brightness: 0.3, busyness: 0.2, bass: 0.7 }) },
      700,
      true,
    );
    expect(meta).toMatchObject({
      title: 'Angel',
      artistName: 'Massive Attack',
      albumTitle: 'Mezzanine',
      recordingId: 'rec-1',
      albumMbid: 'rg-1',
      artistMbid: 'art-1',
      analysis: { bpm: 96 },
      pathsHidden: false,
    });
    expect(meta!.copies).toHaveLength(2);
    expect(meta!.copies[0]).toMatchObject({
      playing: true,
      source: { name: 'Lidarr', kind: 'lidarr', location: 'Lidarr' },
      path: '/music/Massive Attack/Mezzanine/01.flac',
      readPath: '/data/music/Massive Attack/Mezzanine/01.flac',
    });
    expect(meta!.copies[1]).toMatchObject({
      playing: false,
      source: { name: 'NAS', kind: 'folder', location: 'me@nas (SSH)' },
      path: '/volume1/music/Massive Attack/01 Angel.mp3',
      tags: { title: 'Angel', album: 'Mezzanine', genres: ['trip hop'] },
      match: { state: 'auto', score: 0.93 },
    });
    expect(meta!.copies[1]!.tags).not.toHaveProperty('format');
    // No secret ever leaves.
    expect(JSON.stringify(meta)).not.toMatch(/secret-key|"pw"/);
  });

  it('leaves out paths and locations away from home, and answers 404 for unknown songs', async () => {
    const { store, library } = setup();
    const app = Fastify();
    metadataRoutes(app, { store, library, pathMap: [], features: () => new Map() });
    const away = await app.inject({ url: '/api/tracks/700/metadata', remoteAddress: '203.0.113.9' });
    const body = away.json();
    expect(body.pathsHidden).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/volume1|\/music\/|nas \(SSH\)/);
    const home = await app.inject({ url: '/api/tracks/700/metadata', remoteAddress: '192.168.1.20' });
    expect(home.json().copies[1].path).toBe('/volume1/music/Massive Attack/01 Angel.mp3');
    expect((await app.inject({ url: '/api/tracks/99999/metadata', remoteAddress: '192.168.1.20' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/tracks/abc/metadata', remoteAddress: '192.168.1.20' })).statusCode).toBe(400);
  });
});

describe('POST /api/files/:fileId/rematch', () => {
  function withRoutes() {
    const { store, library } = setup();
    const rebuild = vi.fn(async () => {});
    const lib = Object.assign(library, { rebuild, refreshSoon: vi.fn() }) as unknown as Library;
    const matcher = { rematchFile: vi.fn(async () => 'auto' as const) };
    const lidarr = { configured: true, trackFile: vi.fn(async () => ({ id: 9000, artistId: 33, albumId: 44 })), command: vi.fn(async () => ({})) };
    const app = Fastify();
    metadataRoutes(app, { store, library: lib, pathMap: [], features: () => new Map(), matcher, lidarr: lidarr as never });
    const folderCopy = store.load().copies.find((c) => c.path.startsWith('/volume1'))!;
    return { app, store, matcher, lidarr, rebuild, folderCopy };
  }
  const post = (app: ReturnType<typeof Fastify>, fileId: number | string, remoteAddress = '192.168.1.20') =>
    app.inject({ method: 'POST', url: `/api/files/${fileId}/rematch`, remoteAddress });

  it('matches a folder file again, rebuilds, and says which song it belongs to now', async () => {
    const { app, matcher, rebuild, folderCopy } = withRoutes();
    const res = await post(app, folderCopy.id);
    expect(res.json()).toEqual({ kind: 'folder', state: 'auto', trackId: folderCopy.trackId });
    expect(matcher.rematchFile).toHaveBeenCalledWith(folderCopy.sourceId, 'Massive Attack/01 Angel.mp3');
    expect(rebuild).toHaveBeenCalled();
  });

  it('asks Lidarr to refresh the artist for a Lidarr file', async () => {
    const { app, lidarr, matcher } = withRoutes();
    const res = await post(app, 9000);
    expect(res.json()).toMatchObject({ kind: 'lidarr' });
    expect(lidarr.trackFile).toHaveBeenCalledWith(9000);
    expect(lidarr.command).toHaveBeenCalledWith('RefreshArtist', { artistId: 33 });
    expect(matcher.rematchFile).not.toHaveBeenCalled();
  });

  it('works from the home network only, and only for known files', async () => {
    const { app, folderCopy, matcher } = withRoutes();
    expect((await post(app, folderCopy.id, '203.0.113.9')).statusCode).toBe(403);
    expect((await post(app, 424242)).statusCode).toBe(404);
    expect((await post(app, 'x')).statusCode).toBe(404);
    expect(matcher.rematchFile).not.toHaveBeenCalled();
  });
});
