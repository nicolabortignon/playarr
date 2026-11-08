import { RENDER_RATE, type MixMode } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { getMany, setMany } from 'idb-keyval';
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import type { TransitionAnswer } from '../lib/api';
import { AUDIO_CACHE } from '../lib/cacheNames';
import { playableUrl } from '../lib/playable';
import type { Quality } from '../lib/prefs';
import { atLeast, keptUrl, qualityOfUrl, sizeAt } from '../lib/quality';
import { canSave, forgetLegacy, isObject, readLegacy, writer } from '../lib/saved';
import { isLeader, lockManager, onTabMessage, post } from './tabs';

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** Size limits on offer for songs kept on this device; 0 turns it off. */
export const OFFLINE_LIMITS = [0, 512 * MB, 1 * GB, 2 * GB, 5 * GB, 10 * GB];
const DEFAULT_LIMIT = 2 * GB;
/** Never take more than this share of what the browser lets the site store. */
const QUOTA_SHARE = 0.5;
/** Downloads may fill the device up to this share of what the browser allows. */
const DEVICE_SHARE = 0.9;
/** Tries at reading the record at startup before giving up on it for the session. */
const READ_TRIES = 3;

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
  /** Its cover's own color, for the space the cover takes while it loads (an album's `coverColor`). */
  coverColor?: string;
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

/** What's kept on this device, as it's saved. */
interface OfflineRecord {
  /** Songs on this device, by track file id. */
  songs: Record<number, KeptSong>;
  /** Downloads, by key. Their songs never make room for others and don't count towards `limit`. */
  pins: Record<string, Download>;
  limit: number;
}

interface OfflineState extends OfflineRecord {
  /** The record has been read (hydrateOffline): until then nothing deletes audio, downloads or loads ahead. */
  hydrated: boolean;
}

// Nothing to read without IndexedDB (in tests, say): the record is what's here.
export const useOffline = create<OfflineState>()(() => ({ songs: {}, pins: {}, limit: DEFAULT_LIMIT, hydrated: !canSave() }));

/** The download in progress, for progress rings: a store of its own that isn't saved, so progress writes nothing. */
export const useActiveDownload = create<{ active: { fileId: number; loaded: number; total: number } | null }>()(() => ({ active: null }));

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

/** The copy of a song kept on this device plays in this browser: not its own Apple Lossless file kept before Chrome was given its WAV. */
const playsHere = (track: Pick<Track, 'streamUrl' | 'format'>, url: string) => qualityOfUrl(url) !== 'original' || url === playableUrl(track);

/**
 * Kept on this device as this browser plays it, at `quality` or better (High and Normal are encoded streams,
 * lib/quality.ts). One that doesn't play here is fetched again, as one that does.
 */
export function keptAsPlayed(track: Pick<Track, 'fileId' | 'streamUrl' | 'format'>, songs: Record<number, Pick<KeptSong, 'url'>>, quality: Quality = 'original') {
  const url = songs[track.fileId]?.url;
  return !!url && playsHere(track, url) && atLeast(qualityOfUrl(url), quality);
}

/**
 * The copy of a song kept on this device to play instead of streaming it, if there's one that plays here:
 * offline, whatever its quality; online, one at least as good as the quality wanted.
 */
export function keptCopy(track: Pick<Track, 'fileId' | 'streamUrl' | 'format'>, want: Quality): string | undefined {
  const url = useOffline.getState().songs[track.fileId]?.url;
  if (!url || !playsHere(track, url)) return undefined;
  return !navigator.onLine || atLeast(qualityOfUrl(url), want) ? url : undefined;
}

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

