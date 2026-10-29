import type {
  Album,
  AlbumDetail,
  AlbumRef,
  AlbumRequest,
  AlbumSort,
  Artist,
  ArtistMatch,
  CoverLayout,
  ArtistDetail,
  DiscoverArtistDetail,
  DiscoverResults,
  FavoriteTrack,
  PlaylistDetail,
  PlaylistSummary,
  HealthStatus,
  Recommendations,
  SearchResults,
  Track,
} from '@playarr/shared';

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
    headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
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
};

/** Append a size hint to an /art URL so the server returns a resized WebP. */
export function sized(url: string | undefined, size: number): string | undefined {
  if (!url) return undefined;
  const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  return `${url}${url.includes('?') ? '&' : '?'}size=${Math.round(size * dpr)}`;
}
