import { createHash } from 'node:crypto';
import { albumKey as albumNameKey, normalize } from '../library/search.ts';
import { albumKeyFor, artistKeyFor, songNameKey, trackKeyFor } from './keys.ts';
import type { MbReleaseInfo } from './mbRelease.ts';
import type { TagInfo } from './tags.ts';
import type { KnownTrack, NameIndex, SourceAlbum, SourceArtist, SourceSync, SourceTrack } from './types.ts';

export interface FolderEntry {
  /** Path relative to the folder source, with "/" separators. */
  rel: string;
  /** Absolute path. */
  path: string;
  size: number;
  mtimeMs: number;
  tags: TagInfo;
}

/** Folder tags are trusted less than Lidarr's metadata (lower wins). */
export const FOLDER_META_RANK = 2;
/** MusicBrainz data from a match: between Lidarr (0) and plain tags (2). */
export const MATCHED_META_RANK = 1;
export const LOOSE_TITLE = 'Loose songs';

/** What a file says about itself: its tags, else its folder and file names. */
export interface FileDescription {
  artistName: string;
  albumTitle?: string;
  title: string;
  trackNumber: number;
  discNumber: number;
  duration: number;
}

/** A file's artist, album, title and position from its tags, else "Artist/Album/01 Title.flac". */
export function describeFile(rel: string, t: TagInfo): FileDescription {
  const parts = rel.split('/');
  const fileName = parts.at(-1)!;
  const dirs = parts.slice(0, -1);
  const folderArtist = dirs.length >= 2 ? dirs.at(-2) : dirs[0];
  const folderAlbum = dirs.length >= 2 ? cleanFolderAlbum(dirs.at(-1)!) : undefined;
  return {
    artistName: t.albumArtist || t.artist || folderArtist || 'Unknown artist',
    albumTitle: t.album || folderAlbum,
    title: t.title || titleFromFile(fileName),
    trackNumber: t.trackNumber ?? trackNumberFromFile(fileName),
    discNumber: t.discNumber ?? 1,
    duration: t.duration,
  };
}

/**
 * A folder's files as catalog rows. Tags come first, then folder and file names
 * ("Artist/Album/01 Title.flac"). Untagged files join existing artists, albums and songs by name.
 * Files matched to a MusicBrainz release (`tags.releaseId` in `releases`) bring its metadata and
 * its full track list: the songs not in the folder are reported as missing songs.
 */