/** A kept file's id, from its address: /stream/<fileId>… for a song, or a transition's own (transitionFileId). */
export function fileIdOf(address: string): number | undefined {
  const song = /^\/stream\/(\d+)(?:[/?]|$)/.exec(address);
  if (song) return Number(song[1]);
  return address.startsWith('/transitions/') ? transitionFileId(address) : undefined;
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

// ── The record ───────────────────────────────────────────────────────────────────────────────────────────────────
//
// What's kept is saved in IndexedDB in three parts, each under its own key: the songs (written by the leader tab
// alone, as it downloads, plays and drops them: player/tabs.ts), the downloads and the limit (written by any tab). A
// change is made here at once and kept as a change: when it's written, holding the Web Lock "playarr.offline", it's
// made again on the record as stored then. So another tab's newer record is never overwritten, and a write that fails
// (storage full) loses nothing: the changes wait, and go with the next write. Other tabs read what was written again.
//
// Losing the record never deletes a song. Only the leader deletes audio, once the record has been read, holding the
// lock, on the record as stored then (deleteSongs); and audio the record doesn't know is adopted (reconcileOffline).

type Part = keyof OfflineRecord;
const KEYS: { [P in Part]: string } = { songs: 'playarr.offline.songs', pins: 'playarr.offline.pins', limit: 'playarr.offline.limit' };
const PARTS = Object.keys(KEYS) as Part[];
const EMPTY: OfflineRecord = { songs: {}, pins: {}, limit: DEFAULT_LIMIT };
/** Where zustand's persist kept the record in localStorage, until IndexedDB has it. */
const LEGACY = 'playarr.offline';
const RECORD_LOCK = 'playarr.offline';

/** A change to the record, part by part. */
type Change = { [P in Part]?: (value: OfflineRecord[P]) => OfflineRecord[P] };

/** The record as this tab last read or wrote it. */
let stored: OfflineRecord = EMPTY;
/** Changes made here and not written yet, oldest first. */
let pending: Change[] = [];
/** The localStorage copy, merged into the record as it's first written. */
let migration: Change | null = null;
/** The record couldn't be read: nothing is deleted this session, as it might have held downloads. */
let unreadable = false;

function applyChange(c: Change, r: OfflineRecord): OfflineRecord {
  return { songs: c.songs ? c.songs(r.songs) : r.songs, pins: c.pins ? c.pins(r.pins) : r.pins, limit: c.limit ? c.limit(r.limit) : r.limit };
}
const applyAll = (changes: Change[], r: OfflineRecord) => changes.reduce((out, c) => applyChange(c, out), r);
const recordOf = ({ songs, pins, limit }: OfflineRecord): OfflineRecord => ({ songs, pins, limit });
const partsOf = (r: OfflineRecord, parts: Part[]): Partial<OfflineRecord> => Object.fromEntries(parts.map((p) => [p, r[p]]));

/** Change the record: here at once, and where it's saved a moment later. */
function change(c: Change) {
  useOffline.setState((s) => applyChange(c, s));
  if (!canSave()) return;
  pending.push(c);
  saving.schedule();
}

let localTurn: Promise<unknown> = Promise.resolve();

/** Run `fn` holding the record's lock: across tabs with Web Locks, else within this tab. Never called within itself. */
function withRecord<T>(fn: () => Promise<T>): Promise<T> {
  const locks = lockManager();
  if (locks) return locks.request(RECORD_LOCK, fn) as Promise<T>;
  const run = localTurn.then(fn, fn);
  localTurn = run.catch(() => undefined);
  return run;
}

function readSongs(v: unknown): Record<number, KeptSong> {
  const out: Record<number, KeptSong> = {};
  if (!isObject(v)) return out;
  for (const [id, s] of Object.entries(v)) {
    if (!Number.isInteger(Number(id)) || !isObject(s) || typeof s.url !== 'string' || typeof s.bytes !== 'number' || !Number.isFinite(s.bytes)) continue;
    out[Number(id)] = { url: s.url, bytes: s.bytes, usedAt: typeof s.usedAt === 'number' && Number.isFinite(s.usedAt) ? s.usedAt : 0 };
  }
  return out;
}

const readPins = (v: unknown): Record<string, Download> =>
  isObject(v) ? (Object.fromEntries(Object.entries(v).filter(([, d]) => isObject(d) && typeof d.key === 'string' && Array.isArray(d.tracks))) as Record<string, Download>) : {};

const readLimit = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : DEFAULT_LIMIT);

const READERS: { [P in Part]: (v: unknown) => OfflineRecord[P] } = { songs: readSongs, pins: readPins, limit: readLimit };

/** These parts as stored now: another tab may have written them since. */
async function readParts(parts: Part[]): Promise<Partial<OfflineRecord>> {
  const values = await getMany(parts.map((p) => KEYS[p]));
  return Object.fromEntries(parts.map((p, i) => [p, READERS[p](values[i])]));
}

/** The record as it is now: as stored (another tab may have written it since), with what changed here since. */
async function current(): Promise<OfflineRecord> {
  if (!canSave()) return recordOf(useOffline.getState());
  return applyAll(pending, { ...stored, ...(await readParts(PARTS)) });
}

const saving = writer('what’s kept on this device', writeRecord, 500);

