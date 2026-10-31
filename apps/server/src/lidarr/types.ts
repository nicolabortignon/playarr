// Subset of the Lidarr v1 API shapes that Playarr consumes.

export interface LidarrImage {
  coverType: 'poster' | 'banner' | 'fanart' | 'logo' | 'cover' | 'disc' | 'clearlogo' | string;
  url?: string;
  remoteUrl?: string;
  extension?: string;
}

export interface LidarrStatistics {
  albumCount?: number;
  trackFileCount: number;
  trackCount: number;
  totalTrackCount: number;
  sizeOnDisk: number;
  percentOfTracks: number;
}

export interface LidarrArtist {
  id: number;
  artistName: string;
  foreignArtistId: string;
  sortName?: string;
  overview?: string;
  genres: string[];
  images: LidarrImage[];
  path: string;
  statistics?: LidarrStatistics;
}

export interface LidarrAlbum {
  id: number;
  title: string;
  foreignAlbumId: string;
  monitored: boolean;
  artistId: number;
  overview?: string;
  releaseDate?: string;
  albumType: string;
  secondaryTypes: string[];
  genres: string[];
  duration: number; // ms
  images: LidarrImage[];
  statistics?: LidarrStatistics;
}

export interface LidarrTrack {
  id: number;
  albumId: number;
  artistId: number;
  title: string;
  trackNumber: string;
  absoluteTrackNumber: number;
  mediumNumber: number;
  duration: number; // ms
  explicit: boolean;
  hasFile: boolean;
  trackFileId: number;
  foreignRecordingId?: string; // MusicBrainz recording id: the song itself, across releases
}

export interface LidarrMediaInfo {
  audioChannels?: number;
  audioBitRate?: string; // "1232 kbps"
  audioCodec?: string; // "FLAC"
  audioBits?: string; // "24bit"
  audioSampleRate?: string; // "44.1kHz"
}

export interface LidarrTrackFile {
  id: number;
  artistId: number;
  albumId: number;
  path: string;
  size: number;
  dateAdded: string;
  mediaInfo?: LidarrMediaInfo;
  quality?: { quality: { id: number; name: string } };
  /** Read from the file on request: only `GET /trackfile/{id}` returns it, not the list. */
  audioTags?: { duration?: string };
}

export interface LidarrSystemStatus {
  appName: string;
  version: string;
}

export interface LidarrRootFolder {
  id: number;
  path: string;
  accessible: boolean;
  freeSpace?: number;
  defaultQualityProfileId?: number;
  defaultMetadataProfileId?: number;
}

/** Quality and metadata profiles: only what Playarr shows. */
export interface LidarrProfile {
  id: number;
  name: string;
}

export interface LidarrLookupArtist {
  id?: number;
  artistName: string;
  foreignArtistId: string;
  disambiguation?: string;
  overview?: string;
  genres?: string[];
  images: LidarrImage[];
  [key: string]: unknown;
}

export interface LidarrLookupAlbum {
  id?: number;
  title: string;
  foreignAlbumId: string;
  monitored?: boolean;
  releaseDate?: string;
  albumType: string;
  secondaryTypes: string[];
  images: LidarrImage[];
  artist: LidarrLookupArtist;
  statistics?: LidarrStatistics;
  [key: string]: unknown;
}

/** /api/v1/search returns a mix of artist and album hits. */
export interface LidarrSearchHit {
  foreignId: string;
  artist?: LidarrLookupArtist;
  album?: LidarrLookupAlbum;
}

export interface LidarrQueueItem {
  id: number;
  albumId?: number;
  artistId?: number;
  title: string;
  size: number;
  sizeleft: number;
  timeleft?: string;
  status: string; // downloading, paused, queued, completed, failed…
  trackedDownloadStatus?: 'ok' | 'warning' | 'error';
  trackedDownloadState?: string; // downloading, importPending, importing, imported, failedPending, failed
  statusMessages?: { title: string; messages: string[] }[];
  errorMessage?: string;
}

export interface LidarrCommand {
  id: number;
  name: string;
  status: 'queued' | 'started' | 'completed' | 'failed' | 'aborted' | 'cancelled' | 'orphaned';
  message?: string;
}
