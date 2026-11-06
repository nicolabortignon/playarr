import type { Album, AlbumDetail, AlbumSort, Artist, ArtistDetail, LibraryStats, SearchResults, Track } from '@playarr/shared';
import { buildCatalog, type Catalog, type FileRecord, type LidarrAlbumRef } from '../catalog/build.ts';
import type { CatalogRows, CatalogStore } from '../catalog/store.ts';
import type { CatalogSource } from '../catalog/types.ts';
import { coverImage, type CoverImage } from './coverColorStore.ts';
import type { CoverColors } from './coverColors.ts';
import { albumKey, normalize, primaryArtist, scoreMatch, scoreNearMatch } from './search.ts';

export type { FileRecord, LidarrAlbumRef };

/** The sources a view shows (Settings → Accounts), or null for every source. */
export type SourceFilter = readonly number[] | null;

/** Albums' cover colors by image key (`coverImage`), and word of each cover read (CoverColorStore). */
export interface CoverColorSource {
  get(key: string): CoverColors | undefined;
  onRead(listener: (key: string, colors: CoverColors | undefined) => void): void;
}

export interface Snapshot extends Catalog {
  albumIdByKey: Map<string, number>;
  trackById: Map<number, Track>;
  trackByRecording: Map<string, Track>;
  trackByName: Map<string, Track>;
  /** `album/<id>` and `artist/<id>` of every /art/… URL the snapshot's albums and artists use. */
  artwork: Set<string>;
  /** The albums whose cover each image is (by `coverImage` key), to color them when it's read. */
  albumsByCover: Map<string, AlbumDetail[]>;
}

/**
 * The library as someone may see it. The Library itself shows every source; `library.view(sources)`
 * shows only the songs with a copy in those sources, built from those copies alone, so albums, artists,
 * search, files and artwork outside them don't exist for whoever reads it (an account's library access).
 */
export abstract class LibraryView {
  /** Goes up with every new snapshot, so others can tell when what they derived from it is out of date. */
  abstract readonly version: number;
  /** The sources shown, in id order; null for every source. */
  abstract readonly sources: SourceFilter;
  /** The snapshot, waiting for the first one if need be. */
  protected abstract ready(): Promise<Snapshot>;
  /** The snapshot, if there is one yet, without waiting. */
  protected abstract current(): Snapshot | null;
  /** The snapshot built so far, without building one (even if it's out of date). */
  protected abstract existing(): Snapshot | null;

  /** Every album cover whose colors can be read, once each, newest albums first (for CoverColorStore's fill). */
  coverImages(): CoverImage[] {
    const snap = this.current();
    if (!snap) return [];
    const images = new Map<string, CoverImage>();
    const added = (album: AlbumDetail) => album.addedAt ?? '';
    // ISO dates sort as plain strings, much faster than localeCompare over a big library.
    for (const album of [...snap.albums.values()].sort((a, b) => (added(a) < added(b) ? 1 : added(a) > added(b) ? -1 : 0))) {
      const image = coverImage(album.coverUrl, snap.files);
      if (image && !images.has(image.key)) images.set(image.key, image);
    }
    return [...images.values()];
  }

  /** A cover was just read: the albums it's the cover of, and their songs, take its colors at once. */
  colorCover(key: string, colors: CoverColors | undefined) {
    for (const album of this.existing()?.albumsByCover.get(key) ?? []) paint(album, colors);
  }

  /** Every artwork URL the library references (for cache warming). */
  artworkUrls(): string[] {
    const snap = this.current();
    if (!snap) return [];
    const urls = [
      ...[...snap.albums.values()].map((a) => a.coverUrl),
      ...[...snap.artists.values()].flatMap((a) => [a.imageUrl, a.fanartUrl, a.logoUrl]),
    ];
    return [...new Set(urls.filter((u): u is string => !!u))];
  }

  /** Whether an album or artist of this view uses /art/<kind>/<id>/… artwork. */
  async hasArtwork(kind: 'album' | 'artist', id: number): Promise<boolean> {
    return (await this.ready()).artwork.has(`${kind}/${id}`);
  }

