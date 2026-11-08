import type { CuePoints, MixMapEntry, MixMode, TransitionAnswer } from '@playarr/mix';
import type {
  Account,
  AccountRole,
  Album,
  AlbumDetail,
  AlbumPage,
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
  LuckyMix,
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
  ReachabilityCheck,
  Recommendations,
  RematchResult,
  RequestAccess,
  RequestSettingsInfo,
  RequestSettingsPatch,
  RequestsSeen,
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
  /** May ask for albums (`requestAccess` `on` or `ask`), for servers that predate requestAccess. */
  canRequest: boolean;
  /** Whether its requests go straight to Lidarr, wait for an admin, or can't be made. */
  requestAccess: RequestAccess;
  sources: number[] | null;
  /** The device settings this account may not change (ignored for admins). */
  locked?: DeviceSetting[];
}

/** What a playlist's owner changes (PATCH /api/playlists/:id): only what's given. */
export interface PlaylistPatch {
  name?: string;
  description?: string;
  shared?: boolean;
  /** Everyone it's shared with adds, removes and reorders its songs. */
  collaborative?: boolean;
}

/** Where a 401 sends the page: to sign in, then back. Replaceable in tests. */
export const signInRedirect = {
  go() {
    if (/^\/(sign-in|redeem|setup)(\/|$)/.test(location.pathname)) return;
    location.assign(`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`);
  },
};

/**
 * How long a request may wait for the server to answer: long enough for a slow connection, short enough that one
 * that hung (a dead spot the browser still counts as online) fails, to be tried again or reported, rather than
 * waiting for good. Once it answers, a long answer (the whole library) takes as long as it takes.
 */
export const TIMEOUT_MS = 15_000;
/**
 * Calls the server takes its time over: checking a source, organizing files, asking MusicBrainz or Lidarr, making a
 * mix, looking up lyrics online.
 */
export const SLOW_MS = 120_000;

