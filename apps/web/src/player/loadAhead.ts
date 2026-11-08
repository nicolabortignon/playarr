import type { Track } from '@playarr/shared';
import { useEffect } from 'react';
import { sized } from '../lib/api';
import { preloadImage } from '../lib/prefetch';
import { type Quality, usePrefs } from '../lib/prefs';
import { playQuality } from '../lib/quality';
import { useUI } from '../lib/ui';
import { canKeepOffline, type Download, isDownloaded, keepSong, keptAsPlayed, reconcileOffline, touchSong, useOffline, workerReady } from './offline';
import { currentTrack, usePlayer, type RepeatMode } from './store';
import { isLeader, useTabs } from './tabs';

/** Upcoming songs to have on the device on a good connection. */
const AHEAD = 3;
/** Wait for the queue to settle, so skipping through tracks doesn't download each one. */
const SETTLE_MS = 2500;
/** Cover sizes the player shows (mini player, player bar, accent sampling) and Now Playing adds. */
const PLAYER_ART = [44, 56, 96];
const NOW_PLAYING_ART = [300, 560];
/** The lowest stream quality: every copy of a song is at least this good. */
const LOWEST: Quality = 'normal';

type QueueState = { queue: Track[]; order: number[]; pos: number; repeat: RepeatMode };

/**
 * The songs to have ready, most urgent first: the next `ahead` in play order (wrapping around when
 * repeating the queue), then the current one, which is already streaming but is worth keeping for
 * seeks, replays and offline. With repeat-one, the current song is what plays next.
 */
export function loadAheadPlan(s: QueueState, ahead: number, withCurrent = true): Track[] {
  const current = currentTrack(s);
  if (!current) return [];
  const upcoming: Track[] = [];
  for (let i = 1; upcoming.length < ahead && i < s.order.length; i++) {
    const p = s.pos + i;
    if (p >= s.order.length && s.repeat !== 'all') break;
    upcoming.push(s.queue[s.order[p % s.order.length]!]!);
  }
  const plan = s.repeat === 'one' ? [current, ...upcoming] : withCurrent ? [...upcoming, current] : upcoming;
  const seen = new Set<number>();
  return plan.filter((t) => !seen.has(t.fileId) && !!seen.add(t.fileId));
}

interface NetworkInfo extends EventTarget {
  saveData?: boolean;
  effectiveType?: string;
  type?: string;
}
const connection = () => (navigator as Navigator & { connection?: NetworkInfo }).connection;

/** How far to look ahead on this connection: nothing on data saver or 2G, one song on cellular. */
function reach(): { ahead: number; withCurrent: boolean } {
  const c = connection();
  if (!navigator.onLine || c?.saveData || c?.effectiveType?.endsWith('2g')) return { ahead: 0, withCurrent: false };
  if (c?.type === 'cellular') return { ahead: 1, withCurrent: false };
  return { ahead: AHEAD, withCurrent: true };
}

let plan: Track[] = [];
let job: { fileId: number; abort: AbortController } | null = null;
/** Songs that failed or didn't fit this session; retried after a change of limit or connection. */
const skipped = new Set<number>();

function replan() {
  const state = usePlayer.getState();
  const { ahead, withCurrent } = reach();
  plan = canKeepOffline && workerReady() && useOffline.getState().limit ? loadAheadPlan(state, ahead, withCurrent) : [];
  if (job && !plan.some((t) => t.fileId === job!.fileId)) job.abort.abort();
  preloadArt(loadAheadPlan(state, 1, false)[0]);
  void pump();
}

/**
 * The next song of `plan` to keep: one not on the device at `quality` yet. A song of a download is the downloads'
 * to keep, at their own quality: any copy of it will do here.
 */
export function nextToLoad(
  plan: Track[],
  { songs, pins }: { songs: Record<number, { url: string }>; pins: Record<string, Download> },
  quality: Quality,
  skipped: ReadonlySet<number> = new Set(),
): Track | undefined {
  return plan.find((t) => !skipped.has(t.fileId) && !keptAsPlayed(t, songs, isDownloaded(t.fileId, { pins }) ? LOWEST : quality));
}

/** Download what the plan is missing, one song at a time, at the quality songs stream at on this connection. */
async function pump() {
  if (job) return;
  for (;;) {
    // Another tab plays now: it loads ahead for itself.
    if (!isLeader()) return;
    const quality = playQuality();
    const next = nextToLoad(plan, useOffline.getState(), quality, skipped);
    if (!next) return;
    const abort = new AbortController();
    job = { fileId: next.fileId, abort };
    const current = currentTrack(usePlayer.getState());
    const protect = new Set([...plan.map((t) => t.fileId), ...(current ? [current.fileId] : [])]);
    try {
      if (!(await keepSong(next, { signal: abort.signal, protect, quality }))) skipped.add(next.fileId);
    } catch {
      if (!abort.signal.aborted) skipped.add(next.fileId);
    } finally {
      job = null;
    }
  }
}

function preloadArt(track: Track | undefined) {
  if (!track?.coverUrl) return;
  const sizes = useUI.getState().nowPlayingOpen ? [...PLAYER_ART, ...NOW_PLAYING_ART] : PLAYER_ART;
  for (const size of sizes) preloadImage(sized(track.coverUrl, size));
}

/**
 * Load ahead: keeps the next songs in the queue (and the one playing) on this device, so tracks
 * start and seek instantly and keep playing without a connection; preloads the next cover too.
 * Only in the tab that plays (player/tabs.ts), once it has read what's kept on the device.
 */
export function useLoadAhead() {
  const leading = useTabs((s) => s.leading);
  const hydrated = useOffline((s) => s.hydrated);
  useEffect(() => {
    if (!leading || !hydrated) return;
    void reconcileOffline();
    const playing = currentTrack(usePlayer.getState());
    if (playing) touchSong(playing.fileId);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(replan, SETTLE_MS);
    };
    const retry = () => {
      skipped.clear();
      schedule();
    };
    const offPlayer = usePlayer.subscribe((s, prev) => {
      if (s.queue !== prev.queue || s.order !== prev.order || s.pos !== prev.pos || s.repeat !== prev.repeat) schedule();
      const now = currentTrack(s);
      if (now && now.fileId !== currentTrack(prev)?.fileId) touchSong(now.fileId);
    });
    const offLimit = useOffline.subscribe((s, prev) => s.limit !== prev.limit && retry());
    // Another quality for this connection (or DJ mix asking for songs' own files): songs are kept at that one from now on.
    const offQuality = usePrefs.subscribe(
      (s, prev) => (s.wifiQuality !== prev.wifiQuality || s.cellularQuality !== prev.cellularQuality || s.transitions !== prev.transitions) && retry(),
    );
    window.addEventListener('online', retry);
    connection()?.addEventListener('change', retry);
    navigator.serviceWorker?.addEventListener('controllerchange', retry);
    schedule();
    return () => {
      clearTimeout(timer);
      offPlayer();
      offLimit();
      offQuality();
      window.removeEventListener('online', retry);
      connection()?.removeEventListener('change', retry);
      navigator.serviceWorker?.removeEventListener('controllerchange', retry);
      plan = [];
      job?.abort.abort();
    };
  }, [leading, hydrated]);
}
