import {
  hasFidelity,
  type Album,
  type AlbumDetail,
  type AlbumFilters,
  type AlbumPage,
  type AlbumSort,
  type Artist,
  type ArtistDetail,
  type ArtistPage,
  type Fidelity,
  type LibraryStats,
  type SearchResults,
  type Track,
} from '@playarr/shared';
import { randomBytes } from 'node:crypto';
import { buildCatalog, type Catalog, type FileRecord, type LidarrAlbumRef } from '../catalog/build.ts';
import type { CatalogRows, CatalogStore } from '../catalog/store.ts';
import { SourceLocks } from '../catalog/sourceLocks.ts';
import type { CatalogSource } from '../catalog/types.ts';
import { coverImage, type CoverImage } from './coverColorStore.ts';
import type { CoverColors } from './coverColors.ts';
import { albumKey, baseTitle, matchScorer, nearScorer, normalize, primaryArtist } from './search.ts';

export type { FileRecord, LidarrAlbumRef };

/** The sources a view shows (Settings → Accounts), or null for every source. */
export type SourceFilter = readonly number[] | null;

/** Albums' cover colors by image key (`coverImage`), and word of each cover read (CoverColorStore). */
export interface CoverColorSource {
  get(key: string): CoverColors | undefined;
  onRead(listener: (key: string, colors: CoverColors | undefined) => void): void;
}

/**
 * Every name search looks at, normalized once when the snapshot is built rather than for every song on every
 * search (100,000 songs made each search take over 100 ms). Lined up with the lists they name.
 */
interface SearchIndex {
  artists: Artist[];
  artistNames: string[];
  albums: AlbumDetail[];
  albumTitles: string[];
  /** "artist title", as one text. */
  albumFull: string[];
  /** Lined up with the snapshot's tracks. */
  trackTitles: string[];
  trackFull: string[];
}

export interface Snapshot extends Catalog {
  albumIdByKey: Map<string, number>;
  trackById: Map<number, Track>;
  trackByRecording: Map<string, Track>;
  trackByName: Map<string, Track>;
  /** Artists with a MusicBrainz id by normalized name: the first of each name, as artistByName finds it. */
  artistByName: Map<string, { id: number; mbid: string }>;
  /** `album/<id>` and `artist/<id>` of every /art/… URL the snapshot's albums and artists use. */
  artwork: Set<string>;
  /** The albums whose cover each image is (by `coverImage` key), to color them when it's read. */
  albumsByCover: Map<string, AlbumDetail[]>;
  search: SearchIndex;
  /** The albums in each order lists ask for, and the artists A to Z: sorted once, when first asked for. */
  sorted: {
    albums: Map<AlbumSort, AlbumDetail[]>;
    artists?: Artist[];
    /** The albums in an order, filtered (filterKey), kept for the filters asked for most recently. */
    filtered: Map<string, AlbumDetail[]>;
    filters?: AlbumFilters;
  };
}

/** Tells this run of the server from the last in the versions it hands out: the library's version starts over at each start. */
const RUN = randomBytes(4).toString('hex');

/** Compares as `localeCompare` does, without making a collator for every comparison (a 10,000-album sort makes ~150,000). */
const collator = new Intl.Collator();
/** Ignoring case and accents, as artists are sorted. */
const byBase = new Intl.Collator(undefined, { sensitivity: 'base' });

/**
 * The library as someone may see it. The Library itself shows every source; `library.view(sources)`
 * shows only the songs with a copy in those sources, built from those copies alone, so albums, artists,
 * search, files and artwork outside them don't exist for whoever reads it (an account's library access).
 */