  async albumByMbid(mbid: string): Promise<LidarrAlbumRef | undefined> {
    return (await this.ready()).albumsByMbid.get(mbid);
  }

  async trackByRecording(recordingId: string): Promise<Track | undefined> {
    return (await this.ready()).trackByRecording.get(recordingId);
  }

  /** A library track for this song by name, e.g. a different recording (single vs. album version). */
  async trackByName(artistName: string, title: string): Promise<Track | undefined> {
    const index = (await this.ready()).trackByName;
    return index.get(songKey(artistName, title)) ?? index.get(songKey(primaryArtist(artistName), title));
  }

  /** Playable album matching an artist + title from another source (e.g. Deezer). */
  async albumIdByName(artistName: string, albumTitle: string): Promise<number | undefined> {
    return (await this.ready()).albumIdByKey.get(albumKey(artistName, albumTitle));
  }

  async artistIdByMbid(mbid: string): Promise<number | undefined> {
    return (await this.ready()).artistIdByMbid.get(mbid);
  }

  /** Library artist by name (ignoring case and accents), with its MusicBrainz id. */
  async artistByName(name: string): Promise<{ id: number; mbid: string } | undefined> {
    const snap = await this.ready();
    const want = normalize(name);
    for (const [mbid, id] of snap.artistIdByMbid) {
      if (normalize(snap.artists.get(id)?.name ?? '') === want) return { id, mbid };
    }
    return undefined;
  }

  async stats(): Promise<LibraryStats | undefined> {
    return this.current()?.stats;
  }

  async artists(): Promise<Artist[]> {
    const snap = await this.ready();
    return [...snap.artists.values()].sort(bySortName);
  }

