import type { CuePoints, MixMap, MixMode, TransitionPlan } from '@playarr/mix';
import type {
  Album,
  AlbumDetail,
  AlbumRef,
  AlbumRequest,
  AlbumSort,
  Artist,
  ArtistDetail,
  ArtistMatch,
  CoverLayout,
  DiscoverArtist,
  DiscoverArtistDetail,
  DiscoverResults,
  FavoriteTrack,
  FolderAccessOptions,
  FolderBrowseRequest,
  FolderListing,
  HealthStatus,
  ListenBrainzInfo,
  ListeningStats,
  Lyrics,
  MatchingSettings,
  MixDetail,
  MixSettings,
  MixSettingsInfo,
  MixSummary,
  MusicBrainzStatus,
  OrganizePlan,
  OrganizeResult,
  PlaylistDetail,
  PlaylistSummary,
  PlayReport,
  Profile,
  Recommendations,
  RematchResult,
  RequestSettingsInfo,
  RequestSettingsPatch,
  ReviewAction,
  ReviewGroup,
  SearchResults,
  SourceInfo,
  SourceInput,
  SourceTestResult,
  SourcesResponse,
  StatsRange,
  Track,
  TrackLevel,
  TrackMetadata,
  UpdateInfo,
  UpdateSettings,
} from '@playarr/shared';
import { usePrefs } from './prefs';

/**
 * The server's answer for one song into the next: the file to play (ready), still rendering (pending,
 * ask again), better played straight on, or not possible (no mix map yet, say).
 */
export type TransitionAnswer =
  | { status: 'ready'; plan: TransitionPlan; url: string; continuationUrl?: string }
  | { status: 'pending'; plan: TransitionPlan }
  | { status: 'straight'; plan: TransitionPlan }
  | { status: 'unavailable'; reason: string };

/** How many of the library's songs are ready for DJ mix (GET /api/mix-maps/progress). */
export interface MixMapProgress {
  /** Audio analysis is on: without it there's no DJ mix. */
  enabled: boolean;
  songs: number;
  /** Songs with a mix map. */
  ready: number;
  /** Of those, the ones whose beats and bars the beat model found (the rest: the older onset analysis). */
  beatModel: number;
  /** Songs whose analysis failed lately (tried again a day later). */
  failed: number;
  /** Songs queued for analysis, and being analysed now. */
  waiting: number;
  working: number;
  /** The whole library is analysed in the background (Settings → Mixes); otherwise songs as they come up to play. */
  libraryScan: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    // X-Playarr: the server only accepts changes from Playarr's own pages (other sites can't send it).
    headers: {
      Accept: 'application/json',
      'X-Playarr': '1',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      // Who's listening on this device: their mixes, stats and history.
      ...(usePrefs.getState().profileId ? { 'X-Playarr-Profile': String(usePrefs.getState().profileId) } : {}),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status);
  }
  return (res.status === 204 ? undefined : res.json()) as Promise<T>;
}

const get = <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal });

