import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController } from 'fastify';
import { loadConfig } from './config.ts';
import { Analyzer } from './analysis/analyzer.ts';
import { BeatModelThread } from './analysis/beatModelThread.ts';
import { DspThread } from './analysis/dspThread.ts';
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
import { hasRclone } from './media/rclone.ts';
import { apiRoutes } from './routes/api.ts';
import { metadataRoutes } from './routes/metadata.ts';
import { artRoutes, LocalArt, trimArtCache } from './routes/art.ts';
import { levelRoutes } from './routes/levels.ts';
import { mixMapRoutes } from './routes/mixMaps.ts';
import { transitionRoutes } from './routes/transitions.ts';
import { Transitions } from './transitions/transitions.ts';
import { lyricsRoutes } from './routes/lyrics.ts';
import { LyricsService } from './lyrics/lyrics.ts';
import { Scrobbler } from './listenbrainz/scrobbler.ts';
import { Accounts } from './accounts/accounts.ts';
import { authHook } from './accounts/auth.ts';
import { Sessions } from './accounts/sessions.ts';
import { SetupCodes } from './accounts/setupCodes.ts';
import { accountRoutes } from './routes/accounts.ts';
import { authRoutes } from './routes/auth.ts';
import { discoverRoutes } from './routes/discover.ts';
import { favoriteRoutes } from './routes/favorites.ts';
import { playlistRoutes } from './routes/playlists.ts';
import { ACOUSTID_KEY, readRequestSettings, settingsRoutes } from './routes/settings.ts';
import { statusRoutes } from './routes/status.ts';
import { streamRoutes } from './routes/stream.ts';
import { UpdateBridge } from './update/bridge.ts';
import { watchStalls } from './stallMonitor.ts';
import { History } from './mixes/history.ts';
import { Mixes } from './mixes/mixes.ts';
import { mixRoutes } from './routes/mixes.ts';
import { readMixSettings } from './mixes/settings.ts';