export abstract class LibraryView {
  /** Goes up with every new snapshot, so others can tell when what they derived from it is out of date. */
  abstract readonly version: number;
  /** Goes up with every cover whose colors are read (albums and their songs carry them, outside of any snapshot). */
  protected abstract readonly painted: number;
  /** The sources shown, in id order; null for every source. */
  abstract readonly sources: SourceFilter;
  /** The snapshot, waiting for the first one if need be. */
  protected abstract ready(): Promise<Snapshot>;
  /** The snapshot, if there is one yet, without waiting. */
  protected abstract current(): Snapshot | null;
  /** The snapshot built so far, without building one (even if it's out of date). */
  protected abstract existing(): Snapshot | null;

  /**
   * The library's version as clients see it, in pages of a list (AlbumPage.version): another snapshot, or another run
   * of the server, makes another.
   */
  get listVersion(): string {
    return `${RUN}.${this.version}`;
  }

  /**
   * Names what this view's albums or artists list says now, for an ETag, once there's a library to list: it changes
   * with the snapshot, the server's run and (for albums, which carry their covers' colors) every cover read, and
   * differs between views, as another account's sources make another library.
   */
  async listTag(list: 'albums' | 'artists'): Promise<string> {
    await this.ready();
    return [list, this.listVersion, ...(list === 'albums' ? [this.painted] : []), ...(this.sources ? [this.sources.join('.')] : [])].join('-');
  }

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

  /** Whether this image (a `coverImage` key) is the cover of an album here, without waiting for the library. */
  hasCover(key: string): boolean {
    return this.current()?.albumsByCover.has(key) ?? false;
  }

  /**
   * A refresh found nothing new: the snapshot built so far, if any, says it's as recent as the last sync of the
   * sources it shows (`sources`: every source, as the library has them).
   */
  restamp(sources: readonly { id: number; lastSyncAt?: string }[]) {
    const snap = this.existing();
    if (!snap) return;
    const shown = this.sources && new Set(this.sources);
    const at = sources.flatMap((s) => (s.lastSyncAt && (!shown || shown.has(s.id)) ? [s.lastSyncAt] : [])).sort().at(-1);
    if (at) snap.stats = { ...snap.stats, refreshedAt: at };
  }

  /** A cover was just read: the albums it's the cover of, and their songs, take its colors at once. True if there were any. */
  colorCover(key: string, colors: CoverColors | undefined): boolean {
    const albums = this.existing()?.albumsByCover.get(key) ?? [];
    for (const album of albums) paint(album, colors);
    return albums.length > 0;
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
    return (await this.ready()).artistByName.get(normalize(name));
  }

  async stats(): Promise<LibraryStats | undefined> {
    return this.current()?.stats;
  }

  async artists(): Promise<Artist[]> {
    return [...sortedArtists(await this.ready())];
  }

