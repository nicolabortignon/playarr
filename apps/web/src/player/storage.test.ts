import type { Track } from '@playarr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeChannel, FakeLocks, fakeAudioCache, gateReads, idb, openTab as open, quotaError, resetIdb, type Tab } from '../testFakes';
import { expandQueue } from './queueCodec';

// Plan 3 §3's "done when": a full disk or a second tab never deletes a kept song.

vi.mock('idb-keyval', async () => (await import('../testFakes')).fakeIdbKeyval);

const MB = 1024 ** 2;
const track = (fileId: number, size = 100): Track =>
  ({ id: fileId, recordingId: `r${fileId}`, fileId, size, streamUrl: `/stream/${fileId}`, title: `Song ${fileId}`, duration: 200, albumId: 1 }) as Track;
const kept = (fileId: number, bytes = 100, usedAt = 1) => ({ url: `/stream/${fileId}`, bytes, usedAt });
const download = (key: string, ...ids: number[]) => ({ key, title: key, href: `/${key}`, tracks: ids.map((id) => track(id)), addedAt: 1 });
const keys = (record: unknown) => Object.keys(record as object);

/** Time passes: the lock comes, writes are written (half a second after a change), other tabs hear of them. */
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const openTab = () => open(locks);
const keep = (tab: Tab, t: Track) => tab.offline.keepSong(t, { signal: new AbortController().signal, protect: new Set() });

let cache: ReturnType<typeof fakeAudioCache>;
let locks: FakeLocks;

beforeEach(() => {
  vi.useFakeTimers();
  resetIdb();
  localStorage.clear();
  cache = fakeAudioCache();
  locks = new FakeLocks();
  vi.stubGlobal('indexedDB', {});
  vi.stubGlobal('caches', cache.caches);
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array(100), { headers: { 'Content-Length': '100' } }));
  // A secure page, where songs can be kept (canKeepOffline).
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeChannel.open.clear();
  Reflect.deleteProperty(window, 'isSecureContext');
  Reflect.deleteProperty(navigator, 'locks');
});

describe('a full disk', () => {
  it('keeps every song and download, writes nothing over the record, and saves it all with the next change', async () => {
    cache.keep('/stream/1', 100);
    cache.keep('/stream/2', 100);
    idb.data.set('playarr.offline.songs', { 1: kept(1), 2: kept(2) });
    idb.data.set('playarr.offline.pins', { 'album:7': download('album:7', 1) });
    idb.data.set('playarr.offline.limit', 1000);
    const tab = await openTab();
    await tab.offline.hydrateOffline();
    const before = structuredClone(Object.fromEntries(idb.data));

    idb.failWrites = quotaError();
    // A song downloads, an album is downloaded, a song plays: none of it can be written.
    expect(await keep(tab, track(3))).toBe(true);
    tab.offline.addDownload(download('album:8', 3));
    tab.offline.touchSong(2);
    await settle(2000);
    expect(console.warn).toHaveBeenCalledTimes(1);
    // Nothing is cleared, nothing deleted, and the record stays as it was.
    expect(keys(tab.offline.useOffline.getState().songs)).toEqual(['1', '2', '3']);
    expect(keys(tab.offline.useOffline.getState().pins)).toEqual(['album:7', 'album:8']);
    expect(cache.deleted).toEqual([]);
    expect(Object.fromEntries(idb.data)).toEqual(before);

    // Room again: the next change writes everything that waited.
    idb.failWrites = null;
    tab.offline.touchSong(1);
    await settle(1000);
    expect(keys(idb.data.get('playarr.offline.songs'))).toEqual(['1', '2', '3']);
    expect(keys(idb.data.get('playarr.offline.pins'))).toEqual(['album:7', 'album:8']);
    // And the page opened again finds it all, deleting nothing.
    tab.close();
    const reloaded = await openTab();
    expect(reloaded.tabs.isLeader()).toBe(true);
    await reloaded.offline.hydrateOffline();
    await reloaded.offline.reconcileOffline();
    expect(keys(reloaded.offline.useOffline.getState().songs)).toEqual(['1', '2', '3']);
    expect(cache.deleted).toEqual([]);
  });

  it('keeps the queue in memory, and writes it whole with the next change', async () => {
    const tab = await openTab();
    await tab.playerRecord.hydratePlayer();
    idb.failWrites = quotaError();
    tab.store.usePlayer.getState().playTracks([track(1), track(2), track(3)], 1);
    await settle(2000);
    expect(tab.store.usePlayer.getState().queue).toHaveLength(3);
    expect(idb.data.has('playarr.player.queue')).toBe(false);

    idb.failWrites = null;
    tab.store.usePlayer.getState().setResumeAt(42);
    await settle(1000);
    expect(expandQueue(idb.data.get('playarr.player.queue'))?.map((t) => t.fileId)).toEqual([1, 2, 3]);
    expect(idb.data.get('playarr.player')).toMatchObject({ order: [0, 1, 2], pos: 1 });
    expect(idb.data.get('playarr.player.resumeAt')).toBe(42);
  });
});

