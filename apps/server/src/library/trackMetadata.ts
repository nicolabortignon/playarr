import type { FileTags, TrackCopyMetadata, TrackMetadata } from '@playarr/shared';
import type { CatalogStore } from '../catalog/store.ts';
import type { TagInfo } from '../catalog/tags.ts';
import { mapPath } from '../media/index.ts';
import type { Library } from './library.ts';

interface Deps {
  store: Pick<CatalogStore, 'trackDetails' | 'folderFileDetails' | 'source'>;
  library: Pick<Library, 'track'>;
  pathMap: [string, string][];
  /** Playarr's analysis of a song, when measured. */
  features?: (recordingId: string) => TrackMetadata['analysis'] | undefined;
}

/**
 * Everything Playarr knows about a song: its catalog rows, every file of it in every source (the one
 * that plays first), each folder file's own tags and match, and its analysis. Paths and where sources
 * live are left out unless `withPaths` (requests from the home network).
 */
export async function trackMetadata(deps: Deps, trackId: number, withPaths: boolean): Promise<TrackMetadata | undefined> {
  const details = deps.store.trackDetails(trackId);
  if (!details) return undefined;
  const playing = (await deps.library.track(trackId))?.fileId;
  const { track, album, artist } = details;

  const copies = details.copies.map((c): TrackCopyMetadata => {
    const source = deps.store.source(c.sourceId);
    const folder = source?.kind === 'folder';
    const file = folder ? deps.store.folderFileDetails(c.sourceId, c.ref) : undefined;
    const readPath = !folder ? mapPath(c.path, deps.pathMap) : undefined;
    return {
      fileId: c.id,
      playing: c.id === playing,
      source: {
        id: c.sourceId,
        name: source?.name ?? 'Removed source',
        kind: source?.kind ?? 'folder',
        ...(withPaths && source ? { location: locationOf(source.kind, source.settings) } : {}),
      },
      ...(withPaths ? { path: c.path } : {}),
      ...(withPaths && readPath && readPath !== c.path ? { readPath } : {}),
      size: c.size,
      format: c.format,
      ...(c.addedAt ? { addedAt: c.addedAt } : {}),
      ...(file?.tags ? { tags: fileTags(file.tags) } : {}),
      ...(file?.match ? { match: file.match } : {}),
    };
  });
  copies.sort((a, b) => Number(b.playing) - Number(a.playing));

  const analysis = deps.features?.(track.recordingId);
  return {
    trackId: track.id,
    title: track.meta.title,
    artistName: artist.meta.name,
    albumTitle: album.meta.title,
    trackNumber: track.meta.trackNumber,
    discNumber: track.meta.discNumber,
    duration: track.meta.duration,
    explicit: track.meta.explicit,
    recordingId: track.recordingId,
    albumId: album.id,
    ...(album.meta.mbid ? { albumMbid: album.meta.mbid } : {}),
    ...(album.meta.releaseDate ? { releaseDate: album.meta.releaseDate } : {}),
    albumType: album.meta.albumType,
    secondaryTypes: album.meta.secondaryTypes,
    genres: album.meta.genres,
    artistId: artist.id,
    ...(artist.meta.mbid ? { artistMbid: artist.meta.mbid } : {}),
    copies,
    ...(analysis ? { analysis } : {}),
    pathsHidden: !withPaths,
  };
}

/** Where a source's files live, without any secret. */
function locationOf(kind: string, settings: Record<string, unknown>): string {
  if (kind === 'lidarr') return 'Lidarr';
  const access = (settings.access as string | undefined) ?? 'local';
  if (access === 'local') return 'This server';
  const host = String(settings.host ?? '');
  const user = settings.user ? `${String(settings.user)}@` : '';
  return `${user}${host} (${access.toUpperCase()})`;
}

/** The tags worth showing (not the duration and format, shown with the file). */
function fileTags(t: TagInfo): FileTags {
  const { duration: _duration, format: _format, ...rest } = t;
  return rest;
}
