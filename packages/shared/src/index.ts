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
  /** Songs on this album that aren't in the library (shown greyed out). */
  missingTracks: MissingTrack[];
}

/** A song on an album that no source has a file for. */
export interface MissingTrack {
  recordingId: string;
  title: string;
  trackNumber: number;
  discNumber: number;
  duration: number; // seconds
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
  /** Absent when there is no Lidarr source. */
  lidarr?: { ok: boolean; version?: string; error?: string };
  media: { source: 'none' | 'local' | 'sftp' | 'ssh' | 'smb'; ok: boolean; error?: string };
  library?: LibraryStats;
  /** A Lidarr source is set up and requests are allowed in Settings. */
  requests: boolean;
}

export type AlbumSort = 'title' | 'artist' | 'year' | 'added';

export interface FavoriteTrack extends Track {
  favoritedAt: string;
}

// ── Settings → Requests: what Lidarr does when someone requests an album ────

export interface RequestSettings {
  enabled: boolean;
  /** Run Lidarr's album search right after adding; off leaves it to Lidarr's schedule. */
  searchOnAdd: boolean;
  /** Unset: .env, else Lidarr's default. */
  rootFolderPath?: string;
  qualityProfileId?: number;
  metadataProfileId?: number;
}

/** PUT /api/settings/requests: a partial change; null clears a choice. */
export type RequestSettingsPatch = Partial<{
  enabled: boolean;
  searchOnAdd: boolean;
  rootFolderPath: string | null;
  qualityProfileId: number | null;
  metadataProfileId: number | null;
}>;

