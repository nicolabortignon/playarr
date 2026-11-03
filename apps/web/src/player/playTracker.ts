import type { PlayReport, Track } from '@playarr/shared';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';

/** Heard this long (or half a shorter song): a play. */
const PLAY_SECONDS = 30;
/** Left before this: just looking around, not a verdict on the song. */
const SKIP_FROM_SECONDS = 3;
const PENDING_KEY = 'playarr.pendingPlays';
const MAX_PENDING = 300;

/** Why a song stopped being the current one. */
export type Finish = 'ended' | 'changed' | 'closed';

interface Current {
  track: Track;
  startedAt: Date;
  heard: number;
  lastTime: number | null;
}

/**
 * The listening history, as heard on this device: each song is reported once it stops being the
 * current one, with how long it was actually heard (seeking doesn't count) and where in the day.
 */
export class PlayTracker {
  private current: Current | null = null;

  constructor(private readonly send: (plays: PlayReport[]) => void) {}

  start(track: Track, at = new Date()) {
    this.current = { track, startedAt: at, heard: 0, lastTime: null };
  }

  /** The playhead moved while playing. Jumps (seeks) aren't counted as heard. */
  tick(time: number) {
    const c = this.current;
    if (!c) return;
    if (c.lastTime !== null) {
      const delta = time - c.lastTime;
      if (delta > 0 && delta < 2) c.heard += delta;
    }
    c.lastTime = time;
  }

  /** Paused, or jumped: the next tick starts counting afresh. */
  pause() {
    if (this.current) this.current.lastTime = null;
  }

  finish(reason: Finish) {
    const c = this.current;
    this.current = null;
    if (!c) return;
    const duration = c.track.duration || Number.POSITIVE_INFINITY;
    const played = c.heard >= Math.min(PLAY_SECONDS, duration / 2);
    const skipped = !played && reason === 'changed' && c.heard >= SKIP_FROM_SECONDS;
    if (!played && !skipped) return;
    this.send([
      {
        trackId: c.track.id,
        recordingId: c.track.recordingId,
        at: c.startedAt.toISOString(),
        hour: c.startedAt.getHours(),
        weekday: c.startedAt.getDay(),
        seconds: Math.round(c.heard),
        skipped,
      },
    ]);
  }
}

let sending = false;

/**
 * Send reports, keeping the ones that couldn't go (offline, server restarting) for next time. One
 * request at a time: reports arriving meanwhile wait for it, then go together. (The server ignores a
 * report it already has, e.g. one sent as the app closed whose answer never came back.)
 */
export function sendWithRetry(plays: PlayReport[], report: (plays: PlayReport[]) => Promise<unknown> = api.reportPlays) {
  writePending([...readPending(), ...plays].slice(-MAX_PENDING));
  if (sending) return;
  const batch = readPending();
  if (!batch.length) return;
  sending = true;
  void report(batch)
    .then(
      () => {
        writePending(readPending().filter((p) => !batch.some((q) => same(p, q))));
        return true;
      },
      () => false,
    )
    .then((sent) => {
      sending = false;
      // More arrived while this was on its way: send them now.
      if (sent && readPending().length) sendWithRetry([], report);
    });
}

const same = (a: PlayReport, b: PlayReport) => a.trackId === b.trackId && a.at === b.at;

function readPending(): PlayReport[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]');
    return Array.isArray(value) ? (value as PlayReport[]) : [];
  } catch {
    return [];
  }
}

function writePending(plays: PlayReport[]) {
  try {
    if (plays.length) localStorage.setItem(PENDING_KEY, JSON.stringify(plays));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    // Storage full or blocked: the history just misses these.
  }
}

export const playTracker = new PlayTracker((plays) => {
  // Settings → Playback can keep this device out of the history.
  if (usePrefs.getState().recordPlays) sendWithRetry(plays);
});
