// API contracts shared between the Playarr server and web client.

export interface AudioFormat {
  codec: string; // e.g. "FLAC", "MP3"
  container: string; // file extension, e.g. "flac"
  bits?: number; // bit depth, lossless only
  sampleRate?: number; // Hz
  bitrate?: number; // kbps
  channels?: number;
  lossless: boolean;
}

export interface Artist {
  id: number;
  name: string;
  sortName: string;
  genres: string[];
  overview?: string;
  albumCount: number; // albums with at least one file
  trackCount: number; // tracks with files
  imageUrl?: string; // square-ish poster
  fanartUrl?: string; // wide background
  logoUrl?: string; // transparent PNG logo
}

export interface Album {
  id: number;
  title: string;
  artistId: number;
  artistName: string;
  year?: number;
  releaseDate?: string;
  albumType: string;
  secondaryTypes: string[];
  genres: string[];
  duration: number; // seconds, sum of playable tracks
  trackCount: number; // tracks with files
  totalTrackCount: number;
  coverUrl?: string;
  addedAt?: string; // newest file import date
  format?: AudioFormat; // most common format among its tracks
}

export interface Track {
  id: number;
  /** Stable song id (MusicBrainz recording, or "track:<id>"); used for favorites. */
  recordingId: string;
  fileId: number;
  albumId: number;
  artistId: number;
  title: string;
  artistName: string;
  albumTitle: string;
  trackNumber: number;
  discNumber: number;
  duration: number; // seconds
  explicit: boolean;
  format: AudioFormat;
  size: number; // bytes
  streamUrl: string;
  coverUrl?: string;
}

export interface ArtistDetail extends Artist {
  albums: Album[];
}

export interface AlbumDetail extends Album {
  overview?: string;
  tracks: Track[];
  discCount: number;
}

export interface SearchResults {
  artists: Artist[];
  albums: Album[];
  tracks: Track[];
}

export interface LibraryStats {
  artists: number;
  albums: number;
  tracks: number;
  durationSeconds: number;
  sizeBytes: number;
  refreshedAt: string;
}

export interface HealthStatus {
  ok: boolean;
  lidarr: { ok: boolean; version?: string; error?: string };
  media: { source: 'none' | 'local' | 'sftp' | 'ssh'; ok: boolean; error?: string };
  library?: LibraryStats;
}

export type AlbumSort = 'title' | 'artist' | 'year' | 'added';

export interface FavoriteTrack extends Track {
  favoritedAt: string;
}

// ── Discover & requests: music that isn't in the library yet ────────────────

export type AvailabilityState =
  | 'available' // playable in Playarr
  | 'searching' // Lidarr is searching indexers
  | 'downloading'
  | 'importing'
  | 'waiting' // monitored in Lidarr, no release found yet
  | 'failed'
  | 'none'; // not wanted in Lidarr

export interface Availability {
  state: AvailabilityState;
  /** Playarr album id once playable. */
  albumId?: number;
  /** 0..1 while downloading. */
  progress?: number;
  message?: string;
}

export interface DiscoverAlbum {
  mbid: string; // MusicBrainz release-group id (= Lidarr foreignAlbumId)
  title: string;
  artistName: string;
  artistMbid: string;
  year?: number;
  type: string; // Album, EP, Single…
  secondaryTypes: string[];
  coverUrl?: string;
  availability: Availability;
}

export interface DiscoverArtist {
  mbid: string;
  name: string;
  disambiguation?: string;
  imageUrl?: string;
  genres: string[];
  /** Playarr artist id when the artist already has music in the library. */
  artistId?: number;
}

/** Identifies an album by name; the server resolves it to a MusicBrainz release group on request. */
export interface AlbumRef {
  mbid?: string;
  artistName: string;
  albumTitle: string;
}

export interface DiscoverTrack {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  duration?: number; // seconds
  coverUrl?: string;
  /** The album to request for this song. */
  album: AlbumRef;
  availability: Availability;
}

export interface DiscoverResults {
  artists: DiscoverArtist[];
  albums: DiscoverAlbum[];
  tracks: DiscoverTrack[];
}

export interface DiscoverArtistDetail extends DiscoverArtist {
  overview?: string;
  albums: DiscoverAlbum[];
  /** Set when MusicBrainz couldn't be reached, so an empty list isn't mistaken for "no albums". */
  discographyError?: string;
}

export interface AlbumRequest {
  mbid: string;
  title: string;
  artistName: string;
  coverUrl?: string;
  requestedAt: string;
  availability: Availability;
}

// ── Playlists ───────────────────────────────────────────────────────────────

export interface PlaylistSummary {
  id: number;
  name: string;
  description: string;
  trackCount: number;
  duration: number; // seconds, playable tracks only
  /** Up to four distinct album covers, for the mosaic. */
  covers: string[];
  updatedAt: string;
}

export interface PlaylistItem {
  itemId: number;
  recordingId: string;
  title: string;
  artistName: string;
  albumTitle: string;
  addedAt: string;
  /** The playable track, or undefined if the song is no longer in the library. */
  track?: Track;
}

export interface PlaylistDetail extends PlaylistSummary {
  items: PlaylistItem[];
}
