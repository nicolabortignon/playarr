import type { TransitionPlan } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { api, ApiError, type TransitionAnswer } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { useLevels } from './levels';
import { type KeptTransition, transitionFileId, transitionPair, useOffline } from './offline';
import { useSleep } from './sleep';
import { useClock, usePlayer } from './store';
import { readyTransition, refreshUpcomingTransition, useTransition, useUpcomingTransition } from './transitions';

/** How the player asks by default: the first fade length, and the queue as the album's (no source). */
const HOW = { fade: 6, albumQueue: true };

// Catalog ids and file ids differ, to tell which one goes where.
const song = (id: number) => ({ id, fileId: id + 100, recordingId: `rec-${id}`, title: `Song ${id}`, albumId: id, duration: 200, streamUrl: `/stream/${id + 100}` }) as Track;

const plan = (aStart = 170) =>
  ({ style: 'long', aStart, bStart: 8, length: 24, bResume: 32, switchAt: 12 }) as Partial<TransitionPlan> as TransitionPlan;
const pending = (aStart?: number): TransitionAnswer => ({ status: 'pending', plan: plan(aStart) });
const ready = (aStart?: number): TransitionAnswer => ({ status: 'ready', plan: plan(aStart), url: '/transitions/abc.flac' });
const unavailable: TransitionAnswer = { status: 'unavailable', reason: 'No mix map yet for the next song' };

/** Let answers arrive (the API is mocked, so a microtask is enough). */
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));

/** Play the current song on to `to` seconds, a second at a time: time passes and the engine moves the clock. */
async function playTo(to: number) {
  for (let t = useClock.getState().time; t < to; ) {
    const step = Math.min(1, to - t);
    t += step;
    await act(() => vi.advanceTimersByTimeAsync(step * 1000));
    act(() => useClock.setState({ time: t }));
  }
  await settle();
}

/** The clock jumps with no time passing: the seek slider dragged, or a new song's clock reset. */
async function jumpTo(time: number) {
  act(() => useClock.setState({ time }));
  await settle();
}

/** Wait this long without the song moving on (paused, say): only timers run. */
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

/** An ask whose answer the test gives by hand. */
function deferred() {
  let answer!: (a: TransitionAnswer) => void;
  transition.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
  return (a: TransitionAnswer) => answer(a);
}

/** A download that kept the transition from file `from` into file `to`, with its file on this device. */
function keep(from: number, to: number, mode: 'auto' | 'party', aStart: number): KeptTransition {
  const kept = { ...(ready(aStart) as KeptTransition), url: `/transitions/${from}-${to}.flac` };
  useOffline.setState({
    songs: { [transitionFileId(kept.url)]: { url: kept.url, bytes: 100, usedAt: 0 } },
    pins: { 'album:1': { key: 'album:1', title: 'Album', href: '/albums/1', tracks: [], addedAt: 0, transitions: { [transitionPair(from, to, mode)]: kept } } },
  });
  return kept;
}

const goOffline = () => vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

let transition: MockInstance<typeof api.transition>;

