import type {
  AlbumRef,
  AlbumRequest,
  AlbumSort,
  AvailabilityState,
  CoverLayout,
  FavoriteTrack,
  FolderBrowseRequest,
  ListenBrainzInfo,
  MixDetail,
  MixSettings,
  MixSettingsInfo,
  PlaylistDetail,
  RequestSettingsInfo,
  RequestSettingsPatch,
  ReviewAction,
  ReviewGroup,
  SourceInput,
  StatsRange,
  Track,
  UpdateInfo,
  UpdateSettings,
} from '@playarr/shared';
import type { MixMap } from '@playarr/mix';
import { keepPreviousData, queryOptions, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { api, ApiError } from './api';
import { plural } from './format';
import { usePrefs } from './prefs';
import { queryClient } from './queryClient';
import { toast } from './toast';

export const useHealth = () =>
  useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 30_000, refetchInterval: 60_000 });

/** How busy MusicBrainz is. Polled quickly while lookups wait, slowly otherwise; off when `enabled` is false. */
export const useMusicBrainzStatus = (enabled = true) =>
  useQuery({
    queryKey: ['musicbrainz-status'],
    queryFn: api.musicbrainzStatus,
    enabled,
    refetchInterval: (q) => (q.state.data?.queued ? 1500 : 15_000),
  });

/** How far the library is from ready for DJ mix: polled while songs are waiting or being analysed, then left alone. */
export const useMixMapProgress = (enabled = true) =>
  useQuery({
    queryKey: ['mix-map-progress'],
    queryFn: api.mixMapProgress,
    enabled,
    refetchInterval: (q) => (q.state.data && (q.state.data.waiting > 0 || q.state.data.working > 0) ? 10_000 : false),
  });

/** Settings → Playback → Analyse all songs now: the progress line then polls while they're analysed. */
export function useAnalyzeForMixing() {
  const client = useQueryClient();
  return useMutation({
    /** `again`: every song, those already analysed included (Analyse all again). */
    mutationFn: (again: boolean = false) => api.analyzeForMixing(again),
    onSuccess: ({ queued }, again) => {
      const songs = `${queued.toLocaleString('en')} ${queued === 1 ? 'song' : 'songs'}`;
      toast(
        queued
          ? `Analysing ${songs}${again ? ' again' : ''} in the background`
          : 'Every song is already analysed or waiting its turn',
      );
      void client.invalidateQueries({ queryKey: ['mix-map-progress'] });
    },
    onError: (err) => toast((err as Error).message, 'error'),
  });
}

export const useArtists = () => useQuery({ queryKey: ['artists'], queryFn: api.artists });

export const artistQuery = (id: number) => queryOptions({ queryKey: ['artist', id], queryFn: () => api.artist(id) });
export const useArtist = (id: number) => useQuery({ ...artistQuery(id), enabled: Number.isFinite(id) });

export const useAlbums = (sort: AlbumSort, limit?: number) =>
  useQuery({
    queryKey: ['albums', sort, limit],
    queryFn: () => api.albums(sort, limit),
    placeholderData: keepPreviousData,
  });

/** `seed` is only part of the cache key: bump it to draw a fresh random set. */
export const useRandomAlbums = (limit = 12, seed = 0) =>
  useQuery({
    queryKey: ['albums', 'random', limit, seed],
    queryFn: () => api.randomAlbums(limit),
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });

export const albumQuery = (id: number) => queryOptions({ queryKey: ['album', id], queryFn: () => api.album(id) });
export const useAlbum = (id: number) => useQuery({ ...albumQuery(id), enabled: Number.isFinite(id) });

export const useSearch = (q: string) =>
  useQuery({
    queryKey: ['search', q],
    queryFn: ({ signal }) => api.search(q, signal),
    enabled: q.trim().length > 0,
    placeholderData: keepPreviousData,
  });

export const useDiscover = (q: string) =>
  useQuery({
    queryKey: ['discover', q],
    queryFn: ({ signal }) => api.discover(q, signal),
    enabled: q.trim().length >= 2,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });

export const useDiscoverArtist = (mbid: string | undefined) =>
  useQuery({
    queryKey: ['discover-artist', mbid],
    queryFn: ({ signal }) => api.discoverArtist(mbid!, signal),
    enabled: !!mbid,
    staleTime: 60_000,
  });

