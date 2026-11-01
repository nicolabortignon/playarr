import type { MixMode } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { toast } from '../lib/toast';
import {
  canKeepOffline,
  type Download,
  keepSong,
  keepTransition,
  type KeptTransition,
  offlineTransition,
  pinnedFiles,
  transitionKept,
  transitionPair,
  useOffline,
  workerReady,
} from './offline';
import { useTransition } from './transitions';

/** Downloads keep the transitions the player asks for by default: a queue's mix mode starts out 'auto'. */
const TRANSITION_MODE: MixMode = 'auto';
/** While the server renders a transition, ask again this often… */
const POLL_MS = 3000;
/** …and this often after a few polls (renders queue up behind the player's own). */
const SLOW_POLL_MS = 10_000;
const FAST_POLLS = 5;
/** A transition still not rendered after this long is left out (tried again next session). */
const GIVE_UP_MS = 10 * 60_000;

interface DownloadsState {
  /** Songs that didn't download this session (no room, or an error): tried again later. */
  failed: Record<number, string>;
  /** Transitions left out this session, by transitionPair(): none to be had, too slow, no room, an error. */
  skippedPairs: Record<string, string>;
}

/** What went wrong with downloads this session. */
export const useDownloadState = create<DownloadsState>()(() => ({ failed: {}, skippedPairs: {} }));

let job: { fileId: number; abort: AbortController } | null = null;
/** The transition being fetched: the download it's for, and its pair. */
let pairJob: { key: string; fromFileId: number; toFileId: number; abort: AbortController } | null = null;
let running = false;
let warnedFull = false;

/** The next song of a download to fetch: downloads in the order they were added, songs in order. */
export function nextToDownload(pins: Record<string, { addedAt: number; tracks: Track[] }>, songs: Record<number, unknown>, failed: Record<number, string>) {
  for (const d of Object.values(pins).sort((a, b) => a.addedAt - b.addedAt)) {
    const t = d.tracks.find((t) => !(t.fileId in songs) && !(t.fileId in failed));
    if (t) return t;
  }
  return undefined;
}

/**
 * The next transition a download is missing: downloads in the order they were added, pairs in their
 * song order, once both songs are on the device. `busy` pairs are left for later.
 */
export function nextTransition(
  pins: Record<string, Pick<Download, 'key' | 'addedAt' | 'tracks' | 'transitions'>>,
  songs: Record<number, { url: string; bytes: number; usedAt: number }>,
  skipped: Record<string, string>,
  busy: (from: Track, to: Track) => boolean = () => false,
): { key: string; from: Track; to: Track } | undefined {
  for (const d of Object.values(pins).sort((a, b) => a.addedAt - b.addedAt)) {
    for (let i = 1; i < d.tracks.length; i++) {
      const from = d.tracks[i - 1]!;
      const to = d.tracks[i]!;
      const pair = transitionPair(from.fileId, to.fileId, TRANSITION_MODE);
      if (from.fileId === to.fileId || !(from.fileId in songs) || !(to.fileId in songs) || pair in skipped) continue;
      const kept = d.transitions?.[pair];
      if ((kept && transitionKept(kept, songs)) || busy(from, to)) continue;
      return { key: d.key, from, to };
    }
  }
  return undefined;
}

/**
 * The player is asking about this song's transition into another one: the server keeps one waiting
 * render per song, so asking about ours would push the player's out of its queue.
 */
const clashesWithPlayer = (fromFileId: number, toFileId: number) => {
  const playing = useTransition.getState();
  return playing.fromFileId === fromFileId && playing.toFileId !== toFileId;
};

/**
 * Fetch the next transition a download is missing, while transitions are DJ mix: ask the server, ask
 * again until it's rendered, then keep its files. False when there's none to fetch.
 */
export async function keepNextTransition(): Promise<boolean> {
  if (usePrefs.getState().transitions !== 'dj') return false;
  const { pins, songs } = useOffline.getState();
  const next = nextTransition(pins, songs, useDownloadState.getState().skippedPairs, (from, to) => clashesWithPlayer(from.fileId, to.fileId));
  if (!next) return false;
  const { key, from, to } = next;
  const pair = transitionPair(from.fileId, to.fileId, TRANSITION_MODE);
  const abort = new AbortController();
  pairJob = { key, fromFileId: from.fileId, toFileId: to.fileId, abort };
  try {
    // Another download has it already: no need to ask.
    const answer = offlineTransition(from.fileId, to.fileId, TRANSITION_MODE) ?? (await askUntilRendered(from, to, abort.signal));
    if (typeof answer === 'string') skip(pair, answer);
    else if (!(await keepTransition(key, { from, to, mode: TRANSITION_MODE }, answer, { signal: abort.signal }))) {
      skip(pair, 'Not enough space on this device');
    }
  } catch (err) {
    if (!abort.signal.aborted) skip(pair, (err as Error).message);
  } finally {
    pairJob = null;
  }
  return true;
}