/** GET /api/settings/requests: the settings, and Lidarr's choices (absent when Lidarr isn't set up or can't be reached). */
export interface RequestSettingsInfo extends RequestSettings {
  lidarr: boolean;
  options?: {
    rootFolders: { path: string; freeSpace?: number }[];
    qualityProfiles: { id: number; name: string }[];
    metadataProfiles: { id: number; name: string }[];
  };
  /** Why the options are missing, when Lidarr is set up. */
  error?: string;
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

// ── Settings: catalog sources ───────────────────────────────────────────────

export type SourceKind = 'lidarr' | 'folder';

export type FolderAccessKind = 'local' | 'ssh' | 'sftp' | 'smb';

export interface SourceInfo {
  id: number;
  kind: SourceKind;
  name: string;
  /** Place in the priority list: equally good copies play from the source listed first. */
  position: number;
  enabled: boolean;
  /** Connection settings without secrets. Absent for visitors outside the local network. */
  settings?: {
    url?: string;
    path?: string;
    /** Folder sources: where the folder is. Absent means this server. For SMB, `path` is /share/folder. */
    access?: FolderAccessKind;
    host?: string;
    port?: number;
    user?: string;
    privateKeyPath?: string;
    /** SMB: the account's domain (rclone's default is WORKGROUP). */
    domain?: string;
  };
  /** Secret fields that have a saved value. The values themselves are never sent. */
  secrets: string[];
  lastSyncAt?: string;
  error?: string;
  syncing: boolean;
  songs: number;
  albums: number;
  /** Folder sources: album groups waiting for the user's review. */
  review: number;
  /** Folder sources: album groups still being matched. */
  matching: number;
  /** Folder sources: Playarr can write to the folder (needed to organize it). */
  writable?: boolean;
}

export interface SourcesResponse {
  sources: SourceInfo[];
  /** False for visitors outside the local network: Settings is read-only for them. */
  canEdit: boolean;
}

export interface SourceInput {
  kind?: SourceKind;
  name?: string;
  enabled?: boolean;
  /** Lidarr: url, apiKey. Folder: path, plus access/host/port/user/password for SSH, SFTP or SMB, with privateKeyPath (SSH, SFTP) or domain (SMB); for SMB, `path` is /share/folder. Leaving a secret out keeps the saved one. */
  settings?: {
    url?: string;
    apiKey?: string;
    path?: string;
    access?: FolderAccessKind;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    privateKeyPath?: string;
    domain?: string;
  };
}

export interface SourceTestResult {
  ok: boolean;
  version?: string;
  error?: string;
}

/** A folder on the server, for choosing a folder source. */
export interface FolderListing {
  /** null: the list of folders sources may use (FOLDER_ROOTS). */
  path: string | null;
  /** Where "up" goes; null: back to that list. */
  parent: string | null;
  folders: { name: string; path: string }[];
  /** Audio files directly in this folder. */
  audioFiles: number;
  /** A folder sources may use that is missing or completely empty: in Docker, nothing is mounted there yet. */
  emptyRoot?: boolean;
}

// ── Matching: identifying folder music on MusicBrainz ───────────────────────

export interface ReviewFile {
  rel: string;
  title: string;
  trackNumber: number;
  discNumber: number;
  duration: number;
}

export interface ReviewCandidate {
  releaseId: string;
  releaseGroupId: string;
  /** The album (release group) title. */
  title: string;
  /** This edition's own title, when it differs from the album's ("Mezzanine (Deluxe)"). */
  releaseTitle?: string;
  artistName: string;
  /** The album's first release year. */
  year?: number;
  /** This edition's release date: "1998", "1998-04" or "1998-04-20". */
  date?: string;
  /** ISO country code, or XE (Europe) / XW (worldwide). */
  country?: string;
  /** Official, Promotion, Bootleg… */
  status?: string;
  /** MusicBrainz's note telling editions apart ("deluxe", "remaster"). */
  disambiguation?: string;
  /** "Album", "Album · Compilation", "EP"… */
  type?: string;
  /** "2×CD", "Digital Media"… */
  format?: string;
  labels?: { name?: string; catalogNumber?: string }[];
  barcode?: string;
  /** The album cover (Cover Art Archive, through /art/remote). */
  coverUrl?: string;
  /** 0..1 */
  score: number;
  tracks: { disc: number; position: number; title: string; duration: number }[];
  /** File (rel) → index in `tracks` it was matched to. */
  matches: Record<string, number>;
}

export interface ReviewGroup {
  groupKey: string;
  artistName: string;
  albumTitle?: string;
  files: ReviewFile[];
  candidates: ReviewCandidate[];
}

export interface ReviewAction {
  groupKey: string;
  /** A candidate to use; null: leave this group unmatched for good. */
  releaseId?: string | null;
  /** Look for other candidates. */
  search?: { artist: string; album: string };
}

export interface MatchingSettings {
  /** An AcoustID key is saved (the key itself is never sent). */
  acoustid: boolean;
  /** fpcalc (Chromaprint) is installed, so fingerprints can be computed. */
  fingerprints: boolean;
}

/** MusicBrainz answers about one request per second; the UI explains waits with this. */
export interface MusicBrainzStatus {
  /** Lookups waiting in line (including the one running). */
  queued: number;
  /** Of those, how many are background work (identifying folder music). */
  background: number;
  /** Rough seconds until the queue is empty. */
  etaSeconds: number;
  /** Folder album groups still waiting to be matched. */
  matching: number;
}

// ── Organizing folder files ─────────────────────────────────────────────────

export interface OrganizeMove {
  /** Current path, relative to the folder. Also the move's id. */
  from: string;
  to: string;
  artist: string;
  album?: string;
  /** Album and song known on MusicBrainz; guesses start unchecked. */
  confident: boolean;
}

export interface OrganizeSkip {
  from: string;
  to?: string;
  reason: string;
}

export interface OrganizePlan {
  writable: boolean;
  /** Why files can't be organized here, when they can't. */
  reason?: string;
  moves: OrganizeMove[];
  skipped: OrganizeSkip[];
  /** The newest batch that can still be undone. */
  lastBatch?: { id: number; files: number; at: string };
}

export interface OrganizeResult {
  batchId: number;
  moved: number;
  skipped: OrganizeSkip[];
}

/** Browse folders on this server, or over a (possibly unsaved) SSH, SFTP or SMB connection. For SMB, `/` lists the shares. */
export interface FolderBrowseRequest {
  path?: string;
  /** A saved source whose connection (and saved password) to use. */
  id?: number;
  connection?: {
    access: FolderAccessKind;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    privateKeyPath?: string;
    domain?: string;
  };
}

/** Which folder locations this server can reach. */
export interface FolderAccessOptions {
  /** rclone is installed, so SMB shares work. */
  smb: boolean;
}
