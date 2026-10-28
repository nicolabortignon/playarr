import type {
  Album,
  AlbumDetail,
  AlbumSort,
  Artist,
  ArtistDetail,
  AudioFormat,
  LibraryStats,
  SearchResults,
  Track,
} from '@playarr/shared';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LidarrClient } from '../lidarr/client.ts';
import type { LidarrAlbum, LidarrArtist, LidarrImage, LidarrTrackFile } from '../lidarr/types.ts';
import { formatFromTrackFile, formatKey } from './format.ts';
import { albumKey, normalize, primaryArtist, scoreMatch } from './search.ts';

export interface FileRecord {
  id: number;
  path: string; // as reported by Lidarr
  size: number;
  format: AudioFormat;
}

/** What Lidarr knows about an album, keyed by MusicBrainz release-group id. */
export interface LidarrAlbumRef {
  id: number;
  monitored: boolean;
  /** True when Playarr can play it (it's in the snapshot with files). */
  playable: boolean;
}

interface Snapshot {
  artists: Map<number, Artist>;
  albums: Map<number, AlbumDetail>;
  tracks: Track[];
  files: Map<number, FileRecord>;
  stats: LibraryStats;
  albumsByMbid: Map<string, LidarrAlbumRef>;
  artistIdByMbid: Map<string, number>;
  albumIdByKey: Map<string, number>;
  trackByRecording: Map<string, Track>;
  trackByName: Map<string, Track>;
}

/** Bump when the snapshot shape changes so stale files on disk are ignored. */
const SNAPSHOT_VERSION = 2;

interface StoredSnapshot {
  version: number;
  artists: Artist[];
  albums: AlbumDetail[];
  files: FileRecord[];
  albumsByMbid: [string, LidarrAlbumRef][];
  artistIdByMbid: [string, number][];
  stats: LibraryStats;
}

export class Library {
  private snapshot: Snapshot | null = null;
  private inflight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private listeners: ((library: Library) => void)[] = [];
  lastError: string | null = null;

  constructor(
    private readonly lidarr: LidarrClient,
    private readonly log: { info: (msg: string) => void; error: (msg: string) => void },
    /** Where the last snapshot is saved, so a restart can serve instantly instead of waiting on Lidarr. */
    private readonly cacheFile?: string,
  ) {}

  /** Called after every successful refresh. */
  onRefresh(listener: (library: Library) => void) {
    this.listeners.push(listener);
  }

  /** Load the snapshot saved by a previous run, if any. Returns true when one was loaded. */
  async loadCached(): Promise<boolean> {
    if (!this.cacheFile) return false;
    try {
      const stored = JSON.parse(await readFile(this.cacheFile, 'utf8')) as StoredSnapshot;
      if (stored.version !== SNAPSHOT_VERSION) return false;
      this.snapshot = fromStored(stored);
      this.log.info(`Library loaded from cache (${stored.stats.refreshedAt}): ${stored.stats.albums} albums`);
      return true;
    } catch {
      return false;
    }
  }