describe('two tabs', () => {
  it('never lose each other’s songs or downloads, and only the leader deletes audio', async () => {
    cache.keep('/stream/1', 100);
    idb.data.set('playarr.offline.songs', { 1: kept(1) });
    idb.data.set('playarr.offline.limit', 5000);
    const a = await openTab();
    const b = await openTab();
    await Promise.all([a.offline.hydrateOffline(), b.offline.hydrateOffline()]);
    expect([a.tabs.isLeader(), b.tabs.isLeader()]).toEqual([true, false]);

    // A keeps songs as it plays, while B, which read the record before, downloads an album: neither knows of the
    // other's change when it writes its own.
    expect(await keep(a, track(2))).toBe(true);
    b.offline.addDownload(download('album:9', 1, 3));
    expect(await keep(a, track(4))).toBe(true);
    await settle(1000);
    expect(keys(idb.data.get('playarr.offline.songs'))).toEqual(['1', '2', '4']);
    expect(keys(idb.data.get('playarr.offline.pins'))).toEqual(['album:9']);
    // Each tab follows the other's.
    expect(keys(b.offline.useOffline.getState().songs)).toEqual(['1', '2', '4']);
    expect(keys(a.offline.useOffline.getState().pins)).toEqual(['album:9']);

    // The leader's reconcile finds every file known: nothing goes.
    await a.offline.reconcileOffline();
    expect(cache.deleted).toEqual([]);

    // B turns keeping-as-you-listen off: it deletes nothing itself…
    await b.offline.setOfflineLimit(0);
    expect(cache.deleted).toEqual([]);
    // …the leader lets the songs go that no download has, on the record as it is now.
    await settle(2000);
    expect(cache.deleted.sort()).toEqual(['/stream/2', '/stream/4']);
    expect(keys(idb.data.get('playarr.offline.songs'))).toEqual(['1']);
    expect(keys(a.offline.useOffline.getState().songs)).toEqual(['1']);
    expect(keys(b.offline.useOffline.getState().songs)).toEqual(['1']);

    // Remove all, pressed in B: the leader deletes the audio.
    await b.offline.clearOffline();
    expect(cache.deleted).not.toContain('*');
    await settle(1000);
    expect(cache.deleted).toContain('*');
    expect(a.offline.useOffline.getState().songs).toEqual({});
    expect(idb.data.get('playarr.offline.pins')).toEqual({});
  });
});

describe('two tabs changing the downloads at the same moment', () => {
  it('keep both changes: each is made on the record as stored when it’s written', async () => {
    idb.data.set('playarr.offline.pins', { 'album:1': download('album:1', 1), 'album:2': download('album:2', 2) });
    const a = await openTab();
    const b = await openTab();
    await Promise.all([a.offline.hydrateOffline(), b.offline.hydrateOffline()]);
    // Neither has heard of the other's change when it writes its own.
    a.offline.addDownload(download('album:3', 3));
    await b.offline.removeDownload('album:1');
    b.offline.addDownload(download('album:4', 4));
    await settle(2000);
    expect(keys(idb.data.get('playarr.offline.pins'))).toEqual(['album:2', 'album:3', 'album:4']);
    expect(keys(a.offline.useOffline.getState().pins)).toEqual(['album:2', 'album:3', 'album:4']);
    expect(keys(b.offline.useOffline.getState().pins)).toEqual(['album:2', 'album:3', 'album:4']);
  });
});

