import type { Track } from '@playarr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAheadPlan } from './loadAhead';
import { evictions, keepSong, useOffline } from './offline';

const track = (fileId: number, size = 1000): Track =>
  ({ id: fileId, fileId, size, streamUrl: `/stream/${fileId}`, title: `Song ${fileId}`, duration: 200 }) as Track;

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
    useOffline.setState({ songs: {}, limit: 1000, active: null });
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