  /** One page of the artists, A to Z, and how many there are in all. */
  async artistPage(offset: number, limit: number): Promise<ArtistPage> {
    const all = sortedArtists(await this.ready());
    return { artists: all.slice(offset, offset + limit), total: all.length, version: this.listVersion };
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

  async albums(sort: AlbumSort = 'artist', limit?: number, filter: AlbumFilter = {}): Promise<Album[]> {
    const sorted = filteredAlbums(await this.ready(), sort, filter);
    return (limit ? sorted.slice(0, limit) : sorted).map(stripAlbum);
  }

  /** One page of the albums in this order (those the filter finds), and how many there are in all. */
  async albumPage(sort: AlbumSort, offset: number, limit: number, filter: AlbumFilter = {}): Promise<AlbumPage> {
    const sorted = filteredAlbums(await this.ready(), sort, filter);
    return { albums: sorted.slice(offset, offset + limit).map(stripAlbum), total: sorted.length, version: this.listVersion };
  }

  /** What the albums can be filtered by, each with how many albums it finds. */
  async albumFilters(): Promise<AlbumFilters> {
    const snap = await this.ready();
    return (snap.sorted.filters ??= albumFiltersOf(snap.albums.values()));
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

  /** The copies of this copy's song that this library has, best first (itself alone when it's the only one). */
  async copiesOf(fileId: number): Promise<FileRecord[]> {
    const snap = await this.ready();
    const file = snap.files.get(fileId);
    if (!file) return [];
    return (file.trackId !== undefined && snap.copies.get(file.trackId)) || [file];
  }

  async search(query: string, limit = 20): Promise<SearchResults> {
    const snap = await this.ready();
    const q = normalize(query);
    if (!q) return { artists: [], albums: [], tracks: [] };
    const { search: index } = snap;

    const exact = matchScorer(q);
    const found: SearchResults = {
      artists: best(index.artists, [index.artistNames], exact, limit),
      albums: best(index.albums, [index.albumTitles, index.albumFull], exact, limit).map(stripAlbum),
      tracks: best(snap.tracks, [index.trackTitles, index.trackFull], exact, limit),
    };
    if (found.artists.length || found.albums.length || found.tracks.length) return found;

    // Nothing as typed: what's a letter or two away, for a typo ("radiohed"). Only then, as it reads every name.
    const close = nearScorer(q);
    const near: SearchResults = {
      artists: best(index.artists, [index.artistNames], close, limit),
      albums: best(index.albums, [index.albumFull], close, limit).map(stripAlbum),
      tracks: best(snap.tracks, [index.trackFull], close, limit),
    };
    return near.artists.length || near.albums.length || near.tracks.length ? { ...near, near: true } : found;
  }
}

/**
 * The `limit` items scoring highest on any of their texts (each list of `texts` lined up with `items`), best first,
 * in the items' own order where scores tie; none scoring 0.
 */
function best<T>(items: T[], texts: string[][], score: (text: string) => number, limit: number): T[] {
  const hits: { index: number; score: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    let top = 0;
    for (const list of texts) top = Math.max(top, score(list[i]!));
    if (top > 0) hits.push({ index: i, score: top });
  }
  return hits
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((hit) => items[hit.index]!);
}

/** The whole library: every enabled source, synced into the catalog and served from memory. */
export class Library extends LibraryView {
  readonly sources = null;
  version = 0;
  protected painted = 0;
  lastError: string | null = null;
  private snapshot: Snapshot | null = null;
  /** The rows the snapshot was built from: views build theirs from the same rows. */
  private rows: CatalogRows | null = null;
  /** The catalog's generation the rows were read at (CatalogStore.generation): while it stays, so do they. */
  private rowsGeneration = -1;
  /** One view per distinct set of sources, shared by every account with that set. */
  private readonly views = new Map<string, LibraryView>();
  private inflight: Promise<void> | null = null;
  /** Shared with the organizer: a source's sync and the moving of its files take turns. */
  readonly sourceLocks = new SourceLocks();
  private timer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private rebuildTimer: NodeJS.Timeout | null = null;
  private listeners: ((library: Library) => void)[] = [];
  private syncListeners: ((sourceId: number, error: Error | null) => void)[] = [];
  /** Sources that don't answer just now (catalog/health.ts): their copies play only where a song has no other. */
  private offline: ReadonlySet<number> = new Set();

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
      view = new SourceView(ids, {
        version: () => this.version,
        painted: () => this.painted,
        rows: () => this.rows,
        offline: () => this.offline,
        ready: () => this.ready(),
        colors: this.colors,
      });
      this.views.set(key, view);
    }
    return view;
  }