async function request<T>(path: string, init: RequestInit = {}, timeout = TIMEOUT_MS): Promise<T> {
  // The caller's signal still stops it; so does the time running out.
  const controller = new AbortController();
  const stop = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) stop();
  init.signal?.addEventListener('abort', stop);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  try {
    const res = await fetch(path, {
      ...init,
      signal: controller.signal,
      // X-Playarr: the server only accepts changes from Playarr's own pages (other sites can't send it).
      headers: {
        Accept: 'application/json',
        'X-Playarr': '1',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      // Signed out (or never signed in) on a server with accounts. The sign-in calls answer 401 themselves.
      if (res.status === 401 && !path.startsWith('/api/auth/')) signInRedirect.go();
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  } catch (err) {
    if (timedOut) throw new ApiError('The Playarr server took too long to answer', 0);
    throw err;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', stop);
  }
}

const get = <T>(path: string, signal?: AbortSignal, timeout?: number) => request<T>(path, { signal }, timeout);

export const api = {
  health: () => get<HealthStatus>('/api/health'),
  musicbrainzStatus: () => get<MusicBrainzStatus>('/api/musicbrainz/status'),
  artists: () => get<Artist[]>('/api/artists'),
  artist: (id: number) => get<ArtistDetail>(`/api/artists/${id}`),
  artistTracks: (id: number) => get<Track[]>(`/api/artists/${id}/tracks`),
  albums: (sort: AlbumSort, limit?: number) =>
    get<Album[]>(`/api/albums?sort=${sort}${limit ? `&limit=${limit}` : ''}`),
  albumPage: (sort: AlbumSort, offset: number, limit: number) => get<AlbumPage>(`/api/albums?sort=${sort}&offset=${offset}&limit=${limit}`),
  randomAlbums: (limit = 12) => get<Album[]>(`/api/albums/random?limit=${limit}`),
  album: (id: number) => get<AlbumDetail>(`/api/albums/${id}`),
  randomTracks: (limit = 50) => get<Track[]>(`/api/tracks/random?limit=${limit}`),
  search: (q: string, signal?: AbortSignal) =>
    get<SearchResults>(`/api/search?q=${encodeURIComponent(q)}`, signal),
  discover: (q: string, signal?: AbortSignal) =>
    get<DiscoverResults>(`/api/discover/search?q=${encodeURIComponent(q)}`, signal, SLOW_MS),
  discoverArtist: (mbid: string, signal?: AbortSignal) =>
    get<DiscoverArtistDetail>(`/api/discover/artists/${mbid}`, signal, SLOW_MS),
  similarArtists: (mbid: string, signal?: AbortSignal) => get<DiscoverArtist[]>(`/api/discover/artists/${mbid}/similar`, signal, SLOW_MS),
  findArtist: (name: string, signal?: AbortSignal) =>
    get<ArtistMatch>(`/api/discover/artist-lookup?name=${encodeURIComponent(name)}`, signal, SLOW_MS),
  requests: () => get<AlbumRequest[]>('/api/requests'),
  requestAlbum: (ref: AlbumRef) =>
    request<AlbumRequest>('/api/requests', { method: 'POST', body: JSON.stringify(ref) }, SLOW_MS),
  removeRequest: (mbid: string) => request<void>(`/api/requests/${mbid}`, { method: 'DELETE' }),
  /** An admin's yes to a request waiting for approval (it goes to Lidarr), or no. */
  approveRequest: (mbid: string) => request<AlbumRequest>(`/api/requests/${encodeURIComponent(mbid)}/approve`, { method: 'POST' }),
  declineRequest: (mbid: string) => request<AlbumRequest>(`/api/requests/${encodeURIComponent(mbid)}/decline`, { method: 'POST' }),
  /** These of the account's requests have been seen as they are: no longer news on Requests' badge. */
  markRequestsSeen: (mbids: string[]) =>
    request<void>('/api/requests/seen', { method: 'POST', body: JSON.stringify({ mbids } satisfies RequestsSeen) }),
  favorites: () => get<FavoriteTrack[]>('/api/favorites'),
  /** `favoritedAt`: when it was first favorited, putting a favorite taken back where it was in the list. */
  addFavorite: (recordingId: string, favoritedAt?: string) =>
    request<void>(`/api/favorites/${encodeURIComponent(recordingId)}`, { method: 'PUT', ...(favoritedAt ? { body: JSON.stringify({ favoritedAt }) } : {}) }),
  removeFavorite: (recordingId: string) =>
    request<void>(`/api/favorites/${encodeURIComponent(recordingId)}`, { method: 'DELETE' }),
  playlists: () => get<PlaylistSummary[]>('/api/playlists'),
  playlist: (id: number) => get<PlaylistDetail>(`/api/playlists/${id}`),
  createPlaylist: (body: { name: string; description?: string; recordingIds?: string[] }) =>
    request<PlaylistDetail>('/api/playlists', { method: 'POST', body: JSON.stringify(body) }),
  /** `collaborative` only on a shared playlist (stopping sharing stops it too). */
  updatePlaylist: (id: number, patch: PlaylistPatch) =>
    request<PlaylistDetail>(`/api/playlists/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deletePlaylist: (id: number) => request<void>(`/api/playlists/${id}`, { method: 'DELETE' }),
  addToPlaylist: (id: number, recordingIds: string[]) =>
    request<PlaylistDetail>(`/api/playlists/${id}/items`, { method: 'POST', body: JSON.stringify({ recordingIds }) }),
  /**
   * How many of these songs each playlist the account can add to (its own, and collaborative ones shared with it)
   * already holds, only those holding any, by playlist id.
   */
  playlistsHolding: (recordingIds: string[]) =>
    request<{ holding: Record<string, number> }>('/api/playlists/holding', { method: 'POST', body: JSON.stringify({ recordingIds }) }).then(
      (r) => r.holding,
    ),
  removeFromPlaylist: (id: number, itemId: number) =>
    request<PlaylistDetail>(`/api/playlists/${id}/items/${itemId}`, { method: 'DELETE' }),
  reorderPlaylist: (id: number, itemIds: number[]) =>
    request<PlaylistDetail>(`/api/playlists/${id}/order`, { method: 'PUT', body: JSON.stringify({ itemIds }) }),
  setPlaylistCover: (id: number, layout: CoverLayout, variant: number) =>
    request<PlaylistDetail>(`/api/playlists/${id}/cover`, { method: 'PUT', body: JSON.stringify({ layout, variant }) }),
  /** A candidate cover drawn from the playlist's current songs (for the picker). */
  playlistCoverPreview: (id: number, layout: CoverLayout, variant: number) => `/art/playlist/${id}/preview?layout=${layout}&variant=${variant}`,
  playlistRecommendations: (id: number, variant = 0) =>
    get<Recommendations>(`/api/playlists/${id}/recommendations?variant=${variant}`, undefined, SLOW_MS),
  favoriteRecommendations: (variant = 0) => get<Recommendations>(`/api/favorites/recommendations?variant=${variant}`, undefined, SLOW_MS),
  sources: () => get<SourcesResponse>('/api/settings/sources'),
  addSource: (input: SourceInput) =>
    request<SourceInfo>('/api/settings/sources', { method: 'POST', body: JSON.stringify(input) }, SLOW_MS),
  updateSource: (id: number, input: SourceInput) =>
    request<SourceInfo>(`/api/settings/sources/${id}`, { method: 'PATCH', body: JSON.stringify(input) }, SLOW_MS),
  removeSource: (id: number) => request<void>(`/api/settings/sources/${id}`, { method: 'DELETE' }, SLOW_MS),
  reorderSources: (ids: number[]) =>
    request<SourcesResponse>('/api/settings/sources/order', { method: 'PUT', body: JSON.stringify({ ids }) }),
  testSource: (body: { id?: number; url?: string; apiKey?: string }) =>
    request<SourceTestResult>('/api/settings/sources/test', { method: 'POST', body: JSON.stringify(body) }, SLOW_MS),
  rescanSource: (id: number) => request<void>(`/api/settings/sources/${id}/rescan`, { method: 'POST' }),
  /** Folders on this server, or over a (possibly unsaved) SSH, SFTP or SMB connection. */
  browseFolders: (req: FolderBrowseRequest) =>
    request<FolderListing>('/api/settings/folders/browse', { method: 'POST', body: JSON.stringify(req) }, SLOW_MS),
  /** Which folder locations this server can reach (SMB needs rclone). */
  folderAccess: () => get<FolderAccessOptions>('/api/settings/folders/access'),
  review: (id: number) => get<ReviewGroup[]>(`/api/settings/sources/${id}/review`),
  trackMetadata: (id: number) => get<TrackMetadata>(`/api/tracks/${id}/metadata`),
  rematchFile: (fileId: number) => request<RematchResult>(`/api/files/${fileId}/rematch`, { method: 'POST' }, SLOW_MS),
  reviewAction: (id: number, action: ReviewAction) =>
    request<void>(`/api/settings/sources/${id}/review`, { method: 'POST', body: JSON.stringify(action) }, SLOW_MS),
  rematchSource: (id: number) => request<void>(`/api/settings/sources/${id}/rematch`, { method: 'POST' }, SLOW_MS),
  organizePlan: (id: number) => get<OrganizePlan>(`/api/settings/sources/${id}/organize`, undefined, SLOW_MS),
  organize: (id: number, moves: string[]) =>
    request<OrganizeResult>(`/api/settings/sources/${id}/organize`, { method: 'POST', body: JSON.stringify({ moves }) }, SLOW_MS),
  undoOrganize: (id: number, batchId: number) =>
    request<{ restored: number }>(`/api/settings/sources/${id}/organize/undo`, { method: 'POST', body: JSON.stringify({ batchId }) }, SLOW_MS),
  matching: () => get<MatchingSettings>('/api/settings/matching'),
  saveMatching: (acoustidKey: string) =>
    request<MatchingSettings>('/api/settings/matching', { method: 'PUT', body: JSON.stringify({ acoustidKey }) }, SLOW_MS),
  requestSettings: () => get<RequestSettingsInfo>('/api/settings/requests'),
  saveRequestSettings: (patch: RequestSettingsPatch) =>
    request<RequestSettingsInfo>('/api/settings/requests', { method: 'PUT', body: JSON.stringify(patch) }, SLOW_MS),
  updates: () => get<UpdateInfo>('/api/settings/updates'),
  saveUpdates: (patch: UpdateSettingsPatch) =>
    request<UpdateInfo>('/api/settings/updates', { method: 'PUT', body: JSON.stringify(patch) }),
  checkForUpdates: () => request<UpdateInfo>('/api/settings/updates/check', { method: 'POST' }),
  checkReachability: () => request<ReachabilityCheck>('/api/settings/reachability/check', { method: 'POST' }),
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
  /** Listen as an account: a token just signed in with, or one the server keeps in this browser as a cookie. */
  switchAccount: (who: { token: string } | { accountId: number }) => request<Account>('/api/auth/switch', { method: 'POST', body: JSON.stringify(who) }),
  /** A token an older version kept in localStorage, for the server to keep as a cookie no script can read. */
  keepSignIn: (token: string) => request<Account>('/api/auth/keep', { method: 'POST', body: JSON.stringify({ token }) }),
  accounts: () => get<ListedAccount[]>('/api/accounts'),
  createAccount: (body: AccountInput) => request<CreatedAccount>('/api/accounts', { method: 'POST', body: JSON.stringify(body) }),
  updateAccount: (id: number, patch: Partial<AccountInput>) => request<Account>(`/api/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteAccount: (id: number) => request<ListedAccount[]>(`/api/accounts/${id}`, { method: 'DELETE' }),
  resetAccount: (id: number) => request<SetupCode>(`/api/accounts/${id}/reset`, { method: 'POST' }),
  sessions: (id: number) => get<SessionInfo[]>(`/api/accounts/${id}/sessions`),
  endSession: (id: number, sessionId: number) => request<SessionInfo[]>(`/api/accounts/${id}/sessions/${sessionId}`, { method: 'DELETE' }),
  stats: (range: StatsRange) => get<ListeningStats>(`/api/stats?range=${range}`),
  recentAlbums: () => get<Album[]>('/api/plays/recent-albums'),
  lyrics: (trackId: number) => get<{ lyrics: Lyrics | null }>(`/api/tracks/${trackId}/lyrics`, undefined, SLOW_MS).then((r) => r.lyrics),
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
    request<Track[]>('/api/radio', { method: 'POST', body: JSON.stringify({ seeds, exclude, count }) }, SLOW_MS),
  /** Feeling lucky: 15 songs put together now, from one that suits the hour. */
  lucky: () => request<LuckyMix>(`/api/lucky?tz=${encodeURIComponent(timeZone())}`, { method: 'POST' }, SLOW_MS),
  mixes: () => get<MixSummary[]>(`/api/mixes?tz=${encodeURIComponent(timeZone())}`, undefined, SLOW_MS),
  mix: (key: string) => get<MixDetail>(`/api/mixes/${key}?tz=${encodeURIComponent(timeZone())}`, undefined, SLOW_MS),
  regenerateMix: (key: string) =>
    request<MixDetail>(`/api/mixes/${key}/regenerate?tz=${encodeURIComponent(timeZone())}`, { method: 'POST' }, SLOW_MS),
  saveMix: (key: string) =>
    request<PlaylistDetail>(`/api/mixes/${key}/save?tz=${encodeURIComponent(timeZone())}`, { method: 'POST' }, SLOW_MS),
  mixSettings: () => get<MixSettingsInfo>('/api/settings/mixes'),
  saveMixSettings: (patch: MixSettingsPatch) =>
    request<MixSettingsInfo>('/api/settings/mixes', { method: 'PUT', body: JSON.stringify(patch) }),
  listenBrainz: () => get<ListenBrainzInfo>('/api/settings/listenbrainz'),
  saveListenBrainz: (patch: { token?: string; enabled?: boolean }) =>
    request<ListenBrainzInfo>('/api/settings/listenbrainz', { method: 'PUT', body: JSON.stringify(patch) }, SLOW_MS),
  disconnectListenBrainz: () => request<ListenBrainzInfo>('/api/settings/listenbrainz', { method: 'DELETE' }),
  sendEarlierListens: () => request<ListenBrainzInfo>('/api/settings/listenbrainz/earlier', { method: 'POST' }, SLOW_MS),
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