beforeEach(() => {
  vi.useFakeTimers();
  usePrefs.setState({ transitions: 'dj', crossfade: 0 });
  useSleep.getState().cancel();
  useOffline.setState({ songs: {}, pins: {} });
  useLevels.setState({ levels: {}, loaded: {} });
  usePlayer.setState({ repeat: 'off' });
  usePlayer.getState().playTracks([song(1), song(2), song(3)], 0, { shuffle: false });
  useClock.setState({ time: 0 });
  transition = vi.spyOn(api, 'transition').mockResolvedValue(pending());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('when it asks', () => {
  it('waits until the song has played 5 seconds, then asks for this song into the next', async () => {
    renderHook(() => useUpcomingTransition());
    expect(useTransition.getState()).toMatchObject({ fromFileId: 101, toFileId: 102, result: null, ready: undefined });
    await playTo(4);
    expect(transition).not.toHaveBeenCalled();
    await playTo(5);
    // Catalog ids for the server, the mix mode of this queue, where the song is now, and the files the decks have.
    expect(transition).toHaveBeenCalledExactlyOnceWith(1, 2, 'auto', 5, { fromFileId: 101, toFileId: 102 }, HOW);
    expect(useTransition.getState().result).toEqual(pending());
  });

  it('never asks when the song is paused before 5 seconds', async () => {
    renderHook(() => useUpcomingTransition());
    await playTo(3);
    act(() => usePlayer.getState().setPlaying(false));
    await wait(60_000);
    expect(transition).not.toHaveBeenCalled();
  });

  it('counts only time played: a jump forward gives no credit', async () => {
    renderHook(() => useUpcomingTransition());
    await jumpTo(90);
    expect(transition).not.toHaveBeenCalled();
    await playTo(94);
    expect(transition).not.toHaveBeenCalled();
    await playTo(95);
    expect(transition).toHaveBeenCalledExactlyOnceWith(1, 2, 'auto', 95, { fromFileId: 101, toFileId: 102 }, HOW);
  });

  it('gives no credit for a seek backwards', async () => {
    renderHook(() => useUpcomingTransition());
    await playTo(4);
    act(() => useClock.getState().seek(1));
    await playTo(1.5);
    expect(transition).not.toHaveBeenCalled();
    await playTo(2);
    expect(transition).toHaveBeenCalledExactlyOnceWith(1, 2, 'auto', 2, { fromFileId: 101, toFileId: 102 }, HOW);
  });

  it('counts the clock’s long steps while the phone is locked, as long as that much time passed', async () => {
    renderHook(() => useUpcomingTransition());
    await wait(4000);
    await jumpTo(4);
    await wait(2000);
    await jumpTo(6);
    expect(transition).toHaveBeenCalledExactlyOnceWith(1, 2, 'auto', 6, { fromFileId: 101, toFileId: 102 }, HOW);
  });

  it('starts counting again when the song restarts', async () => {
    renderHook(() => useUpcomingTransition());
    await playTo(4);
    act(() => usePlayer.getState().prev(4));
    await jumpTo(0);
    await playTo(4);
    expect(transition).not.toHaveBeenCalled();
    await playTo(5);
    expect(transition).toHaveBeenCalledExactlyOnceWith(1, 2, 'auto', 5, { fromFileId: 101, toFileId: 102 }, HOW);
  });

  it('asks nothing unless transitions are DJ mix', async () => {
    usePrefs.setState({ transitions: 'crossfade' });
    renderHook(() => useUpcomingTransition());
    await playTo(10);
    expect(transition).not.toHaveBeenCalled();
    expect(useTransition.getState()).toMatchObject({ fromFileId: null, toFileId: null, result: null });
  });

  it('asks nothing when this queue isn’t mixed: no pair, so the songs follow each other as usual', async () => {
    usePlayer.getState().setMixMode('off');
    renderHook(() => useUpcomingTransition());
    await playTo(10);
    expect(transition).not.toHaveBeenCalled();
    expect(useTransition.getState()).toMatchObject({ fromFileId: null, toFileId: null, result: null });
  });

  it('asks nothing after the last song', async () => {
    usePlayer.getState().jumpTo(2);
    renderHook(() => useUpcomingTransition());
    await playTo(10);
    expect(transition).not.toHaveBeenCalled();
  });

  it('asks nothing with repeat-one, and wraps to the first song with repeat-all', async () => {
    usePlayer.setState({ repeat: 'one' });
    usePlayer.getState().jumpTo(2);
    renderHook(() => useUpcomingTransition());
    await playTo(10);
    expect(transition).not.toHaveBeenCalled();
    act(() => usePlayer.setState({ repeat: 'all' }));
    expect(useTransition.getState()).toMatchObject({ fromFileId: 103, toFileId: 101 });
    await playTo(12);
    // A new pair asks after a moment, from where the song is then.
    expect(transition).toHaveBeenCalledExactlyOnceWith(3, 1, 'auto', 11, { fromFileId: 103, toFileId: 101 }, HOW);
  });

  it('asks nothing while the sleep timer stops at the end of this song', async () => {
    useSleep.getState().sleepAtEndOfSong();
    renderHook(() => useUpcomingTransition());
    await playTo(10);
    expect(transition).not.toHaveBeenCalled();
    act(() => useSleep.getState().cancel());
    await playTo(12);
    expect(transition).toHaveBeenCalledExactlyOnceWith(1, 2, 'auto', 11, { fromFileId: 101, toFileId: 102 }, HOW);
  });

  it('asks nothing offline, and asks once back online', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderHook(() => useUpcomingTransition());
    await playTo(10);
    expect(transition).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event('online')));
    await settle();
    expect(transition).toHaveBeenCalledExactlyOnceWith(1, 2, 'auto', 10, { fromFileId: 101, toFileId: 102 }, HOW);
  });
});

