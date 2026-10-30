import type { AlbumDetail, Artist, AudioFormat, LibraryStats, Track } from '@playarr/shared';
import { formatKey } from '../library/format.ts';
import { albumKeyFor } from './keys.ts';
import type { AlbumRow, ArtistRow, CatalogRows, CopyRow } from './store.ts';

export interface FileRecord {
  id: number;
  sourceId: number;
  path: string; // as the source reports it
  size: number;
  format: AudioFormat;
}

/** A release group as Lidarr sees it (if it does), and the library album once it's playable. */
export interface LidarrAlbumRef {
  lidarrId?: number;
  monitored: boolean;
  albumId?: number;
}

export interface Catalog {
  artists: Map<number, Artist>;
  albums: Map<number, AlbumDetail>;
  tracks: Track[];
  /** Every copy on an enabled source, so saved queues can still stream a copy that's no longer the best. */
  files: Map<number, FileRecord>;
  albumsByMbid: Map<string, LidarrAlbumRef>;
  artistIdByMbid: Map<string, number>;
  stats: LibraryStats;
}

interface Ranked {
  format: AudioFormat;
  /** The source's place in the Settings list (lower comes first). */
  position: number;
}

/** Negative when `a` should play rather than `b`: lossless, bit depth, sample rate, bitrate, then source order. */
export function compareCopies(a: Ranked, b: Ranked): number {
  const fa = a.format;
  const fb = b.format;
  return (
    Number(fb.lossless) - Number(fa.lossless) ||
    (fb.bits ?? 0) - (fa.bits ?? 0) ||
    (fb.sampleRate ?? 0) - (fa.sampleRate ?? 0) ||
    (fb.bitrate ?? 0) - (fa.bitrate ?? 0) ||
    a.position - b.position
  );
}

