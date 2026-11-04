import type { CuePoints, MixMapEntry, MixMode, TransitionAnswer } from '@playarr/mix';
import type {
  Account,
  AccountRole,
  Album,
  AlbumDetail,
  AlbumRef,
  AlbumRequest,
  AlbumSort,
  AnalysisKind,
  AnalysisProgress,
  Artist,
  ArtistDetail,
  ArtistMatch,
  CoverLayout,
  CreatedAccount,
  DeviceSetting,
  DiscoverArtist,
  DiscoverArtistDetail,
  DiscoverResults,
  FavoriteTrack,
  FolderAccessOptions,
  FolderBrowseRequest,
  FolderListing,
  HealthStatus,
  ListedAccount,
  ListenBrainzInfo,
  ListeningStats,
  Lyrics,
  MatchingSettings,
  MixDetail,
  MixSettingsInfo,
  MixSettingsPatch,
  MixSummary,
  MusicBrainzStatus,
  OrganizePlan,
  OrganizeResult,
  PlaylistDetail,
  PlaylistSummary,
  PlayReport,
  Recommendations,
  RematchResult,
  RequestSettingsInfo,
  RequestSettingsPatch,
  ReviewAction,
  ReviewGroup,
  SearchResults,
  ServerInfo,
  SessionInfo,
  SetupCode,
  SignInResponse,
  SourceInfo,
  SourceInput,
  SourceTestResult,
  SourcesResponse,
  StatsRange,
  Track,
  TrackLevel,
  TrackMetadata,
  UpdateInfo,
  UpdateSettingsPatch,
} from '@playarr/shared';

// Answer types the iOS app shares, generated from these packages: re-exported for the web's imports.
export type { TransitionAnswer } from '@playarr/mix';
export type { AnalysisKind, AnalysisProgress } from '@playarr/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** What an admin sets for an account (Settings → Accounts). */
export interface AccountInput {
  username: string;
  name: string;
  role: AccountRole;
  canRequest: boolean;
  sources: number[] | null;
  /** The device settings this account may not change (ignored for admins). */
  locked?: DeviceSetting[];
}

/** Where a 401 sends the page: to sign in, then back. Replaceable in tests. */
export const signInRedirect = {
  go() {
    if (/^\/(sign-in|redeem|setup)(\/|$)/.test(location.pathname)) return;
    location.assign(`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`);
  },
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    // X-Playarr: the server only accepts changes from Playarr's own pages (other sites can't send it).
    headers: {
      Accept: 'application/json',
      'X-Playarr': '1',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    // Signed out (or never signed in) on a server with accounts. The sign-in calls answer 401 themselves.
    if (res.status === 401 && !path.startsWith('/api/auth/')) signInRedirect.go();
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
  updatePlaylist: (id: number, patch: { name?: string; description?: string; shared?: boolean }) =>
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
  saveUpdates: (patch: UpdateSettingsPatch) =>
    request<UpdateInfo>('/api/settings/updates', { method: 'PUT', body: JSON.stringify(patch) }),
  checkForUpdates: () => request<UpdateInfo>('/api/settings/updates/check', { method: 'POST' }),
  /** keepalive: a report sent as the page closes still arrives. */
  reportPlays: (plays: PlayReport[]) =>
    request<{ recorded: number }>('/api/plays', { method: 'POST', body: JSON.stringify({ plays }), keepalive: true }),
  // Accounts (Settings → Accounts) and signing in.
  server: () => get<ServerInfo>('/api/server'),
  me: () => get<Account>('/api/auth/me'),
  setup: (body: { username: string; name: string; password: string; device: string; platform: string }) =>
    request<SignInResponse>('/api/auth/setup', { method: 'POST', body: JSON.stringify(body) }),
  signIn: (body: { username: string; password: string; device: string; platform: string }) =>
    request<SignInResponse>('/api/auth/sign-in', { method: 'POST', body: JSON.stringify(body) }),
  redeem: (body: { code: string; password: string; device: string; platform: string }) =>
    request<SignInResponse>('/api/auth/redeem', { method: 'POST', body: JSON.stringify(body) }),
  signOut: () => request<void>('/api/auth/sign-out', { method: 'POST' }),
  switchAccount: (token: string) => request<Account>('/api/auth/switch', { method: 'POST', body: JSON.stringify({ token }) }),
  accounts: () => get<ListedAccount[]>('/api/accounts'),
  createAccount: (body: AccountInput) => request<CreatedAccount>('/api/accounts', { method: 'POST', body: JSON.stringify(body) }),
  updateAccount: (id: number, patch: Partial<AccountInput>) => request<Account>(`/api/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteAccount: (id: number) => request<ListedAccount[]>(`/api/accounts/${id}`, { method: 'DELETE' }),
  resetAccount: (id: number) => request<SetupCode>(`/api/accounts/${id}/reset`, { method: 'POST' }),
  sessions: (id: number) => get<SessionInfo[]>(`/api/accounts/${id}/sessions`),
  endSession: (id: number, sessionId: number) => request<SessionInfo[]>(`/api/accounts/${id}/sessions/${sessionId}`, { method: 'DELETE' }),
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
    how?: { fade?: number; albumQueue?: boolean; levels?: { a: number; b: number } },
  ) => request<TransitionAnswer>('/api/transitions', { method: 'POST', body: JSON.stringify({ from, to, mode, position, ...files, ...how }) }),
  analysisProgress: () => get<AnalysisProgress>('/api/analysis/progress'),
  /**
   * Queues every song this analysis (or `all` of them) hasn't done yet, once (the background switch
   * stays as it is); `again`: every song, those done included.
   */
  runAnalysis: (kind: AnalysisKind | 'all', again = false) =>
    request<{ queued: number }>(`/api/analysis/${kind}`, { method: 'POST', body: JSON.stringify({ again }) }),
  /** The mix maps of these recordings (at most 50), with any cue points set by hand. */
  mixMaps: (ids: string[]) =>
    request<Record<string, MixMapEntry>>('/api/mix-maps', { method: 'POST', body: JSON.stringify({ ids }) }),
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
  saveMixSettings: (patch: MixSettingsPatch) =>
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