/** Artists like this one (ListenBrainz), in the library or not. Changes slowly: kept for an hour. */
export const useSimilarArtists = (mbid: string | undefined) =>
  useQuery({
    queryKey: ['similar-artists', mbid],
    queryFn: ({ signal }) => api.similarArtists(mbid!, signal),
    enabled: !!mbid,
    staleTime: 60 * 60_000,
    retry: false,
  });

export const useArtistLookup = (name: string) =>
  useQuery({
    queryKey: ['artist-lookup', name],
    queryFn: ({ signal }) => api.findArtist(name, signal),
    enabled: !!name,
    staleTime: Infinity,
  });

const ACTIVE: AvailabilityState[] = ['searching', 'downloading', 'importing'];

/** Requests, polled while any are in flight. Read-only: safe to use in many places (album cards, say). */
export function useRequests() {
  return useQuery({
    queryKey: ['requests'],
    queryFn: api.requests,
    refetchInterval: (q) => (q.state.data?.some((r) => ACTIVE.includes(r.availability.state)) ? 10_000 : 60_000),
    staleTime: 5000,
  });
}

/**
 * When a request becomes playable: refresh the library and say so. Mounted once (AppShell), so the toast
 * and the refresh happen once however many places show requests.
 */
export function useWatchRequests() {
  const client = useQueryClient();
  const query = useRequests();
  const previous = useRef<Map<string, AvailabilityState>>(new Map());
  useEffect(() => {
    if (!query.data) return;
    const landed = query.data.filter(
      (r) => r.availability.state === 'available' && previous.current.get(r.mbid) !== 'available' && previous.current.size,
    );
    previous.current = new Map(query.data.map((r) => [r.mbid, r.availability.state]));
    if (landed.length) {
      for (const key of ['albums', 'artists', 'artist', 'health', 'search', 'discover', 'discover-artist', 'recommendations']) {
        void client.invalidateQueries({ queryKey: [key] });
      }
      toast(landed.length === 1 ? `“${landed[0]!.title}” is ready to play` : `${landed.length} albums are ready to play`);
    }
  }, [query.data, client]);
}

export const activeRequestCount = (requests: AlbumRequest[] | undefined) =>
  requests?.filter((r) => ACTIVE.includes(r.availability.state)).length ?? 0;

export function useRequestAlbum() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ref: AlbumRef) => api.requestAlbum(ref),
    onSuccess: (req) => {
      toast(
        req.availability.state === 'searching'
          ? `Requested “${req.title}”. Lidarr is searching for it`
          : `Requested “${req.title}”. Lidarr will search for it on its schedule`,
      );
      void client.invalidateQueries({ queryKey: ['requests'] });
      void client.invalidateQueries({ queryKey: ['discover'] });
      void client.invalidateQueries({ queryKey: ['discover-artist'] });
      void client.invalidateQueries({ queryKey: ['recommendations'] });
    },
    onError: (err) => toast((err as Error).message, 'error'),
  });
}

export const useFavorites = () => useQuery({ queryKey: ['favorites'], queryFn: api.favorites, staleTime: 60_000 });

export const useIsFavorite = (recordingId: string | undefined) =>
  useQuery({
    queryKey: ['favorites'],
    queryFn: api.favorites,
    staleTime: 60_000,
    select: (favs) => !!recordingId && favs.some((f) => f.recordingId === recordingId),
  }).data ?? false;

/** Add/remove a favorite with an optimistic update, so the heart responds instantly. */
export function useToggleFavorite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ track, favorite }: { track: Track; favorite: boolean }) =>
      favorite ? api.addFavorite(track.recordingId) : api.removeFavorite(track.recordingId),
    onMutate: async ({ track, favorite }) => {
      await client.cancelQueries({ queryKey: ['favorites'] });
      const previous = client.getQueryData<FavoriteTrack[]>(['favorites']);
      client.setQueryData<FavoriteTrack[]>(['favorites'], (old = []) => {
        const rest = old.filter((t) => t.recordingId !== track.recordingId);
        return favorite ? [{ ...track, favoritedAt: new Date().toISOString() }, ...rest] : rest;
      });
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      client.setQueryData(['favorites'], ctx?.previous);
      toast(`Couldn't update favorites: ${(err as Error).message}`, 'error');
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['favorites'] }),
  });
}