export const api = {
  health: () => get<HealthStatus>('/api/health'),
  musicbrainzStatus: () => get<MusicBrainzStatus>('/api/musicbrainz/status'),
  artists: () => get<Artist[]>('/api/artists'),
  artist: (id: number) => get<ArtistDetail>(`/api/artists/${id}`),
  artistTracks: (id: number) => get<Track[]>(`/api/artists/${id}/tracks`),
  albums: (sort: AlbumSort, limit?: number) =>
    get<Album[]>(`/api/albums?sort=${sort}${limit ? `&limit=${limit}` : ''}`),
  randomAlbums: (limit = 12) => get<Album[]>(`/api/albums/random?limit=${limit}`),
  album: (id: number) => get<AlbumDetail>(`/api/albums/${id}`),
  randomTracks: (limit = 50) => get<Track[]>(`/api/tracks/random?limit=${limit}`),
  search: (q: string, signal?: AbortSignal) =>
    get<SearchResults>(`/api/search?q=${encodeURIComponent(q)}`, signal),
  discover: (q: string, signal?: AbortSignal) =>
    get<DiscoverResults>(`/api/discover/search?q=${encodeURIComponent(q)}`, signal),
  discoverArtist: (mbid: string, signal?: AbortSignal) =>
    get<DiscoverArtistDetail>(`/api/discover/artists/${mbid}`, signal),
  similarArtists: (mbid: string, signal?: AbortSignal) => get<DiscoverArtist[]>(`/api/discover/artists/${mbid}/similar`, signal),
  findArtist: (name: string, signal?: AbortSignal) =>
    get<ArtistMatch>(`/api/discover/artist-lookup?name=${encodeURIComponent(name)}`, signal),
  requests: () => get<AlbumRequest[]>('/api/requests'),
  requestAlbum: (ref: AlbumRef) =>
    request<AlbumRequest>('/api/requests', { method: 'POST', body: JSON.stringify(ref) }),
  removeRequest: (mbid: string) => request<void>(`/api/requests/${mbid}`, { method: 'DELETE' }),
  favorites: () => get<FavoriteTrack[]>('/api/favorites'),
  addFavorite: (recordingId: string) =>
    request<void>(`/api/favorites/${encodeURIComponent(recordingId)}`, { method: 'PUT' }),
  removeFavorite: (recordingId: string) =>
    request<void>(`/api/favorites/${encodeURIComponent(recordingId)}`, { method: 'DELETE' }),
  playlists: () => get<PlaylistSummary[]>('/api/playlists'),
  playlist: (id: number) => get<PlaylistDetail>(`/api/playlists/${id}`),
  createPlaylist: (body: { name: string; description?: string; recordingIds?: string[] }) =>
    request<PlaylistDetail>('/api/playlists', { method: 'POST', body: JSON.stringify(body) }),
  updatePlaylist: (id: number, patch: { name?: string; description?: string }) =>
    request<PlaylistDetail>(`/api/playlists/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deletePlaylist: (id: number) => request<void>(`/api/playlists/${id}`, { method: 'DELETE' }),
  addToPlaylist: (id: number, recordingIds: string[]) =>
    request<PlaylistDetail>(`/api/playlists/${id}/items`, { method: 'POST', body: JSON.stringify({ recordingIds }) }),
  removeFromPlaylist: (id: number, itemId: number) =>
    request<PlaylistDetail>(`/api/playlists/${id}/items/${itemId}`, { method: 'DELETE' }),
  reorderPlaylist: (id: number, itemIds: number[]) =>
    request<PlaylistDetail>(`/api/playlists/${id}/order`, { method: 'PUT', body: JSON.stringify({ itemIds }) }),
  setPlaylistCover: (id: number, layout: CoverLayout, variant: number) =>
    request<PlaylistDetail>(`/api/playlists/${id}/cover`, { method: 'PUT', body: JSON.stringify({ layout, variant }) }),
  /** A candidate cover drawn from the playlist's current songs (for the picker). */
  playlistCoverPreview: (id: number, layout: CoverLayout, variant: number) => `/art/playlist/${id}/preview?layout=${layout}&variant=${variant}`,
  playlistRecommendations: (id: number, variant = 0) =>
    get<Recommendations>(`/api/playlists/${id}/recommendations?variant=${variant}`),
  sources: () => get<SourcesResponse>('/api/settings/sources'),
  addSource: (input: SourceInput) =>
    request<SourceInfo>('/api/settings/sources', { method: 'POST', body: JSON.stringify(input) }),
  updateSource: (id: number, input: SourceInput) =>
    request<SourceInfo>(`/api/settings/sources/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  removeSource: (id: number) => request<void>(`/api/settings/sources/${id}`, { method: 'DELETE' }),
  reorderSources: (ids: number[]) =>
    request<SourcesResponse>('/api/settings/sources/order', { method: 'PUT', body: JSON.stringify({ ids }) }),
  testSource: (body: { id?: number; url?: string; apiKey?: string }) =>
    request<SourceTestResult>('/api/settings/sources/test', { method: 'POST', body: JSON.stringify(body) }),
  rescanSource: (id: number) => request<void>(`/api/settings/sources/${id}/rescan`, { method: 'POST' }),
  /** Folders on this server, or over a (possibly unsaved) SSH, SFTP or SMB connection. */
  browseFolders: (req: FolderBrowseRequest) =>
    request<FolderListing>('/api/settings/folders/browse', { method: 'POST', body: JSON.stringify(req) }),
  /** Which folder locations this server can reach (SMB needs rclone). */
  folderAccess: () => get<FolderAccessOptions>('/api/settings/folders/access'),
  review: (id: number) => get<ReviewGroup[]>(`/api/settings/sources/${id}/review`),
  trackMetadata: (id: number) => get<TrackMetadata>(`/api/tracks/${id}/metadata`),
  rematchFile: (fileId: number) => request<RematchResult>(`/api/files/${fileId}/rematch`, { method: 'POST' }),
  reviewAction: (id: number, action: ReviewAction) =>
    request<void>(`/api/settings/sources/${id}/review`, { method: 'POST', body: JSON.stringify(action) }),
  rematchSource: (id: number) => request<void>(`/api/settings/sources/${id}/rematch`, { method: 'POST' }),
  organizePlan: (id: number) => get<OrganizePlan>(`/api/settings/sources/${id}/organize`),
  organize: (id: number, moves: string[]) =>
    request<OrganizeResult>(`/api/settings/sources/${id}/organize`, { method: 'POST', body: JSON.stringify({ moves }) }),
  undoOrganize: (id: number, batchId: number) =>
    request<{ restored: number }>(`/api/settings/sources/${id}/organize/undo`, { method: 'POST', body: JSON.stringify({ batchId }) }),
  matching: () => get<MatchingSettings>('/api/settings/matching'),
  saveMatching: (acoustidKey: string) =>
    request<MatchingSettings>('/api/settings/matching', { method: 'PUT', body: JSON.stringify({ acoustidKey }) }),
  requestSettings: () => get<RequestSettingsInfo>('/api/settings/requests'),
  saveRequestSettings: (patch: RequestSettingsPatch) =>
    request<RequestSettingsInfo>('/api/settings/requests', { method: 'PUT', body: JSON.stringify(patch) }),
  updates: () => get<UpdateInfo>('/api/settings/updates'),
  saveUpdates: (patch: Partial<UpdateSettings>) =>
    request<UpdateInfo>('/api/settings/updates', { method: 'PUT', body: JSON.stringify(patch) }),
  checkForUpdates: () => request<UpdateInfo>('/api/settings/updates/check', { method: 'POST' }),
  /** keepalive: a report sent as the page closes still arrives. */
  reportPlays: (plays: PlayReport[]) =>
    request<{ recorded: number }>('/api/plays', { method: 'POST', body: JSON.stringify({ plays }), keepalive: true }),
  profiles: () => get<Profile[]>('/api/profiles'),
  createProfile: (name: string) => request<Profile>('/api/profiles', { method: 'POST', body: JSON.stringify({ name }) }),
  renameProfile: (id: number, name: string) => request<Profile>(`/api/profiles/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteProfile: (id: number) => request<Profile[]>(`/api/profiles/${id}`, { method: 'DELETE' }),
  stats: (range: StatsRange) => get<ListeningStats>(`/api/stats?range=${range}`),
  recentAlbums: () => get<Album[]>('/api/plays/recent-albums'),
  lyrics: (trackId: number) => get<{ lyrics: Lyrics | null }>(`/api/tracks/${trackId}/lyrics`).then((r) => r.lyrics),
  levels: (ids: string[]) => request<Record<string, TrackLevel>>('/api/levels', { method: 'POST', body: JSON.stringify({ ids }) }),
  /**
   * `from` into `to` (catalog song ids). `position`: where `from` is now, so the plan doesn't start in
   * the past. `files`: the files the player has for the two songs, so the server never renders from
   * another one (it answers "unavailable" if the library has since picked a different file). `how`: the
   * listener's fade length (for songs that can't be mixed on the beat), and whether the queue plays the
   * songs' album (songs of one album in order then go straight on).
   */
  transition: (
    from: number,
    to: number,
    mode: MixMode,
    position?: number,
    files?: { fromFileId: number; toFileId: number },
    how?: { fade?: number; albumQueue?: boolean },
  ) => request<TransitionAnswer>('/api/transitions', { method: 'POST', body: JSON.stringify({ from, to, mode, position, ...files, ...how }) }),
  mixMapProgress: () => get<MixMapProgress>('/api/mix-maps/progress'),
  /**
   * Queues every song still to be analysed for DJ mix, once (Settings → Mixes' switch stays as it is);
   * `again`: every song, those ready included.
   */
  analyzeForMixing: (again = false) =>
    request<{ queued: number }>('/api/mix-maps/analyze', { method: 'POST', body: JSON.stringify({ again }) }),
  /** The mix maps of these recordings (at most 50), with any cue points set by hand. */
  mixMaps: (ids: string[]) =>
    request<Record<string, MixMap & { cues?: CuePoints }>>('/api/mix-maps', { method: 'POST', body: JSON.stringify({ ids }) }),
  /** Replaces both mix points: null (or left out) clears one, so the song uses the detected point again. */
  setCues: (recordingId: string, cues: { mixIn: number | null; mixOut: number | null }) =>
    request<CuePoints>(`/api/recordings/${encodeURIComponent(recordingId)}/cues`, { method: 'PUT', body: JSON.stringify(cues) }),
  radio: (seeds: string[], exclude: string[] = [], count = 25) =>
    request<Track[]>('/api/radio', { method: 'POST', body: JSON.stringify({ seeds, exclude, count }) }),
  mixes: () => get<MixSummary[]>(`/api/mixes?tz=${encodeURIComponent(timeZone())}`),
  mix: (key: string) => get<MixDetail>(`/api/mixes/${key}?tz=${encodeURIComponent(timeZone())}`),
  regenerateMix: (key: string) =>
    request<MixDetail>(`/api/mixes/${key}/regenerate?tz=${encodeURIComponent(timeZone())}`, { method: 'POST' }),
  saveMix: (key: string) =>
    request<PlaylistDetail>(`/api/mixes/${key}/save?tz=${encodeURIComponent(timeZone())}`, { method: 'POST' }),
  mixSettings: () => get<MixSettingsInfo>('/api/settings/mixes'),
  saveMixSettings: (patch: Partial<MixSettings>) =>
    request<MixSettingsInfo>('/api/settings/mixes', { method: 'PUT', body: JSON.stringify(patch) }),
  listenBrainz: () => get<ListenBrainzInfo>('/api/settings/listenbrainz'),
  saveListenBrainz: (patch: { token?: string; enabled?: boolean }) =>
    request<ListenBrainzInfo>('/api/settings/listenbrainz', { method: 'PUT', body: JSON.stringify(patch) }),
  disconnectListenBrainz: () => request<ListenBrainzInfo>('/api/settings/listenbrainz', { method: 'DELETE' }),
  sendEarlierListens: () => request<ListenBrainzInfo>('/api/settings/listenbrainz/earlier', { method: 'POST' }),
  clearHistory: () => request<MixSettingsInfo>('/api/settings/mixes/history', { method: 'DELETE' }),
};

/** This device's time zone: mixes follow the listener's clock, not the server's. */
function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Append a size hint to an /art URL so the server returns a resized WebP. */
export function sized(url: string | undefined, size: number): string | undefined {
  if (!url) return undefined;
  const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  return `${url}${url.includes('?') ? '&' : '?'}size=${Math.round(size * dpr)}`;
}

/** The artist page's backdrop: the wide fanart, or else the square photo (shown blown up and blurred). */
export const artistHero = (artist: { fanartUrl?: string; imageUrl?: string }) =>
  sized(artist.fanartUrl ?? artist.imageUrl, artist.fanartUrl ? 1200 : 480);