describe('the pair', () => {
  it('follows the queue: a new next song drops the old answer and asks again after a moment', async () => {
    renderHook(() => useUpcomingTransition());
    await playTo(6);
    expect(useTransition.getState().result?.status).toBe('pending');
    act(() => usePlayer.getState().playNext([song(9)]));
    expect(useTransition.getState()).toMatchObject({ fromFileId: 101, toFileId: 109, result: null });
    await settle();
    expect(transition).toHaveBeenCalledTimes(1);
    await playTo(8);
    // The song has played long enough already: 2 seconds later, from where it is then.
    expect(transition).toHaveBeenLastCalledWith(1, 9, 'auto', 7, { fromFileId: 101, toFileId: 109 }, HOW);
  });

  it('asks for one pair only when the next song is changed again and again', async () => {
    renderHook(() => useUpcomingTransition());
    await playTo(10);
    transition.mockClear();
    for (const id of [7, 8, 9]) {
      act(() => usePlayer.getState().playNext([song(id)]));
      await wait(500);
    }
    await wait(2000);
    expect(transition).toHaveBeenCalledExactlyOnceWith(1, 9, 'auto', 10, { fromFileId: 101, toFileId: 109 }, HOW);
  });

  it('starts over on the next song, with 5 seconds to play first', async () => {
    renderHook(() => useUpcomingTransition());
    await playTo(6);
    act(() => usePlayer.getState().next());
    await jumpTo(0);
    expect(useTransition.getState()).toMatchObject({ fromFileId: 102, toFileId: 103, result: null });
    transition.mockClear();
    await playTo(4);
    expect(transition).not.toHaveBeenCalled();
    await playTo(5);
    expect(transition).toHaveBeenCalledExactlyOnceWith(2, 3, 'auto', 5, { fromFileId: 102, toFileId: 103 }, HOW);
  });

  it('asks again when the mix mode changes', async () => {
    renderHook(() => useUpcomingTransition());
    await playTo(6);
    act(() => usePlayer.getState().setMixMode('party'));
    expect(useTransition.getState().result).toBeNull();
    await playTo(8);
    expect(transition).toHaveBeenLastCalledWith(1, 2, 'party', 7, { fromFileId: 101, toFileId: 102 }, HOW);
  });

  it('asks with the listener’s fade length, and again when it changes', async () => {
    renderHook(() => useUpcomingTransition());
    await playTo(6);
    act(() => usePrefs.getState().setCrossfade(12));
    expect(useTransition.getState().result).toBeNull();
    await playTo(8);
    expect(transition).toHaveBeenLastCalledWith(1, 2, 'auto', 7, { fromFileId: 101, toFileId: 102 }, { fade: 12, albumQueue: true });
  });

  it('asks at the levels the songs play at, and again once a level is learned', async () => {
    renderHook(() => useUpcomingTransition());
    await playTo(6);
    expect(transition).toHaveBeenLastCalledWith(1, 2, 'auto', 5, { fromFileId: 101, toFileId: 102 }, HOW);
    // The next song's level learned: it'll play its levelled stream, so the transition is made at that level.
    act(() => useLevels.setState((s) => ({ levels: { ...s.levels, 'rec-2': { track: -4.5 } } })));
    expect(useTransition.getState().result).toBeNull();
    await playTo(8);
    expect(transition).toHaveBeenLastCalledWith(1, 2, 'auto', 7, { fromFileId: 101, toFileId: 102 }, { ...HOW, levels: { a: 0, b: -4.5 } });
    // The song playing was started on its own file before its level came: the transition takes it as it plays.
    act(() => {
      useLevels.getState().loaded[101] = null;
      useLevels.setState((s) => ({ levels: { ...s.levels, 'rec-1': { track: -3 } } }));
    });
    await playTo(10);
    expect(transition).toHaveBeenLastCalledWith(1, 2, 'auto', 7, { fromFileId: 101, toFileId: 102 }, { ...HOW, levels: { a: 0, b: -4.5 } });
  });

  it('says when the queue doesn’t play the songs’ album (a playlist)', async () => {
    act(() => usePlayer.getState().playTracks([song(1), song(2)], 0, { shuffle: false, source: { label: 'Mine', href: '/playlists/7' } }));
    renderHook(() => useUpcomingTransition());
    await playTo(6);
    expect(transition).toHaveBeenLastCalledWith(1, 2, 'auto', 5, { fromFileId: 101, toFileId: 102 }, { fade: 6, albumQueue: false });
  });

  it('ignores an answer that arrives after the pair changed', async () => {
    const answer = deferred();
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    act(() => usePlayer.getState().playNext([song(9)]));
    await playTo(8);
    answer(ready());
    await settle();
    expect(useTransition.getState()).toMatchObject({ toFileId: 109, result: pending(), ready: undefined });
  });

  it('stops asking when transitions are switched away from DJ mix', async () => {
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    act(() => usePrefs.setState({ transitions: 'crossfade' }));
    expect(useTransition.getState()).toMatchObject({ fromFileId: null, toFileId: null, result: null });
    await wait(30_000);
    expect(transition).toHaveBeenCalledTimes(1);
  });

  it('stops everything when unmounted', async () => {
    const { unmount } = renderHook(() => useUpcomingTransition());
    await playTo(5);
    unmount();
    expect(useTransition.getState()).toMatchObject({ fromFileId: null, toFileId: null, result: null, ready: undefined });
    await wait(30_000);
    expect(transition).toHaveBeenCalledTimes(1);
  });
});

