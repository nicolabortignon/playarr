import type { Track } from '@playarr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeChannel, FakeLocks, gateReads, idb, openTab, resetIdb } from '../testFakes';
import { compactQueue } from './queueCodec';

// The player's saved record (plan 3 §3): what's written when, and what a page opening finds.

vi.mock('idb-keyval', async () => (await import('../testFakes')).fakeIdbKeyval);

const track = (fileId: number): Track => ({ id: fileId, recordingId: `r${fileId}`, fileId, size: 100, streamUrl: `/stream/${fileId}`, title: `Song ${fileId}`, duration: 200, albumId: 1 }) as Track;
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const fileIds = (queue: Track[]) => queue.map((t) => t.fileId);

let locks: FakeLocks;
const open = () => openTab(locks);

beforeEach(() => {
  vi.useFakeTimers();
  resetIdb();
  localStorage.clear();
  locks = new FakeLocks();
  vi.stubGlobal('indexedDB', {});
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

describe('the saved player', () => {
  it('writes where the song is on its own: the queue isn’t written again as it plays', async () => {
    const tab = await open();
    await tab.playerRecord.hydratePlayer();
    tab.store.usePlayer.getState().playTracks([track(1), track(2), track(3)]);
    await settle(1000);
    expect(idb.writes).toEqual([['playarr.player.queue', 'playarr.player']]);

    idb.writes.length = 0;
    tab.store.usePlayer.getState().setResumeAt(12);
    await settle(1000);
    tab.store.usePlayer.getState().setResumeAt(17);
    await settle(1000);
    expect(idb.writes).toEqual([['playarr.player.resumeAt'], ['playarr.player.resumeAt']]);
    // On to the next song: its place and where it starts, still not the queue.
    tab.store.usePlayer.getState().nextNow();
    await settle(1000);
    expect(idb.writes.at(-1)).toEqual(['playarr.player', 'playarr.player.resumeAt']);
  });

  it('keeps the mix mode with the queue, but never where a song is asked to start, nor whether it plays', async () => {
    const tab = await open();
    await tab.playerRecord.hydratePlayer();
    tab.store.usePlayer.getState().playTracks([track(1), track(2)], 0, { at: 30 });
    tab.store.usePlayer.getState().setMixMode('party');
    await settle(1000);
    const saved = idb.data.get('playarr.player');
    expect(saved).toMatchObject({ mixMode: 'party', pos: 0 });
    expect(saved).not.toHaveProperty('startAt');
    expect(saved).not.toHaveProperty('playing');
  });

  it('resumes the saved queue only once it’s been read', async () => {
    idb.data.set('playarr.player.queue', compactQueue([track(1), track(2), track(3)]));
    idb.data.set('playarr.player', { order: [0, 1, 2], pos: 1, shuffle: false, repeat: 'off', volume: 1, muted: false, mixMode: 'auto' });
    idb.data.set('playarr.player.resumeAt', 42);
    const read = gateReads();
    const tab = await open();
    const hydrating = tab.playerRecord.hydratePlayer();
    // Nothing for the engine to load meanwhile, so nothing resumes on an unread record.
    expect(tab.store.usePlayer.getState()).toMatchObject({ queue: [], pos: -1, hydrated: false });

    read();
    await hydrating;
    const s = tab.store.usePlayer.getState();
    expect(fileIds(s.queue)).toEqual([1, 2, 3]);
    expect(s).toMatchObject({ pos: 1, resumeAt: 42, hydrated: true });
    expect(tab.store.currentTrack(s)?.fileId).toBe(2);
  });

  it('keeps what was played before the record was read, with the settings saved', async () => {
    idb.data.set('playarr.player.queue', compactQueue([track(1), track(2), track(3)]));
    idb.data.set('playarr.player', { order: [0, 1, 2], pos: 2, shuffle: false, repeat: 'all', volume: 0.3, muted: false, mixMode: 'party' });
    idb.data.set('playarr.player.resumeAt', 42);
    const read = gateReads();
    const tab = await open();
    const hydrating = tab.playerRecord.hydratePlayer();
    tab.store.usePlayer.getState().playTracks([track(7)]);

    read();
    await hydrating;
    const s = tab.store.usePlayer.getState();
    expect(fileIds(s.queue)).toEqual([7]);
    expect(s).toMatchObject({ pos: 0, resumeAt: 0, mixMode: 'auto', playing: true, volume: 0.3, repeat: 'all' });
    await settle(1000);
    expect(idb.data.get('playarr.player')).toMatchObject({ pos: 0, volume: 0.3, repeat: 'all' });
    expect(idb.data.get('playarr.player.resumeAt')).toBe(0);
  });
});