/** ListenBrainz "songs like these"; `variant` > 0 is a reshuffled mix. Slow-moving, so cache generously. */
export const usePlaylistRecommendations = (id: number, variant: number, enabled: boolean) =>
  useQuery({
    queryKey: ['recommendations', id, variant],
    queryFn: () => api.playlistRecommendations(id, variant),
    enabled,
    staleTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

/** While the server is still listening to new songs, poll so the generated covers refine. */
const COVER_POLL_MS = 4000;

export const usePlaylists = () =>
  useQuery({
    queryKey: ['playlists'],
    queryFn: api.playlists,
    staleTime: 60_000,
    refetchInterval: (q) => (q.state.data?.some((p) => p.cover.pending) ? COVER_POLL_MS : false),
  });

export const playlistQuery = (id: number) => queryOptions({ queryKey: ['playlist', id], queryFn: () => api.playlist(id) });
export const usePlaylist = (id: number) =>
  useQuery({
    ...playlistQuery(id),
    enabled: Number.isFinite(id),
    refetchInterval: (q) => (q.state.data?.cover.pending ? COVER_POLL_MS : false),
  });

/** Playlist mutations: each returns the updated playlist, which refreshes both caches. */
export function usePlaylistMutations() {
  const client = useQueryClient();
  const settle = (p: PlaylistDetail) => {
    client.setQueryData(['playlist', p.id], p);
    void client.invalidateQueries({ queryKey: ['playlists'] });
  };
  const onError = (err: Error) => toast(err.message, 'error');

  return {
    create: useMutation({
      mutationFn: api.createPlaylist,
      onSuccess: (p) => {
        settle(p);
        toast(p.trackCount ? `Created “${p.name}” with ${p.trackCount} ${p.trackCount === 1 ? 'song' : 'songs'}` : `Created “${p.name}”`);
      },
      onError,
    }),
    add: useMutation({
      mutationFn: ({ id, tracks }: { id: number; tracks: Track[] }) => api.addToPlaylist(id, tracks.map((t) => t.recordingId)),
      onSuccess: (p, { tracks }) => {
        settle(p);
        toast(`Added ${tracks.length === 1 ? `“${tracks[0]!.title}”` : `${tracks.length} songs`} to “${p.name}”`);
      },
      onError,
    }),
    setCover: useMutation({
      mutationFn: ({ id, layout, variant }: { id: number; layout: CoverLayout; variant: number }) => api.setPlaylistCover(id, layout, variant),
      onSuccess: settle,
      onError,
    }),
    update: useMutation({
      mutationFn: ({ id, ...patch }: { id: number; name?: string; description?: string }) => api.updatePlaylist(id, patch),
      onSuccess: settle,
      onError,
    }),
    remove: useMutation({
      mutationFn: ({ id, itemId }: { id: number; itemId: number }) => api.removeFromPlaylist(id, itemId),
      onSuccess: settle,
      onError,
    }),
    reorder: useMutation({
      mutationFn: ({ id, itemIds }: { id: number; itemIds: number[] }) => api.reorderPlaylist(id, itemIds),
      // Optimistic: the list already moved under the user's finger.
      onMutate: ({ id, itemIds }) => {
        const previous = client.getQueryData<PlaylistDetail>(['playlist', id]);
        if (previous) {
          const byId = new Map(previous.items.map((i) => [i.itemId, i]));
          client.setQueryData(['playlist', id], { ...previous, items: itemIds.map((i) => byId.get(i)!).filter(Boolean) });
        }
        return { previous };
      },
      onSuccess: settle,
      onError: (err: Error, { id }, ctx) => {
        if (ctx?.previous) client.setQueryData(['playlist', id], ctx.previous);
        onError(err);
      },
    }),
    destroy: useMutation({
      mutationFn: (id: number) => api.deletePlaylist(id),
      onSuccess: (_r, id) => {
        client.removeQueries({ queryKey: ['playlist', id] });
        void client.invalidateQueries({ queryKey: ['playlists'] });
      },
      onError,
    }),
  };
}

/** Sources for Settings. Polls while they sync, and refreshes everything once a sync finishes. */
export function useSources() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['sources'],
    queryFn: api.sources,
    refetchInterval: (q) => (q.state.data?.sources.some((s) => s.syncing || s.matching > 0) ? 2000 : 30_000),
  });
  const syncing = !!query.data?.sources.some((s) => s.syncing);
  const wasSyncing = useRef(false);
  useEffect(() => {
    if (wasSyncing.current && !syncing) void client.invalidateQueries();
    wasSyncing.current = syncing;
  }, [syncing, client]);
  return query;
}