async function writeRecord() {
  if (!useOffline.getState().hydrated || unreadable || !pending.length) return;
  const batch = pending.slice();
  const parts = PARTS.filter((p) => batch.some((c) => c[p]));
  const written = await withRecord(async () => {
    const next = applyAll(batch, { ...stored, ...(await readParts(parts)) });
    await setMany(parts.map((p) => [KEYS[p], next[p]]));
    return next;
  });
  pending = pending.slice(batch.length);
  if (migration && batch.includes(migration)) {
    forgetLegacy(LEGACY);
    migration = null;
  }
  stored = { ...stored, ...partsOf(written, parts) };
  // Here: the record as stored now, with what changed here since.
  useOffline.setState(partsOf(applyAll(pending, stored), parts));
  post({ type: 'saved', keys: parts.map((p) => KEYS[p]) });
}

let hydration: Promise<void> | undefined;

/** Read the record once, at startup (from localStorage the first time). Nothing deletes audio before it's read. */
export function hydrateOffline(): Promise<void> {
  return (hydration ??= readRecord());
}

async function readRecord() {
  if (useOffline.getState().hydrated) return;
  for (let attempt = 1; ; attempt++) {
    try {
      await withRecord(async () => {
        const [songs, pins, limit] = await getMany(PARTS.map((p) => KEYS[p]));
        stored = { songs: readSongs(songs), pins: readPins(pins), limit: readLimit(limit) };
        const legacy = songs === undefined && pins === undefined && limit === undefined ? readLegacy(LEGACY) : undefined;
        if (legacy) {
          const old: OfflineRecord = { songs: readSongs(legacy.songs), pins: readPins(legacy.pins), limit: readLimit(legacy.limit) };
          // Merged into whatever another tab writes first, never over it.
          migration = { songs: (s) => ({ ...old.songs, ...s }), pins: (p) => ({ ...old.pins, ...p }), limit: () => old.limit };
        }
      });
      break;
    } catch (err) {
      if (attempt >= READ_TRIES) {
        unreadable = true;
        // Shown as localStorage last had it, if it has it (an older browser's private window, where IndexedDB won't open).
        const legacy = readLegacy(LEGACY);
        if (legacy) stored = { songs: readSongs(legacy.songs), pins: readPins(legacy.pins), limit: readLimit(legacy.limit) };
        console.warn('Playarr couldn’t read what’s kept on this device: nothing on it is removed this session', err);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  if (migration) pending.unshift(migration);
  // Changes made before (a download added at once) are made on it.
  useOffline.setState({ ...applyAll(pending, stored), hydrated: true });
  if (pending.length) saving.schedule();
}

function whenHydrated(): Promise<void> {
  if (useOffline.getState().hydrated) return Promise.resolve();
  return new Promise((resolve) => {
    const off = useOffline.subscribe((s) => {
      if (!s.hydrated) return;
      off();
      resolve();
    });
  });
}

/** Another tab wrote these parts: read them again (the leader then tidies up after what changed). */
async function reload(parts: Part[]) {
  if (!useOffline.getState().hydrated || unreadable) return;
  const before = recordOf(useOffline.getState());
  try {
    stored = { ...stored, ...(await withRecord(() => readParts(parts))) };
  } catch (err) {
    console.warn('Playarr couldn’t read what another tab kept on this device', err);
    return;
  }
  useOffline.setState(partsOf(applyAll(pending, stored), parts));
  if (isLeader() && needsTidy(before, recordOf(useOffline.getState()))) void tidy();
}

onTabMessage('saved', ({ keys }) => {
  const parts = PARTS.filter((p) => keys.includes(KEYS[p]));
  if (parts.length) void reload(parts);
});

// ── Keeping and dropping songs: the leader's ─────────────────────────────────────────────────────────────────────

/** Bumped by clearOffline(), so a download that was in flight doesn't come back afterwards. */
let generation = 0;
/** Addresses being written into the cache (a song downloading): not in the record yet, and not to be touched. */
const writing = new Set<string>();
/** Files of a transition being kept: not any download's yet, and not to be tidied away meanwhile. */
const inFlight = new Set<number>();

/**
 * Delete kept songs: besides Remove all, the only way audio leaves this device. Only the leader deletes, once the
 * record has been read, holding its lock, on the record as stored then (another tab's newest downloads included):
 * `choose` picks from that, and a song of a download is never taken. Resolves with the songs that went.
 */
async function deleteSongs(choose: (now: OfflineRecord) => number[]): Promise<number[]> {
  await whenHydrated();
  if (!isLeader() || unreadable) return [];
  return withRecord(async () => {
    const now = await current();
    const pinned = pinnedFiles(now.pins);
    const urls = new Map<number, string>();
    for (const id of choose(now)) {
      const song = now.songs[id];
      if (song && !pinned.has(id) && !inFlight.has(id)) urls.set(id, song.url);
    }
    if (!urls.size) return [];
    const cache = await caches.open(AUDIO_CACHE);
    await Promise.all([...urls.values()].map((url) => cache.delete(url)));
    change({ songs: (songs) => omitWhere(songs, (id, s) => urls.get(id) === s.url) });
    return [...urls.keys()];
  });
}

/** Files that lost their download, or a lower limit: what the leader tidies up after. */
function needsTidy(before: OfflineRecord, after: OfflineRecord): boolean {
  if (after.limit < before.limit) return true;
  const pinned = pinnedFiles(after.pins);
  for (const id of pinnedFiles(before.pins)) if (!pinned.has(id)) return true;
  return false;
}

/** Transition files no download has any more go, and songs kept as you listen fit the limit. */
async function tidy() {
  await deleteSongs(({ songs }) => Object.keys(songs).map(Number).filter((id) => id < 0));
  await fitLimit();
}

/** Make a change to the downloads or the limit; the leader tidies up after it. */
async function changeKept(c: Change) {
  const before = recordOf(useOffline.getState());
  change(c);
  // Another tab's leader does it when it reads the change.
  if (isLeader() && needsTidy(before, recordOf(useOffline.getState()))) await tidy();
}

const storageEstimate = (): Promise<StorageEstimate | undefined> => navigator.storage?.estimate?.().catch(() => undefined) ?? Promise.resolve(undefined);

/** The limit for songs kept as you listen, within the share of what the browser allows. */
const limitWithin = (limit: number, estimate: StorageEstimate | undefined) => (estimate?.quota ? Math.min(limit, estimate.quota * QUOTA_SHARE) : limit);

/** Songs that make room for `need` bytes of a song: within the limit, or (for a download) on the device. Null if it won't fit. */
function roomFor(record: OfflineRecord, need: number, { pinned, protect, estimate }: Room): number[] | null {
  const { rest } = splitKept(record.songs, record.pins);
  return pinned ? roomOnDevice(rest, need, protect, estimate) : evictions(rest, need, limitWithin(record.limit, estimate), protect);
}

interface Room {
  pinned: boolean;
  protect: ReadonlySet<number>;
  estimate: StorageEstimate | undefined;
}

/**
 * Download a song and keep it on this device at `quality` (its own file, or its encoded stream: see
 * keptUrl), making room by dropping the least recently used. Only the leader keeps songs, once the record
 * has been read. Resolves false when it won't fit; rejects on network errors and when aborted.
 */
export async function keepSong(
  track: Track,
  { signal, protect, pinned = false, quality = 'original' }: { signal: AbortSignal; protect: ReadonlySet<number>; pinned?: boolean; quality?: Quality },
): Promise<boolean> {
  await whenHydrated();
  if (!isLeader()) return false;
  const started = generation;
  const size = sizeAt(track, quality);
  const room: Room = { pinned, protect, estimate: await storageEstimate() };
  // A first look, on the record here: does it fit at all, before anything is fetched.
  const evict = roomFor(useOffline.getState(), size, room);
  if (!evict) return false;
  const url = keptUrl(track, quality);
  const res = await fetch(url, { signal });
  if (res.status !== 200 || !res.body) {
    void res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  // Room made on the record as stored now: never a song of a download, this tab's or another's.
  if (evict.length) {
    let fits = false;
    await deleteSongs((now) => {
      const made = roomFor(now, size, room);
      fits = made !== null;
      return made ?? [];
    });
    if (!fits) {
      void res.body.cancel();
      return false;
    }
  }

  const expected = Number(res.headers.get('content-length'));
  const total = expected || size;
  let loaded = 0;
  let reported = 0;
  const progress = (active: { fileId: number; loaded: number; total: number } | null) => {
    useActiveDownload.setState({ active });
    post({ type: 'progress', active });
  };
  progress({ fileId: track.fileId, loaded, total });
  const counted = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        loaded += chunk.byteLength;
        // Every 2%: smooth enough for a ring, without re-rendering on each chunk.
        if (loaded - reported > total / 50) {
          reported = loaded;
          progress({ fileId: track.fileId, loaded, total });
        }
        out.enqueue(chunk);
      },
    }),
  );
  writing.add(url);
  try {
    const cache = await caches.open(AUDIO_CACHE);
    try {
      await cache.put(url, new Response(counted, { headers: res.headers }));
    } finally {
      progress(null);
    }
    if (generation !== started || (expected && loaded !== expected)) {
      await cache.delete(url);
      return false;
    }
    // The copy it replaces, at another quality or as this browser can't play it.
    const before = useOffline.getState().songs[track.fileId]?.url;
    if (before && before !== url) await cache.delete(before);
    const usedAt = Date.now();
    change({ songs: (s) => ({ ...s, [track.fileId]: { url, bytes: loaded, usedAt } }) });
  } finally {
    writing.delete(url);
  }
  void askToPersist();
  return true;
}

