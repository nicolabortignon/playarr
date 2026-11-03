// Records real answers of every endpoint family the iOS app calls, for its contract tests
// (apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/ContractTests.swift). Run with RECORD_FIXTURES=1
// to write them; without it these are ordinary route tests. The library, favorites, playlists, plays and
// stats run on the real services over a small catalog; MusicBrainz, Lidarr, lyrics, mixes, ListenBrainz,
// analysis and rendering are fakes returning complete values typed by the shared types (no casts on
// the values), so a fixture still checks the TypeScript type against the Swift one.
import { MIX_MAP_VERSION, type MixMap, type TransitionAnswer, type TransitionPlan } from '@playarr/mix';
import type {
  AlbumRequest,
  Availability,
  DiscoverAlbum,
  DiscoverArtist,
  DiscoverArtistDetail,
  DiscoverResults,
  ListenBrainzInfo,
  Lyrics,
  MixDetail,
  MixSummary,
  PlayReport,
  Recommendations,
  Track,
} from '@playarr/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Analyzer } from '../analysis/analyzer.ts';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb, mezzanine, tempDir } from '../catalog/testFixtures.ts';
import type { Config } from '../config.ts';
import { PlaylistCovers } from '../cover/index.ts';
import type { Discover } from '../discover/discover.ts';
import type { Recommendations as RecommendationService } from '../discover/recommendations.ts';
import type { Requests } from '../discover/requests.ts';
import { Favorites } from '../favorites.ts';
import { LidarrClient } from '../lidarr/client.ts';
import { Library } from '../library/library.ts';
import type { MediaSource } from '../media/index.ts';
import { History } from '../mixes/history.ts';
import type { Mixes } from '../mixes/mixes.ts';
import { Playlists } from '../playlists.ts';
import { recordFixture } from '../testing/recordFixture.ts';
import { apiRoutes } from './api.ts';
import { discoverRoutes } from './discover.ts';
import { favoriteRoutes } from './favorites.ts';
import { lyricsRoutes } from './lyrics.ts';
import { metadataRoutes } from './metadata.ts';
import { mixMapRoutes } from './mixMaps.ts';
import { mixRoutes } from './mixes.ts';
import { playlistRoutes } from './playlists.ts';
import { account, actAs, asAccount } from '../accounts/testAccess.ts';
import { transitionRoutes } from './transitions.ts';

const ANGEL = '0b6a2c1e-1111-4222-8333-944455556666';
const RISINGSON = '0b6a2c1e-1111-4222-8333-944455557777';
const ARTIST_MBID = '10adbe5e-a2c0-4bf3-8249-2b4cbf6e6ca8';
const ALBUM_MBID = 'a9a3d3bd-0c1c-3a6c-8b3f-4b1e3b1f5b7e';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

/** The test catalog (Mezzanine, two songs) with MusicBrainz recording ids, as the routes require. */
async function catalog() {
  const db = freshDb();
  const store = new CatalogStore(db);
  const sourceId = store.addSource('lidarr', 'Lidarr');
  const sync = mezzanine();
  sync.tracks = sync.tracks.map((t) => ({ ...t, recordingId: t.recordingId === 'rec-1' ? ANGEL : RISINGSON }));
  const library = new Library(store, () => [{ id: sourceId, source: { kind: 'lidarr', sync: async () => sync } }], { info: () => {}, error: () => {} });
  await library.refresh();
  const tracks = (await library.allTracks()).sort((a, b) => a.id - b.id);
  return { db, store, library, tracks };
}

/** Each GET answers 2xx and is saved as the named fixture. */
async function recordGets(app: FastifyInstance, gets: [name: string, url: string][], headers: Record<string, string> = {}) {
  for (const [name, url] of gets) {
    const res = await app.inject({ method: 'GET', url, headers });
    expect(res.statusCode, `${url}: ${res.body}`).toBeLessThan(300);
    recordFixture(name, res);
  }
}