describe('polling', () => {
  it('asks every 3 seconds while the server renders, with the same position, and stops once it is ready', async () => {
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    expect(transition).toHaveBeenCalledTimes(1);
    await playTo(7);
    expect(transition).toHaveBeenCalledTimes(1);
    await playTo(8);
    expect(transition).toHaveBeenCalledTimes(2);
    transition.mockResolvedValue(ready());
    await playTo(11);
    expect(transition).toHaveBeenCalledTimes(3);
    // The plan starts from where the song was at the first ask: asking from a later point could
    // change the plan and start its render over.
    for (const call of transition.mock.calls) expect(call).toEqual([1, 2, 'auto', 5, { fromFileId: 101, toFileId: 102 }, HOW]);
    expect(useTransition.getState().result).toEqual(ready());
    expect(readyTransition(useTransition.getState())).toEqual({ ...ready(), fromFileId: 101, toFileId: 102 });
    await playTo(30);
    await wait(30_000);
    expect(transition).toHaveBeenCalledTimes(3);
  });

  it('slows to every 10 seconds after 5 polls', async () => {
    renderHook(() => useUpcomingTransition());
    await playTo(17); // asks at 5, 8, 11, 14 and 17
    expect(transition).toHaveBeenCalledTimes(5);
    await playTo(26);
    expect(transition).toHaveBeenCalledTimes(5);
    await playTo(27);
    expect(transition).toHaveBeenCalledTimes(6);
    await playTo(37);
    expect(transition).toHaveBeenCalledTimes(7);
  });

  it('polls every 10 seconds while paused', async () => {
    renderHook(() => useUpcomingTransition());
    act(() => usePlayer.getState().setPlaying(false));
    await playTo(5);
    await wait(9000);
    expect(transition).toHaveBeenCalledTimes(1);
    await wait(1000);
    expect(transition).toHaveBeenCalledTimes(2);
  });

  it('keeps the ready answer the same object while other things change', async () => {
    transition.mockResolvedValue(ready());
    const { result } = renderHook(() => useTransition(readyTransition));
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    const first = result.current;
    expect(first?.url).toBe('/transitions/abc.flac');
    act(() => usePlayer.getState().setVolume(0.5));
    await playTo(20);
    expect(result.current).toBe(first);
    expect(readyTransition(useTransition.getState())).toBe(first);
  });
});

