import type { Track } from '@playarr/shared';
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { AUDIO_CACHE } from '../lib/cacheNames';

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** Size limits on offer for songs kept on this device; 0 turns it off. */
export const OFFLINE_LIMITS = [0, 512 * MB, 1 * GB, 2 * GB, 5 * GB, 10 * GB];
const DEFAULT_LIMIT = 2 * GB;
/** Never take more than this share of what the browser lets the site store. */
const QUOTA_SHARE = 0.5;

/**
 * Keeping songs needs the Cache API (and a service worker to play them), which browsers only offer
 * on HTTPS and localhost.
 */
export const canKeepOffline = typeof window !== 'undefined' && window.isSecureContext && typeof caches !== 'undefined';

/** Kept songs play from disk only through the service worker (none in dev); without it, keeping them is wasted. */
export const workerReady = () => !!navigator.serviceWorker?.controller;

const onWorkerChange = (cb: () => void) => {
  navigator.serviceWorker?.addEventListener('controllerchange', cb);
  return () => navigator.serviceWorker?.removeEventListener('controllerchange', cb);
};
export const useWorkerReady = () => useSyncExternalStore(onWorkerChange, workerReady, () => false);

interface KeptSong {
  url: string;
  bytes: number;
  /** Last time it was played or downloaded: the least recently used go first when space runs out. */
  usedAt: number;
}

interface OfflineState {
  /** Songs on this device, by track file id. */
  songs: Record<number, KeptSong>;
  limit: number;
  /** The download in progress, for progress rings. */
  active: { fileId: number; loaded: number; total: number } | null;
}

export const useOffline = create<OfflineState>()(
  persist(() => ({ songs: {}, limit: DEFAULT_LIMIT, active: null }) as OfflineState, {
    name: 'playarr.offline',
    version: 1,
    partialize: ({ songs, limit }) => ({ songs, limit }),
  }),
);

export const useIsKept = (fileId: number) => useOffline((s) => fileId in s.songs);

export const keptBytes = (songs: Record<number, KeptSong>) => Object.values(songs).reduce((sum, s) => sum + s.bytes, 0);

/**
 * Songs to drop, least recently used first, so that `need` more bytes fit within `limit`; `null`
 * when they can't fit even then (songs in `protect` are never dropped).
 */
export function evictions(songs: Record<number, KeptSong>, need: number, limit: number, protect: ReadonlySet<number> = new Set()): number[] | null {
  let used = keptBytes(songs);
  const out: number[] = [];
  const oldest = Object.entries(songs)
    .map(([id, s]) => [Number(id), s] as const)
    .filter(([id]) => !protect.has(id))
    .sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [id, song] of oldest) {
    if (used + need <= limit) break;
    out.push(id);
    used -= song.bytes;
  }
  return used + need <= limit ? out : null;
}

/** Bumped by clearOffline(), so a download that was in flight doesn't come back afterwards. */
let generation = 0;

/**
 * Download a song and keep it on this device, making room by dropping the least recently used.
 * Resolves false when it won't fit; rejects on network errors and when aborted.
 */
export async function keepSong(track: Track, { signal, protect }: { signal: AbortSignal; protect: ReadonlySet<number> }): Promise<boolean> {
  const started = generation;
  const room = evictions(useOffline.getState().songs, track.size, await effectiveLimit(), protect);
  if (!room) return false;
  const res = await fetch(track.streamUrl, { signal });
  if (res.status !== 200 || !res.body) {
    void res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  await dropSongs(room);

  const expected = Number(res.headers.get('content-length'));
  const total = expected || track.size;
  let loaded = 0;
  let reported = 0;
  const progress = () => useOffline.setState({ active: { fileId: track.fileId, loaded, total } });
  progress();
  const counted = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        loaded += chunk.byteLength;
        // Every 2%: smooth enough for a ring, without re-rendering on each chunk.
        if (loaded - reported > total / 50) {
          reported = loaded;
          progress();
        }
        out.enqueue(chunk);
      },
    }),
  );
  const cache = await caches.open(AUDIO_CACHE);
  try {
    await cache.put(track.streamUrl, new Response(counted, { headers: res.headers }));
  } finally {
    useOffline.setState({ active: null });
  }
  if (generation !== started || (expected && loaded !== expected)) {
    await cache.delete(track.streamUrl);
    return false;
  }
  useOffline.setState((s) => ({ songs: { ...s.songs, [track.fileId]: { url: track.streamUrl, bytes: loaded, usedAt: Date.now() } } }));
  void askToPersist();
  return true;
}

/** Mark a kept song as just played, so it's among the last to go. */
export function touchSong(fileId: number) {
  const song = useOffline.getState().songs[fileId];
  if (song) useOffline.setState((s) => ({ songs: { ...s.songs, [fileId]: { ...song, usedAt: Date.now() } } }));
}

export async function setOfflineLimit(limit: number) {
  useOffline.setState({ limit });
  if (!limit) return clearOffline();
  await dropSongs(evictions(useOffline.getState().songs, 0, limit) ?? []);
}

export async function clearOffline() {
  generation++;
  useOffline.setState({ songs: {} });
  if (canKeepOffline) await caches.delete(AUDIO_CACHE);
}

/** Forget songs the browser has cleared, and drop stored audio we have no record of. */
export async function reconcileOffline() {
  if (!canKeepOffline) return;
  const cache = await caches.open(AUDIO_CACHE);
  const stored = new Set((await cache.keys()).map((r) => new URL(r.url).pathname));
  const { songs } = useOffline.getState();
  const known = new Set(Object.values(songs).map((s) => s.url));
  await Promise.all([...stored].filter((url) => !known.has(url)).map((url) => cache.delete(url)));
  const gone = Object.entries(songs).filter(([, s]) => !stored.has(s.url));
  if (gone.length) useOffline.setState((s) => ({ songs: omit(s.songs, gone.map(([id]) => Number(id))) }));
}

async function dropSongs(ids: number[]) {
  if (!ids.length) return;
  const { songs } = useOffline.getState();
  const cache = await caches.open(AUDIO_CACHE);
  await Promise.all(ids.map((id) => songs[id] && cache.delete(songs[id].url)));
  useOffline.setState((s) => ({ songs: omit(s.songs, ids) }));
}

async function effectiveLimit(): Promise<number> {
  const { limit } = useOffline.getState();
  const quota = (await navigator.storage?.estimate?.().catch(() => undefined))?.quota;
  return quota ? Math.min(limit, quota * QUOTA_SHARE) : limit;
}

let persistAsked = false;
/** Ask the browser not to clear our storage under pressure (granted silently by most). */
async function askToPersist() {
  if (persistAsked || !navigator.storage?.persist) return;
  persistAsked = true;
  if (!(await navigator.storage.persisted())) await navigator.storage.persist();
}

function omit(songs: Record<number, KeptSong>, ids: number[]): Record<number, KeptSong> {
  const out = { ...songs };
  for (const id of ids) delete out[id];
  return out;
}
