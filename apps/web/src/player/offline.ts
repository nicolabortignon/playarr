import { RENDER_RATE, type MixMode } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TransitionAnswer } from '../lib/api';
import { AUDIO_CACHE } from '../lib/cacheNames';
import { playableUrl } from '../lib/playable';

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** Size limits on offer for songs kept on this device; 0 turns it off. */
export const OFFLINE_LIMITS = [0, 512 * MB, 1 * GB, 2 * GB, 5 * GB, 10 * GB];
const DEFAULT_LIMIT = 2 * GB;
/** Never take more than this share of what the browser lets the site store. */
const QUOTA_SHARE = 0.5;
/** Downloads may fill the device up to this share of what the browser allows. */
const DEVICE_SHARE = 0.9;

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

/** The server's answer for a transition that's rendered: its plan, and the files to play it from. */
export type KeptTransition = Extract<TransitionAnswer, { status: 'ready' }>;

/** An album, playlist, mix or Favorites downloaded to this device: its songs stay until it's removed. */
export interface Download {
  /** "album:12", "playlist:3", "mix:discovery", "favorites". */
  key: string;
  title: string;
  subtitle?: string;
  coverUrl?: string;
  /** Where it lives in the app. */
  href: string;
  /** Its songs as of the last visit: what's downloaded, and what plays offline. */
  tracks: Track[];
  addedAt: number;
  /**
   * The DJ transitions between its songs, kept with them so the download mixes offline too, by
   * transitionPair(). Only fetched while transitions are DJ mix; older downloads have none.
   */
  transitions?: Record<string, KeptTransition>;
}

interface OfflineState {
  /** Songs on this device, by track file id. */
  songs: Record<number, KeptSong>;
  /** Downloads, by key. Their songs never make room for others and don't count towards `limit`. */
  pins: Record<string, Download>;
  limit: number;
  /** The download in progress, for progress rings. */
  active: { fileId: number; loaded: number; total: number } | null;
}

export const useOffline = create<OfflineState>()(
  persist(() => ({ songs: {}, pins: {}, limit: DEFAULT_LIMIT, active: null }) as OfflineState, {
    name: 'playarr.offline',
    version: 1,
    partialize: ({ songs, pins, limit }) => ({ songs, pins, limit }),
  }),
);

/** pinnedFiles() for the downloads as they are, worked out once per change rather than once per song row. */
const pinnedCache = new WeakMap<Record<string, Download>, Set<number>>();
const pinnedNow = (pins: Record<string, Download>) => {
  let set = pinnedCache.get(pins);
  if (!set) pinnedCache.set(pins, (set = pinnedFiles(pins)));
  return set;
};

/** A song of a download (an album, playlist, mix or Favorites downloaded): not one only loaded ahead as you listen. */
export const isDownloaded = (fileId: number, s: Pick<OfflineState, 'pins'>) => pinnedNow(s.pins).has(fileId);

/** Downloaded and on this device: what the "on this device" mark means. */
export const useIsDownloaded = (fileId: number) => useOffline((s) => fileId in s.songs && isDownloaded(fileId, s));

/**
 * Kept on this device as this browser plays it. An Apple Lossless file kept before Chrome was given its WAV isn't:
 * it's fetched again, as the WAV.
 */
export const keptAsPlayed = (track: Pick<Track, 'fileId' | 'streamUrl' | 'format'>, songs: Record<number, Pick<KeptSong, 'url'>>) =>
  songs[track.fileId]?.url === playableUrl(track);

export const keptBytes = (songs: Record<number, KeptSong>) => Object.values(songs).reduce((sum, s) => sum + s.bytes, 0);

/** The songs of every download, and the files of their transitions. */
export function pinnedFiles(pins: Record<string, Download>): Set<number> {
  return new Set(Object.values(pins).flatMap((d) => [...d.tracks.map((t) => t.fileId), ...transitionFileIds(d)]));
}

/** How a transition is known in a download: the two files and the mix mode, like the server's own pair. */
export const transitionPair = (fromFileId: number, toFileId: number, mode: MixMode) => `${fromFileId}-${toFileId}-${mode}`;

/** The pairs a song order plays, back to back. */
export function pairsOf(tracks: Track[], mode: MixMode): Set<string> {
  return new Set(tracks.slice(1).map((to, i) => transitionPair(tracks[i]!.fileId, to.fileId, mode)));
}

/**
 * Transition files are kept like songs, under an id made from their URL: negative, so it's never a
 * song's (file ids count up from 1).
 */
export function transitionFileId(url: string): number {
  // cyrb53: 53 bits of hash, so the few hundred files a device keeps never share an id.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return -(1 + 4294967296 * (2097151 & h2) + (h1 >>> 0));
}