describe('giving up and starting over', () => {
  it('gives up on the pair when the song comes within 20 seconds of the mix point', async () => {
    transition.mockResolvedValue(pending(40));
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    await playTo(19.5);
    expect(useTransition.getState().result?.status).toBe('pending');
    await playTo(20);
    expect(useTransition.getState().result).toEqual({ status: 'gave up' });
    const asked = transition.mock.calls.length;
    transition.mockResolvedValue(ready(40));
    await playTo(35);
    await wait(10_000);
    expect(transition).toHaveBeenCalledTimes(asked);
    expect(readyTransition(useTransition.getState())).toBeUndefined();
  });

  it('ignores a ready answer that arrives after giving up', async () => {
    transition.mockResolvedValue(pending(30));
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    const answer = deferred();
    await playTo(8);
    await playTo(10);
    expect(useTransition.getState().result).toEqual({ status: 'gave up' });
    answer(ready(30));
    await settle();
    expect(useTransition.getState()).toMatchObject({ result: { status: 'gave up' }, ready: undefined });
  });

  it('treats a ready answer too close to its mix point as given up', async () => {
    transition.mockResolvedValue(ready(20));
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    expect(useTransition.getState()).toMatchObject({ result: { status: 'gave up' }, ready: undefined });
  });

  it('keeps a ready transition through a seek that stays before its mix point', async () => {
    transition.mockResolvedValue(ready(170));
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    const first = useTransition.getState().ready;
    act(() => useClock.getState().seek(100));
    await settle();
    // Into the song's outro, closer than the 20 seconds a file not yet ready would need: the engine
    // has it loaded by now, so it still plays.
    act(() => useClock.getState().seek(160));
    await settle();
    expect(transition).toHaveBeenCalledTimes(1);
    expect(useTransition.getState().ready).toBe(first);
  });

  it('keeps a ready transition as it takes over from the song, the clock stepping a little back without a seek', async () => {
    transition.mockResolvedValue(ready(170));
    renderHook(() => useUpcomingTransition());
    await playTo(169.5);
    const first = useTransition.getState().ready;
    // The clock follows the transition's file now, a few milliseconds behind A's own time.
    await jumpTo(169.46);
    await playTo(172);
    expect(useTransition.getState().ready).toBe(first);
    expect(transition).toHaveBeenCalledTimes(1);
  });

  it('starts over from the new position after a seek past the mix point', async () => {
    transition.mockResolvedValue(ready(170));
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    act(() => useClock.getState().seek(175));
    expect(useTransition.getState()).toMatchObject({ result: null, ready: undefined });
    await settle();
    // Asked again from there; a new render that late is too late for this song.
    expect(transition).toHaveBeenLastCalledWith(1, 2, 'auto', 175, { fromFileId: 101, toFileId: 102 }, HOW);
    expect(useTransition.getState().result).toEqual({ status: 'gave up' });

    // From the start again, it asks again once the song has played 5 seconds.
    transition.mockClear();
    act(() => usePlayer.getState().prev(176));
    await jumpTo(0);
    expect(useTransition.getState().result).toBeNull();
    await playTo(4);
    expect(transition).not.toHaveBeenCalled();
    await playTo(5);
    expect(transition).toHaveBeenCalledExactlyOnceWith(1, 2, 'auto', 5, { fromFileId: 101, toFileId: 102 }, HOW);
    expect(useTransition.getState().ready?.plan.aStart).toBe(170);
  });

  it('asks again after giving up when the song restarts', async () => {
    transition.mockResolvedValue(pending(40));
    renderHook(() => useUpcomingTransition());
    await playTo(20);
    expect(useTransition.getState().result).toEqual({ status: 'gave up' });
    transition.mockClear();
    act(() => usePlayer.getState().prev(25));
    await jumpTo(0);
    expect(useTransition.getState().result).toBeNull();
    await playTo(4);
    expect(transition).not.toHaveBeenCalled();
    await playTo(5);
    expect(transition).toHaveBeenCalledExactlyOnceWith(1, 2, 'auto', 5, { fromFileId: 101, toFileId: 102 }, HOW);
  });
});