/** Folders to choose from: on this server, or over a (possibly unsaved) SSH, SFTP or SMB connection. */
export const useFolderListing = (req: FolderBrowseRequest, enabled = true) =>
  useQuery({
    // The password itself stays out of the cache key.
    queryKey: ['folders', req.path ?? '', req.id ?? null, req.connection ? { ...req.connection, password: !!req.connection.password } : null],
    queryFn: () => api.browseFolders(req),
    enabled,
    retry: false,
  });

/** Which folder locations this server can reach: SMB shares need rclone on the server. */
export const useFolderAccess = () => useQuery({ queryKey: ['folder-access'], queryFn: api.folderAccess, staleTime: 5 * 60_000 });

/** False once we know there's no Lidarr source: requests and Discover are hidden then. */
export function useHasLidarr() {
  const { data } = useHealth();
  return data === undefined || data.lidarr !== undefined;
}

/** False once we know requests are off in Settings (or there's no Lidarr): Request buttons are hidden then. */
export function useRequestsEnabled() {
  const { data } = useHealth();
  return data === undefined || data.requests;
}

/** Settings → Requests. Outside the home network the server answers 403: no point retrying. */
export const useRequestSettings = () =>
  useQuery({
    queryKey: ['request-settings'],
    queryFn: api.requestSettings,
    retry: (count, err) => !(err instanceof ApiError && err.status === 403) && count < 2,
  });

/** Saves a change at once, showing it before the server answers. */
export function useSaveRequestSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: RequestSettingsPatch) => api.saveRequestSettings(patch),
    onMutate: async (patch) => {
      await client.cancelQueries({ queryKey: ['request-settings'] });
      const previous = client.getQueryData<RequestSettingsInfo>(['request-settings']);
      if (previous) {
        const next: RequestSettingsInfo = { ...previous };
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete next[key as keyof RequestSettingsPatch];
          else if (value !== undefined) Object.assign(next, { [key]: value });
        }
        client.setQueryData(['request-settings'], next);
      }
      return { previous };
    },
    onSuccess: (data) => client.setQueryData(['request-settings'], data),
    onError: (err: Error, _patch, ctx) => {
      if (ctx?.previous) client.setQueryData(['request-settings'], ctx.previous);
      void client.invalidateQueries({ queryKey: ['request-settings'] });
      toast(`Couldn’t save: ${err.message}`, 'error');
    },
    // Request buttons follow health.requests.
    onSettled: () => void client.invalidateQueries({ queryKey: ['health'] }),
  });
}

/** Settings → Updates: polled every 5 s while a check is waiting or running, every minute otherwise. */
export const useUpdates = () =>
  useQuery({
    queryKey: ['updates'],
    queryFn: api.updates,
    retry: (count, err) => !(err instanceof ApiError && err.status === 403) && count < 2,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && (data.requested || data.status?.state === 'checking') ? 5_000 : 60_000;
    },
  });

/** Turns automatic updates on or off, or changes how often; shown at once. */
export function useSaveUpdates() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<UpdateSettings>) => api.saveUpdates(patch),
    onMutate: async (patch) => {
      await client.cancelQueries({ queryKey: ['updates'] });
      const previous = client.getQueryData<UpdateInfo>(['updates']);
      if (previous) client.setQueryData<UpdateInfo>(['updates'], { ...previous, ...patch });
      return { previous };
    },
    onSuccess: (data) => client.setQueryData(['updates'], data),
    onError: (err: Error, _patch, ctx) => {
      if (ctx?.previous) client.setQueryData(['updates'], ctx.previous);
      void client.invalidateQueries({ queryKey: ['updates'] });
      toast(`Couldn’t save: ${err.message}`, 'error');
    },
  });
}

/** Check now: the updater picks it up within half a minute. */
export function useCheckForUpdates() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.checkForUpdates,
    onSuccess: (data) => client.setQueryData(['updates'], data),
    onError: (err: Error) => toast(`Couldn’t check for updates: ${err.message}`, 'error'),
  });
}

