import type { PlayReport, Track } from '@playarr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayTracker, sendWithRetry } from './playTracker';

const song = (duration = 240) => ({ id: 7, recordingId: 'rec-7', duration }) as Track;
/** Play from `from` to `to` seconds in quarter-second ticks, as timeupdate does. */
const listen = (t: PlayTracker, from: number, to: number) => {
  for (let s = from; s <= to; s += 0.25) t.tick(s);
};

afterEach(() => localStorage.clear());

describe('PlayTracker', () => {
  it('reports a song heard for 30 seconds as played, with the local hour and weekday', () => {
    const sent: PlayReport[] = [];
    const t = new PlayTracker((p) => sent.push(...p));
    const at = new Date(2026, 10, 1, 21, 15); // a Sunday, 9:15 PM here
    t.start(song(), at);
    listen(t, 0, 31);
    t.finish('changed');
    expect(sent).toEqual([{ trackId: 7, recordingId: 'rec-7', at: at.toISOString(), hour: 21, weekday: 0, seconds: 31, skipped: false }]);
  });

  it('counts only what was heard: seeking ahead is not listening', () => {
    const sent: PlayReport[] = [];
    const t = new PlayTracker((p) => sent.push(...p));
    t.start(song());
    listen(t, 0, 10);
    t.pause(); // seeking
    listen(t, 200, 205);
    t.finish('changed');
    expect(sent[0]).toMatchObject({ skipped: true, seconds: 15 });
  });

  it('a short song heard halfway is a play; leaving in the first seconds is nothing at all', () => {
    const sent: PlayReport[] = [];
    const t = new PlayTracker((p) => sent.push(...p));
    t.start(song(40));
    listen(t, 0, 21);
    t.finish('ended');
    t.start(song());
    listen(t, 0, 2);
    t.finish('changed');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.skipped).toBe(false);
  });

  it('closing the app mid-song is never a skip', () => {
    const sent: PlayReport[] = [];
    const t = new PlayTracker((p) => sent.push(...p));
    t.start(song());
    listen(t, 0, 10);
    t.finish('closed');
    expect(sent).toEqual([]);
  });
});

describe('sendWithRetry', () => {
  const report = (n: number): PlayReport => ({ trackId: n, recordingId: `rec-${n}`, at: `2026-11-01T10:0${n}:00.000Z`, hour: 10, weekday: 0, seconds: 60, skipped: false });

  it('keeps reports that could not be sent and sends them with the next one', async () => {
    const offline = vi.fn(async () => {
      throw new Error('offline');
    });
    sendWithRetry([report(1)], offline);
    await Promise.resolve();
    const online = vi.fn(async () => ({}));
    sendWithRetry([report(2)], online);
    expect(online).toHaveBeenCalledWith([report(1), report(2)]);
    await vi.waitFor(() => expect(localStorage.getItem('playarr.pendingPlays')).toBeNull());
  });
});