export function buildCatalog(rows: CatalogRows): Catalog {
  const position = new Map(rows.sources.filter((s) => s.enabled).map((s) => [s.id, s.position]));
  const rank = (c: CopyRow): Ranked => ({ format: c.format, position: position.get(c.sourceId)! });

  const files = new Map<number, FileRecord>();
  const copiesByTrack = new Map<number, CopyRow[]>();
  for (const c of rows.copies) {
    if (!position.has(c.sourceId)) continue;
    files.set(c.id, { id: c.id, sourceId: c.sourceId, path: c.path, size: c.size, format: c.format });
    const list = copiesByTrack.get(c.trackId);
    if (list) list.push(c);
    else copiesByTrack.set(c.trackId, [c]);
  }

  const artistRows = new Map(rows.artists.map((a) => [a.id, a]));
  const albumRows = new Map(rows.albums.map((a) => [a.id, a]));

  const byAlbum = new Map<number, { tracks: Track[]; added: string[] }>();
  for (const t of rows.tracks) {
    const copies = copiesByTrack.get(t.id);
    const album = albumRows.get(t.albumId);
    const artist = album && artistRows.get(album.artistId);
    if (!copies || !album || !artist) continue;
    const copy = copies.reduce((best, c) => (compareCopies(rank(c), rank(best)) < 0 ? c : best));
    const track: Track = {
      id: t.id,
      recordingId: t.recordingId,
      fileId: copy.id,
      albumId: album.id,
      artistId: artist.id,
      title: t.meta.title,
      artistName: artist.meta.name,
      albumTitle: album.meta.title,
      trackNumber: t.meta.trackNumber,
      discNumber: t.meta.discNumber,
      duration: t.meta.duration,
      explicit: t.meta.explicit,
      format: copy.format,
      size: copy.size,
      streamUrl: `/stream/${copy.id}`,
      coverUrl: album.meta.coverUrl,
    };
    let entry = byAlbum.get(album.id);
    if (!entry) byAlbum.set(album.id, (entry = { tracks: [], added: [] }));
    entry.tracks.push(track);
    for (const c of copies) if (c.addedAt) entry.added.push(c.addedAt);
  }

  const albums = new Map<number, AlbumDetail>();
  const tracks: Track[] = [];
  const albumIdsByArtist = new Map<number, number[]>();
  for (const [albumId, entry] of [...byAlbum].sort(([a], [b]) => a - b)) {
    entry.tracks.sort((a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber);
    const row = albumRows.get(albumId)!;
    const artist = artistRows.get(row.artistId)!;
    albums.set(albumId, toAlbumDetail(row, artist, entry.tracks, entry.added));
    tracks.push(...entry.tracks);
    const ids = albumIdsByArtist.get(artist.id) ?? [];
    ids.push(albumId);
    albumIdsByArtist.set(artist.id, ids);
  }

  const artists = new Map<number, Artist>();
  const artistIdByMbid = new Map<string, number>();
  for (const [artistId, albumIds] of albumIdsByArtist) {
    const row = artistRows.get(artistId)!;
    artists.set(artistId, toArtist(row, albumIds.map((id) => albums.get(id)!)));
    if (row.meta.mbid) artistIdByMbid.set(row.meta.mbid, artistId);
  }

  // Playable albums by release group, then Lidarr's own list (owned or not) on top.
  const albumsByMbid = new Map<string, LidarrAlbumRef>();
  for (const album of albums.values()) {
    const mbid = albumRows.get(album.id)!.meta.mbid;
    if (mbid) albumsByMbid.set(mbid, { monitored: false, albumId: album.id });
  }
  const albumIdByKey = new Map(rows.albums.map((a) => [a.key, a.id]));
  for (const source of rows.sources) {
    if (!position.has(source.id)) continue;
    for (const la of source.state.lidarrAlbums ?? []) {
      const id = albumIdByKey.get(albumKeyFor(la.mbid, '', ''));
      albumsByMbid.set(la.mbid, {
        lidarrId: la.lidarrId,
        monitored: la.monitored,
        albumId: id !== undefined && albums.has(id) ? id : undefined,
      });
    }
  }

  let durationSeconds = 0;
  let sizeBytes = 0;
  for (const t of tracks) {
    durationSeconds += t.duration;
    sizeBytes += t.size;
  }
  const lastSync = rows.sources.flatMap((s) => (s.lastSyncAt ? [s.lastSyncAt] : [])).sort().at(-1);

  return {
    artists,
    albums,
    tracks,
    files,
    albumsByMbid,
    artistIdByMbid,
    stats: {
      artists: artists.size,
      albums: albums.size,
      tracks: tracks.length,
      durationSeconds,
      sizeBytes,
      refreshedAt: lastSync ?? new Date().toISOString(),
    },
  };
}

function toArtist(row: ArtistRow, albums: AlbumDetail[]): Artist {
  const m = row.meta;
  return {
    id: row.id,
    name: m.name,
    sortName: m.sortName,
    genres: m.genres,
    overview: m.overview,
    albumCount: albums.length,
    trackCount: albums.reduce((n, a) => n + a.tracks.length, 0),
    // Lidarr's metadata has no photo for some artists; fall back to their newest album cover.
    imageUrl:
      m.imageUrl ??
      [...albums]
        .sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))
        .find((a) => a.coverUrl)?.coverUrl,
    fanartUrl: m.fanartUrl,
    logoUrl: m.logoUrl,
  };
}

function toAlbumDetail(row: AlbumRow, artist: ArtistRow, tracks: Track[], added: string[]): AlbumDetail {
  const m = row.meta;
  const year = m.releaseDate ? new Date(m.releaseDate).getUTCFullYear() : undefined;
  return {
    id: row.id,
    title: m.title,
    artistId: artist.id,
    artistName: artist.meta.name,
    year: year && year > 1000 ? year : undefined,
    releaseDate: m.releaseDate,
    albumType: m.albumType,
    secondaryTypes: m.secondaryTypes,
    genres: m.genres.length ? m.genres : artist.meta.genres.slice(0, 3),
    duration: tracks.reduce((sum, t) => sum + t.duration, 0),
    trackCount: tracks.length,
    totalTrackCount: m.totalTrackCount ?? tracks.length,
    coverUrl: m.coverUrl,
    addedAt: added.sort().at(-1),
    format: mostCommonFormat(tracks),
    overview: m.overview,
    tracks,
    discCount: new Set(tracks.map((t) => t.discNumber)).size,
  };
}

/** The most common format, so mixed-quality albums still get a sensible badge. */
function mostCommonFormat(tracks: Track[]): AudioFormat | undefined {
  const counts = new Map<string, { format: AudioFormat; n: number }>();
  for (const t of tracks) {
    const key = formatKey(t.format);
    const entry = counts.get(key) ?? { format: t.format, n: 0 };
    entry.n++;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.format;
}
