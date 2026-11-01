import type { TransitionPlan } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { api, type TransitionAnswer } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { useClock, usePlayer } from './store';
import { readyTransition, useTransition, useUpcomingTransition } from './transitions';

// Catalog ids and file ids differ, to tell which one goes where.
const song = (id: number) => ({ id, fileId: id + 100, recordingId: `rec-${id}`, title: `Song ${id}`, albumId: id, duration: 200 }) as Track;

const plan = (aStart = 170) => ({ style: 'long', aStart, bStart: 8, length: 24, bResume: 32, switchAt: 12 }) as Partial<TransitionPlan> as TransitionPlan;
const pending = (aStart?: number): TransitionAnswer => ({ status: 'pending', plan: plan(aStart) });
const ready = (aStart?: number): TransitionAnswer => ({ status: 'ready', plan: plan(aStart), url: '/transitions/abc.flac' });

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

/** Wait this long without the song moving on (paused, say): only timers run. */
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

let transition: MockInstance<typeof api.transition>;

beforeEach(() => {
  vi.useFakeTimers();
  usePrefs.setState({ transitions: 'dj' });
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

describe('the upcoming transition', () => {
  it('waits until the song has played 5 seconds, then asks for this song into the next', async () => {
    renderHook(() => useUpcomingTransition());
    expect(useTransition.getState()).toMatchObject({ fromFileId: 101, toFileId: 102, result: null });
    await playTo(4);
    expect(transition).not.toHaveBeenCalled();
    await playTo(5);
    // Catalog ids for the server, the mix mode of this queue, and where the song is now.
    expect(transition).toHaveBeenCalledExactlyOnceWith(1, 2, 'auto', 5);
    expect(useTransition.getState().result).toEqual(pending());
  });

  it('counts only time played, not a jump: a song skipped to its middle still has to play 5 seconds', async () => {
    renderHook(() => useUpcomingTransition());
    act(() => useClock.setState({ time: 90 }));
    await settle();
    expect(transition).not.toHaveBeenCalled();
    await playTo(95);
    expect(transition).toHaveBeenCalledExactlyOnceWith(1, 2, 'auto', 95);
  });

  it('follows the queue: a new next song drops the old answer and asks again', async () => {
    renderHook(() => useUpcomingTransition());
    await playTo(6);
    expect(useTransition.getState().result?.status).toBe('pending');

    act(() => usePlayer.getState().playNext([song(9)]));
    expect(useTransition.getState()).toMatchObject({ fromFileId: 101, toFileId: 109 });
    await settle();
    // The song has played long enough already: it asks right away, from where it is now.
    expect(transition).toHaveBeenLastCalledWith(1, 9, 'auto', 6);

    // Skipping on: a new pair, and the 5 seconds start over.
    act(() => usePlayer.getState().next());
    act(() => useClock.setState({ time: 0 }));
    expect(useTransition.getState()).toMatchObject({ fromFileId: 109, toFileId: 102, result: null });
    transition.mockClear();
    await playTo(4);
    expect(transition).not.toHaveBeenCalled();
    await playTo(5);
    expect(transition).toHaveBeenCalledExactlyOnceWith(9, 2, 'auto', 5);
  });

  it('asks again when the mix mode changes', async () => {
    renderHook(() => useUpcomingTransition());
    await playTo(6);
    act(() => usePlayer.getState().setMixMode('party'));
    expect(useTransition.getState().result).toBeNull();
    await settle();
    expect(transition).toHaveBeenLastCalledWith(1, 2, 'party', 6);
  });

  it('ignores an answer that arrives after the pair changed', async () => {
    let answer!: (a: TransitionAnswer) => void;
    transition.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    act(() => usePlayer.getState().playNext([song(9)]));
    await settle();
    answer(ready());
    await settle();
    expect(useTransition.getState()).toMatchObject({ toFileId: 109, result: pending() });
  });

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
    for (const call of transition.mock.calls) expect(call).toEqual([1, 2, 'auto', 5]);
    expect(useTransition.getState().result).toEqual(ready());
    expect(readyTransition(useTransition.getState())).toEqual({ ...ready(), fromFileId: 101, toFileId: 102 });
    await playTo(30);
    await wait(30_000);
    expect(transition).toHaveBeenCalledTimes(3);
  });

  it('keeps polling while paused, on timers alone', async () => {
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    await wait(3000);
    await wait(3000);
    expect(transition).toHaveBeenCalledTimes(3);
  });

  it('gives up on the pair when the song comes within 20 seconds of the mix point', async () => {
    transition.mockResolvedValue(pending(40));
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    expect(readyTransition(useTransition.getState())).toBeUndefined();
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

  it('gives up when the server can’t be asked', async () => {
    transition.mockRejectedValue(new Error('Cannot reach the Playarr server'));
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    expect(useTransition.getState().result).toEqual({ status: 'gave up' });
    await wait(10_000);
    expect(transition).toHaveBeenCalledTimes(1);
  });

  it('keeps a straight or unavailable answer without asking again', async () => {
    transition.mockResolvedValue({ status: 'unavailable', reason: 'No mix map yet for the next song' });
    renderHook(() => useUpcomingTransition());
    await playTo(5);
    await wait(10_000);
    expect(transition).toHaveBeenCalledTimes(1);
    expect(useTransition.getState().result?.status).toBe('unavailable');
  });

  it('asks nothing unless transitions are DJ mix, there is a next song, and the device is online', async () => {
    usePrefs.setState({ transitions: 'crossfade' });
    renderHook(() => useUpcomingTransition());
    await playTo(10);
    expect(transition).not.toHaveBeenCalled();
    expect(useTransition.getState()).toMatchObject({ fromFileId: null, toFileId: null, result: null });

    act(() => usePlayer.getState().jumpTo(2)); // the last song: nothing after it
    act(() => usePrefs.setState({ transitions: 'dj' }));
    act(() => useClock.setState({ time: 0 }));
    await playTo(10);
    expect(transition).not.toHaveBeenCalled();

    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => usePlayer.getState().addToQueue([song(4)]));
    await playTo(20);
    expect(transition).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event('online')));
    await settle();
    expect(transition).toHaveBeenCalledExactlyOnceWith(3, 4, 'auto', 20);
  });
});
