import { createHash } from 'node:crypto';
import { albumKey as albumNameKey, normalize } from '../library/search.ts';
import { albumKeyFor, artistKeyFor, songNameKey, trackKeyFor } from './keys.ts';
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
export const LOOSE_TITLE = 'Loose songs';

/**
 * A folder's files as catalog rows. Tags come first, then folder and file names
 * ("Artist/Album/01 Title.flac"). Untagged files join existing artists, albums and songs by name.
 */
export function folderSync(entries: FolderEntry[], index: NameIndex): SourceSync {
  const artists = new Map<string, SourceArtist>();
  const albums = new Map<string, SourceAlbum>();
  const tracks = new Map<string, SourceTrack>();
  const sync: SourceSync = { artists: [], albums: [], tracks: [], copies: [], metaRank: FOLDER_META_RANK };

  for (const e of [...entries].sort((a, b) => a.rel.localeCompare(b.rel))) {
    const t = e.tags;
    const parts = e.rel.split('/');
    const fileName = parts.at(-1)!;
    const dirs = parts.slice(0, -1);
    const folderArtist = dirs.length >= 2 ? dirs.at(-2) : dirs[0];
    const folderAlbum = dirs.length >= 2 ? cleanFolderAlbum(dirs.at(-1)!) : undefined;

    let artistName = t.albumArtist || t.artist || folderArtist || 'Unknown artist';
    const albumTitle = t.album || folderAlbum;
    const title = t.title || titleFromFile(fileName);
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

    if (!tracks.has(trackKey)) {
      tracks.set(trackKey, {
        key: trackKey,
        albumKey,
        recordingId,
        title,
        trackNumber: t.trackNumber ?? trackNumberFromFile(fileName),
        discNumber: t.discNumber ?? 1,
        duration: t.duration,
        explicit: false,
      });
    }
    sync.copies.push({
      ref: e.rel,
      trackKey,
      path: e.path,
      size: e.size,
      format: t.format,
      addedAt: new Date(e.mtimeMs).toISOString(),
    });
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