/** Mark a kept song as just played, so it's among the last to go. */
export function touchSong(fileId: number) {
  if (!(fileId in useOffline.getState().songs)) return;
  const usedAt = Date.now();
  change({ songs: (s) => (s[fileId] ? { ...s, [fileId]: { ...s[fileId], usedAt } } : s) });
}

export async function setOfflineLimit(limit: number) {
  await changeKept({ limit: () => limit });
}

/** Drop songs kept as you listen (never those of downloads) until they fit the limit. */
export async function fitLimit() {
  await deleteSongs(({ songs, pins, limit }) => {
    const { rest } = splitKept(songs, pins);
    return limit ? (evictions(rest, 0, limit) ?? Object.keys(rest).map(Number)) : Object.keys(rest).map(Number);
  });
}

/** Remove everything from this device, downloads included. Only the leader deletes the audio: another tab asks it to. */
export async function clearOffline() {
  generation++;
  change({ songs: () => ({}), pins: () => ({}) });
  await saving.flush();
  if (!canKeepOffline) return;
  if (isLeader()) await caches.delete(AUDIO_CACHE);
  else post({ type: 'clear' });
}

onTabMessage('clear', () => {
  if (!isLeader() || !canKeepOffline) return;
  generation++;
  void caches.delete(AUDIO_CACHE);
});