describe('reconciling with the audio cache', () => {
  it('adopts audio the record doesn’t know, as kept as you listen, and forgets songs whose audio is gone', async () => {
    cache.keep('/stream/1', 100);
    cache.keep('/stream/5', 500, 'Tue, 03 Nov 2026 09:00:00 GMT');
    cache.keep('/stream/6/aac?kbps=128', 300, 'Wed, 04 Nov 2026 09:00:00 GMT');
    cache.keep('/transitions/4-5.flac', 50, 'Wed, 04 Nov 2026 09:00:00 GMT');
    // Song 9's audio was cleared by the browser.
    idb.data.set('playarr.offline.songs', { 1: kept(1), 9: kept(9) });
    idb.data.set('playarr.offline.pins', { 'album:6': download('album:6', 6) });
    const tab = await openTab();
    await tab.offline.hydrateOffline();
    await tab.offline.reconcileOffline();

    const { songs, pins } = tab.offline.useOffline.getState();
    expect(songs).toEqual({
      1: kept(1),
      5: { url: '/stream/5', bytes: 500, usedAt: Date.parse('Tue, 03 Nov 2026 09:00:00 GMT') },
      6: { url: '/stream/6/aac?kbps=128', bytes: 300, usedAt: Date.parse('Wed, 04 Nov 2026 09:00:00 GMT') },
      [tab.offline.transitionFileId('/transitions/4-5.flac')]: { url: '/transitions/4-5.flac', bytes: 50, usedAt: Date.parse('Wed, 04 Nov 2026 09:00:00 GMT') },
    });
    expect(cache.deleted).toEqual([]);
    // Kept as you listen, unless a download has it: song 6 is the album's again.
    const { inDownloads, rest } = tab.offline.splitKept(songs, pins);
    expect(keys(inDownloads)).toEqual(['6']);
    expect(rest[5]).toBeDefined();
    await settle(1000);
    expect(keys(idb.data.get('playarr.offline.songs'))).toHaveLength(4);
  });

  it('deletes nothing when the whole record is gone: every song comes back', async () => {
    for (const id of [1, 2, 3]) cache.keep(`/stream/${id}`, 400);
    const tab = await openTab();
    await tab.offline.hydrateOffline();
    await tab.offline.reconcileOffline();
    expect(keys(tab.offline.useOffline.getState().songs)).toEqual(['1', '2', '3']);
    expect(cache.deleted).toEqual([]);
  });

  it('lets a second copy of a song it keeps go, never the song', async () => {
    cache.keep('/stream/1', 100);
    cache.keep('/stream/1/aac?kbps=128', 40);
    idb.data.set('playarr.offline.songs', { 1: kept(1) });
    const tab = await openTab();
    await tab.offline.hydrateOffline();
    await tab.offline.reconcileOffline();
    expect(cache.deleted).toEqual(['/stream/1/aac?kbps=128']);
    expect(tab.offline.useOffline.getState().songs).toEqual({ 1: kept(1) });
  });
});

describe('before the record is read', () => {
  it('nothing deletes audio, and what was asked meanwhile is done on the record as read', async () => {
    for (const id of [1, 2, 3]) cache.keep(`/stream/${id}`, 400);
    idb.data.set('playarr.offline.songs', { 1: kept(1, 400), 2: kept(2, 400), 3: kept(3, 400) });
    idb.data.set('playarr.offline.pins', { 'album:7': download('album:7', 1, 2) });
    idb.data.set('playarr.offline.limit', 1000);
    const open = gateReads();
    const tab = await openTab();
    const hydrated = tab.offline.hydrateOffline();
    // Unread, the record here is empty: every file looks unknown, every song unpinned.
    const asked = [tab.offline.reconcileOffline(), tab.offline.fitLimit(), tab.offline.setOfflineLimit(0), keep(tab, track(4, 900))];
    await settle(5000);
    expect(tab.offline.useOffline.getState().hydrated).toBe(false);
    expect(cache.deleted).toEqual([]);

    open();
    await hydrated;
    const [, , , keptFour] = await Promise.all(asked);
    // Keeping songs as you listen is off now: song 3 goes, and song 4 isn't kept; the album's songs stay.
    expect(keptFour).toBe(false);
    expect(cache.deleted).toEqual(['/stream/3']);
    expect(keys(tab.offline.useOffline.getState().songs)).toEqual(['1', '2']);
    expect(tab.offline.useOffline.getState().limit).toBe(0);
  });

  it('does what was asked meanwhile on the record moved from localStorage, not on an empty one', async () => {
    for (const id of [1, 2, 3]) cache.keep(`/stream/${id}`, 400);
    const songs = { 1: kept(1, 400), 2: kept(2, 400), 3: kept(3, 400) };
    localStorage.setItem('playarr.offline', JSON.stringify({ state: { songs, pins: { 'album:7': download('album:7', 1, 2) }, limit: 1000 }, version: 1 }));
    const open = gateReads();
    const tab = await openTab();
    const hydrated = tab.offline.hydrateOffline();
    const lowered = tab.offline.setOfflineLimit(0);
    await settle(5000);
    expect(cache.deleted).toEqual([]);

    open();
    await hydrated;
    await lowered;
    expect(cache.deleted).toEqual(['/stream/3']);
    expect(keys(tab.offline.useOffline.getState().songs)).toEqual(['1', '2']);
  });

  it('a download added at once is added to the record as read, not over it', async () => {
    idb.data.set('playarr.offline.pins', { 'album:7': download('album:7', 1) });
    const open = gateReads();
    const tab = await openTab();
    const hydrated = tab.offline.hydrateOffline();
    tab.offline.addDownload(download('album:8', 2));
    open();
    await hydrated;
    expect(keys(tab.offline.useOffline.getState().pins)).toEqual(['album:7', 'album:8']);
    await settle(1000);
    expect(keys(idb.data.get('playarr.offline.pins'))).toEqual(['album:7', 'album:8']);
  });
});

