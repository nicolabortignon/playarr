import type { TransitionPlan } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { api, type TransitionAnswer } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { keepNextTransition, nextToDownload, useDownloadState } from './downloads';
import { loadAheadPlan } from './loadAhead';
import {
  addDownload,
  downloadProgress,
  evictions,
  keepSong,
  offlineTransition,
  removeDownload,
  setOfflineLimit,
  splitKept,
  transitionFileId,
  useOffline,
} from './offline';
import { useTransition } from './transitions';

const track = (fileId: number, size = 1000): Track =>
  ({ id: fileId, fileId, size, streamUrl: `/stream/${fileId}`, title: `Song ${fileId}`, duration: 200, albumId: 1 }) as Track;

describe('load-ahead plan', () => {
  const queue = [1, 2, 3, 4, 5].map((id) => track(id));
  const at = (pos: number, repeat: 'off' | 'all' | 'one' = 'off', order = [0, 1, 2, 3, 4]) => ({ queue, order, pos, repeat });
  const ids = (tracks: Track[]) => tracks.map((t) => t.fileId);

  it('takes the next songs in play order, then the one playing', () => {
    expect(ids(loadAheadPlan(at(0), 3))).toEqual([2, 3, 4, 1]);
    expect(ids(loadAheadPlan(at(1, 'off', [4, 2, 0, 1, 3]), 2))).toEqual([1, 2, 3]);
  });

  it('stops at the end of the queue unless it repeats', () => {
    expect(ids(loadAheadPlan(at(3), 3))).toEqual([5, 4]);
    expect(ids(loadAheadPlan(at(3, 'all'), 3))).toEqual([5, 1, 2, 4]);
  });

  it('puts the current song first on repeat-one, and leaves it out on request', () => {
    expect(ids(loadAheadPlan(at(0, 'one'), 1))).toEqual([1, 2]);
    expect(ids(loadAheadPlan(at(0), 1, false))).toEqual([2]);
  });

  it('lists each file once, and nothing for an empty queue', () => {
    const twice = { queue: [track(7), track(8), track(7)], order: [0, 1, 2], pos: 0, repeat: 'off' as const };
    expect(ids(loadAheadPlan(twice, 3))).toEqual([8, 7]);
    expect(loadAheadPlan({ queue: [], order: [], pos: -1, repeat: 'off' }, 3)).toEqual([]);
  });
});

describe('evictions', () => {
  const songs = {
    1: { url: '/stream/1', bytes: 400, usedAt: 30 },
    2: { url: '/stream/2', bytes: 400, usedAt: 10 },
    3: { url: '/stream/3', bytes: 400, usedAt: 20 },
  };

  it('drops the least recently used until the new song fits', () => {
    expect(evictions(songs, 100, 2000)).toEqual([]);
    expect(evictions(songs, 500, 1500)).toEqual([2]);
    expect(evictions(songs, 900, 1500)).toEqual([2, 3]);
  });

  it('never drops protected songs, and gives up when it cannot fit', () => {
    expect(evictions(songs, 500, 1500, new Set([2]))).toEqual([3]);
    expect(evictions(songs, 1000, 1500, new Set([1, 3]))).toBeNull();
    expect(evictions({}, 2000, 1500)).toBeNull();
  });
});

/** Just enough Cache Storage for the downloader, with bodies read into memory. */
function fakeCaches() {
  const store = new Map<string, ArrayBuffer>();
  const cache = {
    put: async (url: string, res: Response) => void store.set(url, await res.arrayBuffer()),
    delete: async (url: string) => store.delete(url),
    keys: async () => [...store.keys()].map((url) => new Request(new URL(url, 'http://localhost'))),
  };
  return { store, caches: { open: async () => cache, delete: async () => store.clear() } };
}

