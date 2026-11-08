import type { Track } from '@playarr/shared';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDownloads } from './downloads';
import { useLoadAhead } from './loadAhead';
import { useOffline } from './offline';
import { usePlayer } from './store';
import { useTabs } from './tabs';

// What only the tab that plays does (plan 3 §3): downloads and loading ahead, on a page where songs can be kept.

const kept = vi.hoisted(() => {
  const files = new Map<string, number>();
  const cache = {
    put: async (url: string, res: Response) => void files.set(url, (await res.arrayBuffer()).byteLength),
    delete: async (url: string) => files.delete(url),
    keys: async () => [...files.keys()].map((url) => new Request(new URL(url, 'http://localhost:4000'))),
    match: async () => undefined,
  };
  // Set before the modules load: canKeepOffline is worked out once.
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.assign(globalThis, { caches: { open: async () => cache, delete: async () => true, match: async () => undefined } });
  return files;
});

const track = (fileId: number): Track => ({ id: fileId, recordingId: `r${fileId}`, fileId, size: 100, streamUrl: `/stream/${fileId}`, title: `Song ${fileId}`, duration: 200, albumId: 1 }) as Track;
const fetched = vi.fn(async (_url: string, _init?: RequestInit) => new Response(new Uint8Array(100), { headers: { 'Content-Length': '100' } }));
const asked = () => fetched.mock.calls.map(([url]) => url);

beforeEach(() => {
  vi.useFakeTimers();
  kept.clear();
  fetched.mockClear();
  vi.stubGlobal('fetch', fetched);
  // A service worker plays kept songs (workerReady).
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { controller: {}, addEventListener() {}, removeEventListener() {} } });
  useOffline.setState({ songs: {}, pins: { 'album:7': { key: 'album:7', title: 'Mezzanine', href: '/albums/7', tracks: [track(1), track(2)], addedAt: 1 } }, limit: 10_000 });
  usePlayer.setState({ queue: [track(3), track(4), track(5)], order: [0, 1, 2], pos: 0, repeat: 'off' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'serviceWorker');
  useTabs.setState({ leading: true, elsewhere: false });
  useOffline.setState({ songs: {}, pins: {} });
});

describe('downloads and loading ahead', () => {
  it('don’t run in a tab that follows another; taking the lead starts them where they are', async () => {
    useTabs.setState({ leading: false, elsewhere: true });
    renderHook(() => {
      useDownloads();
      useLoadAhead();
    });
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(fetched).not.toHaveBeenCalled();

    // Played here: this tab leads now, and carries on the downloads, then loads the next songs ahead.
    await act(async () => {
      useTabs.setState({ leading: true, elsewhere: false });
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(asked()).toEqual(expect.arrayContaining(['/stream/1', '/stream/2', '/stream/4', '/stream/5']));
    expect([...kept.keys()]).toEqual(expect.arrayContaining(['/stream/1', '/stream/2', '/stream/4', '/stream/5']));

    // Another tab takes the lead: nothing more is fetched here.
    fetched.mockClear();
    await act(async () => {
      useTabs.setState({ leading: false, elsewhere: true });
      usePlayer.setState({ pos: 1 });
      useOffline.setState({ pins: { ...useOffline.getState().pins, 'album:8': { key: 'album:8', title: 'Blue Lines', href: '/albums/8', tracks: [track(9)], addedAt: 2 } } });
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetched).not.toHaveBeenCalled();
  });

  it('wait for what’s kept to be read', async () => {
    useOffline.setState({ hydrated: false });
    renderHook(() => {
      useDownloads();
      useLoadAhead();
    });
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(fetched).not.toHaveBeenCalled();
    await act(async () => {
      useOffline.setState({ hydrated: true });
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(asked()).toEqual(expect.arrayContaining(['/stream/1', '/stream/4']));
  });
});