describe('moving from localStorage', () => {
  const queue = [track(1), track(2), track(3)];
  const savedPlayer = {
    queue,
    order: [2, 0, 1],
    pos: 1,
    shuffle: true,
    repeat: 'all',
    volume: 0.4,
    muted: false,
    resumeAt: 73.5,
    source: { label: 'Mezzanine', href: '/albums/7' },
    mixMode: 'party',
  };
  const savedOffline = { songs: { 1: kept(1), 2: kept(2) }, pins: { 'album:7': download('album:7', 1, 2) }, limit: 512 * MB };

  beforeEach(() => {
    localStorage.setItem('playarr.player', JSON.stringify({ state: savedPlayer, version: 1 }));
    localStorage.setItem('playarr.offline', JSON.stringify({ state: savedOffline, version: 1 }));
    cache.keep('/stream/1', 100);
    cache.keep('/stream/2', 100);
  });

  it('keeps the songs, the downloads, the limit and the queue, and removes the old copies once written', async () => {
    const tab = await openTab();
    await Promise.all([tab.offline.hydrateOffline(), tab.playerRecord.hydratePlayer()]);
    expect(tab.offline.useOffline.getState()).toMatchObject(savedOffline);
    expect(tab.store.usePlayer.getState()).toMatchObject(savedPlayer);

    await settle(1000);
    expect(idb.data.get('playarr.offline.songs')).toEqual(savedOffline.songs);
    expect(idb.data.get('playarr.offline.pins')).toEqual(savedOffline.pins);
    expect(idb.data.get('playarr.offline.limit')).toBe(512 * MB);
    expect(expandQueue(idb.data.get('playarr.player.queue'))).toEqual(queue);
    expect(idb.data.get('playarr.player')).toMatchObject({ order: [2, 0, 1], pos: 1, shuffle: true, repeat: 'all', volume: 0.4, mixMode: 'party' });
    expect(idb.data.get('playarr.player.resumeAt')).toBe(73.5);
    expect(localStorage.getItem('playarr.offline')).toBeNull();
    expect(localStorage.getItem('playarr.player')).toBeNull();

    // From now on IndexedDB has it.
    tab.close();
    const next = await openTab();
    await Promise.all([next.offline.hydrateOffline(), next.playerRecord.hydratePlayer()]);
    expect(next.offline.useOffline.getState()).toMatchObject(savedOffline);
    expect(next.store.usePlayer.getState()).toMatchObject(savedPlayer);
  });

  it('keeps the old copies while IndexedDB can’t be written, and moves them on the next visit', async () => {
    idb.failWrites = quotaError();
    const tab = await openTab();
    await Promise.all([tab.offline.hydrateOffline(), tab.playerRecord.hydratePlayer()]);
    await settle(1000);
    expect(tab.offline.useOffline.getState()).toMatchObject(savedOffline);
    expect(tab.store.usePlayer.getState()).toMatchObject(savedPlayer);
    expect(localStorage.getItem('playarr.offline')).not.toBeNull();
    expect(localStorage.getItem('playarr.player')).not.toBeNull();

    idb.failWrites = null;
    tab.close();
    const next = await openTab();
    await Promise.all([next.offline.hydrateOffline(), next.playerRecord.hydratePlayer()]);
    await settle(1000);
    expect(next.offline.useOffline.getState()).toMatchObject(savedOffline);
    expect(expandQueue(idb.data.get('playarr.player.queue'))).toEqual(queue);
    expect(localStorage.getItem('playarr.offline')).toBeNull();
  });
});

describe('a tab that follows another', () => {
  it('doesn’t download or report plays; the leader does', async () => {
    const a = await openTab();
    const b = await openTab();
    await Promise.all([a.offline.hydrateOffline(), b.offline.hydrateOffline()]);
    expect(b.tabs.isLeader()).toBe(false);

    const fetched = vi.fn(async () => new Response(new Uint8Array(100), { headers: { 'Content-Length': '100' } }));
    vi.stubGlobal('fetch', fetched);
    expect(await keep(b, track(5))).toBe(false);
    expect(fetched).not.toHaveBeenCalled();
    expect(await keep(a, track(5))).toBe(true);
    expect(fetched).toHaveBeenCalledTimes(1);

    // A song heard for a minute in each tab: only the leader's is reported.
    for (const tab of [b, a]) {
      tab.tracker.playTracker.start(track(1));
      for (let s = 0; s <= 60; s += 0.25) tab.tracker.playTracker.tick(s);
      tab.tracker.playTracker.finish('changed');
    }
    expect(b.reported).not.toHaveBeenCalled();
    expect(a.reported).toHaveBeenCalledTimes(1);
    expect(a.reported.mock.calls[0]![0]).toMatchObject([{ trackId: 1, seconds: 60, skipped: false }]);
  });
});