onTabMessage('progress', ({ active }) => {
  if (!isLeader()) useActiveDownload.setState({ active });
});

/**
 * Download an album, playlist, mix or Favorites (or update the songs of one already downloaded).
 * Transitions between songs that no longer follow each other go.
 */
export function addDownload(download: Omit<Download, 'addedAt' | 'transitions'>) {
  const addedAt = Date.now();
  void changeKept({
    pins: (pins) => {
      const before = pins[download.key];
      const transitions = Object.entries(before?.transitions ?? {}).filter(([pair]) => pairsOf(download.tracks, pairMode(pair)).has(pair));
      return { ...pins, [download.key]: { ...download, addedAt: before?.addedAt ?? addedAt, transitions: Object.fromEntries(transitions) } };
    },
  });
}

/**
 * Remove a download: its songs become ordinary kept songs, which make room as usual. Its transitions
 * are only any use to downloads, so they go unless another one has them too.
 */
export async function removeDownload(key: string) {
  await changeKept({
    pins: (pins) => {
      const out = { ...pins };
      delete out[key];
      return out;
    },
  });
}

/**
 * Put back a download just removed (its Undo): as it was, in its place in the list. Songs that made room for others
 * meanwhile download again.
 */
export function restoreDownload(download: Download) {
  change({ pins: (pins) => ({ ...pins, [download.key]: download }) });
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
  const pair = transitionPair(from.fileId, to.fileId, mode);
  const fetched: number[] = [];
  let kept = false;
  try {
    for (const { url, size } of files) {
      const fileId = transitionFileId(url);
      // Kept already: another download has the same pair.
      if (fileId in useOffline.getState().songs) continue;
      inFlight.add(fileId);
      fetched.push(fileId);
      const pseudoTrack = { fileId, streamUrl: url, size } as Track;
      if (!(await keepSong(pseudoTrack, { signal, protect: pinnedFiles(useOffline.getState().pins), pinned: true }))) return false;
    }
    const download = useOffline.getState().pins[key];
    // Removed meanwhile, or its songs no longer follow each other: nothing to keep it for.
    if (!download || !pairsOf(download.tracks, mode).has(pair)) return true;
    change({
      pins: (pins) => {
        const d = pins[key];
        return d && pairsOf(d.tracks, mode).has(pair) ? { ...pins, [key]: { ...d, transitions: { ...d.transitions, [pair]: transition } } } : pins;
      },
    });
    kept = true;
    return true;
  } finally {
    for (const id of fetched) inFlight.delete(id);
    if (!kept) await deleteSongs(() => fetched);
  }
}

