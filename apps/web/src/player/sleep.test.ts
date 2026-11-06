import { describe, expect, it } from 'vitest';
import { useToasts } from '../lib/toast';
import { useUI } from '../lib/ui';
import { fellAsleep, SLEEP_FADE_MS, sleepGain, sleepLabel, sleepsAtSongEnd, useSleep } from './sleep';

describe('sleep timer', () => {
  it('fades out over the last seconds, and says how long is left', () => {
    const now = 1_000_000;
    useSleep.setState({ endsAt: now + 10 * 60_000, endOfSong: false });
    expect(sleepGain(now)).toBe(1);
    expect(sleepGain(now + 10 * 60_000 - SLEEP_FADE_MS / 2)).toBeCloseTo(0.5);
    expect(sleepGain(now + 11 * 60_000)).toBe(0);
    expect(sleepLabel(now + 10 * 60_000, false, now)).toBe('10 min');
    expect(sleepLabel(now + 90 * 60_000, false, now)).toBe('1 h 30 min');
    expect(sleepLabel(now + 60 * 60_000, false, now)).toBe('1 h');
    expect(sleepLabel(null, true)).toBe('End of song');
    useSleep.getState().cancel();
    expect(sleepGain()).toBe(1);
  });

  it('stops once at the end of the song', () => {
    useSleep.getState().sleepAtEndOfSong();
    expect(sleepsAtSongEnd()).toBe(true);
    expect(sleepsAtSongEnd()).toBe(false);
  });
});

describe('the timer’s end', () => {
  it('says goodnight in Now Playing when it’s open, and with a toast when it isn’t', () => {
    useToasts.setState({ toasts: [] });
    useUI.setState({ nowPlayingOpen: true });
    fellAsleep();
    expect(useSleep.getState().sleptAt).not.toBeNull();
    expect(useToasts.getState().toasts).toEqual([]);
    useSleep.getState().wake();
    expect(useSleep.getState().sleptAt).toBeNull();
    useUI.setState({ nowPlayingOpen: false });
    fellAsleep();
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['Sleep timer: music stopped']);
  });

  it('forgets the last goodnight when a new timer is set', () => {
    fellAsleep();
    useSleep.getState().sleepIn(30);
    expect(useSleep.getState().sleptAt).toBeNull();
    fellAsleep();
    useSleep.getState().sleepAtEndOfSong();
    expect(useSleep.getState().sleptAt).toBeNull();
    useSleep.getState().cancel();
  });
});