const PLAN: TransitionPlan = {
  style: 'long',
  aStart: 312.4,
  bStart: 0.42,
  length: 24,
  bResume: 24.42,
  switchAt: 12,
  bRate: [{ at: 0, value: 1.02 }, { at: 24, value: 1 }],
  aGain: [{ at: 0, value: 1 }, { at: 16, value: 0 }],
  bGain: [{ at: 0, value: 0 }, { at: 8, value: 1 }],
  aLowDb: [{ at: 0, value: 0 }, { at: 12, value: -24 }],
  bLowDb: [{ at: 0, value: -24 }, { at: 12, value: 0 }],
  aHighPassHz: [{ at: 0, value: 20 }],
  reason: 'Both songs hold their beat over a 32-beat phrase',
  beats: 32,
};

const MAP: MixMap = {
  version: MIX_MAP_VERSION,
  duration: 379,
  bpm: 80,
  firstBeat: 0.42,
  downbeatOffset: 1,
  downbeatConfidence: 0.8,
  gridStable: true,
  beatConfidence: 0.9,
  key: { camelot: '8A', confidence: 0.7 },
  introEnd: 32.5,
  outroStart: 340,
  firstDrop: 64,
  coldStart: false,
  coldEnd: false,
  soundStart: 0.1,
  soundEnd: 378.2,
  beatsFrom: 'model',
  phraseEnergy: [0.4, 0.8, null, 1],
  phraseDrift: [3, null, 5],
  edgesStable: true,
};