  private async saveCached(snap: Snapshot) {
    if (!this.cacheFile) return;
    const stored: StoredSnapshot = {
      version: SNAPSHOT_VERSION,
      artists: [...snap.artists.values()],
      albums: [...snap.albums.values()],
      files: [...snap.files.values()],
      albumsByMbid: [...snap.albumsByMbid],
      artistIdByMbid: [...snap.artistIdByMbid],
      stats: snap.stats,
    };
    await mkdir(dirname(this.cacheFile), { recursive: true });
    await writeFile(`${this.cacheFile}.tmp`, JSON.stringify(stored));
    await rename(`${this.cacheFile}.tmp`, this.cacheFile);
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

  /** Rebuild the snapshot from Lidarr. Concurrent callers share one refresh. */
  refresh(): Promise<void> {
    this.inflight ??= this.build()
      .then((snap) => {
        this.snapshot = snap;
        this.lastError = null;
        const s = snap.stats;
        this.log.info(`Library refreshed: ${s.artists} artists, ${s.albums} albums, ${s.tracks} tracks`);
        void this.saveCached(snap).catch((err: Error) => this.log.error(`Saving library cache failed: ${err.message}`));
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
    const [lArtists, lAlbums] = await Promise.all([this.lidarr.artists(), this.lidarr.albums()]);
    const withFiles = lArtists.filter((a) => (a.statistics?.trackFileCount ?? 0) > 0);

    const perArtist = await mapLimit(withFiles, 4, async (artist) => {
      const [tracks, files] = await Promise.all([
        this.lidarr.tracksForArtist(artist.id),
        this.lidarr.trackFilesForArtist(artist.id),
      ]);
      return { artist, tracks, files };
    });

    const albumsById = new Map(lAlbums.map((a) => [a.id, a]));
    const artists = new Map<number, Artist>();
    const albums = new Map<number, AlbumDetail>();
    const files = new Map<number, FileRecord>();
    const allTracks: Track[] = [];

    for (const { artist: la, tracks: lTracks, files: lFiles } of perArtist) {
      const fileById = new Map<number, LidarrTrackFile>(lFiles.map((f) => [f.id, f]));
      for (const f of lFiles) {
        files.set(f.id, { id: f.id, path: f.path, size: f.size, format: formatFromTrackFile(f) });
      }

      const tracksByAlbum = new Map<number, Track[]>();
      for (const t of lTracks) {
        const file = t.hasFile ? fileById.get(t.trackFileId) : undefined;
        const album = albumsById.get(t.albumId);
        if (!file || !album) continue;
        const track: Track = {
          id: t.id,
          recordingId: t.foreignRecordingId || `track:${t.id}`,
          fileId: file.id,
          albumId: album.id,
          artistId: la.id,
          title: t.title,
          artistName: la.artistName,
          albumTitle: album.title,
          trackNumber: Number.parseInt(t.trackNumber, 10) || t.absoluteTrackNumber,
          discNumber: t.mediumNumber || 1,
          duration: Math.round(t.duration / 1000),
          explicit: t.explicit,
          format: files.get(file.id)!.format,
          size: file.size,
          streamUrl: `/stream/${file.id}`,
          coverUrl: artUrl('album', album.id, 'cover', album.images),
        };
        let list = tracksByAlbum.get(album.id);
        if (!list) tracksByAlbum.set(album.id, (list = []));
        list.push(track);
      }

      let artistTrackCount = 0;
      for (const [albumId, tracks] of tracksByAlbum) {
        tracks.sort((a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber);
        const la2 = albumsById.get(albumId)!;
        const albumFiles = tracks.map((t) => fileById.get(t.fileId)!);
        albums.set(albumId, toAlbumDetail(la2, la, tracks, albumFiles));
        allTracks.push(...tracks);
        artistTrackCount += tracks.length;
      }

      const artistAlbumCount = tracksByAlbum.size;
      if (artistAlbumCount > 0) {
        const artist = toArtist(la, artistAlbumCount, artistTrackCount);
        // Lidarr's metadata has no photo for some artists; fall back to their newest album cover.
        artist.imageUrl ??= [...tracksByAlbum.keys()]
          .map((id) => albums.get(id)!)
          .sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))
          .find((a) => a.coverUrl)?.coverUrl;
        artists.set(la.id, artist);
      }
    }

    const albumsByMbid = new Map<string, LidarrAlbumRef>(
      lAlbums.map((a) => [a.foreignAlbumId, { id: a.id, monitored: a.monitored, playable: albums.has(a.id) }]),
    );
    const artistIdByMbid = new Map<string, number>(
      lArtists.filter((a) => artists.has(a.id)).map((a) => [a.foreignArtistId, a.id]),
    );

    const albumIdByKey = new Map<string, number>(
      [...albums.values()].map((a) => [albumKey(a.artistName, a.title), a.id]),
    );

    let durationSeconds = 0;
    let sizeBytes = 0;
    for (const t of allTracks) {
      durationSeconds += t.duration;
      sizeBytes += t.size;
    }

    return {
      artists,
      albums,
      tracks: allTracks,
      files,
      albumsByMbid,
      artistIdByMbid,
      albumIdByKey,
      trackByRecording: indexByRecording(allTracks),
      trackByName: indexByName(allTracks),
      stats: {
        artists: artists.size,
        albums: albums.size,
        tracks: allTracks.length,
        durationSeconds,
        sizeBytes,
        refreshedAt: new Date().toISOString(),
      },
    };
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

function artUrl(
  kind: 'artist' | 'album',
  id: number,
  type: string,
  images: LidarrImage[],
): string | undefined {
  const img = images.find((i) => i.coverType === type);
  if (!img) return undefined;
  // Lidarr appends ?lastWrite=… to local artwork URLs; reuse it for cache busting.
  const version = img.url?.match(/lastWrite=(\d+)/)?.[1];
  return `/art/${kind}/${id}/${type}${version ? `?v=${version}` : ''}`;
}

function toArtist(la: LidarrArtist, albumCount: number, trackCount: number): Artist {
  return {
    id: la.id,
    name: la.artistName,
    sortName: la.sortName || la.artistName,
    genres: la.genres ?? [],
    overview: la.overview || undefined,
    albumCount,
    trackCount,
    imageUrl: artUrl('artist', la.id, 'poster', la.images),
    fanartUrl: artUrl('artist', la.id, 'fanart', la.images),
    logoUrl: artUrl('artist', la.id, 'clearlogo', la.images),
  };
}

function toAlbumDetail(
  la: LidarrAlbum,
  artist: LidarrArtist,
  tracks: Track[],
  files: LidarrTrackFile[],
): AlbumDetail {
  // Pick the most common format so mixed-quality albums still get a sensible badge.
  const counts = new Map<string, { format: AudioFormat; n: number }>();
  for (const t of tracks) {
    const key = formatKey(t.format);
    const entry = counts.get(key) ?? { format: t.format, n: 0 };
    entry.n++;
    counts.set(key, entry);
  }
  const format = [...counts.values()].sort((a, b) => b.n - a.n)[0]?.format;
  const addedAt = files.map((f) => f.dateAdded).sort().at(-1);
  const year = la.releaseDate ? new Date(la.releaseDate).getUTCFullYear() : undefined;

  return {
    id: la.id,
    title: la.title,
    artistId: artist.id,
    artistName: artist.artistName,
    year: year && year > 1000 ? year : undefined,
    releaseDate: la.releaseDate,
    albumType: la.albumType,
    secondaryTypes: la.secondaryTypes ?? [],
    genres: la.genres?.length ? la.genres : (artist.genres ?? []).slice(0, 3),
    duration: tracks.reduce((sum, t) => sum + t.duration, 0),
    trackCount: tracks.length,
    totalTrackCount: la.statistics?.totalTrackCount ?? tracks.length,
    coverUrl: artUrl('album', la.id, 'cover', la.images),
    addedAt,
    format,
    overview: la.overview || undefined,
    tracks,
    discCount: new Set(tracks.map((t) => t.discNumber)).size,
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

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function fromStored(stored: StoredSnapshot): Snapshot {
  const albums = new Map(stored.albums.map((a) => [a.id, a]));
  return {
    artists: new Map(stored.artists.map((a) => [a.id, a])),
    albums,
    tracks: stored.albums.flatMap((a) => a.tracks),
    files: new Map(stored.files.map((f) => [f.id, f])),
    stats: stored.stats,
    albumsByMbid: new Map(stored.albumsByMbid),
    artistIdByMbid: new Map(stored.artistIdByMbid),
    albumIdByKey: new Map(stored.albums.map((a) => [albumKey(a.artistName, a.title), a.id])),
    trackByRecording: indexByRecording(stored.albums.flatMap((a) => a.tracks)),
    trackByName: indexByName(stored.albums.flatMap((a) => a.tracks)),
  };
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