describe('errors', () => {
  it('tries again after a server error or a lost connection, then takes the answer', async () => {
    transition
      .mockRejectedValueOnce(new ApiError('Service unavailable', 503))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(ready());
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    expect(useTransition.getState().result).toBeNull();
    await playTo(8);
    expect(transition).toHaveBeenCalledTimes(2);
    await playTo(17);
    expect(transition).toHaveBeenCalledTimes(2);
    await playTo(18);
    expect(transition).toHaveBeenCalledTimes(3);
    expect(useTransition.getState().ready?.url).toBe('/transitions/abc.flac');
    for (const call of transition.mock.calls) expect(call).toEqual([1, 2, 'auto', 5, { fromFileId: 101, toFileId: 102 }, HOW]);
  });

  it('gives up at once when the server refuses', async () => {
    transition.mockRejectedValue(new ApiError('Not found', 404));
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    expect(useTransition.getState().result).toEqual({ status: 'gave up' });
    await playTo(60);
    expect(transition).toHaveBeenCalledTimes(1);
  });

  it('asks again once back online when the connection drops mid-ask', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    transition.mockImplementationOnce(() => {
      online.mockReturnValue(false);
      return Promise.reject(new TypeError('Failed to fetch'));
    });
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    await playTo(30);
    expect(transition).toHaveBeenCalledTimes(1);
    expect(useTransition.getState().result).toBeNull();
    online.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event('online')));
    await settle();
    expect(transition).toHaveBeenCalledTimes(2);
    expect(transition).toHaveBeenLastCalledWith(1, 2, 'auto', 5, { fromFileId: 101, toFileId: 102 }, HOW);
  });

  it('asks once more a minute after “unavailable” (the song may have been analyzed since), then keeps it', async () => {
    transition.mockResolvedValue(unavailable);
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    expect(useTransition.getState().result).toEqual(unavailable);
    await playTo(64);
    expect(transition).toHaveBeenCalledTimes(1);
    await playTo(65);
    expect(transition).toHaveBeenCalledTimes(2);
    await playTo(150);
    expect(transition).toHaveBeenCalledTimes(2);
    expect(useTransition.getState().result).toEqual(unavailable);
  });

  it('keeps a straight answer without asking again', async () => {
    transition.mockResolvedValue({ status: 'straight', plan: plan() });
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    await playTo(100);
    expect(transition).toHaveBeenCalledTimes(1);
    expect(useTransition.getState().result?.status).toBe('straight');
  });
});

