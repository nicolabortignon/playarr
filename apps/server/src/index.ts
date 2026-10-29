import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController } from 'fastify';
import { loadConfig } from './config.ts';
import { Analyzer } from './analysis/analyzer.ts';
import { PlaylistCovers } from './cover/index.ts';
import { openDatabase } from './db.ts';
import { Discover } from './discover/discover.ts';
import { MusicBrainz } from './discover/musicbrainz.ts';
import { Recommendations } from './discover/recommendations.ts';
import { Requests } from './discover/requests.ts';
import { Favorites } from './favorites.ts';
import { Playlists } from './playlists.ts';
import { LidarrClient } from './lidarr/client.ts';
import { Library } from './library/library.ts';
import { createMediaSource } from './media/index.ts';
import { apiRoutes } from './routes/api.ts';
import { artRoutes, LocalArt } from './routes/art.ts';
import { discoverRoutes } from './routes/discover.ts';
import { favoriteRoutes } from './routes/favorites.ts';
import { playlistRoutes } from './routes/playlists.ts';
import { streamRoutes } from './routes/stream.ts';

const config = loadConfig();
const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  logController: new LogController({ disableRequestLogging: process.env.LOG_REQUESTS !== '1' }),
});

const lidarr = new LidarrClient(config.LIDARR_URL, config.LIDARR_API_KEY);
const library = new Library(
  lidarr,
  { info: (m) => app.log.info(m), error: (m) => app.log.error(m) },
  resolve(config.CACHE_DIR, 'library.json'),
);
const art = new LocalArt(lidarr, resolve(config.CACHE_DIR, 'art'));
// Keep every cover cached locally so browsing never waits on Lidarr.
library.onRefresh((lib) => void art.warm(lib.artworkUrls(), app.log));
const media = createMediaSource(config);
const db = openDatabase(resolve(config.DATA_DIR));
const favorites = new Favorites(db, library);
const analyzer = new Analyzer(db, library, media, {
  enabled: config.ANALYSIS === 'on',
  pathMap: config.pathMap,
  log: app.log,
});
const covers = new PlaylistCovers(analyzer, library, resolve(config.CACHE_DIR, 'covers'));
const playlists = new Playlists(db, library, covers);
const musicbrainz = new MusicBrainz(`Playarr/0.1.0 ( ${config.MUSICBRAINZ_CONTACT} )`);
const requests = new Requests(lidarr, musicbrainz, library, resolve(config.CACHE_DIR, 'requests.json'), {
  rootFolderPath: config.LIDARR_ROOT_FOLDER,
  qualityProfileId: config.LIDARR_QUALITY_PROFILE_ID,
  metadataProfileId: config.LIDARR_METADATA_PROFILE_ID,
});
const discover = new Discover(lidarr, musicbrainz, library, requests);
const recommendations = new Recommendations(playlists, library, requests);

apiRoutes(app, { config, lidarr, library, media });
artRoutes(app, { art, cacheDir: resolve(config.CACHE_DIR) });
streamRoutes(app, { config, library, media });
discoverRoutes(app, { discover, requests });
favoriteRoutes(app, { favorites, library });
playlistRoutes(app, { playlists, recommendations, covers });

// In production, serve the built web app from the same origin.
const webDist = config.WEB_DIST
  ? resolve(config.WEB_DIST)
  : fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    const isApi = /^\/(api|stream|art)\//.test(req.url);
    return isApi || req.method !== 'GET'
      ? reply.code(404).send({ error: 'Not found' })
      : reply.sendFile('index.html');
  });
}

const shutdown = async () => {
  library.stop();
  await media.close();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown).on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
app.log.info(`Lidarr: ${config.LIDARR_URL} · media source: ${media.kind}`);

// Serve the last saved snapshot immediately, then refresh from Lidarr in the background.
await library.loadCached();
library.refresh().catch(() => {});
library.startAutoRefresh(config.LIBRARY_REFRESH_MINUTES);