describe('keeping songs', () => {
  let store: Map<string, ArrayBuffer>;
  const stalled = new Set(['/stream/6']);

  beforeEach(() => {
    const fake = fakeCaches();
    store = fake.store;
    vi.stubGlobal('caches', fake.caches);
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const size = Number(url.split('/').pop()) * 100;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          init?.signal?.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')));
          c.enqueue(new Uint8Array(size / 2));
          if (stalled.has(url)) return; // the rest never arrives
          setTimeout(() => {
            if (init?.signal?.aborted) return;
            c.enqueue(new Uint8Array(size / 2));
            c.close();
          }, 5);
        },
      });
      return new Response(body, { headers: { 'Content-Length': String(size) } });
    });
    useOffline.setState({ songs: {}, pins: {}, limit: 1000, active: null });
  });
  afterEach(() => vi.unstubAllGlobals());

  const keep = (t: Track, signal = new AbortController().signal, protect = new Set<number>()) => keepSong(t, { signal, protect });

  it('downloads a song into the cache and remembers its size', async () => {
    expect(await keep(track(4, 400))).toBe(true);
    expect(store.get('/stream/4')?.byteLength).toBe(400);
    expect(useOffline.getState().songs[4]).toMatchObject({ url: '/stream/4', bytes: 400 });
    expect(useOffline.getState().active).toBeNull();
  });

  it('makes room by dropping the song played longest ago', async () => {
    await keep(track(4, 400));
    await keep(track(5, 500));
    expect(await keep(track(3, 300))).toBe(true);
    expect(Object.keys(useOffline.getState().songs)).toEqual(['3', '5']);
    expect([...store.keys()].sort()).toEqual(['/stream/3', '/stream/5']);
  });

  it('skips songs that cannot fit, and keeps nothing from an aborted download', async () => {
    expect(await keep(track(20, 2000))).toBe(false);
    const abort = new AbortController();
    const pending = keep(track(6, 600), abort.signal);
    await vi.waitFor(() => expect(useOffline.getState().active?.fileId).toBe(6));
    abort.abort();
    await expect(pending).rejects.toThrow();
    expect(useOffline.getState().songs).toEqual({});
    expect(useOffline.getState().active).toBeNull();
  });
});

describe('downloads', () => {
  let store: Map<string, ArrayBuffer>;
  beforeEach(() => {
    const fake = fakeCaches();
    store = fake.store;
    vi.stubGlobal('caches', fake.caches);
    vi.stubGlobal('fetch', async (url: string) => {
      const size = Number(url.split('/').pop()) * 100;
      return new Response(new Uint8Array(size), { headers: { 'Content-Length': String(size) } });
    });
    useOffline.setState({ songs: {}, pins: {}, limit: 1000, active: null });
  });
  afterEach(() => vi.unstubAllGlobals());

  const album = { key: 'album:1', title: 'Dummy', href: '/albums/1', tracks: [track(4, 400), track(5, 500), track(6, 600)] };

  it('keeps a download’s songs beyond the limit, and they never make room for others', async () => {
    addDownload(album);
    for (const t of album.tracks) expect(await keepSong(t, { signal: new AbortController().signal, protect: new Set(), pinned: true })).toBe(true);
    expect(downloadProgress(useOffline.getState().pins['album:1']!, useOffline.getState().songs)).toEqual({ done: 3, total: 3, bytes: 1500 });
    // A song kept as you listen fits within the limit on its own.
    expect(await keepSong(track(7, 700), { signal: new AbortController().signal, protect: new Set() })).toBe(true);
    const { inDownloads, rest } = splitKept(useOffline.getState().songs, useOffline.getState().pins);
    expect(Object.keys(inDownloads)).toEqual(['4', '5', '6']);
    expect(Object.keys(rest)).toEqual(['7']);
    // Turning keeping-as-you-listen off leaves downloads alone.
    await setOfflineLimit(0);
    expect(Object.keys(useOffline.getState().songs)).toEqual(['4', '5', '6']);
  });

  it('removing a download lets its songs go within the limit', async () => {
    addDownload(album);
    for (const t of album.tracks) await keepSong(t, { signal: new AbortController().signal, protect: new Set(), pinned: true });
    await removeDownload('album:1');
    expect(useOffline.getState().pins).toEqual({});
    const left = Object.values(useOffline.getState().songs).reduce((sum, s) => sum + s.bytes, 0);
    expect(left).toBeLessThanOrEqual(1000);
    expect(store.size).toBe(Object.keys(useOffline.getState().songs).length);
  });

  it('fetches downloads in the order they were added, skipping what failed', () => {
    const pins = { b: { addedAt: 2, tracks: [track(8)] }, a: { addedAt: 1, tracks: [track(1), track(2)] } };
    expect(nextToDownload(pins, {}, {})?.fileId).toBe(1);
    expect(nextToDownload(pins, { 1: {} }, { 2: 'no room' })?.fileId).toBe(8);
    expect(nextToDownload(pins, { 1: {}, 2: {}, 8: {} }, {})).toBeUndefined();
  });
});

