import { useEffect } from 'react';
import { create } from 'zustand';
import { toast } from '../lib/toast';
import { useUI } from '../lib/ui';
import { usePlayer } from './store';

/** The music fades out over the last seconds of a sleep timer. */
export const SLEEP_FADE_MS = 20_000;

interface SleepState {
  /** When the music stops (epoch ms). */
  endsAt: number | null;
  /** Stop when the song playing ends. */
  endOfSong: boolean;
  /** When the timer last stopped the music (epoch ms), until something wakes the screen: Now Playing says goodnight. */
  sleptAt: number | null;
  sleepIn: (minutes: number) => void;
  sleepAtEndOfSong: () => void;
  cancel: () => void;
  /** Done with goodnight: a touch, a key, the music playing again. */
  wake: () => void;
}

/** The sleep timer: stop playing after a while, or when this song ends. */
export const useSleep = create<SleepState>()((set) => ({
  endsAt: null,
  endOfSong: false,
  sleptAt: null,
  sleepIn: (minutes) => set({ endsAt: Date.now() + minutes * 60_000, endOfSong: false, sleptAt: null }),
  sleepAtEndOfSong: () => set({ endsAt: null, endOfSong: true, sleptAt: null }),
  cancel: () => set({ endsAt: null, endOfSong: false }),
  wake: () => set({ sleptAt: null }),
}));

/**
 * The timer has stopped the music (its time ran out, or the song it waited for ended): Now Playing dims to a moon and
 * "Sleep well" before the screen rests. Said with a toast only where Now Playing isn't open to say it.
 */
export function fellAsleep() {
  useSleep.setState({ sleptAt: Date.now() });
  if (!useUI.getState().nowPlayingOpen) toast('Sleep timer: music stopped');
}

/** How loud to play as the timer runs out: 1, then down to 0 over the fade. */
export function sleepGain(now = Date.now()): number {
  const { endsAt } = useSleep.getState();
  if (endsAt === null) return 1;
  return Math.max(0, Math.min(1, (endsAt - now) / SLEEP_FADE_MS));
}

/** Called when a song ends on its own: true if the timer stops the music here. */
export function sleepsAtSongEnd(): boolean {
  if (!useSleep.getState().endOfSong) return false;
  useSleep.getState().cancel();
  return true;
}

/** Runs the timer: fades out at the end (through `applyVolume`), then pauses. */
export function useSleepTimer(applyVolume: () => void) {
  const endsAt = useSleep((s) => s.endsAt);
  useEffect(() => {
    if (endsAt === null) return applyVolume();
    const id = setInterval(() => {
      const left = endsAt - Date.now();
      if (left <= SLEEP_FADE_MS) applyVolume();
      if (left > 0) return;
      usePlayer.getState().setPlaying(false);
      useSleep.getState().cancel();
      fellAsleep();
    }, 500);
    return () => clearInterval(id);
  }, [endsAt]);
}

/** "23 min" left, for the timer's button. */
export function sleepLabel(endsAt: number | null, endOfSong: boolean, now = Date.now()): string | undefined {
  if (endOfSong) return 'End of song';
  if (endsAt === null) return undefined;
  const minutes = Math.max(1, Math.ceil((endsAt - now) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60 ? `${minutes % 60} min` : ''}`.trim() : `${minutes} min`;
}