/** The files a transition plays from: the transition itself, and B's remainder when it has one. */
const transitionUrls = (t: KeptTransition) => (t.continuationUrl ? [t.url, t.continuationUrl] : [t.url]);

const transitionFileIds = (d: Download) => Object.values(d.transitions ?? {}).flatMap((t) => transitionUrls(t).map(transitionFileId));

/** Whether every file of a transition is on this device. */
export const transitionKept = (t: KeptTransition, songs: Record<number, KeptSong>) => transitionUrls(t).every((url) => transitionFileId(url) in songs);

/**
 * A transition kept with a download, for playing the pair offline (the server can't be asked then):
 * its plan and URLs, which the service worker answers from this device. Undefined when no download
 * has it, or its files are gone.
 */
export function offlineTransition(fromFileId: number, toFileId: number, mode: MixMode): KeptTransition | undefined {
  const { pins, songs } = useOffline.getState();
  const pair = transitionPair(fromFileId, toFileId, mode);
  for (const d of Object.values(pins)) {
    const kept = d.transitions?.[pair];
    if (kept && transitionKept(kept, songs)) return kept;
  }
  return undefined;
}

/** Kept songs split into those of downloads and the rest (kept as you listen, within the limit). */
export function splitKept(songs: Record<number, KeptSong>, pins: Record<string, Download>) {
  const pinned = pinnedFiles(pins);
  const inDownloads: Record<number, KeptSong> = {};
  const rest: Record<number, KeptSong> = {};
  for (const [id, song] of Object.entries(songs)) (pinned.has(Number(id)) ? inDownloads : rest)[Number(id)] = song;
  return { inDownloads, rest };
}

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
export async function keepSong(
  track: Track,
  { signal, protect, pinned = false }: { signal: AbortSignal; protect: ReadonlySet<number>; pinned?: boolean },
): Promise<boolean> {
  const started = generation;
  const { songs, pins } = useOffline.getState();
  const { rest } = splitKept(songs, pins);
  // A download only needs room on the device; other kept songs go first if it's short.
  const room = pinned ? await roomOnDevice(rest, track.size, protect) : evictions(rest, track.size, await effectiveLimit(), protect);
  if (!room) return false;
  const url = playableUrl(track);
  const res = await fetch(url, { signal });
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
    await cache.put(url, new Response(counted, { headers: res.headers }));
  } finally {
    useOffline.setState({ active: null });
  }
  if (generation !== started || (expected && loaded !== expected)) {
    await cache.delete(url);
    return false;
  }
  // The copy it replaces, kept as this browser can't play it.
  const before = useOffline.getState().songs[track.fileId]?.url;
  if (before && before !== url) await cache.delete(before);
  useOffline.setState((s) => ({ songs: { ...s.songs, [track.fileId]: { url, bytes: loaded, usedAt: Date.now() } } }));
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
  await fitLimit();
}

/** Drop songs kept as you listen (never those of downloads) until they fit the limit. */
export async function fitLimit() {
  const { songs, pins, limit } = useOffline.getState();
  const { rest } = splitKept(songs, pins);
  await dropSongs(limit ? (evictions(rest, 0, limit) ?? Object.keys(rest).map(Number)) : Object.keys(rest).map(Number));
}

/** Remove everything from this device, downloads included. */
export async function clearOffline() {
  generation++;
  useOffline.setState({ songs: {}, pins: {} });
  if (canKeepOffline) await caches.delete(AUDIO_CACHE);
}

/**
 * Download an album, playlist, mix or Favorites (or update the songs of one already downloaded).
 * Transitions between songs that no longer follow each other go.
 */
export function addDownload(download: Omit<Download, 'addedAt' | 'transitions'>) {
  const before = useOffline.getState().pins[download.key];
  const transitions = Object.entries(before?.transitions ?? {}).filter(([pair]) => pairsOf(download.tracks, pairMode(pair)).has(pair));
  useOffline.setState((s) => ({
    pins: {
      ...s.pins,
      [download.key]: { ...download, addedAt: s.pins[download.key]?.addedAt ?? Date.now(), transitions: Object.fromEntries(transitions) },
    },
  }));
  if (before) void dropUnpinned(transitionFileIds(before));
}

/**
 * Remove a download: its songs become ordinary kept songs, which make room as usual. Its transitions
 * are only any use to downloads, so they go unless another one has them too.
 */