const config = loadConfig();
const app = Fastify({
  // Behind a reverse proxy (TRUST_PROXY): the visitor's address, host and protocol from the proxy's headers.
  trustProxy: config.trustProxy,
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
// rclone reads folders on SMB shares; without it the SMB choice is off.
const shares = await hasRclone(config.RCLONE_PATH);
if (!shares) app.log.info('SMB shares are off: rclone isn’t installed');
// One filesystem (this server's disk, an SSH/SFTP connection, or an SMB share) per folder source.
const folders = new FolderAccess(store, {
  ffmpeg: config.FFMPEG_PATH,
  fpcalc: config.FPCALC_PATH,
  localFingerprints: fingerprints,
  rclone: shares ? config.RCLONE_PATH : undefined,
});
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
    searchArtists: (name) => musicbrainz.searchArtists(name, undefined, { background: true }),
    searchReleasesOfArtist: (artistMbid, album) => musicbrainz.searchReleasesOfArtist(artistMbid, album, undefined, { background: true }),
  },
  acoustid: new AcoustId(() => store.appSetting(ACOUSTID_KEY) || undefined),
  fingerprint: (sourceId, path) => folders.get(sourceId)?.fingerprint?.(path) ?? Promise.resolve(null),
  // Matches only change how scanned files are read: rebuild from the last scan, don't scan again.
  onMatched: () => library.rebuildSoon(),
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
// One DSP worker for the whole server: analysis and transition rendering take turns on it.
const dsp = new DspThread();
// The beat model (beats and bars for DJ mix) in a thread of its own, started only while songs are analysed.
const beatModel = new BeatModelThread({
  onError: (reason) => app.log.warn({ reason }, 'the beat model can’t run here: beats come from the onset analysis'),
});
const analyzer = new Analyzer(db, library, files, { enabled: config.ANALYSIS === 'on', log: app.log, dsp, beats: beatModel });
// DJ mix: transitions rendered to cached files. They're planned from mix maps, which only audio
// analysis makes; without it the player is told "unavailable" and crossfades as before.
const transitions = analyzer.canAnalyzeAudio
  ? new Transitions({
      library,
      files,
      maps: analyzer,
      dsp,
      cacheDir: resolve(config.CACHE_DIR),
      ffmpegPath: config.FFMPEG_PATH,
      log: app.log,
      maxBytes: config.TRANSITIONS_CACHE_MB * 1024 * 1024,
    })
  : undefined;
// The cache's index from disk, so transitions rendered before a restart are served, not made again.
await transitions?.load().catch((err: unknown) => app.log.warn({ err }, 'transition cache could not be read'));
const covers = new PlaylistCovers(analyzer, library, resolve(config.CACHE_DIR, 'covers'));
const playlists = new Playlists(db, library, covers);
// Made for you: mixes generated from the library and what's been played.
const history = new History(db, library);
// Who signs in: accounts with device sessions, and setup codes for first passwords.
const accounts = new Accounts(db);
const sessions = new Sessions(db);
const setupCodes = new SetupCodes(db);
const mixes = new Mixes({ db, store, library, analyzer, history, playlists, log: app.log, accounts: () => accounts.ids() });
mixes.start();
const scrobbler = new Scrobbler(db, store, library, { log: app.log, accounts: () => accounts.ids() });
scrobbler.start();
// Settings → Requests, read fresh each time so a change applies at once; .env values are the fallback.
const requestSettings = () => readRequestSettings(store);
const requests = new Requests(lidarr, musicbrainz, library, resolve(config.CACHE_DIR, 'requests.json'), requestSettings, {
  rootFolderPath: config.LIDARR_ROOT_FOLDER,
  qualityProfileId: config.LIDARR_QUALITY_PROFILE_ID,
  metadataProfileId: config.LIDARR_METADATA_PROFILE_ID,
});
const discover = new Discover(lidarr, musicbrainz, library, requests);
const recommendations = new Recommendations(playlists, library, requests, musicbrainz);

// Every request's account (req.auth), from a Bearer token or the session cookie; 401 once set up.
app.decorateRequest('auth', null);
app.addHook('onRequest', authHook({ accounts, sessions }));
authRoutes(app, { accounts, sessions, setupCodes });
accountRoutes(app, { accounts, sessions, setupCodes, publicUrl: config.PUBLIC_URL });
apiRoutes(app, { config, lidarr, library, media, requestSettings });
metadataRoutes(app, { store, library, pathMap: config.pathMap, features: (ids) => analyzer.features(ids), matcher, lidarr });
artRoutes(app, { art, cacheDir: resolve(config.CACHE_DIR), library, files, folders });
streamRoutes(app, { library, files, loudness: analyzer });
levelRoutes(app, { analyzer, library });
// New cue points make new plans: the transitions made from the old ones are deleted.
mixMapRoutes(app, {
  analyzer,
  library,
  onCuesChanged: transitions && ((recordingId) => transitions.forget(recordingId)),
  libraryScan: () => readMixSettings(store).analyzeLibrary,
});
transitionRoutes(app, { transitions, unavailableReason: 'DJ mixing needs audio analysis, which is off on this server' });
lyricsRoutes(app, { lyrics: new LyricsService(db, library, files, { log: app.log }) });
discoverRoutes(app, { discover, requests });
favoriteRoutes(app, { favorites, library });
playlistRoutes(app, { playlists, recommendations, covers });
mixRoutes(app, {
  mixes,
  history,
  store,
  analysisAvailable: analyzer.canAnalyzeAudio,
  analyzeLibrary: () => void analyzer.analyzeLibrary().catch((err: unknown) => app.log.warn({ err }, 'queueing the library for analysis failed')),
  library,
  scrobbler,
  db,
});
// Settings → Updates: files shared with the updater container (UPDATE_DIR, set by docker/compose.yaml).
const updates = new UpdateBridge(config.UPDATE_DIR);
settingsRoutes(app, { sources, library, matcher, store, organizer, fingerprints, shares, lidarr, updates });
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
    const isApi = /^\/(api|stream|art|transitions)\//.test(req.url);
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
  analyzer.close();
  // A render a moment from done is let finish (its file is then complete); one that isn't is cut off.
  await Promise.race([transitions?.idle(), new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
  // Shared, so the analyzer leaves it open: closed here, once neither uses it.
  dsp.close();
  beatModel.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown).on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
app.log.info(`Sources: ${store.listSources().map((s) => s.name).join(', ') || 'none'} · media source: ${media.kind}`);
if (accounts.setupMode()) app.log.info('Nobody has set up Playarr yet: open Settings → Accounts from your home network to set the owner’s password');

// Serve the catalog saved by the last run immediately, then sync the sources in the background.
library.loadStored();
library.refresh().catch(() => {});
library.startAutoRefresh(config.LIBRARY_REFRESH_MINUTES);
watchStalls(app.log);

// Settings → Analysis → In the background: the analysis queue lives in memory, so after a restart (an
// update, say) the library's backlog is queued again, behind the songs someone is waiting for.
if (readMixSettings(store).analyzeLibrary) {
  analyzer.analyzeLibrary().then(
    (queued) => queued > 0 && app.log.info(`Library analysis: ${queued} songs queued again`),
    (err: unknown) => app.log.warn({ err }, 'queueing the library for analysis failed'),
  );
}

// Keep the artwork cache to its size: shortly after starting, then every few hours.
const trimArt = () =>
  trimArtCache(resolve(config.CACHE_DIR, 'art'), config.ART_CACHE_MB * 1024 * 1024).then(
    ({ removed, bytes }) => removed && app.log.info(`Artwork cache trimmed: ${removed} images removed, ${(bytes / 1048576).toFixed(0)} MB kept`),
    (err) => app.log.warn({ err }, 'artwork cache trim failed'),
  );
setTimeout(trimArt, 5 * 60_000).unref();
setInterval(trimArt, 6 * 3600_000).unref();