export function folderSync(
  entries: FolderEntry[],
  index: NameIndex,
  releases: Map<string, MbReleaseInfo> = new Map(),
): SourceSync {
  const artists = new Map<string, SourceArtist>();
  const albums = new Map<string, SourceAlbum>();
  const tracks = new Map<string, SourceTrack>();
  const matchedAlbums = new Map<string, MbReleaseInfo>();
  const sync: SourceSync = { artists: [], albums: [], tracks: [], copies: [], metaRank: FOLDER_META_RANK, addedAt: 'firstSeen' };

  for (const e of [...entries].sort((a, b) => a.rel.localeCompare(b.rel))) {
    const t = e.tags;
    const d = describeFile(e.rel, t);
    let artistName = d.artistName;
    const albumTitle = d.albumTitle;
    const title = d.title;
    let artistKey = t.albumArtistMbid
      ? `mb:${t.albumArtistMbid}`
      : (index.artists.get(normalize(artistName))?.key ?? artistKeyFor(undefined, artistName));

    let albumKey: string;
    let albumName: string;
    let known: KnownTrack | undefined;
    if (albumTitle) {
      albumName = albumTitle;
      albumKey = t.releaseGroupMbid
        ? `mb:${t.releaseGroupMbid}`
        : (index.albums.get(albumNameKey(artistName, albumTitle))?.key ?? albumKeyFor(undefined, artistName, albumTitle));
      known = index.tracks.get(`${albumKey}|${normalize(title)}`);
    } else {
      // A loose song: file it under the album the library already has it on, else under "Loose songs".
      known = index.songs.get(songNameKey(artistName, title));
      if (known) {
        artistKey = known.artistKey;
        artistName = known.artistName;
        albumKey = known.albumKey;
        albumName = known.albumTitle;
      } else {
        albumKey = `loose:${artistKey}`;
        albumName = LOOSE_TITLE;
      }
    }

    const recordingId = t.recordingMbid || known?.recordingId || `local:${hash(songNameKey(artistName, title))}`;
    const trackKey = known?.key ?? trackKeyFor(albumKey, recordingId);

    if (!artists.has(artistKey)) {
      artists.set(artistKey, { key: artistKey, mbid: t.albumArtistMbid, name: artistName, sortName: artistName, genres: [] });
    }
    let album = albums.get(albumKey);
    if (!album) {
      album = {
        key: albumKey,
        artistKey,
        mbid: albumTitle ? t.releaseGroupMbid : undefined,
        title: albumName,
        albumType: albumKey.startsWith('loose:') ? 'Loose' : 'Album',
        secondaryTypes: [],
        releaseDate: t.year ? `${t.year}-01-01T00:00:00Z` : undefined,
        genres: [],
      };
      albums.set(albumKey, album);
    }
    album.releaseDate ??= t.year ? `${t.year}-01-01T00:00:00Z` : undefined;
    for (const g of t.genres) if (album.genres.length < 3 && !album.genres.includes(g)) album.genres.push(g);
    if (t.trackTotal && (album.totalTrackCount ?? 0) < t.trackTotal) album.totalTrackCount = t.trackTotal;
    const release = albumTitle && t.releaseId ? releases.get(t.releaseId) : undefined;
    if (release) {
      const rg = release.releaseGroup;
      album.metaRank = MATCHED_META_RANK;
      album.title = rg.title;
      album.albumType = rg.primaryType ?? 'Album';
      album.secondaryTypes = rg.secondaryTypes;
      if (rg.firstReleaseDate) album.releaseDate = rg.firstReleaseDate;
      album.totalTrackCount = release.tracks.length;
      matchedAlbums.set(albumKey, release);
    }

    if (!tracks.has(trackKey)) {
      tracks.set(trackKey, {
        key: trackKey,
        albumKey,
        recordingId,
        title,
        trackNumber: d.trackNumber,
        discNumber: d.discNumber,
        duration: d.duration,
        explicit: false,
      });
    }
    if (release) tracks.get(trackKey)!.metaRank = MATCHED_META_RANK;
    sync.copies.push({
      ref: e.rel,
      trackKey,
      path: e.path,
      size: e.size,
      format: t.format,
      addedAt: new Date(e.mtimeMs).toISOString(),
    });
  }

  // The rest of each matched release: songs the folder doesn't have.
  for (const [albumKey, release] of matchedAlbums) {
    for (const track of release.tracks) {
      const key = trackKeyFor(albumKey, track.recordingId);
      if (tracks.has(key)) continue;
      tracks.set(key, {
        key,
        albumKey,
        recordingId: track.recordingId,
        title: track.title,
        trackNumber: track.position,
        discNumber: track.disc,
        duration: track.length,
        explicit: false,
        metaRank: MATCHED_META_RANK,
      });
    }
  }

  sync.artists = [...artists.values()];
  sync.albums = [...albums.values()];
  sync.tracks = [...tracks.values()];
  return sync;
}

const stem = (fileName: string) => fileName.replace(/\.[^.]+$/, '');

/** "03 - Sour Times.flac" → "Sour Times". */
function titleFromFile(fileName: string): string {
  const name = stem(fileName);
  return name.replace(/^\d{1,3}\s*[-._)]?\s*/, '').trim() || name;
}

function trackNumberFromFile(fileName: string): number {
  return Number(stem(fileName).match(/^(\d{1,3})/)?.[1] ?? 0);
}

/** "1994 - Dummy" or "Dummy (1994) [FLAC]" → "Dummy". */
function cleanFolderAlbum(name: string): string {
  const cleaned = name
    .replace(/^\(?\d{4}\)?\s*[-–.]\s*/, '')
    .replace(/(\s*[([](\d{4}|flac|mp3|320|v0|web|cd|vinyl|24bit[^)\]]*)[)\]])+\s*$/i, '')
    .trim();
  return cleaned || name;
}

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);
