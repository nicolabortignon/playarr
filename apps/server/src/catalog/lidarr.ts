import { formatFromTrackFile } from '../library/format.ts';
import type { LidarrClient } from '../lidarr/client.ts';
import type { LidarrImage, LidarrTrack, LidarrTrackFile } from '../lidarr/types.ts';
import { albumKeyFor, artistKeyFor, trackKeyFor } from './keys.ts';
import type { CatalogSource, SourceSync } from './types.ts';

/** Lidarr's library as a catalog source: validated MusicBrainz metadata, files as Lidarr imported them. */
export class LidarrSource implements CatalogSource {
  readonly kind = 'lidarr' as const;
  /** File lengths, by track file id and size, for songs MusicBrainz has no length for. */
  private readonly fileLengths = new Map<string, number>();

  constructor(private readonly lidarr: LidarrClient) {}

  async sync(): Promise<SourceSync> {
    const [lArtists, lAlbums] = await Promise.all([this.lidarr.artists(), this.lidarr.albums()]);
    const withFiles = lArtists.filter((a) => (a.statistics?.trackFileCount ?? 0) > 0);
    const perArtist = await mapLimit(withFiles, 4, async (artist) => {
      const [tracks, files] = await Promise.all([
        this.lidarr.tracksForArtist(artist.id),
        this.lidarr.trackFilesForArtist(artist.id),
      ]);
      return { artist, tracks, files };
    });

    await this.measureUntimed(perArtist);

    const albumsById = new Map(lAlbums.map((a) => [a.id, a]));
    const sync: SourceSync = {
      artists: [],
      albums: [],
      tracks: [],
      copies: [],
      metaRank: 0,
      lidarrAlbums: lAlbums.map((a) => ({ mbid: a.foreignAlbumId, lidarrId: a.id, monitored: a.monitored })),
    };

    for (const { artist: la, tracks, files } of perArtist) {
      const artistKey = artistKeyFor(la.foreignArtistId, la.artistName);
      const fileById = new Map<number, LidarrTrackFile>(files.map((f) => [f.id, f]));
      const albumsSeen = new Set<number>();
      const trackKeys = new Set<string>();

      // Albums with at least one file; all their songs are reported, so the missing ones show greyed out.
      const owned = new Set(tracks.filter((t) => t.hasFile && fileById.has(t.trackFileId)).map((t) => t.albumId));
      for (const t of tracks) {
        const album = albumsById.get(t.albumId);
        if (!album || !owned.has(album.id)) continue;
        const file = t.hasFile ? fileById.get(t.trackFileId) : undefined;
        const albumKey = albumKeyFor(album.foreignAlbumId, la.artistName, album.title);
        if (!albumsSeen.has(album.id)) {
          albumsSeen.add(album.id);
          sync.albums.push({
            key: albumKey,
            preferredId: album.id,
            artistKey,
            mbid: album.foreignAlbumId || undefined,
            title: album.title,
            albumType: album.albumType,
            secondaryTypes: album.secondaryTypes ?? [],
            releaseDate: album.releaseDate,
            genres: album.genres ?? [],
            overview: album.overview || undefined,
            coverUrl: artUrl('album', album.id, 'cover', album.images),
            totalTrackCount: album.statistics?.totalTrackCount,
          });
        }
        const recordingId = t.foreignRecordingId || `track:${t.id}`;
        const key = uniqueKey(trackKeyFor(albumKey, recordingId), trackKeys);
        sync.tracks.push({
          key,
          preferredId: t.id,
          albumKey,
          recordingId,
          title: t.title,
          trackNumber: Number.parseInt(t.trackNumber, 10) || t.absoluteTrackNumber,
          discNumber: t.mediumNumber || 1,
          duration: Math.round(t.duration / 1000) || (file ? (this.fileLengths.get(lengthKey(file)) ?? 0) : 0),
          explicit: t.explicit,
        });
        if (file) {
          sync.copies.push({
            ref: String(file.id),
            preferredId: file.id,
            trackKey: key,
            path: file.path,
            size: file.size,
            format: formatFromTrackFile(file),
            addedAt: file.dateAdded,
          });
        }
      }

      if (albumsSeen.size) {
        sync.artists.push({
          key: artistKey,
          preferredId: la.id,
          mbid: la.foreignArtistId || undefined,
          name: la.artistName,
          sortName: la.sortName || la.artistName,
          genres: la.genres ?? [],
          overview: la.overview || undefined,
          imageUrl: artUrl('artist', la.id, 'poster', la.images),
          fanartUrl: artUrl('artist', la.id, 'fanart', la.images),
          logoUrl: artUrl('artist', la.id, 'clearlogo', la.images),
        });
      }
    }
    return sync;
  }

  /**
   * Some songs have no length on MusicBrainz (Lidarr reports 0): ask Lidarr for the length of the
   * file instead, which it reads from the file itself. Remembered per file, so later syncs don't ask again.
   */
  private async measureUntimed(perArtist: { tracks: LidarrTrack[]; files: LidarrTrackFile[] }[]) {
    const untimed = perArtist.flatMap(({ tracks, files }) => {
      const fileById = new Map(files.map((f) => [f.id, f]));
      return tracks.flatMap((t) => {
        const file = !t.duration && t.hasFile ? fileById.get(t.trackFileId) : undefined;
        return file && !this.fileLengths.has(lengthKey(file)) ? [file] : [];
      });
    });
    await mapLimit(untimed, 4, async (file) => {
      try {
        const { audioTags } = await this.lidarr.trackFile(file.id);
        this.fileLengths.set(lengthKey(file), timeSpanSeconds(audioTags?.duration));
      } catch {
        // Try again on the next sync.
      }
    });
  }
}

const lengthKey = (file: LidarrTrackFile) => `${file.id}:${file.size}`;

/** Lidarr's .NET TimeSpans ("00:01:18.2666666", "1.02:03:04") in whole seconds; 0 if absent. */
export function timeSpanSeconds(span: string | undefined): number {
  const m = span?.match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return 0;
  const [, days = '0', h, min, s] = m;
  return Math.round(Number(days) * 86_400 + Number(h) * 3600 + Number(min) * 60 + Number(s));
}

/** The same recording twice on one album (rare): give the repeat its own key. */
function uniqueKey(base: string, seen: Set<string>): string {
  let key = base;
  for (let n = 2; seen.has(key); n++) key = `${base}#${n}`;
  seen.add(key);
  return key;
}

function artUrl(kind: 'artist' | 'album', id: number, type: string, images: LidarrImage[]): string | undefined {
  const img = images.find((i) => i.coverType === type);
  if (!img) return undefined;
  // Lidarr appends ?lastWrite=… to local artwork URLs; reuse it for cache busting.
  const version = img.url?.match(/lastWrite=(\d+)/)?.[1];
  return `/art/${kind}/${id}/${type}${version ? `?v=${version}` : ''}`;
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
