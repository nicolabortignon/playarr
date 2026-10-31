import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
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
