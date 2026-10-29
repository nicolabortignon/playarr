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
  /** MusicBrainz release-group id, when known. */
  mbid?: string;
  /** A specific MusicBrainz release (edition); resolved to its release group on request. */
  releaseMbid?: string;
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
  /** Known without extra lookups: `artistId` if in the library, `artistMbid` if search turned it up. */
  artistId?: number;
  artistMbid?: string;
}

/** An artist name resolved to MusicBrainz (and the library, when owned). */
export interface ArtistMatch {
  mbid: string;
  artistId?: number;
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

export type CoverLayout = 'ridges' | 'grooves' | 'blocks' | 'horizon' | 'currents' | 'colonies';

/** Artwork generated from what the playlist's songs sound like, pinned once drawn. */
export interface PlaylistCoverInfo {
  /** Versioned: changes when the cover or the playlist's name changes. */
  url: string;
  layout: CoverLayout;
  /** Which variation of the layout (the picker's Shuffle). */
  variant: number;
  /** Drawn and pinned: it changes only when the user picks a new cover. */
  frozen: boolean;
  /** The songs have changed a lot since the cover was drawn. */
  stale: boolean;
  /** Typical tempo of the songs with a clear beat. */
  tempo?: number;
  /** 0–1. */
  energy: number;
  /** Main styles, strongest first. */
  styles: string[];
  era?: [from: number, to: number];
  /** Songs whose audio has been analyzed, of `total`. */
  analyzed: number;
  total: number;
  /** Still listening to some songs (before the cover is pinned, it refines as they land). */
  pending: boolean;
}

export interface PlaylistSummary {
  id: number;
  name: string;
  description: string;
  trackCount: number;
  duration: number; // seconds, playable tracks only
  cover: PlaylistCoverInfo;
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

// ── Recommendations ─────────────────────────────────────────────────────────

export interface RecommendedTrack {
  recordingId: string;
  title: string;
  artistName: string;
  albumTitle: string;
  coverUrl?: string;
  /** Title of the playlist song it's most similar to. */
  because: string;
  /** Set when the song is in the library: play it or add it directly. */
  track?: Track;
  /** Set when it isn't: request its album through Lidarr. */
  album?: AlbumRef;
  availability?: Availability;
  /** Lead artist, for linking: `artistId` when they're in the library, else their discover page by `artistMbid`. */
  artistId?: number;
  artistMbid?: string;
}

export interface Recommendations {
  /** Similar songs you already have. */
  owned: RecommendedTrack[];
  /** Similar songs you don't have yet. */
  missing: RecommendedTrack[];
  seedCount: number;
}

export * from './range.ts';
