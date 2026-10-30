import type {
  Album,
  AlbumDetail,
  AlbumSort,
  Artist,
  ArtistDetail,
  LibraryStats,
  SearchResults,
  Track,
} from '@playarr/shared';
import { buildCatalog, type Catalog, type FileRecord, type LidarrAlbumRef } from '../catalog/build.ts';
import type { CatalogStore } from '../catalog/store.ts';
import type { CatalogSource } from '../catalog/types.ts';
import { albumKey, normalize, primaryArtist, scoreMatch } from './search.ts';

export type { FileRecord, LidarrAlbumRef };

interface Snapshot extends Catalog {
  albumIdByKey: Map<string, number>;
  trackByRecording: Map<string, Track>;
  trackByName: Map<string, Track>;
}

export class Library {
  private snapshot: Snapshot | null = null;
  private inflight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private listeners: ((library: Library) => void)[] = [];
  lastError: string | null = null;

  constructor(
    private readonly store: CatalogStore,
    /** The sources to sync, read on every refresh (Settings can change them). */
    private readonly sources: () => { id: number; source: CatalogSource }[],
    private readonly log: { info: (msg: string) => void; error: (msg: string) => void },
  ) {}

  /** Called after every successful refresh. */
  onRefresh(listener: (library: Library) => void) {
    this.listeners.push(listener);
  }

  /** Serve the catalog saved by a previous run, so a restart doesn't wait on the sources. */
  loadStored(): boolean {
    if (!this.store.hasData()) return false;
    this.snapshot = toSnapshot(buildCatalog(this.store.load()));
    this.log.info(`Library loaded from the database: ${this.snapshot.stats.albums} albums`);
    return true;
  }

  /** True while the sources are syncing. */
  get refreshing(): boolean {
    return this.inflight !== null;
  }

  /** Rebuild from the stored catalog without syncing, e.g. after a source was removed or reordered. */
  reload() {
    this.snapshot = toSnapshot(buildCatalog(this.store.load()));
    for (const listener of this.listeners) listener(this);
  }

  /** Every artwork URL the library references (for cache warming). */
  artworkUrls(): string[] {
    const snap = this.snapshot;
    if (!snap) return [];
    const urls = [
      ...[...snap.albums.values()].map((a) => a.coverUrl),
      ...[...snap.artists.values()].flatMap((a) => [a.imageUrl, a.fanartUrl, a.logoUrl]),
    ];
    return [...new Set(urls.filter((u): u is string => !!u))];
  }

  startAutoRefresh(minutes: number) {
    this.timer = setInterval(() => void this.refresh().catch(() => {}), minutes * 60_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Sync every source into the catalog and rebuild. Concurrent callers share one refresh. */
  refresh(): Promise<void> {
    this.inflight ??= this.build()
      .then((snap) => {
        this.snapshot = snap;
        this.lastError = null;
        const s = snap.stats;
        this.log.info(`Library refreshed: ${s.artists} artists, ${s.albums} albums, ${s.tracks} tracks`);
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

  private async ready(): Promise<Snapshot> {
    if (!this.snapshot) await this.refresh();
    return this.snapshot!;
  }

  private async build(): Promise<Snapshot> {
    const results = await Promise.allSettled(
      this.sources().map(async ({ id, source }) => {
        try {
          this.store.applySync(id, await source.sync());
          this.store.setSyncError(id, null);
        } catch (err) {
          this.store.setSyncError(id, (err as Error).message);
          throw err;
        }
      }),
    );
    const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as Error] : []));
    // One unreachable source shouldn't hide the others: its last sync stays in the catalog.
    if (failures.length && failures.length === results.length) throw failures[0];
    for (const err of failures) this.log.error(`A source failed to sync: ${err.message}`);
    return toSnapshot(buildCatalog(this.store.load()));
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

  /** Refresh soon, coalescing bursts (e.g. several downloads finishing together). */
  refreshSoon(delayMs = 3000) {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh().catch(() => {});
    }, delayMs);
  }

  async stats(): Promise<LibraryStats | undefined> {
    return this.snapshot?.stats;
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

    const rank = <T>(items: Iterable<T>, fields: (item: T) => string[]) =>
      [...items]
        .map((item) => ({ item, score: Math.max(...fields(item).map((f) => scoreMatch(q, f))) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((r) => r.item);

    return {
      artists: rank(snap.artists.values(), (a) => [a.name]),
      albums: rank(snap.albums.values(), (a) => [a.title, `${a.artistName} ${a.title}`]).map(stripAlbum),
      tracks: rank(snap.tracks, (t) => [t.title, `${t.artistName} ${t.title}`]),
    };
  }
}

function toSnapshot(catalog: Catalog): Snapshot {
  return {
    ...catalog,
    albumIdByKey: new Map([...catalog.albums.values()].map((a) => [albumKey(a.artistName, a.title), a.id])),
    trackByRecording: indexByRecording(catalog.tracks),
    trackByName: indexByName(catalog.tracks),
  };
}

function stripAlbum({ tracks: _t, overview: _o, discCount: _d, ...album }: AlbumDetail): Album {
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
