import type { AlbumRef, AlbumRequest, AlbumSort, AvailabilityState, CoverLayout, FavoriteTrack, PlaylistDetail, ReviewAction, SourceInput, Track } from '@playarr/shared';
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from './api';
import { plural } from './format';
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

export const useDiscoverArtist = (mbid: string) =>
  useQuery({
    queryKey: ['discover-artist', mbid],
    queryFn: ({ signal }) => api.discoverArtist(mbid, signal),
    staleTime: 60_000,
  });

export const useArtistLookup = (name: string) =>
  useQuery({
    queryKey: ['artist-lookup', name],
    queryFn: ({ signal }) => api.findArtist(name, signal),
    enabled: !!name,
    staleTime: Infinity,
  });

const ACTIVE: AvailabilityState[] = ['searching', 'downloading', 'importing'];

/** Polls requests while any are in flight; refreshes the library when one becomes playable. */
export function useRequests() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['requests'],
    queryFn: api.requests,
    refetchInterval: (q) => (q.state.data?.some((r) => ACTIVE.includes(r.availability.state)) ? 10_000 : 60_000),
    staleTime: 5000,
  });
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
  return query;
}

export const activeRequestCount = (requests: AlbumRequest[] | undefined) =>
  requests?.filter((r) => ACTIVE.includes(r.availability.state)).length ?? 0;

export function useRequestAlbum() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ref: AlbumRef) => api.requestAlbum(ref),
    onSuccess: (req) => {
      toast(`Requested “${req.title}”. Lidarr is searching for it`);
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

/** Folders on the server, for choosing a folder source. */
export const useFolders = (path: string | undefined) =>
  useQuery({ queryKey: ['folders', path ?? ''], queryFn: () => api.folders(path), retry: false });

/** False once we know there's no Lidarr source: requests and Discover are hidden then. */
export function useHasLidarr() {
  const { data } = useHealth();
  return data === undefined || data.lidarr !== undefined;
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
export const useReview = (id: number | null) =>
  useQuery({ queryKey: ['review', id], queryFn: () => api.review(id!), enabled: id !== null });

export function useReviewAction(id: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: ReviewAction) => api.reviewAction(id, action),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['review', id] });
      void client.invalidateQueries({ queryKey: ['sources'] });
    },
    onError: (err: Error) => toast(err.message, 'error'),
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
