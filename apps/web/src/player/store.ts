import type { MixMode } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type RepeatMode = 'off' | 'all' | 'one';

/** What the queue was started from (an album, a mix, a playlist…), for "Playing from". */
export interface PlaySource {
  label: string;
  href: string;
}

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
  /** Where the engine starts the song it loads next, once (then null): e.g. a mix point played from its dialog. */
  startAt: number | null;
  /** What the queue was started from; unset, Now Playing shows the song's album. */
  source?: PlaySource;
  /** How this queue is mixed when transitions are DJ mix: Auto, Party (longer blends) or no mixing. */
  mixMode: MixMode;

  /** `at`: start the song there (seconds) instead of its beginning. */
  playTracks: (tracks: Track[], startIndex?: number, opts?: { shuffle?: boolean; source?: PlaySource; at?: number }) => void;
  playNext: (tracks: Track[]) => void;
  addToQueue: (tracks: Track[]) => void;
  jumpTo: (orderPos: number, opts?: { at?: number }) => void;
  removeAt: (orderPos: number) => void;
  move: (fromPos: number, toPos: number) => void;
  clearUpcoming: () => void;
  /** Replace what plays after the current song: indices into `queue`, e.g. reordered or restored. */
  setUpcoming: (queueIndices: number[]) => void;
  /** On to the next song: `auto` when the song ended (or the engine moved on); a press of Next otherwise. */
  next: (auto?: boolean) => void;
  /** A press of Next that the engine doesn't take over (see takeNextPresses). */
  nextNow: () => void;
  prev: (currentTime: number) => void;
  setPlaying: (playing: boolean) => void;
  toggle: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  setResumeAt: (t: number) => void;
  setMixMode: (mode: MixMode) => void;
}

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const MIX_MODES: readonly MixMode[] = ['auto', 'party', 'off'];

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/**
 * The engine can take a press of Next over, to mix into the next song first (a live mix, on desktop): it
 * then moves the queue on itself as the next song takes over, or at once with nextNow if the mix can't be
 * made. Called within the press, so the engine may start audio there.
 */
let nextTaker: (() => boolean) | null = null;

/** The engine took this press of Next over. Should it fail, the press goes through as ever: Next never does nothing. */
function takenOver(): boolean {
  try {
    return !!nextTaker?.();
  } catch {
    return false;
  }
}

/** On to the next song in the play order (round to the first with repeat all): false at the end of the queue. */
function moveOn(get: () => Pick<PlayerState, 'pos' | 'order' | 'repeat'>, set: (s: Partial<PlayerState>) => void): boolean {
  const { pos, order, repeat } = get();
  if (pos + 1 < order.length) set({ pos: pos + 1, playing: true, resumeAt: 0 });
  else if (repeat === 'all' && order.length) set({ pos: 0, playing: true, resumeAt: 0 });
  else return false;
  return true;
}

/** Let `take` see each press of Next first: true when it takes the press over. Returns the undo. */
export function takeNextPresses(take: () => boolean): () => void {
  nextTaker = take;
  return () => {
    if (nextTaker === take) nextTaker = null;
  };
}

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
      startAt: null,
      mixMode: 'auto',

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
          source: opts?.source,
          // A party mode picked for the last queue shouldn't carry over to something new.
          mixMode: 'auto',
          playing: true,
          resumeAt: 0,
          startAt: opts?.at ?? null,
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

      jumpTo: (orderPos, opts) => {
        if (orderPos < 0 || orderPos >= get().order.length) return;
        set({ pos: orderPos, playing: true, resumeAt: 0, startAt: opts?.at ?? null, restartToken: get().restartToken + 1 });
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

      setUpcoming: (queueIndices) => {
        const { order, pos, queue } = get();
        const valid = queueIndices.filter((i) => i >= 0 && i < queue.length && i !== order[pos]);
        set({ order: [...order.slice(0, pos + 1), ...valid] });
      },

      clearUpcoming: () => {
        const { order, pos } = get();
        set({ order: order.slice(0, pos + 1) });
      },

      next: (auto = false) => {
        if (!auto) {
          if (takenOver()) return;
          return get().nextNow();
        }
        const { repeat, restartToken } = get();
        if (repeat === 'one') return set({ restartToken: restartToken + 1, resumeAt: 0 });
        // End of queue: stop at the last track.
        if (!moveOn(get, set)) set({ playing: false, resumeAt: 0, restartToken: restartToken + 1 });
      },

      nextNow: () => {
        moveOn(get, set);
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
      setMixMode: (mixMode) => set({ mixMode }),
    }),
    {
      name: 'playarr.player',
      version: 1,
      partialize: ({ queue, order, pos, shuffle, repeat, volume, muted, resumeAt, source, mixMode }) => ({
        source,
        mixMode,
        queue,
        order,
        pos,
        shuffle,
        repeat,
        volume,
        muted,
        resumeAt,
      }),
      // A mix mode this version doesn't know (or none, from before mixing) plays as Auto.
      merge: (saved, current) => {
        const s = (saved ?? {}) as Partial<PlayerState>;
        return { ...current, ...s, mixMode: MIX_MODES.includes(s.mixMode as MixMode) ? (s.mixMode as MixMode) : 'auto' };
      },
    },
  ),
);

export function currentTrack(s: Pick<PlayerState, 'queue' | 'order' | 'pos'>): Track | undefined {
  const idx = s.order[s.pos];
  return idx === undefined ? undefined : s.queue[idx];
}

export const useCurrentTrack = () => usePlayer(currentTrack);

/** The song a press of Next goes to (repeat one included: Next leaves the song), if any. */
export function nextByPress(s: Pick<PlayerState, 'queue' | 'order' | 'pos' | 'repeat'>): Track | undefined {
  if (s.pos < 0) return undefined;
  if (s.pos + 1 < s.order.length) return s.queue[s.order[s.pos + 1]!];
  return s.repeat === 'all' && s.order.length ? s.queue[s.order[0]!] : undefined;
}

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