export function useSourceActions() {
  const client = useQueryClient();
  const changed = () => {
    void client.invalidateQueries({ queryKey: ['sources'] });
    void client.invalidateQueries({ queryKey: ['health'] });
  };
  const fail = (err: Error) => toast(err.message, 'error');
  return {
    add: useMutation({ mutationFn: api.addSource, onSuccess: changed, onError: fail }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: number; input: SourceInput }) => api.updateSource(id, input),
      onSuccess: changed,
      onError: fail,
    }),
    remove: useMutation({
      mutationFn: api.removeSource,
      onSuccess: () => void client.invalidateQueries(), // its songs leave every list
      onError: fail,
    }),
    reorder: useMutation({
      mutationFn: api.reorderSources,
      onSuccess: (data) => client.setQueryData(['sources'], data),
      onError: (err: Error) => {
        fail(err);
        changed();
      },
    }),
    rescan: useMutation({ mutationFn: api.rescanSource, onSuccess: changed, onError: fail }),
    rematch: useMutation({ mutationFn: api.rematchSource, onSuccess: changed, onError: fail }),
  };
}

/** A folder source's albums waiting for review (doubtful matches). */
/** Everything about one song (track menu → Show metadata). Always fresh: files and matches change. */
/** A song's words; fetched once per song and visit. */
export const useLyrics = (trackId: number, enabled = true) =>
  useQuery({ queryKey: ['lyrics', trackId], queryFn: () => api.lyrics(trackId), enabled, staleTime: Infinity, retry: 1 });

/**
 * The mix maps (tempo, key, energy) of these songs, by recording id. A song not measured yet is
 * missing and gets measured on the server meanwhile, so it's asked for again a minute later (a few
 * times: a server that can't analyse audio never has them).
 */
export const useMixMaps = (recordingIds: string[], enabled = true) => useQuery(mixMapsQuery(recordingIds, enabled));

const mixMapsQuery = (recordingIds: string[], enabled = true) =>
  queryOptions({
    queryKey: ['mix-maps', ...recordingIds],
    queryFn: () => api.mixMaps(recordingIds),
    enabled: enabled && recordingIds.length > 0,
    staleTime: 60_000,
    refetchInterval: (q) =>
      q.state.data && q.state.dataUpdateCount < 5 && recordingIds.some((id) => !q.state.data![id]) ? 60_000 : false,
  });

/** The server answers mix maps for at most this many songs at a time. */
const MIX_MAPS_PER_REQUEST = 50;

/**
 * Each song's measured tempo in BPM, by recording id, for song lists to show next to the length.
 * From the songs' mix maps, asked for 50 songs at a time; a song not measured yet (or without a
 * beat) is left out.
 */
export function useTempos(tracks: readonly (Track | undefined)[]): Record<string, number> {
  const key = [...new Set(tracks.flatMap((t) => (t ? [t.recordingId] : [])))].join('\n');
  const queries = useMemo(() => {
    const ids = key ? key.split('\n') : [];
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += MIX_MAPS_PER_REQUEST) batches.push(ids.slice(i, i + MIX_MAPS_PER_REQUEST));
    return batches.map((batch) => mixMapsQuery(batch));
  }, [key]);
  return useQueries({ queries, combine: temposOf });
}

/**
 * The tempos in mix-map answers. Kept outside the hook and a plain object: useQueries then reuses the
 * last result while the answers are the same, rather than handing every render a new one.
 */
function temposOf(results: { data?: Record<string, MixMap> }[]): Record<string, number> {
  const tempos: Record<string, number> = {};
  for (const { data } of results) for (const [id, map] of Object.entries(data ?? {})) if (map.bpm > 0) tempos[id] = map.bpm;
  return tempos;
}

export const useTrackMetadata = (id: number | null) =>
  useQuery({ queryKey: ['track-metadata', id], queryFn: () => api.trackMetadata(id!), enabled: id !== null, staleTime: 0 });

/**
 * Show metadata → Match again: a folder file is matched on MusicBrainz again (and the library rebuilt);
 * a Lidarr file's artist is refreshed in Lidarr. Everything showing songs may change, so refresh it all.
 */
export function useRematchFile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (fileId: number) => api.rematchFile(fileId),
    onSuccess: () => void client.invalidateQueries(),
  });
}