/**
 * Ask for a pair's transition until it's rendered: the ready answer, or why there's none to keep.
 * No position is sent: the player's first ask comes early in the song, and the server reuses the plan
 * made here for it as long as the plan is still ahead, so both get the same file.
 */
async function askUntilRendered(from: Track, to: Track, signal: AbortSignal): Promise<KeptTransition | string> {
  const started = Date.now();
  for (let polls = 0; ; polls++) {
    const answer = await api.transition(from.id, to.id, TRANSITION_MODE);
    signal.throwIfAborted();
    if (answer.status === 'ready') return answer;
    if (answer.status === 'unavailable') return answer.reason;
    if (answer.status === 'straight') return 'No transition: the songs play straight on';
    if (Date.now() - started >= GIVE_UP_MS) return 'The transition took too long to render';
    // Asking again also puts it back in the server's queue, should newer asks have pushed it out.
    await wait(polls < FAST_POLLS ? POLL_MS : SLOW_POLL_MS, signal);
  }
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}

function skip(pair: string, reason: string) {
  useDownloadState.setState((s) => ({ skippedPairs: { ...s.skippedPairs, [pair]: reason } }));
}

/**
 * Fetch what downloads are missing while there's a connection: their songs, one at a time, then the
 * transitions between them, one pair at a time (the server renders one at a time, and drops older
 * asks once a few wait).
 */
async function pump() {
  if (running || !canKeepOffline || !workerReady() || !navigator.onLine) return;
  running = true;
  try {
    for (;;) {
      const { pins, songs } = useOffline.getState();
      const next = nextToDownload(pins, songs, useDownloadState.getState().failed);
      if (!navigator.onLine) return;
      if (!next) {
        if (await keepNextTransition()) continue;
        return;
      }
      const abort = new AbortController();
      job = { fileId: next.fileId, abort };
      try {
        const kept = await keepSong(next, { signal: abort.signal, protect: pinnedFiles(pins), pinned: true });
        if (!kept) {
          fail(next.fileId, 'Not enough space on this device');
          if (!warnedFull) {
            warnedFull = true;
            toast('This device is out of space for downloads: remove some in Library → Downloads', 'error');
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) fail(next.fileId, (err as Error).message);
      } finally {
        job = null;
      }
    }
  } finally {
    running = false;
  }
}

function fail(fileId: number, reason: string) {
  useDownloadState.setState((s) => ({ failed: { ...s.failed, [fileId]: reason } }));
}

/** Try the songs and transitions that failed again (back online, or after space was freed). */
function retry() {
  warnedFull = false;
  useDownloadState.setState({ failed: {}, skippedPairs: {} });
  void pump();
}

/** Keeps downloads complete: fetches what they're missing, stops fetching what's no longer wanted. */
export function useDownloads() {
  useEffect(() => {
    void pump();
    const off = useOffline.subscribe((s, prev) => {
      if (s.pins === prev.pins) return;
      // A download removed mid-song: stop fetching it.
      if (job && !pinnedFiles(s.pins).has(job.fileId)) job.abort.abort();
      // Songs come before transitions, and a removed download's transitions aren't wanted.
      if (pairJob && (!s.pins[pairJob.key] || nextToDownload(s.pins, s.songs, useDownloadState.getState().failed))) pairJob.abort.abort();
      if (Object.keys(s.pins).length < Object.keys(prev.pins).length) retry();
      else void pump();
    });
    // Switched to DJ mix: downloads made before fetch their transitions now.
    const offPrefs = usePrefs.subscribe((s, prev) => {
      if (s.transitions === prev.transitions) return;
      if (s.transitions !== 'dj') pairJob?.abort.abort();
      else void pump();
    });
    // The player moved on to another pair: one left aside for it may be fetched now (or must wait).
    const offPlayer = useTransition.subscribe((s, prev) => {
      if (s.fromFileId === prev.fromFileId && s.toFileId === prev.toFileId) return;
      if (pairJob && clashesWithPlayer(pairJob.fromFileId, pairJob.toFileId)) pairJob.abort.abort();
      void pump();
    });
    window.addEventListener('online', retry);
    navigator.serviceWorker?.addEventListener('controllerchange', retry);
    return () => {
      off();
      offPrefs();
      offPlayer();
      window.removeEventListener('online', retry);
      navigator.serviceWorker?.removeEventListener('controllerchange', retry);
      job?.abort.abort();
      pairJob?.abort.abort();
    };
  }, []);
}