  async artist(id: number): Promise<ArtistDetail | undefined> {
    const snap = await this.ready();
    const artist = snap.artists.get(id);
    if (!artist) return undefined;
    const albums = [...snap.albums.values()]
      .filter((a) => a.artistId === id)
      .map(stripAlbum)
      .sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''));
    return { ...artist, albums };
  }

  async artistTracks(id: number): Promise<Track[]> {
    const snap = await this.ready();
    return [...snap.albums.values()]
      .filter((a) => a.artistId === id)
      .sort((a, b) => (a.releaseDate ?? '').localeCompare(b.releaseDate ?? ''))
      .flatMap((a) => a.tracks);
  }

  async albums(sort: AlbumSort = 'artist', limit?: number): Promise<Album[]> {
    const snap = await this.ready();
    const list = [...snap.albums.values()].map(stripAlbum);
    const cmp: Record<AlbumSort, (a: Album, b: Album) => number> = {
      title: (a, b) => a.title.localeCompare(b.title),
      artist: (a, b) => {
        const aa = snap.artists.get(a.artistId);
        const ba = snap.artists.get(b.artistId);
        return (aa && ba ? bySortName(aa, ba) : 0) || (a.releaseDate ?? '').localeCompare(b.releaseDate ?? '');
      },
      year: (a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''),
      added: (a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? ''),
    };
    list.sort(cmp[sort]);
    return limit ? list.slice(0, limit) : list;
  }

  async randomAlbums(count: number): Promise<Album[]> {
    const snap = await this.ready();
    return shuffle([...snap.albums.values()]).slice(0, count).map(stripAlbum);
  }

  async randomTracks(count: number): Promise<Track[]> {
    const snap = await this.ready();
    return shuffle([...snap.tracks]).slice(0, count);
  }

  async track(id: number): Promise<Track | undefined> {
    return (await this.ready()).trackById.get(id);
  }

  /** Every song in the library, album by album. */
  async allTracks(): Promise<Track[]> {
    return (await this.ready()).tracks;
  }

  /** The library's song for each recording, in this order, leaving out those no longer in the library. */
  async tracksByRecordings(ids: string[]): Promise<Track[]> {
    const index = (await this.ready()).trackByRecording;
    return ids.flatMap((id) => index.get(id) ?? []);
  }

  /** These songs, in this order, leaving out any no longer in the library. */
  async tracksByIds(ids: number[]): Promise<Track[]> {
    const index = (await this.ready()).trackById;
    return ids.flatMap((id) => index.get(id) ?? []);
  }

  async album(id: number): Promise<AlbumDetail | undefined> {
    const snap = await this.ready();
    return snap.albums.get(id);
  }

  async file(fileId: number): Promise<FileRecord | undefined> {
    const snap = await this.ready();
    return snap.files.get(fileId);
  }

  async search(query: string, limit = 20): Promise<SearchResults> {
    const snap = await this.ready();
    const q = normalize(query);
    if (!q) return { artists: [], albums: [], tracks: [] };

    const rank = <T>(items: Iterable<T>, fields: (item: T) => string[], score = scoreMatch) =>
      [...items]
        .map((item) => ({ item, score: Math.max(...fields(item).map((f) => score(q, f))) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((r) => r.item);

    const found: SearchResults = {
      artists: rank(snap.artists.values(), (a) => [a.name]),
      albums: rank(snap.albums.values(), (a) => [a.title, `${a.artistName} ${a.title}`]).map(stripAlbum),
      tracks: rank(snap.tracks, (t) => [t.title, `${t.artistName} ${t.title}`]),
    };
    if (found.artists.length || found.albums.length || found.tracks.length) return found;

    // Nothing as typed: what's a letter or two away, for a typo ("radiohed"). Only then, as it reads every name.
    const near: SearchResults = {
      artists: rank(snap.artists.values(), (a) => [a.name], scoreNearMatch),
      albums: rank(snap.albums.values(), (a) => [`${a.artistName} ${a.title}`], scoreNearMatch).map(stripAlbum),
      tracks: rank(snap.tracks, (t) => [`${t.artistName} ${t.title}`], scoreNearMatch),
    };
    return near.artists.length || near.albums.length || near.tracks.length ? { ...near, near: true } : found;
  }
}

/** The whole library: every enabled source, synced into the catalog and served from memory. */
export class Library extends LibraryView {
  readonly sources = null;
  version = 0;
  lastError: string | null = null;
  private snapshot: Snapshot | null = null;
  /** The rows the snapshot was built from: views build theirs from the same rows. */
  private rows: CatalogRows | null = null;
  /** One view per distinct set of sources, shared by every account with that set. */
  private readonly views = new Map<string, LibraryView>();
  private inflight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private rebuildTimer: NodeJS.Timeout | null = null;
  private listeners: ((library: Library) => void)[] = [];

  constructor(
    private readonly store: CatalogStore,
    /** The sources to sync, read on every refresh (Settings can change them). */
    private readonly syncSources: () => { id: number; source: CatalogSource }[],
    private readonly log: { info: (msg: string) => void; error: (msg: string) => void },
    /** Albums' and songs' cover colors; without it they have none. */
    private readonly colors?: CoverColorSource,
  ) {
    super();
    colors?.onRead((key, found) => this.colorCover(key, found));
  }

  /** The library as an account with these sources sees it; the whole library for null. */
  view(sources: SourceFilter): LibraryView {
    if (sources === null) return this;
    const ids = [...new Set(sources)].sort((a, b) => a - b);
    const key = ids.join(',');
    let view = this.views.get(key);
    if (!view) {
      view = new SourceView(ids, { version: () => this.version, rows: () => this.rows, ready: () => this.ready(), colors: this.colors });
      this.views.set(key, view);
    }
    return view;
  }

  /** Colors the library's albums and every view's. */
  override colorCover(key: string, colors: CoverColors | undefined) {
    super.colorCover(key, colors);
    for (const view of this.views.values()) view.colorCover(key, colors);
  }

  protected current(): Snapshot | null {
    return this.snapshot;
  }

  protected existing(): Snapshot | null {
    return this.snapshot;
  }

  protected async ready(): Promise<Snapshot> {
    if (!this.snapshot) await this.refresh();
    return this.snapshot!;
  }

  private setSnapshot(rows: CatalogRows) {
    this.rows = rows;
    this.snapshot = toSnapshot(buildCatalog(rows), this.colors);
    this.version++;
  }

  /** Called after every successful refresh. */
  onRefresh(listener: (library: Library) => void) {
    this.listeners.push(listener);
  }

  /** Serve the catalog saved by a previous run, so a restart doesn't wait on the sources. */
  loadStored(): boolean {
    if (!this.store.hasData()) return false;
    this.setSnapshot(this.store.load());
    this.log.info(`Library loaded from the database: ${this.snapshot!.stats.albums} albums`);
    return true;
  }

  /** True while the sources are syncing. */
  get refreshing(): boolean {
    return this.inflight !== null;
  }

  /** Rebuild from the stored catalog without syncing, e.g. after a source was removed or reordered. */
  reload() {
    this.setSnapshot(this.store.load());
    for (const listener of this.listeners) listener(this);
  }

  startAutoRefresh(minutes: number) {
    this.timer = setInterval(() => void this.refresh().catch(() => {}), minutes * 60_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Sync every source (or just `only`; the others keep their last sync) into the catalog and rebuild.
   * Concurrent callers share one refresh.
   */
  refresh(only?: number): Promise<void> {
    const started = Date.now();
    this.inflight ??= this.build(only)
      .then((rows) => {
        this.setSnapshot(rows);
        this.lastError = null;
        const s = this.snapshot!.stats;
        this.log.info(
          `Library refreshed: ${s.artists} artists, ${s.albums} albums, ${s.tracks} tracks in ${((Date.now() - started) / 1000).toFixed(1)}s`,
        );
        for (const listener of this.listeners) listener(this);
      })
      .catch((err: Error) => {
        this.lastError = err.message;
        this.log.error(`Library refresh failed: ${err.message}`);
        throw err;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async build(only?: number): Promise<CatalogRows> {
    const sources = this.syncSources().filter((s) => only === undefined || s.id === only);
    const failures: Error[] = [];
    // In Settings order: later sources match their files against what earlier ones reported.
    for (const { id, source } of sources) {
      try {
        this.store.applySync(id, await source.sync());
        this.store.setSyncError(id, null);
      } catch (err) {
        this.store.setSyncError(id, (err as Error).message);
        failures.push(err as Error);
      }
    }
    // One unreachable source shouldn't hide the others: its last sync stays in the catalog.
    if (failures.length && failures.length === sources.length) throw failures[0];
    for (const err of failures) this.log.error(`A source failed to sync: ${err.message}`);
    return this.store.load();
  }

  /**
   * Rebuild from what the sources reported last, without scanning folders or asking Lidarr again: for
   * when only matches changed. Runs after any refresh in progress.
   */
  async rebuild(): Promise<void> {
    await this.inflight?.catch(() => {});
    const started = Date.now();
    for (const { id, source } of this.syncSources()) {
      if (!source.cached) continue;
      try {
        this.store.applySync(id, source.cached());
      } catch (err) {
        this.log.error(`Rebuilding a source failed: ${(err as Error).message}`);
      }
    }
    this.setSnapshot(this.store.load());
    this.log.info(`Library rebuilt from the last scan in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    for (const listener of this.listeners) listener(this);
  }

  /** Rebuild soon (see rebuild), coalescing bursts such as matches landing album after album. */
  rebuildSoon(delayMs = 10_000) {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      void this.rebuild().catch(() => {});
    }, delayMs);
    this.rebuildTimer.unref?.();
  }

  /** Refresh soon, coalescing bursts (e.g. several downloads finishing together). */
  refreshSoon(delayMs = 3000) {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh().catch(() => {});
    }, delayMs);
  }
}

/** Some sources only: the catalog built from their copies, made once per library snapshot. */
class SourceView extends LibraryView {
  private built: { version: number; snap: Snapshot } | null = null;

  constructor(
    readonly sources: readonly number[],
    private readonly library: {
      version: () => number;
      rows: () => CatalogRows | null;
      ready: () => Promise<unknown>;
      colors?: CoverColorSource;
    },
  ) {
    super();
  }

  get version(): number {
    return this.library.version();
  }

  protected current(): Snapshot | null {
    const rows = this.library.rows();
    if (!rows) return null;
    const version = this.library.version();
    if (this.built?.version !== version) {
      const keep = new Set(this.sources);
      const catalog = buildCatalog({ ...rows, sources: rows.sources.filter((s) => keep.has(s.id)) });
      this.built = { version, snap: toSnapshot(catalog, this.library.colors) };
    }
    return this.built.snap;
  }

  protected existing(): Snapshot | null {
    return this.built?.snap ?? null;
  }

  protected async ready(): Promise<Snapshot> {
    await this.library.ready();
    return this.current()!;
  }
}

function toSnapshot(catalog: Catalog, colors?: CoverColorSource): Snapshot {
  const albumsByCover = new Map<string, AlbumDetail[]>();
  for (const album of catalog.albums.values()) {
    const key = coverImage(album.coverUrl, catalog.files)?.key;
    if (!key) continue;
    const albums = albumsByCover.get(key);
    if (albums) albums.push(album);
    else albumsByCover.set(key, [album]);
    const found = colors?.get(key);
    if (found) paint(album, found);
  }
  return {
    ...catalog,
    albumIdByKey: new Map([...catalog.albums.values()].map((a) => [albumKey(a.artistName, a.title), a.id])),
    trackById: new Map(catalog.tracks.map((t) => [t.id, t])),
    trackByRecording: indexByRecording(catalog.tracks),
    trackByName: indexByName(catalog.tracks),
    artwork: artworkKeys(catalog),
    albumsByCover,
  };
}

/** Give an album and its songs its cover's colors, or take them away (undefined: they're then left out of answers). */
function paint(album: AlbumDetail, colors: CoverColors | undefined) {
  for (const item of [album, ...album.tracks]) {
    item.coverColor = colors?.color;
    item.coverAccent = colors?.accent;
  }
}

const ART_URL = /^\/art\/(artist|album)\/(\d+)\//;

/** `album/<id>` and `artist/<id>` for the /art/… URLs the catalog's albums and artists use. */
function artworkKeys(catalog: Catalog): Set<string> {
  const keys = new Set<string>();
  const add = (url: string | undefined) => {
    const m = url?.match(ART_URL);
    if (m) keys.add(`${m[1]}/${m[2]}`);
  };
  for (const a of catalog.albums.values()) add(a.coverUrl);
  for (const a of catalog.artists.values()) for (const url of [a.imageUrl, a.fanartUrl, a.logoUrl]) add(url);
  return keys;
}

/** An album as lists show it: no tracks, text or missing songs (those are on its own page, and lists are big). */
export function stripAlbum({ tracks: _t, overview: _o, discCount: _d, missingTracks: _m, ...album }: AlbumDetail): Album {
  return album;
}

function bySortName(a: Artist, b: Artist) {
  return a.sortName.localeCompare(b.sortName, undefined, { sensitivity: 'base' });
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

export const songKey = (artistName: string, title: string) => `${normalize(artistName)}|${normalize(title)}`;

function indexByName(tracks: Track[]): Map<string, Track> {
  const map = new Map<string, Track>();
  for (const t of tracks) {
    for (const key of new Set([songKey(t.artistName, t.title), songKey(primaryArtist(t.artistName), t.title)])) {
      if (!map.has(key)) map.set(key, t);
    }
  }
  return map;
}

/** First (album-ordered) track for each recording; the same song can sit on several albums. */
function indexByRecording(tracks: Track[]): Map<string, Track> {
  const map = new Map<string, Track>();
  for (const t of tracks) if (!map.has(t.recordingId)) map.set(t.recordingId, t);
  return map;
}