  /** Colors the library's albums and every view's. */
  override colorCover(key: string, colors: CoverColors | undefined): boolean {
    let any = super.colorCover(key, colors);
    for (const view of this.views.values()) any = view.colorCover(key, colors) || any;
    if (any) this.painted++;
    return any;
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

  /** The catalog as it is now, with the generation it's at. */
  private load(): { rows: CatalogRows; generation: number } {
    return { generation: this.store.generation, rows: this.store.load() };
  }

  private setSnapshot({ rows, generation }: { rows: CatalogRows; generation: number }) {
    this.rows = rows;
    this.rowsGeneration = generation;
    this.snapshot = toSnapshot(buildCatalog(rows, this.offline), this.colors);
    this.version++;
  }

  /**
   * These sources don't answer just now (or answer again): songs play a copy elsewhere where they have one, and the
   * library and every view are rebuilt from the rows they have, without asking the sources or the catalog.
   */
  setOffline(sources: ReadonlySet<number>) {
    const same = sources.size === this.offline.size && [...sources].every((id) => this.offline.has(id));
    if (same) return;
    this.offline = new Set(sources);
    if (!this.rows) return;
    this.setSnapshot({ rows: this.rows, generation: this.rowsGeneration });
    for (const listener of this.listeners) listener(this);
  }

  /**
   * Whether the catalog changed since the snapshot was built: a source had something new, or one was added, removed,
   * changed or moved.
   */
  private get stale(): boolean {
    return !this.snapshot || this.store.generation !== this.rowsGeneration;
  }

  /** Nothing changed: the snapshot stands, and it and every view's are as recent as the sources' syncs just now. */
  private touch() {
    if (!this.rows) return;
    const synced = this.store.syncTimes();
    // Views built from these rows later take the new times too.
    for (const source of this.rows.sources) source.lastSyncAt = synced.get(source.id) ?? source.lastSyncAt;
    this.restamp(this.rows.sources);
    for (const view of this.views.values()) view.restamp(this.rows.sources);
  }

  /** Called after every successful refresh. */
  onRefresh(listener: (library: Library) => void) {
    this.listeners.push(listener);
  }

  /** Called after each source's sync, with what went wrong if it failed. */
  onSync(listener: (sourceId: number, error: Error | null) => void) {
    this.syncListeners.push(listener);
  }

  /** Serve the catalog saved by a previous run, so a restart doesn't wait on the sources. */
  loadStored(): boolean {
    if (!this.store.hasData()) return false;
    this.setSnapshot(this.load());
    this.log.info(`Library loaded from the database: ${this.snapshot!.stats.albums} albums`);
    return true;
  }

  /** True while the sources are syncing. */
  get refreshing(): boolean {
    return this.inflight !== null;
  }

  /** Rebuild from the stored catalog without syncing, e.g. after a source was removed or reordered. */
  reload() {
    this.setSnapshot(this.load());
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
   * Sync every source (or just `only`; the others keep their last sync) into the catalog and rebuild, unless
   * nothing changed. Concurrent callers share one refresh.
   */
  refresh(only?: number): Promise<void> {
    const started = Date.now();
    this.inflight ??= this.build(only)
      .then((loaded) => {
        if (loaded) this.setSnapshot(loaded);
        else this.touch();
        this.lastError = null;
        const s = this.snapshot!.stats;
        const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
        this.log.info(
          loaded
            ? `Library refreshed: ${s.artists} artists, ${s.albums} albums, ${s.tracks} tracks in ${took}`
            : `Library refreshed, nothing changed: ${s.tracks} tracks in ${took}`,
        );
        // Listeners warm artwork and read covers' colors, trying again what failed before: they hear of every refresh.
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

  /** Sync the sources into the catalog: the catalog to build from, or null when it hasn't changed (the snapshot stands). */
  private async build(only?: number): Promise<{ rows: CatalogRows; generation: number } | null> {
    const sources = this.syncSources().filter((s) => only === undefined || s.id === only);
    const failures: Error[] = [];
    // In Settings order: later sources match their files against what earlier ones reported.
    for (const { id, source } of sources) {
      try {
        await this.sourceLocks.run(id, async () => this.store.applySync(id, await source.sync()));
        this.store.setSyncError(id, null);
        for (const listener of this.syncListeners) listener(id, null);
      } catch (err) {
        this.store.setSyncError(id, (err as Error).message);
        failures.push(err as Error);
        for (const listener of this.syncListeners) listener(id, err as Error);
      }
    }
    // One unreachable source shouldn't hide the others: its last sync stays in the catalog.
    if (failures.length && failures.length === sources.length) throw failures[0];
    for (const err of failures) this.log.error(`A source failed to sync: ${err.message}`);
    // No source had anything new, and none was added, removed, changed or moved: rebuilding 100,000 songs for
    // nothing kept the server busy for seconds every ten minutes.
    return this.stale ? this.load() : null;
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
    // Matches that change nothing the catalog holds (songs still not found, say) leave the snapshot as it is.
    if (!this.stale) return;
    this.setSnapshot(this.load());
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
      painted: () => number;
      rows: () => CatalogRows | null;
      offline: () => ReadonlySet<number>;
      ready: () => Promise<unknown>;
      colors?: CoverColorSource;
    },
  ) {
    super();
  }

  get version(): number {
    return this.library.version();
  }

  protected get painted(): number {
    return this.library.painted();
  }

  protected current(): Snapshot | null {
    const rows = this.library.rows();
    if (!rows) return null;
    const version = this.library.version();
    if (this.built?.version !== version) {
      const keep = new Set(this.sources);
      const catalog = buildCatalog({ ...rows, sources: rows.sources.filter((s) => keep.has(s.id)) }, this.library.offline());
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

/** The albums in an order lists ask for, sorted on first asking and kept with the snapshot. */
function sortedAlbums(snap: Snapshot, sort: AlbumSort): AlbumDetail[] {
  let sorted = snap.sorted.albums.get(sort);
  if (!sorted) {
    const cmp: Record<AlbumSort, (a: AlbumDetail, b: AlbumDetail) => number> = {
      title: (a, b) => collator.compare(a.title, b.title),
      artist: (a, b) => {
        const aa = snap.artists.get(a.artistId);
        const ba = snap.artists.get(b.artistId);
        return (aa && ba ? bySortName(aa, ba) : 0) || collator.compare(a.releaseDate ?? '', b.releaseDate ?? '');
      },
      year: (a, b) => collator.compare(b.releaseDate ?? '', a.releaseDate ?? ''),
      added: (a, b) => collator.compare(b.addedAt ?? '', a.addedAt ?? ''),
    };
    sorted = [...snap.albums.values()].sort(cmp[sort]);
    snap.sorted.albums.set(sort, sorted);
  }
  return sorted;
}

/** Which albums a list shows: those with this genre (in any case) and of this fidelity (see hasFidelity). */
export interface AlbumFilter {
  genre?: string;
  fidelity?: Fidelity;
}

/** Filtered lists kept per snapshot, the most recently asked for: each is an array of references, a few KB. */
const FILTERED_KEPT = 32;

/** The albums in an order that a filter finds, filtered on first asking and kept with the snapshot. */
function filteredAlbums(snap: Snapshot, sort: AlbumSort, filter: AlbumFilter): AlbumDetail[] {
  const genre = filter.genre?.trim().toLowerCase();
  const { fidelity } = filter;
  if (!genre && !fidelity) return sortedAlbums(snap, sort);
  const key = `${sort}\0${genre ?? ''}\0${fidelity ?? ''}`;
  const kept = snap.sorted.filtered;
  let found = kept.get(key);
  if (found) {
    // Most recently asked for last, so the oldest goes first.
    kept.delete(key);
  } else {
    found = sortedAlbums(snap, sort).filter(
      (album) =>
        (!genre || album.genres.some((g) => g.trim().toLowerCase() === genre)) &&
        (!fidelity || (!!album.format && hasFidelity(album.format, fidelity))),
    );
    if (kept.size >= FILTERED_KEPT) kept.delete(kept.keys().next().value!);
  }
  kept.set(key, found);
  return found;
}

const FIDELITIES: Fidelity[] = ['hi-res', 'lossless', 'lossy'];

/** The albums' genres (told apart regardless of case, named as most albums spell them) and fidelities, with counts. */
export function albumFiltersOf(albums: Iterable<AlbumDetail>): AlbumFilters {
  const genres = new Map<string, { count: number; spellings: Map<string, number> }>();
  const fidelities = new Map<Fidelity, number>();
  for (const album of albums) {
    const seen = new Set<string>();
    for (const raw of album.genres) {
      const name = raw.trim();
      const key = name.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      let genre = genres.get(key);
      if (!genre) genres.set(key, (genre = { count: 0, spellings: new Map() }));
      genre.count++;
      genre.spellings.set(name, (genre.spellings.get(name) ?? 0) + 1);
    }
    if (album.format) for (const f of FIDELITIES) if (hasFidelity(album.format, f)) fidelities.set(f, (fidelities.get(f) ?? 0) + 1);
  }
  return {
    genres: [...genres.values()]
      .map(({ count, spellings }) => ({ name: [...spellings].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]))[0]![0], count }))
      .sort((a, b) => byBase.compare(a.name, b.name)),
    fidelities: FIDELITIES.filter((f) => fidelities.has(f)).map((value) => ({ value, count: fidelities.get(value)! })),
  };
}

/** The artists A to Z, sorted on first asking and kept with the snapshot. */
function sortedArtists(snap: Snapshot): Artist[] {
  return (snap.sorted.artists ??= [...snap.artists.values()].sort(bySortName));
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
  // Names repeat (an artist's on each of their songs, "Intro" on many albums): each is normalized once.
  const normalized = new Map<string, string>();
  const norm = (s: string) => {
    let n = normalized.get(s);
    if (n === undefined) normalized.set(s, (n = normalize(s)));
    return n;
  };
  // normalize("artist title") is normalize("artist") + " " + normalize("title"): the space between them is one.
  const both = (a: string, b: string) => (a && b ? `${a} ${b}` : a || b);
  const artists = [...catalog.artists.values()];
  const albums = [...catalog.albums.values()];
  const trackTitles = catalog.tracks.map((t) => norm(t.title));
  const artistByName = new Map<string, { id: number; mbid: string }>();
  for (const [mbid, id] of catalog.artistIdByMbid) {
    const name = norm(catalog.artists.get(id)?.name ?? '');
    if (!artistByName.has(name)) artistByName.set(name, { id, mbid });
  }
  return {
    ...catalog,
    albumIdByKey: new Map(albums.map((a) => [`${norm(a.artistName)}|${norm(baseTitle(a.title) || a.title)}`, a.id])),
    trackById: new Map(catalog.tracks.map((t) => [t.id, t])),
    trackByRecording: indexByRecording(catalog.tracks),
    trackByName: indexByName(catalog.tracks, trackTitles, norm),
    artistByName,
    artwork: artworkKeys(catalog),
    albumsByCover,
    search: {
      artists,
      artistNames: artists.map((a) => norm(a.name)),
      albums,
      albumTitles: albums.map((a) => norm(a.title)),
      albumFull: albums.map((a) => both(norm(a.artistName), norm(a.title))),
      trackTitles,
      trackFull: catalog.tracks.map((t, i) => both(norm(t.artistName), trackTitles[i]!)),
    },
    sorted: { albums: new Map(), filtered: new Map() },
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
  return byBase.compare(a.sortName, b.sortName);
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

export const songKey = (artistName: string, title: string) => `${normalize(artistName)}|${normalize(title)}`;

/** Songs by artist and title, the lead artist's too (`titles` lined up with `tracks`, normalized). */
function indexByName(tracks: Track[], titles: string[], norm: (s: string) => string): Map<string, Track> {
  const map = new Map<string, Track>();
  tracks.forEach((t, i) => {
    const title = titles[i]!;
    for (const key of new Set([`${norm(t.artistName)}|${title}`, `${norm(primaryArtist(t.artistName))}|${title}`])) {
      if (!map.has(key)) map.set(key, t);
    }
  });
  return map;
}

/** First (album-ordered) track for each recording; the same song can sit on several albums. */
function indexByRecording(tracks: Track[]): Map<string, Track> {
  const map = new Map<string, Track>();
  for (const t of tracks) if (!map.has(t.recordingId)) map.set(t.recordingId, t);
  return map;
}
