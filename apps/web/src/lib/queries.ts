import type { AlbumRef, AlbumRequest, AlbumSort, AvailabilityState } from '@playarr/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from './api';
import { toast } from './toast';

export const useHealth = () =>
  useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 30_000, refetchInterval: 60_000 });

export const useArtists = () => useQuery({ queryKey: ['artists'], queryFn: api.artists });

export const useArtist = (id: number) =>
  useQuery({ queryKey: ['artist', id], queryFn: () => api.artist(id), enabled: Number.isFinite(id) });

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

export const useAlbum = (id: number) =>
  useQuery({ queryKey: ['album', id], queryFn: () => api.album(id), enabled: Number.isFinite(id) });

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
      for (const key of ['albums', 'artists', 'artist', 'health', 'search', 'discover', 'discover-artist']) {
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
    },
    onError: (err) => toast((err as Error).message, 'error'),
  });
}
