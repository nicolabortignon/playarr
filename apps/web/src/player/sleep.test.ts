import { describe, expect, it } from 'vitest';
import { SLEEP_FADE_MS, sleepGain, sleepLabel, sleepsAtSongEnd, useSleep } from './sleep';

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
