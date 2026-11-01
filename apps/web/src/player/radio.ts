import type { Track } from '@playarr/shared';
import { useEffect } from 'react';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { toast } from '../lib/toast';
import { currentTrack, usePlayer } from './store';

/** Songs to base what comes next on: the last few played. */
const SEEDS = 5;

/** "Start radio" on a song: it, then songs like it from the library. */
export async function startRadio(track: Track) {
  try {
    const more = await api.radio([track.recordingId], [track.recordingId]);
    usePlayer.getState().playTracks([track, ...more], 0, {
      shuffle: false,
      source: { label: `${track.title} radio`, href: `/albums/${track.albumId}` },
    });
  } catch (err) {
    toast(`Couldn’t start a radio: ${(err as Error).message}`, 'error');
  }
}

/**
 * Keep the music going: when the last song of the queue starts (and nothing repeats), add songs like
 * the last few, so playback carries on without a gap. Settings → Playback can turn it off.
 */
export function useAutoplay() {
  const fileId = usePlayer((s) => currentTrack(s)?.fileId);
  useEffect(() => {
    const s = usePlayer.getState();
    if (fileId === undefined || !usePrefs.getState().autoplay || s.repeat !== 'off' || s.pos !== s.order.length - 1) return;
    const played = s.order.slice(0, s.pos + 1).map((i) => s.queue[i]!);
    const seeds = played.slice(-SEEDS).map((t) => t.recordingId);
    let cancelled = false;
    void api.radio(seeds, s.queue.map((t) => t.recordingId)).then(
      (more) => {
        const now = usePlayer.getState();
        // Still on the last song (nothing was queued meanwhile): carry on with these.
        if (!cancelled && more.length && now.pos === now.order.length - 1 && currentTrack(now)?.fileId === fileId) now.addToQueue(more);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [fileId]);
}
