import type { Track } from '@playarr/shared';
import { useEffect } from 'react';
import { create } from 'zustand';
import { toast } from '../lib/toast';
import { canKeepOffline, keepSong, pinnedFiles, useOffline, workerReady } from './offline';

interface DownloadsState {
  /** Songs that didn't download this session (no room, or an error): tried again later. */
  failed: Record<number, string>;
}

/** What went wrong with downloads this session. */
export const useDownloadState = create<DownloadsState>()(() => ({ failed: {} }));

let job: { fileId: number; abort: AbortController } | null = null;
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

/** Fetch the songs downloads are missing, one at a time, while there's a connection. */
async function pump() {
  if (running || !canKeepOffline || !workerReady() || !navigator.onLine) return;
  running = true;
  try {
    for (;;) {
      const { pins, songs } = useOffline.getState();
      const next = nextToDownload(pins, songs, useDownloadState.getState().failed);
      if (!next || !navigator.onLine) return;
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

/** Try the songs that failed again (back online, or after space was freed). */
function retry() {
  warnedFull = false;
  useDownloadState.setState({ failed: {} });
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
      if (Object.keys(s.pins).length < Object.keys(prev.pins).length) retry();
      else void pump();
    });
    window.addEventListener('online', retry);
    navigator.serviceWorker?.addEventListener('controllerchange', retry);
    return () => {
      off();
      window.removeEventListener('online', retry);
      navigator.serviceWorker?.removeEventListener('controllerchange', retry);
      job?.abort.abort();
    };
  }, []);
}
