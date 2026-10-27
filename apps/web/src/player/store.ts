import type { Track } from '@playarr/shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type RepeatMode = 'off' | 'all' | 'one';

interface PlayerState {
  /** Tracks in the order they were added. */
  queue: Track[];
  /** Play order: indices into `queue` (identity unless shuffled). */
  order: number[];
  /** Position within `order` of the current track, -1 when empty. */
  pos: number;
  playing: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number;
  muted: boolean;
  /** Bumped to ask the engine to restart the current track (e.g. "previous" near the start). */
  restartToken: number;
  /** Where to resume after a reload. */
  resumeAt: number;

  playTracks: (tracks: Track[], startIndex?: number, opts?: { shuffle?: boolean }) => void;
  playNext: (tracks: Track[]) => void;
  addToQueue: (tracks: Track[]) => void;
  jumpTo: (orderPos: number) => void;
  removeAt: (orderPos: number) => void;
  move: (fromPos: number, toPos: number) => void;
  clearUpcoming: () => void;
  next: (auto?: boolean) => void;
  prev: (currentTime: number) => void;
  setPlaying: (playing: boolean) => void;
  toggle: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  setResumeAt: (t: number) => void;
}

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

export const usePlayer = create<PlayerState>()(
  persist(
    (set, get) => ({
      queue: [],
      order: [],
      pos: -1,
      playing: false,
      shuffle: false,
      repeat: 'off',
      volume: 1,
      muted: false,
      restartToken: 0,
      resumeAt: 0,

      playTracks: (tracks, startIndex = 0, opts) => {
        if (!tracks.length) return;
        const shuffle = opts?.shuffle ?? get().shuffle;
        const start = opts?.shuffle ? Math.floor(Math.random() * tracks.length) : startIndex;
        const order = shuffle
          ? [start, ...shuffled(range(tracks.length).filter((i) => i !== start))]
          : range(tracks.length);
        set({
          queue: tracks,
          order,
          pos: shuffle ? 0 : start,
          shuffle,
          playing: true,
          resumeAt: 0,
          restartToken: get().restartToken + 1,
        });
      },

      playNext: (tracks) => {
        const { queue, order, pos } = get();
        if (pos < 0) return get().playTracks(tracks);
        const base = queue.length;
        set({
          queue: [...queue, ...tracks],
          order: [...order.slice(0, pos + 1), ...tracks.map((_, i) => base + i), ...order.slice(pos + 1)],
        });
      },

      addToQueue: (tracks) => {
        const { queue, order, pos } = get();
        if (pos < 0) return get().playTracks(tracks);
        const base = queue.length;
        set({ queue: [...queue, ...tracks], order: [...order, ...tracks.map((_, i) => base + i)] });
      },

      jumpTo: (orderPos) => {
        if (orderPos < 0 || orderPos >= get().order.length) return;
        set({ pos: orderPos, playing: true, resumeAt: 0, restartToken: get().restartToken + 1 });
      },

      removeAt: (orderPos) => {
        const { order, pos } = get();
        if (orderPos === pos || orderPos < 0 || orderPos >= order.length) return;
        // Leave the track in `queue` (indices stay valid); just drop it from the play order.
        set({ order: order.filter((_, i) => i !== orderPos), pos: orderPos < pos ? pos - 1 : pos });
      },

      move: (fromPos, toPos) => {
        const { order, pos } = get();
        if (fromPos === toPos) return;
        const next = [...order];
        const [item] = next.splice(fromPos, 1);
        next.splice(toPos, 0, item!);
        const current = order[pos]!;
        set({ order: next, pos: next.indexOf(current) });
      },

      clearUpcoming: () => {
        const { order, pos } = get();
        set({ order: order.slice(0, pos + 1) });
      },

      next: (auto = false) => {
        const { pos, order, repeat, restartToken } = get();
        if (auto && repeat === 'one') return set({ restartToken: restartToken + 1, resumeAt: 0 });
        if (pos + 1 < order.length) return set({ pos: pos + 1, playing: true, resumeAt: 0 });
        if (repeat === 'all' && order.length) return set({ pos: 0, playing: true, resumeAt: 0 });
        // End of queue: stop at the last track.
        if (auto) set({ playing: false, resumeAt: 0, restartToken: restartToken + 1 });
      },

      prev: (currentTime) => {
        const { pos, order, repeat, restartToken } = get();
        if (currentTime > 3 || (pos === 0 && repeat !== 'all')) {
          return set({ restartToken: restartToken + 1, resumeAt: 0 });
        }
        set({ pos: pos > 0 ? pos - 1 : order.length - 1, playing: true, resumeAt: 0 });
      },

      setPlaying: (playing) => set({ playing }),
      toggle: () => get().pos >= 0 && set({ playing: !get().playing }),

      toggleShuffle: () => {
        const { shuffle, order, pos, queue } = get();
        if (pos < 0) return set({ shuffle: !shuffle });
        const current = order[pos]!;
        if (!shuffle) {
          // Keep history, shuffle only what's upcoming.
          const upcoming = shuffled(order.slice(pos + 1));
          set({ shuffle: true, order: [...order.slice(0, pos + 1), ...upcoming] });
        } else {
          // Restore original queue order, continuing from the current track.
          const restored = range(queue.length).filter((i) => order.includes(i));
          set({ shuffle: false, order: restored, pos: restored.indexOf(current) });
        }
      },

      cycleRepeat: () =>
        set({ repeat: ({ off: 'all', all: 'one', one: 'off' } as const)[get().repeat] }),

      setVolume: (volume) => set({ volume: Math.min(1, Math.max(0, volume)), muted: false }),
      toggleMute: () => set({ muted: !get().muted }),
      setResumeAt: (resumeAt) => set({ resumeAt }),
    }),
    {
      name: 'playarr.player',
      version: 1,
      partialize: ({ queue, order, pos, shuffle, repeat, volume, muted, resumeAt }) => ({
        queue,
        order,
        pos,
        shuffle,
        repeat,
        volume,
        muted,
        resumeAt,
      }),
    },
  ),
);

export function currentTrack(s: Pick<PlayerState, 'queue' | 'order' | 'pos'>): Track | undefined {
  const idx = s.order[s.pos];
  return idx === undefined ? undefined : s.queue[idx];
}

export const useCurrentTrack = () => usePlayer(currentTrack);

/** High-frequency playback clock, kept out of the persisted store to avoid re-render storms. */
interface ClockState {
  time: number;
  duration: number;
  buffered: number;
  loading: boolean;
  error: string | null;
  seekRequest: { time: number; id: number } | null;
  seek: (time: number) => void;
}

export const useClock = create<ClockState>()((set, get) => ({
  time: 0,
  duration: 0,
  buffered: 0,
  loading: false,
  error: null,
  seekRequest: null,
  seek: (time) => set({ time, seekRequest: { time, id: (get().seekRequest?.id ?? 0) + 1 } }),
}));