describe('contract fixtures', () => {
  it('library, search, metadata and lyrics', async () => {
    const { store, library } = await catalog();
    const lyrics: Lyrics = { synced: [{ at: 12.5, text: 'Love, love is a verb' }], plain: 'Love, love is a verb', source: 'lrclib' };
    const app = Fastify();
    apiRoutes(app, {
      config: { pathMap: [] } as unknown as Config,
      lidarr: new LidarrClient(),
      library,
      media: { kind: 'local', check: async () => {} } as unknown as MediaSource,
      requestSettings: () => ({ enabled: false, searchOnAdd: true }),
    });
    metadataRoutes(app, { store, library, pathMap: [], features: () => new Map() });
    lyricsRoutes(app, { lyrics: { forTrack: async () => lyrics } });
    await recordGets(app, [
      ['health', '/api/health'],
      ['artists', '/api/artists'],
      ['artist', '/api/artists/7'],
      ['artist-tracks', '/api/artists/7/tracks'],
      ['albums', '/api/albums?sort=added'],
      ['albums-random', '/api/albums/random'],
      ['album', '/api/albums/70'],
      ['search', '/api/search?q=massive'],
      ['track-metadata', '/api/tracks/700/metadata'],
      ['lyrics', '/api/tracks/700/lyrics'],
    ]);
    const random = await app.inject({ method: 'GET', url: '/api/tracks/random' });
    expect(random.json()).toHaveLength(2);
    recordFixture('tracks-random', random, (tracks: Track[]) => tracks.sort((a, b) => a.id - b.id));
  });

  it('favorites and playlists', async () => {
    const { db, library } = await catalog();
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const analyzer = { ensure() {}, features: () => new Map(), meta: () => new Map(), pending: () => 0 } as unknown as Analyzer;
    const covers = new PlaylistCovers(analyzer, library, dir);
    const recommendations: Recommendations = {
      owned: [{ recordingId: RISINGSON, title: 'Risingson', artistName: 'Massive Attack', albumTitle: 'Mezzanine', because: 'Angel', track: (await library.trackByRecording(RISINGSON))!, artistId: 7 }],
      missing: [
        {
          recordingId: 'b3c4d5e6-1111-4222-8333-944455558888',
          title: 'Teardrop',
          artistName: 'Massive Attack',
          albumTitle: 'Mezzanine (Deluxe)',
          because: 'Angel',
          album: { mbid: ALBUM_MBID, artistName: 'Massive Attack', albumTitle: 'Mezzanine (Deluxe)' },
          availability: { state: 'none' },
          artistMbid: ARTIST_MBID,
        },
      ],
      seedCount: 2,
    };
    const app = Fastify();
    // Since accounts, favorites and playlists belong to the signed-in account: act as the owner.
    actAs(app, [account(1, { role: 'admin', canRequest: true })]);
    const owner = asAccount(1);
    favoriteRoutes(app, { favorites: new Favorites(db), library });
    playlistRoutes(app, {
      playlists: new Playlists(db, library, covers),
      recommendations: { forPlaylist: async () => recommendations } as unknown as RecommendationService,
      covers,
      library,
    });
    expect((await app.inject({ method: 'PUT', url: `/api/favorites/${ANGEL}`, headers: owner })).statusCode).toBe(204);
    const created = await app.inject({ method: 'POST', url: '/api/playlists', headers: owner, payload: { name: 'Late night', description: 'For the drive home', recordingIds: [ANGEL, RISINGSON] } });
    expect(created.statusCode).toBe(201);
    recordFixture('playlist', created);
    await recordGets(app, [
      ['favorites', '/api/favorites'],
      ['playlists', '/api/playlists'],
      ['recommendations', `/api/playlists/${created.json().id}/recommendations`],
    ], owner);
  });

  it('discover and requests', async () => {
    const availability: Availability = { state: 'partial', albumId: 70, have: 2, total: 11 };
    const album: DiscoverAlbum = {
      mbid: ALBUM_MBID,
      title: 'Mezzanine',
      artistName: 'Massive Attack',
      artistMbid: ARTIST_MBID,
      year: 1998,
      type: 'Album',
      secondaryTypes: [],
      coverUrl: `/art/remote?url=${encodeURIComponent('https://coverartarchive.org/release-group/x/front-250')}`,
      availability,
    };
    const artist: DiscoverArtist = { mbid: ARTIST_MBID, name: 'Massive Attack', disambiguation: 'Bristol group', genres: ['trip hop'], artistId: 7 };
    const results: DiscoverResults = {
      artists: [artist],
      albums: [album],
      tracks: [
        {
          id: 'b3c4d5e6-1111-4222-8333-944455558888',
          title: 'Teardrop',
          artistName: 'Massive Attack',
          albumTitle: 'Mezzanine',
          duration: 330,
          album: { mbid: ALBUM_MBID, artistName: 'Massive Attack', albumTitle: 'Mezzanine' },
          availability,
          artistId: 7,
        },
      ],
    };
    const detail: DiscoverArtistDetail = { ...artist, overview: 'Formed in Bristol in 1988.', albums: [album] };
    const request: AlbumRequest = {
      mbid: ALBUM_MBID,
      title: 'Mezzanine',
      artistName: 'Massive Attack',
      requestedAt: '2026-11-03T12:00:00.000Z',
      availability: { state: 'downloading', progress: 0.4, message: 'Downloading 4 of 11' },
    };
    const app = Fastify();
    discoverRoutes(app, {
      discover: { search: async () => results, artist: async () => detail, similarArtists: async () => [artist], findArtist: async () => ({ mbid: ARTIST_MBID, artistId: 7 }) } as unknown as Discover,
      requests: { list: async () => [request], request: async () => request, remove: async () => {} } as unknown as Requests,
    });
    await recordGets(app, [
      ['discover-search', '/api/discover/search?q=massive'],
      ['discover-artist', `/api/discover/artists/${ARTIST_MBID}`],
      ['discover-similar', `/api/discover/artists/${ARTIST_MBID}/similar`],
      ['artist-lookup', '/api/discover/artist-lookup?name=Massive%20Attack'],
      ['requests', '/api/requests'],
    ]);
    recordFixture('request-created', await app.inject({ method: 'POST', url: '/api/requests', payload: { mbid: ALBUM_MBID, artistName: 'Massive Attack', albumTitle: 'Mezzanine' } }));
  });

  it('plays, stats, mixes and ListenBrainz', async () => {
    const { db, store, library, tracks } = await catalog();
    const summary: MixSummary = {
      key: 'vibes',
      kind: 'vibes',
      title: 'Your vibes',
      subtitle: 'Massive Attack and more',
      description: 'Songs you play the most at this hour',
      trackCount: tracks.length,
      duration: tracks.reduce((sum, t) => sum + t.duration, 0),
      covers: ['/art/album/70/cover'],
      hue: 210,
      generatedAt: '2026-11-03T12:00:00.000Z',
      refreshesAt: '2026-11-03T13:00:00.000Z',
    };
    const detail: MixDetail = { ...summary, tracks };
    const listenBrainz: ListenBrainzInfo = { connected: true, user: 'listener', enabled: true, pending: 0, sent: 42, earlier: 3, lastSentAt: '2026-11-03T12:00:00.000Z' };
    const app = Fastify();
    mixRoutes(app, {
      mixes: { list: async () => [summary], get: async () => detail, regenerate: async () => detail, radio: async () => tracks, reset: async () => {} } as unknown as Mixes,
      history: new History(db, library),
      store,
      analysisAvailable: true,
      analyzeLibrary: vi.fn(),
      library,
      db,
      scrobbler: { info: () => listenBrainz, connect: async () => listenBrainz, disconnect: () => listenBrainz, setEnabled: () => listenBrainz, sendEarlier: () => listenBrainz, kick: async () => {} },
    });
    const plays: PlayReport[] = tracks.map((t, i) => ({ trackId: t.id, recordingId: t.recordingId, at: `2026-11-0${i + 1}T21:00:00.000Z`, hour: 21, weekday: i, seconds: t.duration, skipped: false }));
    const recorded = await app.inject({ method: 'POST', url: '/api/plays', payload: { plays } });
    expect(recorded.json()).toEqual({ recorded: 2 });
    recordFixture('plays', recorded);
    await recordGets(app, [
      ['recent-albums', '/api/plays/recent-albums'],
      ['stats', '/api/stats?range=all'],
      ['mixes', '/api/mixes?tz=Europe%2FLondon'],
      ['mix', '/api/mixes/vibes?tz=Europe%2FLondon'],
      ['mix-settings', '/api/settings/mixes'],
      ['listenbrainz', '/api/settings/listenbrainz'],
    ]);
    recordFixture('radio', await app.inject({ method: 'POST', url: '/api/radio', payload: { seeds: [ANGEL] } }));
  });

  it('mix maps, cue points and transitions', async () => {
    const { library } = await catalog();
    const analyzer = {
      canAnalyzeAudio: true,
      mixMaps: (ids: string[]) => new Map(ids.filter((id) => id === ANGEL).map((id) => [id, MAP] as const)),
      cues: (ids: string[]) => new Map(ids.filter((id) => id === ANGEL).map((id) => [id, { mixIn: 30, mixOut: 350 }] as const)),
      setCues: vi.fn(),
      ensure: vi.fn(),
      analysisProgress: () => ({
        songs: 2,
        beats: { ready: 1, beatModel: 1, failed: 0 },
        sound: { ready: 1, failed: 0 },
        loudness: { ready: 2, failed: 0 },
        tags: { ready: 2, songs: 2 },
        waiting: 1,
        working: 0,
        loudnessWaiting: 0,
        loudnessWorking: 0,
        tagsWaiting: 0,
      }),
      analyzeLibrary: async () => 0,
      reanalyzeLibrary: async () => 0,
    };
    const answers: Record<number, TransitionAnswer> = {
      1: { status: 'ready', plan: PLAN, url: `/transitions/${'a'.repeat(40)}.flac`, continuationUrl: `/transitions/${'a'.repeat(40)}.rest.flac`, tail: 8, lead: 4, levels: { a: -3.5, b: 1.2 } },
      2: { status: 'pending', plan: PLAN, render: { step: 'mixing', done: 0.45, ahead: 1 } },
      3: { status: 'straight', plan: { ...PLAN, style: 'straight', reason: 'Same album, in order', beats: 0 } },
      4: { status: 'unavailable', reason: 'No mix map yet for the next song' },
    };
    const app = Fastify();
    mixMapRoutes(app, { analyzer, library });
    transitionRoutes(app, { transitions: { request: async ({ fromTrackId }) => answers[fromTrackId]!, filePath: () => undefined } });
    recordFixture('mix-maps', await app.inject({ method: 'POST', url: '/api/mix-maps', payload: { ids: [ANGEL, RISINGSON] } }));
    recordFixture('analysis-progress', await app.inject({ method: 'GET', url: '/api/analysis/progress' }));
    await recordGets(app, [['cues', `/api/recordings/${ANGEL}/cues`]]);
    for (const [from, name] of [[1, 'ready'], [2, 'pending'], [3, 'straight'], [4, 'unavailable']] as const) {
      const res = await app.inject({ method: 'POST', url: '/api/transitions', payload: { from, to: 701, mode: 'auto' } });
      expect(res.json().status).toBe(name);
      recordFixture(`transition-${name}`, res);
    }
  });
});
