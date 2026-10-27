import type { AlbumSort } from '@playarr/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from './api';

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
