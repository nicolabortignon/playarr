import type { Track } from '@playarr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeChannel, FakeLocks, fakeAudioCache, openTab as open, resetIdb, type Tab } from '../testFakes';

// One leader tab (plan 3 §3): which tab plays, how the others follow it, and how the lead moves.

vi.mock('idb-keyval', async () => (await import('../testFakes')).fakeIdbKeyval);

const track = (fileId: number): Track => ({ id: fileId, recordingId: `r${fileId}`, fileId, size: 100, streamUrl: `/stream/${fileId}`, title: `Song ${fileId}`, duration: 200, albumId: 1 }) as Track;
const queueOf = (tab: Tab) => tab.store.usePlayer.getState().queue.map((t) => t.fileId);
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

let locks: FakeLocks;
const openTab = async () => {
  const tab = await open(locks);
  await tab.playerRecord.hydratePlayer();
  return tab;
};

beforeEach(() => {
  vi.useFakeTimers();
  resetIdb();
  locks = new FakeLocks();
  vi.stubGlobal('indexedDB', {});
  vi.stubGlobal('caches', fakeAudioCache().caches);
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeChannel.open.clear();
  Reflect.deleteProperty(navigator, 'locks');
});

describe('one leader tab', () => {
  it('is the first one open; the others follow its queue and say it’s playing', async () => {
    const a = await openTab();
    const b = await openTab();
    expect([a.tabs.isLeader(), b.tabs.isLeader()]).toEqual([true, false]);

    a.store.usePlayer.getState().playTracks([track(1), track(2), track(3)], 1);
    await settle(1000);
    expect(queueOf(b)).toEqual([1, 2, 3]);
    expect(b.store.usePlayer.getState().pos).toBe(1);
    // Where the player bar shows the song: "Playing in another tab". It plays nothing itself.
    expect(b.tabs.useTabs.getState()).toMatchObject({ leading: false, elsewhere: true });
    expect(b.store.usePlayer.getState().playing).toBe(false);

    a.store.usePlayer.getState().setPlaying(false);
    await settle();
    expect(b.tabs.useTabs.getState().elsewhere).toBe(false);
  });

  it('moves to a tab that plays, at once: the old leader pauses and lets go, and leads again once that tab closes', async () => {
    const a = await openTab();
    const b = await openTab();
    a.store.usePlayer.getState().playTracks([track(1), track(2)]);
    await settle(1000);

    // Play, pressed in B: it leads within the press, as the audio must start there.
    b.store.usePlayer.getState().toggle();
    expect(b.tabs.isLeader()).toBe(true);
    await settle();
    expect(a.tabs.isLeader()).toBe(false);
    expect(a.store.usePlayer.getState().playing).toBe(false);
    expect(a.tabs.useTabs.getState().elsewhere).toBe(true);
    expect(b.tabs.useTabs.getState().elsewhere).toBe(false);
    // B saves the queue now; A follows it.
    b.store.usePlayer.getState().addToQueue([track(3)]);
    await settle(1000);
    expect(queueOf(a)).toEqual([1, 2, 3]);

    b.close();
    await settle();
    expect(a.tabs.isLeader()).toBe(true);
  });

  it('makes a follower’s queue edits, which every tab then follows; not one made on a queue that has moved on', async () => {
    const a = await openTab();
    const b = await openTab();
    a.store.usePlayer.getState().playTracks([track(1), track(2), track(3)]);
    await settle(1000);

    b.store.usePlayer.getState().addToQueue([track(4)]);
    await settle(1000);
    expect(queueOf(a)).toEqual([1, 2, 3, 4]);
    expect(queueOf(b)).toEqual([1, 2, 3, 4]);
    expect(b.tabs.isLeader()).toBe(false);

    // The song moves on in A while B, not yet told, removes what was the third song: it would take the fourth now.
    a.store.usePlayer.getState().nextNow();
    b.store.usePlayer.getState().removeAt(2);
    await settle(1000);
    expect(a.store.usePlayer.getState().order).toEqual([0, 1, 2, 3]);
    expect(b.store.usePlayer.getState().order).toEqual([0, 1, 2, 3]);
    expect(b.store.usePlayer.getState().pos).toBe(1);
  });

  it('without Web Locks, every tab is its own leader, as before', async () => {
    Reflect.deleteProperty(navigator, 'locks');
    const a = await open(null);
    const b = await open(null);
    expect([a.tabs.isLeader(), b.tabs.isLeader()]).toEqual([true, true]);
  });
});
