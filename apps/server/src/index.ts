import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController } from 'fastify';
import { loadConfig } from './config.ts';
import { Analyzer } from './analysis/analyzer.ts';
import { AcoustId, hasFpcalc } from './catalog/acoustid.ts';
import { FileResolver } from './catalog/files.ts';
import { FolderAccess } from './catalog/folderAccess.ts';
import { Matcher } from './catalog/matcher.ts';
import { toReleaseInfo } from './catalog/mbRelease.ts';
import { Organizer } from './catalog/organizer.ts';
import { SourceManager } from './catalog/sources.ts';
import { CatalogStore } from './catalog/store.ts';
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
import { ACOUSTID_KEY, settingsRoutes } from './routes/settings.ts';
import { statusRoutes } from './routes/status.ts';
import { streamRoutes } from './routes/stream.ts';

const config = loadConfig();
const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  logController: new LogController({ disableRequestLogging: process.env.LOG_REQUESTS !== '1' }),
});

// One Lidarr client for the whole server; the Lidarr source in Settings points it at a Lidarr (or not).
const lidarr = new LidarrClient();
const db = openDatabase(resolve(config.DATA_DIR));
const store = new CatalogStore(db);
const sources = new SourceManager(store, lidarr, { info: (m) => app.log.info(m) }, config.folderRoots);
// fpcalc on this server fingerprints local folders; SSH folders run it on their own host.
const fingerprints = await hasFpcalc(config.FPCALC_PATH);
// One filesystem (this server's disk, or an SSH/SFTP connection) per folder source.
const folders = new FolderAccess(store, { ffmpeg: config.FFMPEG_PATH, fpcalc: config.FPCALC_PATH, localFingerprints: fingerprints });
sources.useFolderAccess(folders);
sources.seedFromEnv({ url: config.LIDARR_URL, apiKey: config.LIDARR_API_KEY });
sources.active(); // configure the Lidarr client before anything uses it
const library = new Library(store, () => sources.active(), {
  info: (m) => app.log.info(m),
  error: (m) => app.log.error(m),
});
// One MusicBrainz queue (~1 request/s) shared by matching and Discover.
const musicbrainz = new MusicBrainz(`Playarr/0.1.0 ( ${config.MUSICBRAINZ_CONTACT} )`);
// Identifies untagged folder music in the background after each scan.
const matcher = new Matcher({
  store,
  mb: {
    // Background work: counted apart in the queue status, so the UI can say why Discover waits.
    searchReleases: (artist, album) => musicbrainz.searchReleases(artist, album, undefined, { background: true }),
    release: async (id) => toReleaseInfo(await musicbrainz.release(id, undefined, { background: true })),
  },
  acoustid: new AcoustId(() => store.appSetting(ACOUSTID_KEY) || undefined),
  fingerprint: (sourceId, path) => folders.get(sourceId)?.fingerprint?.(path) ?? Promise.resolve(null),
  onMatched: () => library.refreshSoon(),
  log: { warn: (m) => app.log.warn(m) },
});
sources.useMatcher(matcher);
// Moves folder files into Artist/Album/NN Title on request (Settings → Sources → Organize files).
const organizer = new Organizer(store);
const art = new LocalArt(lidarr, resolve(config.CACHE_DIR, 'art'));
// Keep every cover cached locally so browsing never waits on Lidarr.
library.onRefresh((lib) => void art.warm(lib.artworkUrls(), app.log));
const media = createMediaSource(config);
// Lidarr's files through MEDIA_SOURCE + PATH_MAP; folder sources through their own filesystem.
const files = new FileResolver(store, { media, pathMap: config.pathMap }, folders);
const favorites = new Favorites(db, library);
const analyzer = new Analyzer(db, library, files, { enabled: config.ANALYSIS === 'on', log: app.log });
const covers = new PlaylistCovers(analyzer, library, resolve(config.CACHE_DIR, 'covers'));
const playlists = new Playlists(db, library, covers);
const requests = new Requests(lidarr, musicbrainz, library, resolve(config.CACHE_DIR, 'requests.json'), {
  rootFolderPath: config.LIDARR_ROOT_FOLDER,
  qualityProfileId: config.LIDARR_QUALITY_PROFILE_ID,
  metadataProfileId: config.LIDARR_METADATA_PROFILE_ID,
});
const discover = new Discover(lidarr, musicbrainz, library, requests);
const recommendations = new Recommendations(playlists, library, requests);

apiRoutes(app, { config, lidarr, library, media });
artRoutes(app, { art, cacheDir: resolve(config.CACHE_DIR), library, files, folders });
streamRoutes(app, { library, files });
discoverRoutes(app, { discover, requests });
favoriteRoutes(app, { favorites, library });
playlistRoutes(app, { playlists, recommendations, covers });
settingsRoutes(app, { sources, library, matcher, store, organizer, fingerprints });
statusRoutes(app, {
  musicbrainz,
  matching: () => store.listSources().reduce((n, s) => n + matcher.pendingGroups(s.id), 0),
});

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
  await folders.closeAll();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown).on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
app.log.info(`Sources: ${store.listSources().map((s) => s.name).join(', ') || 'none'} · media source: ${media.kind}`);

// Serve the catalog saved by the last run immediately, then sync the sources in the background.
library.loadStored();
library.refresh().catch(() => {});
library.startAutoRefresh(config.LIBRARY_REFRESH_MINUTES);