/** How far along a download is; its bytes count its transitions too. */
export function downloadProgress(d: Download, songs: Record<number, KeptSong>) {
  const done = d.tracks.filter((t) => t.fileId in songs);
  const bytes = [...done.map((t) => t.fileId), ...new Set(transitionFileIds(d))].reduce((sum, id) => sum + (songs[id]?.bytes ?? 0), 0);
  return { done: done.length, total: d.tracks.length, bytes };
}

/** A Cache Storage key as the record knows it: its path and query (a song kept encoded is /stream/7/aac?kbps=128). */
const addressOf = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

/** A kept file's size: as its headers say (the server's), else as long as it is. */
async function sizeOf(res: Response): Promise<number> {
  const length = Number(res.headers.get('content-length'));
  return length > 0 ? length : (await res.blob()).size;
}

/** When a file was kept, near enough: when the server sent it. */
function keptAt(res: Response): number {
  const at = Date.parse(res.headers.get('date') ?? '');
  return Number.isFinite(at) ? at : 0;
}

/** Of two copies of a song, `a` is the better. */
const better = (a: string, b: string) => !atLeast(qualityOfUrl(b), qualityOfUrl(a));

/**
 * Make the record and Cache Storage agree, in the leader, once the record has been read. Audio the record doesn't know
 * is adopted, not deleted: its file id is in its address, its size in its headers, and it counts as a song kept as
 * you listen, so it goes only when room is needed (a download's song is the download's again). Songs whose audio the
 * browser has cleared are forgotten. A second copy of a song the record has (a download replaced midway) goes: the
 * song stays, in its copy.
 */
export async function reconcileOffline() {
  if (!canKeepOffline) return;
  await whenHydrated();
  if (!isLeader() || unreadable) return;
  await withRecord(async () => {
    const cache = await caches.open(AUDIO_CACHE);
    const inCache = new Map((await cache.keys()).map((request) => [addressOf(request.url), request] as const));
    const now = await current();
    const known = new Set(Object.values(now.songs).map((s) => s.url));
    const gone = new Set([...known].filter((url) => !inCache.has(url)));
    const adopted: Record<number, KeptSong> = {};
    const spare: string[] = [];
    for (const [address, request] of inCache) {
      if (known.has(address) || writing.has(address)) continue;
      const id = fileIdOf(address);
      // Not a file this app keeps: left alone.
      if (id === undefined) continue;
      const kept = now.songs[id];
      if (kept && !gone.has(kept.url)) {
        spare.push(address);
        continue;
      }
      const prior = adopted[id];
      if (prior && !better(address, prior.url)) {
        spare.push(address);
        continue;
      }
      const res = await cache.match(request);
      if (!res) continue;
      if (prior) spare.push(prior.url);
      adopted[id] = { url: address, bytes: await sizeOf(res), usedAt: keptAt(res) };
    }
    if (spare.length) await Promise.all(spare.map((address) => cache.delete(address)));
    if (!gone.size && !Object.keys(adopted).length) return;
    change({
      songs: (songs) => {
        const out = omitWhere(songs, (_, s) => gone.has(s.url));
        for (const [id, song] of Object.entries(adopted)) out[Number(id)] ??= song;
        return out;
      },
    });
  });
}

/** The mode a transitionPair() was made with. */
const pairMode = (pair: string) => pair.slice(pair.lastIndexOf('-') + 1) as MixMode;

/** Room for `need` more bytes on the device, dropping songs kept as you listen if it's short; null if it won't fit. */
function roomOnDevice(rest: Record<number, KeptSong>, need: number, protect: ReadonlySet<number>, estimate: StorageEstimate | undefined): number[] | null {
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

let persistAsked = false;
/** Ask the browser not to clear our storage under pressure (granted silently by most). */
async function askToPersist() {
  if (persistAsked || !navigator.storage?.persist) return;
  persistAsked = true;
  if (!(await navigator.storage.persisted())) await navigator.storage.persist();
}

function omitWhere(songs: Record<number, KeptSong>, drop: (id: number, song: KeptSong) => boolean): Record<number, KeptSong> {
  const out = { ...songs };
  for (const [id, song] of Object.entries(songs)) if (drop(Number(id), song)) delete out[Number(id)];
  return out;
}