export async function removeDownload(key: string) {
  const removed = useOffline.getState().pins[key];
  useOffline.setState((s) => {
    const pins = { ...s.pins };
    delete pins[key];
    return { pins };
  });
  if (removed) await dropUnpinned(transitionFileIds(removed));
  await fitLimit();
}

/**
 * Put back a download just removed (its Undo): as it was, in its place in the list. Songs that made room for others
 * meanwhile download again.
 */
export function restoreDownload(download: Download) {
  useOffline.setState((s) => ({ pins: { ...s.pins, [download.key]: download } }));
}

/**
 * Keep a rendered transition with a download (and B's remainder, if it has one), so the pair mixes
 * offline too. Resolves false when it won't fit on the device; rejects on network errors and when aborted.
 */
export async function keepTransition(
  key: string,
  { from, to, mode }: { from: Track; to: Track; mode: MixMode },
  transition: KeptTransition,
  { signal }: { signal: AbortSignal },
): Promise<boolean> {
  // Sizes for making room, before the server says: uncompressed, which the FLAC files never exceed.
  const bytesFor = (seconds: number) => Math.ceil(Math.max(0, seconds) * RENDER_RATE * 4);
  const files = [
    { url: transition.url, size: bytesFor(transition.plan.length) },
    ...(transition.continuationUrl ? [{ url: transition.continuationUrl, size: bytesFor(to.duration - transition.plan.bResume) }] : []),
  ];
  const fetched: number[] = [];
  try {
    for (const { url, size } of files) {
      const fileId = transitionFileId(url);
      // Kept already: another download has the same pair.
      if (fileId in useOffline.getState().songs) continue;
      const pseudoTrack = { fileId, streamUrl: url, size } as Track;
      if (!(await keepSong(pseudoTrack, { signal, protect: pinnedFiles(useOffline.getState().pins), pinned: true }))) {
        await dropUnpinned(fetched);
        return false;
      }
      fetched.push(fileId);
    }
  } catch (err) {
    await dropUnpinned(fetched);
    throw err;
  }
  const pair = transitionPair(from.fileId, to.fileId, mode);
  const download = useOffline.getState().pins[key];
  // Removed meanwhile, or its songs no longer follow each other: nothing to keep it for.
  if (!download || !pairsOf(download.tracks, mode).has(pair)) {
    await dropUnpinned(fetched);
    return true;
  }
  useOffline.setState((s) => ({
    pins: { ...s.pins, [key]: { ...s.pins[key]!, transitions: { ...s.pins[key]!.transitions, [pair]: transition } } },
  }));
  return true;
}

/** How far along a download is; its bytes count its transitions too. */
export function downloadProgress(d: Download, songs: Record<number, KeptSong>) {
  const done = d.tracks.filter((t) => t.fileId in songs);
  const bytes = [...done.map((t) => t.fileId), ...new Set(transitionFileIds(d))].reduce((sum, id) => sum + (songs[id]?.bytes ?? 0), 0);
  return { done: done.length, total: d.tracks.length, bytes };
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

/** Drop transition files no download has any more. */
async function dropUnpinned(ids: number[]) {
  const pinned = pinnedFiles(useOffline.getState().pins);
  await dropSongs(ids.filter((id) => !pinned.has(id)));
}

/** The mode a transitionPair() was made with. */
const pairMode = (pair: string) => pair.slice(pair.lastIndexOf('-') + 1) as MixMode;

async function dropSongs(ids: number[]) {
  if (!ids.length) return;
  const { songs } = useOffline.getState();
  const cache = await caches.open(AUDIO_CACHE);
  await Promise.all(ids.map((id) => songs[id] && cache.delete(songs[id].url)));
  useOffline.setState((s) => ({ songs: omit(s.songs, ids) }));
}

/** Room for `need` more bytes on the device, dropping songs kept as you listen if it's short; null if it won't fit. */
async function roomOnDevice(rest: Record<number, KeptSong>, need: number, protect: ReadonlySet<number>): Promise<number[] | null> {
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  if (!estimate?.quota) return [];
  const free = estimate.quota * DEVICE_SHARE - (estimate.usage ?? 0);
  if (free >= need) return [];
  return freeUp(rest, need - free, protect);
}

/** The least recently used songs that free `bytes`; null if all of them don't. */
function freeUp(rest: Record<number, KeptSong>, bytes: number, protect: ReadonlySet<number>): number[] | null {
  const out: number[] = [];
  let freed = 0;
  for (const [id, song] of Object.entries(rest).sort((a, b) => a[1].usedAt - b[1].usedAt)) {
    if (freed >= bytes) break;
    if (protect.has(Number(id))) continue;
    out.push(Number(id));
    freed += song.bytes;
  }
  return freed >= bytes ? out : null;
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