describe('transitions kept with downloads', () => {
  it('plays a kept transition offline, without asking', async () => {
    goOffline();
    const kept = keep(101, 102, 'auto', 170);
    renderHook(() => useUpcomingTransition());
    expect(useTransition.getState()).toMatchObject({ result: kept, ready: { ...kept, fromFileId: 101, toFileId: 102 } });
    await playTo(30);
    expect(transition).not.toHaveBeenCalled();
  });

  it('has nothing offline when no download kept the pair', async () => {
    goOffline();
    keep(102, 103, 'auto', 170);
    renderHook(() => useUpcomingTransition());
    await playTo(30);
    expect(transition).not.toHaveBeenCalled();
    expect(useTransition.getState()).toMatchObject({ result: null, ready: undefined });
  });

  it('plays the kept Auto transition offline when the queue is in Party mode: better than none', async () => {
    goOffline();
    usePlayer.getState().setMixMode('party');
    const kept = keep(101, 102, 'auto', 170);
    renderHook(() => useUpcomingTransition());
    expect(useTransition.getState().ready?.url).toBe(kept.url);
  });

  it('gives up on a kept transition the song is already too close to', async () => {
    goOffline();
    keep(101, 102, 'auto', 30);
    useClock.setState({ time: 15 });
    renderHook(() => useUpcomingTransition());
    expect(useTransition.getState()).toMatchObject({ result: { status: 'gave up' }, ready: undefined });
  });

  it('picks up the kept transition when the connection drops while the server renders', async () => {
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    expect(useTransition.getState().result?.status).toBe('pending');
    const kept = keep(101, 102, 'auto', 170);
    goOffline();
    act(() => window.dispatchEvent(new Event('offline')));
    expect(useTransition.getState().ready?.url).toBe(kept.url);
    await wait(30_000);
    expect(transition).toHaveBeenCalledTimes(1);
  });

  it('online, plays a kept transition still ahead at once, and asks the server for the rest', async () => {
    const kept = keep(101, 102, 'auto', 170);
    renderHook(() => useUpcomingTransition());
    expect(useTransition.getState().ready?.url).toBe(kept.url);
    await playTo(30);
    expect(transition).not.toHaveBeenCalled();
    // Seeking past its mix point: the server plans one from there.
    act(() => useClock.getState().seek(175));
    await settle();
    expect(transition).toHaveBeenCalledExactlyOnceWith(1, 2, 'auto', 175, { fromFileId: 101, toFileId: 102 }, HOW);
  });

  it('online, asks the server for Party rather than using the kept Auto transition', async () => {
    usePlayer.getState().setMixMode('party');
    keep(101, 102, 'auto', 170);
    renderHook(() => useUpcomingTransition());
    expect(useTransition.getState().ready).toBeUndefined();
    await playTo(5);
    expect(transition).toHaveBeenCalledExactlyOnceWith(1, 2, 'party', 5, { fromFileId: 101, toFileId: 102 }, HOW);
  });
});

describe('mix points edited by hand', () => {
  it('drops the ready transition when either song’s mix points change, and asks afresh after a moment', async () => {
    transition.mockResolvedValue(ready());
    renderHook(() => useUpcomingTransition());
    await playTo(6);
    expect(useTransition.getState().ready).toBeDefined();
    // The server forgot its file: keeping the answer would play a missing file.
    act(() => refreshUpcomingTransition('rec-2'));
    expect(useTransition.getState()).toMatchObject({ fromFileId: 101, toFileId: 102, result: null, ready: undefined });
    await wait(1999);
    expect(transition).toHaveBeenCalledTimes(1);
    await wait(1);
    expect(transition).toHaveBeenCalledTimes(2);
    expect(transition).toHaveBeenLastCalledWith(1, 2, 'auto', 6, { fromFileId: 101, toFileId: 102 }, HOW);
    expect(useTransition.getState().ready).toBeDefined();
  });

  it('stops polling the old render, for the song playing too', async () => {
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    expect(transition).toHaveBeenCalledTimes(1);
    act(() => refreshUpcomingTransition('rec-1'));
    // The poll due 3 seconds after the first answer doesn't come; the fresh ask 2 seconds on does.
    await wait(2000);
    expect(transition).toHaveBeenCalledTimes(2);
    await wait(1000);
    expect(transition).toHaveBeenCalledTimes(2);
  });

  it('keeps the transition when another song’s mix points change', async () => {
    transition.mockResolvedValue(ready());
    renderHook(() => useUpcomingTransition());
    await playTo(6);
    const kept = useTransition.getState().ready;
    act(() => refreshUpcomingTransition('rec-3'));
    expect(useTransition.getState().ready).toBe(kept);
    await wait(60_000);
    expect(transition).toHaveBeenCalledTimes(1);
  });
});
