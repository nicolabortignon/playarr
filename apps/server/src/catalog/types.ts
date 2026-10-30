import type { AudioFormat } from '@playarr/shared';

export type SourceKind = 'lidarr' | 'folder';

/**
 * What a source reports. `key`s identify the same artist, album or song across sources
 * (see keys.ts); `preferredId` is the id to use when the row is first created, if it's free
 * (Lidarr's ids, so existing links, queues and offline songs keep working).
 */
export interface SourceArtist {
  key: string;
  preferredId?: number;
  mbid?: string;
  name: string;
  sortName: string;
  genres: string[];
  overview?: string;
  imageUrl?: string;
  fanartUrl?: string;
  logoUrl?: string;
  /** Overrides the sync's rank for this row. */
  metaRank?: number;
}

export interface SourceAlbum {
  key: string;
  preferredId?: number;
  artistKey: string;
  /** MusicBrainz release group. */
  mbid?: string;
  title: string;
  albumType: string;
  secondaryTypes: string[];
  releaseDate?: string;
  genres: string[];
  overview?: string;
  coverUrl?: string;
  totalTrackCount?: number;
  /** Overrides the sync's rank for this row. */
  metaRank?: number;
}

export interface SourceTrack {
  key: string;
  preferredId?: number;
  albumKey: string;
  /** MusicBrainz recording id, or "track:<id>" when unknown. Favorites and playlists key on it. */
  recordingId: string;
  title: string;
  trackNumber: number;
  discNumber: number;
  duration: number; // seconds
  explicit: boolean;
  /** Overrides the sync's rank for this row. */
  metaRank?: number;
}

export interface SourceCopy {
  /** Stable within the source: Lidarr's track-file id, or a path relative to the folder. */
  ref: string;
  preferredId?: number;
  trackKey: string;
  /** As the source reports it (Lidarr's path; mapped with PATH_MAP before reading). */
  path: string;
  size: number;
  format: AudioFormat;
  addedAt?: string;
}

/** Lidarr's view of a release group, owned or not; requests use it. */
export interface LidarrAlbumState {
  mbid: string;
  lidarrId: number;
  monitored: boolean;
}

export interface SourceSync {
  artists: SourceArtist[];
  albums: SourceAlbum[];
  tracks: SourceTrack[];
  copies: SourceCopy[];
  lidarrAlbums?: LidarrAlbumState[];
  /** How much this source's metadata is trusted: lower wins (Lidarr 0, folder tags 2). Default 0. */
  metaRank?: number;
}

export interface CatalogSource {
  readonly kind: SourceKind;
  /** Everything the source currently has. Copies it no longer reports are removed. */
  sync(): Promise<SourceSync>;
}

/** A song already in the catalog, as the name index finds it. */
export interface KnownTrack {
  key: string;
  recordingId: string;
  albumKey: string;
  albumTitle: string;
  artistKey: string;
  artistName: string;
}

/** The catalog by name, so untagged folder files can join what's already there. */
export interface NameIndex {
  /** normalize(artist name) → artist */
  artists: Map<string, { key: string; name: string }>;
  /** albumKey(artist, title) from library/search.ts → album */
  albums: Map<string, { key: string; title: string }>;
  /** `${album key}|${normalize(title)}` → song on that album */
  tracks: Map<string, KnownTrack>;
  /** songNameKey(artist, title) → the song on its most "original" album (studio album first) */
  songs: Map<string, KnownTrack>;
}