describe('download transitions', () => {
  let store: Map<string, ArrayBuffer>;
  let transition: MockInstance<typeof api.transition>;
  /** Bytes the server sends for each file. */
  const sizes: Record<string, number> = {};

  const plan = { style: 'long', aStart: 170, bStart: 8, length: 24, bResume: 32, switchAt: 12 } as Partial<TransitionPlan> as TransitionPlan;
  const ready = (from: number, to: number, rest = false): TransitionAnswer => ({
    status: 'ready',
    plan,
    url: `/transitions/${from}-${to}.flac`,
    ...(rest ? { continuationUrl: `/transitions/${from}-${to}.rest.flac` } : {}),
  });
  const pending: TransitionAnswer = { status: 'pending', plan };

  /** Answers by pair, in turn: the last one repeats. */
  function answers(byPair: Record<string, TransitionAnswer[]>) {
    transition.mockImplementation(async (from, to) => {
      const list = byPair[`${from}-${to}`];
      if (!list) throw new Error(`Unexpected ask ${from}-${to}`);
      return list.length > 1 ? list.shift()! : list[0]!;
    });
  }

  /** Fetch every transition downloads are missing, as the downloader does after their songs. */
  async function keepAll() {
    while (await keepNextTransition());
  }

  const keptSongs = (...ids: number[]) => Object.fromEntries(ids.map((id) => [id, { url: `/stream/${id}`, bytes: id * 100, usedAt: 0 }]));

  beforeEach(() => {
    const fake = fakeCaches();
    store = fake.store;
    vi.stubGlobal('caches', fake.caches);
    vi.stubGlobal('fetch', async (url: string) => {
      const size = sizes[url] ?? 50;
      return new Response(new Uint8Array(size), { headers: { 'Content-Length': String(size) } });
    });
    for (const url of Object.keys(sizes)) delete sizes[url];
    usePrefs.setState({ transitions: 'dj', crossfade: 0 });
    useDownloadState.setState({ failed: {}, skippedPairs: {} });
    useTransition.setState({ fromFileId: null, toFileId: null, result: null, ready: undefined });
    useOffline.setState({ songs: keptSongs(4, 5, 6), pins: {}, limit: 1000, active: null });
    transition = vi.spyOn(api, 'transition');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const album = { key: 'album:1', title: 'Dummy', href: '/albums/1', tracks: [track(4, 400), track(5, 500), track(6, 600)] };

  it('asks for each pair of a download in its song order, without a position, and keeps the files', async () => {
    sizes['/transitions/4-5.flac'] = 70;
    sizes['/transitions/5-6.flac'] = 80;
    sizes['/transitions/5-6.rest.flac'] = 90;
    answers({ '4-5': [ready(4, 5)], '5-6': [ready(5, 6, true)] });
    addDownload(album);
    await keepAll();

    // Asked as the player asks for its album: the same plans, so the same files.
    const asAlbum = [undefined, undefined, { fade: 6, albumQueue: true }];
    expect(transition.mock.calls).toEqual([
      [4, 5, 'auto', ...asAlbum],
      [5, 6, 'auto', ...asAlbum],
    ]);
    expect([...store.keys()].sort()).toEqual(['/transitions/4-5.flac', '/transitions/5-6.flac', '/transitions/5-6.rest.flac']);
    expect(useOffline.getState().pins['album:1']!.transitions).toEqual({ '4-5-auto': ready(4, 5), '5-6-auto': ready(5, 6, true) });
    expect(useOffline.getState().songs[transitionFileId('/transitions/5-6.rest.flac')]).toMatchObject({ url: '/transitions/5-6.rest.flac', bytes: 90 });
    // They belong to the download: counted with it, never made room with.
    const { inDownloads, rest } = splitKept(useOffline.getState().songs, useOffline.getState().pins);
    expect(Object.keys(inDownloads)).toHaveLength(6);
    expect(rest).toEqual({});
    expect(downloadProgress(useOffline.getState().pins['album:1']!, useOffline.getState().songs)).toEqual({ done: 3, total: 3, bytes: 1500 + 240 });
  });

  it('looks a kept transition up by its pair and mode', async () => {
    answers({ '4-5': [ready(4, 5)], '5-6': [ready(5, 6, true)] });
    addDownload(album);
    await keepAll();
    expect(offlineTransition(5, 6, 'auto')).toEqual(ready(5, 6, true));
    expect(offlineTransition(6, 5, 'auto')).toBeUndefined();
    expect(offlineTransition(5, 6, 'party')).toBeUndefined();
    // The browser cleared its file: nothing to play it from.
    useOffline.setState((s) => {
      const songs = { ...s.songs };
      delete songs[transitionFileId('/transitions/5-6.rest.flac')];
      return { songs };
    });
    expect(offlineTransition(5, 6, 'auto')).toBeUndefined();
  });

  it('polls a pair while it renders, and moves on once one takes too long', async () => {
    vi.useFakeTimers();
    answers({ '4-5': [pending, pending, ready(4, 5)], '5-6': [pending] });
    addDownload(album);
    const done = keepAll();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await done;
    expect(transition.mock.calls.filter(([from]) => from === 4)).toHaveLength(3);
    expect(transition.mock.calls.filter(([from]) => from === 5).length).toBeGreaterThan(3);
    expect(Object.keys(useOffline.getState().pins['album:1']!.transitions ?? {})).toEqual(['4-5-auto']);
    expect(useDownloadState.getState().skippedPairs['5-6-auto']).toMatch(/too long/);
  });

  it('skips pairs with no transition to keep, and pairs whose songs aren’t kept yet', async () => {
    useOffline.setState({ songs: keptSongs(4, 5, 6, 8) });
    answers({ '4-5': [{ status: 'unavailable', reason: 'No mix map yet for the next song' }], '5-6': [{ status: 'straight', plan }], '6-7': [ready(6, 7)] });
    addDownload({ ...album, tracks: [...album.tracks, track(7), track(8)] });
    await keepAll();
    const asAlbum = [undefined, undefined, { fade: 6, albumQueue: true }];
    expect(transition.mock.calls).toEqual([
      [4, 5, 'auto', ...asAlbum],
      [5, 6, 'auto', ...asAlbum],
    ]);
    expect(store.size).toBe(0);
    expect(useOffline.getState().pins['album:1']!.transitions ?? {}).toEqual({});
    expect(Object.keys(useDownloadState.getState().skippedPairs)).toEqual(['4-5-auto', '5-6-auto']);
  });

  it('shares a transition between downloads, and removes its files with the last one', async () => {
    answers({ '4-5': [ready(4, 5)], '5-6': [ready(5, 6, true)] });
    addDownload(album);
    addDownload({ key: 'playlist:1', title: 'Two', href: '/playlists/1', tracks: [track(4, 400), track(5, 500)] });
    await keepAll();
    expect(transition).toHaveBeenCalledTimes(2);
    expect(useOffline.getState().pins['playlist:1']!.transitions).toEqual({ '4-5-auto': ready(4, 5) });

    await removeDownload('album:1');
    expect([...store.keys()]).toEqual(['/transitions/4-5.flac']);
    expect(offlineTransition(5, 6, 'auto')).toBeUndefined();
    expect(offlineTransition(4, 5, 'auto')).toEqual(ready(4, 5));
    await removeDownload('playlist:1');
    expect(store.size).toBe(0);
    expect(Object.keys(useOffline.getState().songs).map(Number).filter((id) => id < 0)).toEqual([]);
  });

  it('forgets transitions of pairs a download no longer has', async () => {
    answers({ '4-5': [ready(4, 5)], '5-6': [ready(5, 6, true)] });
    addDownload(album);
    await keepAll();
    addDownload({ ...album, tracks: [track(4, 400), track(5, 500)] });
    expect(Object.keys(useOffline.getState().pins['album:1']!.transitions ?? {})).toEqual(['4-5-auto']);
    await vi.waitFor(() => expect([...store.keys()]).toEqual(['/transitions/4-5.flac']));
  });

  it('leaves the pair the player is about to mix to the player', async () => {
    answers({ '4-5': [ready(4, 5)], '5-6': [ready(5, 6, true)] });
    // Song 4 plays with song 9 next: asking for 4→5 now would push the player's ask out of the server's queue.
    useTransition.setState({ fromFileId: 4, toFileId: 9 });
    addDownload(album);
    await keepAll();
    expect(transition.mock.calls).toEqual([[5, 6, 'auto', undefined, undefined, { fade: 6, albumQueue: true }]]);
  });

  it('fetches nothing unless transitions are DJ mix', async () => {
    usePrefs.setState({ transitions: 'crossfade' });
    addDownload(album);
    expect(await keepNextTransition()).toBe(false);
    expect(transition).not.toHaveBeenCalled();
  });
});
