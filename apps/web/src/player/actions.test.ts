import type { Track } from '@playarr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNDO_MS, useToasts } from '../lib/toast';
import { queueTracks } from './actions';
import { usePlayer } from './store';

const track = (id: number, title = `Song ${id}`) =>
  ({ id, recordingId: `rec-${id}`, fileId: id, albumId: 1, artistId: 1, title, artistName: 'Massive Attack', albumTitle: 'Mezzanine', duration: 200, streamUrl: `/s/${id}` }) as Track;

const upcoming = () => {
  const s = usePlayer.getState();
  return s.order.slice(s.pos + 1).map((i) => s.queue[i]!.title);
};
const lastToast = () => useToasts.getState().toasts.at(-1)!;

beforeEach(() => {
  usePlayer.setState({ queue: [track(1), track(2)], order: [0, 1], pos: 0, playing: true });
  useToasts.setState({ toasts: [] });
});
afterEach(() => vi.useRealTimers());

describe('Play next and Add to queue', () => {
  it('names the song that plays next, and Undo takes it back out', () => {
    queueTracks([track(3, 'Teardrop')], 'next');
    expect(upcoming()).toEqual(['Teardrop', 'Song 2']);
    expect(lastToast().message).toBe('“Teardrop” plays next');
    expect(lastToast().action?.label).toBe('Undo');
    lastToast().action!.run();
    expect(upcoming()).toEqual(['Song 2']);
  });

  it('counts several songs added to the queue, and Undo takes them all back out', () => {
    queueTracks([track(3), track(4), track(5)], 'end');
    expect(lastToast().message).toBe('Added 3 songs to the queue');
    queueTracks([track(6), track(7)], 'next');
    expect(lastToast().message).toBe('2 songs play next');
    useToasts.getState().toasts[0]!.action!.run();
    expect(upcoming()).toEqual(['Song 6', 'Song 7', 'Song 2']);
  });

  it('doesn’t take the song playing back out, nor touch a queue that has been replaced since', () => {
    queueTracks([track(3, 'Teardrop')], 'next');
    const undo = lastToast().action!.run;
    usePlayer.getState().next();
    undo();
    expect(usePlayer.getState().queue[usePlayer.getState().order[usePlayer.getState().pos]!]!.title).toBe('Teardrop');
    usePlayer.getState().playTracks([track(8), track(9), track(10), track(11)]);
    undo();
    expect(usePlayer.getState().order).toEqual([0, 1, 2, 3]);
  });

  it('just plays when nothing is queued, with nothing to undo', () => {
    usePlayer.setState({ queue: [], order: [], pos: -1, playing: false });
    queueTracks([track(3, 'Teardrop')], 'end');
    expect(usePlayer.getState().playing).toBe(true);
    expect(lastToast().message).toBe('Playing “Teardrop”');
    expect(lastToast().action).toBeUndefined();
  });

  it('lets its Undo go after a while, but not while it’s held (pointed at or focused)', () => {
    vi.useFakeTimers();
    queueTracks([track(3, 'Teardrop')], 'next');
    const { id } = lastToast();
    useToasts.getState().hold(id, true);
    vi.advanceTimersByTime(UNDO_MS * 2);
    expect(useToasts.getState().toasts).toHaveLength(1);
    useToasts.getState().hold(id, false);
    vi.advanceTimersByTime(UNDO_MS);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});