/** How many times to ask again while MusicBrainz details are still coming (every 2 s: about a minute). */
const REVIEW_DETAIL_POLLS = 30;

export const useReview = (id: number | null) =>
  useQuery({
    queryKey: ['review', id],
    queryFn: () => api.review(id!),
    enabled: id !== null,
    // The server fetches edition details in the background for the album on screen and the next one.
    refetchInterval: (q) =>
      q.state.dataUpdateCount < REVIEW_DETAIL_POLLS && q.state.data?.slice(0, 2).some((g) => g.candidates.some((c) => !c.detailed))
        ? 2000
        : false,
  });

/**
 * Review actions. Choosing an album or leaving it unmatched takes the album off the list at once (and
 * puts it back if saving fails); a search keeps its pending state until the new candidates are in.
 */
export function useReviewAction(id: number) {
  const client = useQueryClient();
  const key = ['review', id];
  return useMutation({
    mutationKey: ['review-action', id],
    mutationFn: (action: ReviewAction) => api.reviewAction(id, action),
    onMutate: async (action) => {
      if (action.search) return {};
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<ReviewGroup[]>(key);
      client.setQueryData<ReviewGroup[]>(key, (groups) => groups?.filter((g) => g.groupKey !== action.groupKey));
      return { previous };
    },
    onError: (_err, _action, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },
    onSuccess: async (_data, action) => {
      void client.invalidateQueries({ queryKey: ['sources'] });
      if (action.search) await client.invalidateQueries({ queryKey: key });
      else void client.invalidateQueries({ queryKey: key });
    },
  });
}

/** A folder source's proposed moves into Artist/Album/NN Title (Settings → Sources → Organize files). */
export const useOrganizePlan = (id: number | null) =>
  useQuery({ queryKey: ['organize', id], queryFn: () => api.organizePlan(id!), enabled: id !== null, staleTime: 0 });

export function useOrganizeActions(id: number) {
  const client = useQueryClient();
  const done = () => void client.invalidateQueries(); // paths and covers changed everywhere
  return {
    apply: useMutation({
      mutationFn: (moves: string[]) => api.organize(id, moves),
      onSuccess: (r) => {
        toast(`Moved ${plural(r.moved, 'file')}${r.skipped.length ? `; ${r.skipped.length} skipped` : ''}`);
        done();
      },
      onError: (err: Error) => toast(err.message, 'error'),
    }),
    undo: useMutation({
      mutationFn: (batchId: number) => api.undoOrganize(id, batchId),
      onSuccess: (r) => {
        toast(`Put ${plural(r.restored, 'file')} back`);
        done();
      },
      onError: (err: Error) => toast(err.message, 'error'),
    }),
  };
}

export const useMatching = () => useQuery({ queryKey: ['matching'], queryFn: api.matching });

export function useSaveMatching() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.saveMatching,
    onSuccess: (data) => client.setQueryData(['matching'], data),
    onError: (err: Error) => toast(err.message, 'error'),
  });
}

// ── Made for you ────────────────────────────────────────────────────────────

/**
 * When to look at mixes again: just after the soonest is due, then every 15 s for a little while
 * (the server serves the old ones while it makes the new ones in the background).
 */
function mixRecheck(dueTimes: number[]): number {
  const due = Math.min(...dueTimes);
  if (!Number.isFinite(due)) return 60_000;
  const wait = due - Date.now() + 5_000;
  return wait > 0 ? wait : 15_000;
}

/** Jump back in: albums heard lately. */
export const useRecentAlbums = () => useQuery({ queryKey: ['recent-albums'], queryFn: api.recentAlbums, staleTime: 60_000 });

/** The generated mixes. Each changes on its own schedule (hour, day, week). */
export const useMixes = () =>
  useQuery({
    queryKey: ['mixes'],
    queryFn: api.mixes,
    staleTime: 30_000,
    refetchInterval: (q) => mixRecheck((q.state.data ?? []).map((m) => Date.parse(m.refreshesAt))),
    refetchOnWindowFocus: true,
  });

export const useMix = (key: string) =>
  useQuery({
    queryKey: ['mix', key],
    queryFn: () => api.mix(key),
    staleTime: 30_000,
    refetchInterval: (q) => mixRecheck(q.state.data ? [Date.parse(q.state.data.refreshesAt)] : []),
    refetchOnWindowFocus: true,
  });

/** "New mix": another draw for the same hour, day or week. */
export function useRegenerateMix(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.regenerateMix(key),
    onSuccess: (mix: MixDetail) => {
      client.setQueryData(['mix', key], mix);
      void client.invalidateQueries({ queryKey: ['mixes'] });
    },
    onError: (err: Error) => toast(`Couldn’t make a new mix: ${err.message}`, 'error'),
  });
}

/** Keep a mix as an ordinary playlist. */
export function useSaveMix(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.saveMix(key),
    onSuccess: (playlist: PlaylistDetail) => {
      void client.invalidateQueries({ queryKey: ['playlists'] });
      toast(`Saved as “${playlist.name}”`);
    },
    onError: (err: Error) => toast(`Couldn’t save the mix: ${err.message}`, 'error'),
  });
}

export const useMixSettings = () =>
  useQuery({
    queryKey: ['mix-settings'],
    queryFn: api.mixSettings,
    retry: (count, err) => !(err instanceof ApiError && err.status === 403) && count < 2,
  });

/** Saves a change at once, showing it before the server answers; the mixes are made again with it. */
export function useSaveMixSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<MixSettings>) => api.saveMixSettings(patch),
    onMutate: async (patch) => {
      await client.cancelQueries({ queryKey: ['mix-settings'] });
      const previous = client.getQueryData<MixSettingsInfo>(['mix-settings']);
      if (previous) {
        client.setQueryData<MixSettingsInfo>(['mix-settings'], {
          ...previous,
          ...patch,
          enabled: { ...previous.enabled, ...patch.enabled },
        });
      }
      return { previous };
    },
    onSuccess: (data) => {
      client.setQueryData(['mix-settings'], data);
      void client.invalidateQueries({ queryKey: ['mixes'] });
      void client.invalidateQueries({ queryKey: ['mix'] });
    },
    onError: (err: Error, _patch, ctx) => {
      if (ctx?.previous) client.setQueryData(['mix-settings'], ctx.previous);
      toast(`Couldn’t save: ${err.message}`, 'error');
    },
  });
}

export function useClearHistory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.clearHistory,
    onSuccess: (data) => {
      client.setQueryData(['mix-settings'], data);
      void client.invalidateQueries({ queryKey: ['mixes'] });
      toast('Listening history cleared');
    },
    onError: (err: Error) => toast(`Couldn’t clear the history: ${err.message}`, 'error'),
  });
}

export const useListenBrainz = () =>
  useQuery({
    queryKey: ['listenbrainz'],
    queryFn: api.listenBrainz,
    // Shows plays going out while the panel is open.
    refetchInterval: 30_000,
    retry: (count, err) => !(err instanceof ApiError && err.status === 403) && count < 2,
  });

/** Connect, pause, disconnect or send earlier plays: the panel shows what the server answers. */
export function useListenBrainzAction<T>(fn: (arg: T) => Promise<ListenBrainzInfo>, done?: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      client.setQueryData(['listenbrainz'], data);
      if (done) toast(done);
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });
}

/** Your listening, for a period. */
export const useListeningStats = (range: StatsRange, enabled = true) =>
  useQuery({ queryKey: ['stats', range], queryFn: () => api.stats(range), enabled, staleTime: 5 * 60_000, placeholderData: (prev) => prev });

export const useProfiles = () => useQuery({ queryKey: ['profiles'], queryFn: api.profiles, staleTime: 60_000 });

/** What depends on who's listening: dropped when the device switches profile, so nothing shows someone else's. */
const PERSONAL = ['mixes', 'mix', 'stats', 'recent-albums', 'mix-settings', 'listenbrainz'];

/** This device listens as someone else from now on. */
export function switchProfile(id: number) {
  usePrefs.getState().setProfileId(id);
  // Reset, not just refetched: the last profile's data mustn't stay on screen meanwhile.
  for (const key of PERSONAL) void queryClient.resetQueries({ queryKey: [key] });
}

/** Add, rename or remove a profile; the list shows what the server answers. */
export function useProfileAction<T>(fn: (arg: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void client.invalidateQueries({ queryKey: ['profiles'] }),
    onError: (err: Error) => toast(err.message, 'error'),
  });
}
