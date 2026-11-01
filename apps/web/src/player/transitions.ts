import type { MixMode } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { useEffect } from 'react';
import { create } from 'zustand';
import { api, type TransitionAnswer } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { upNext } from './decks';
import { currentTrack, useClock, usePlayer } from './store';

/** Ask only once a song has played this long, so skipping through songs doesn't render each pair. */
const MIN_PLAYED_S = 5;
/** While the server renders, ask again this often. */
const POLL_MS = 3000;
/** Not ready this close to the mix point: too late to load it, so the pair plays the usual way. */
const GIVE_UP_S = 20;
/** Clock steps longer than this are jumps (a seek, a new song), not listening. */
const MAX_STEP_S = 2;

/** What's known of the transition into the next song: the server's answer, or "gave up" (fall back). */
export type UpcomingResult = TransitionAnswer | { status: 'gave up' };

interface TransitionState {
  /** The current → next pair, by file (as the decks know them); null when no transition is wanted. */
  fromFileId: number | null;
  toFileId: number | null;
  /** Null until the server answers for this pair. */
  result: UpcomingResult | null;
}

/** The DJ transition from the song playing into the next one. */
export const useTransition = create<TransitionState>()(() => ({ fromFileId: null, toFileId: null, result: null }));

export type ReadyTransition = Extract<TransitionAnswer, { status: 'ready' }> & { fromFileId: number; toFileId: number };

/** The transition file to play between the two songs, once rendered. */
export function readyTransition(s: TransitionState): ReadyTransition | undefined {
  if (s.result?.status !== 'ready' || s.fromFileId === null || s.toFileId === null) return undefined;
  return { ...s.result, fromFileId: s.fromFileId, toFileId: s.toFileId };
}

/** One pair being asked about. */
interface Pair {
  key: string;
  from: Track;
  to: Track;
  mode: MixMode;
  /**
   * Where the song was at the first ask, sent unchanged on every ask after: the server's plan (and so
   * its render) depends on it, and a later position could make it start over.
   */
  position?: number;
  asking: boolean;
  /** Asks again after a "pending". */
  poll?: ReturnType<typeof setTimeout>;
  /** The plan's mix point in the song playing, once the server has planned it. */
  aStart?: number;
  /** Answered for good (or gave up): no more asking. */
  done: boolean;
}

/**
 * Asks the server for the transition from the song playing into the next, while it plays, so it's
 * rendered by the time it's needed. Mounted once, in the AudioEngine.
 */
export function useUpcomingTransition() {
  useEffect(watchUpcomingTransition, []);
}

function watchUpcomingTransition() {
  let pair: Pair | null = null;
  /** The song whose listening time is counted, and how long it has played. */
  let playingFileId: number | undefined;
  let played = 0;
  let lastTime: number | null = null;

  const publish = (result: UpcomingResult | null) => useTransition.setState({ result });

  function drop() {
    clearTimeout(pair?.poll);
    pair = null;
  }

  /** Too close to the mix point to still be useful. */
  const tooLate = (p: Pair) => p.aStart !== undefined && useClock.getState().time >= p.aStart - GIVE_UP_S;

  function giveUp(p: Pair) {
    clearTimeout(p.poll);
    p.done = true;
    publish({ status: 'gave up' });
  }

  function maybeAsk() {
    const p = pair;
    if (!p || p.done || p.asking || p.poll !== undefined || played < MIN_PLAYED_S || !navigator.onLine) return;
    if (tooLate(p)) return giveUp(p);
    p.asking = true;
    p.position ??= useClock.getState().time;
    api.transition(p.from.id, p.to.id, p.mode, p.position).then(
      (answer) => {
        // The pair changed meanwhile (or gave up): this answer is for nothing now.
        if (pair !== p || p.done) return;
        p.asking = false;
        if (answer.status !== 'pending') {
          p.done = true;
          return publish(answer);
        }
        p.aStart = answer.plan.aStart;
        if (tooLate(p)) return giveUp(p);
        publish(answer);
        p.poll = setTimeout(() => {
          p.poll = undefined;
          maybeAsk();
        }, POLL_MS);
      },
      // Can't reach the server: this pair plays the usual way.
      () => pair === p && !p.done && giveUp(p),
    );
  }

  /** The pair to ask about now, if any; a different one starts over. */
  function check() {
    const s = usePlayer.getState();
    const from = currentTrack(s);
    const to = upNext(s);
    if (from?.fileId !== playingFileId) {
      // A new song: its listening time starts from nothing (the clock may still show the last one's).
      playingFileId = from?.fileId;
      played = 0;
      lastTime = null;
    }
    const wanted = usePrefs.getState().transitions === 'dj' && !!from && !!to && from.fileId !== to.fileId;
    const key = wanted ? JSON.stringify([from.id, from.fileId, to.id, to.fileId, s.mixMode]) : null;
    if (key !== (pair?.key ?? null)) {
      drop();
      if (wanted) pair = { key: key!, from: from!, to: to!, mode: s.mixMode, asking: false, done: false };
      useTransition.setState({ fromFileId: wanted ? from!.fileId : null, toFileId: wanted ? to!.fileId : null, result: null });
    }
    maybeAsk();
  }

  function onClock(time: number) {
    // Only small steps forward are listening; seeks and the clock's reset for a new song aren't.
    if (lastTime !== null && time > lastTime && time - lastTime <= MAX_STEP_S) played += time - lastTime;
    lastTime = time;
    if (pair && !pair.done && tooLate(pair)) return giveUp(pair);
    maybeAsk();
  }

  check();
  // At mount the clock is the song playing's own; after a song change it isn't until the engine resets it.
  lastTime = useClock.getState().time;
  const offPlayer = usePlayer.subscribe(check);
  const offPrefs = usePrefs.subscribe((s, prev) => s.transitions !== prev.transitions && check());
  const offClock = useClock.subscribe((s, prev) => s.time !== prev.time && onClock(s.time));
  window.addEventListener('online', check);
  return () => {
    offPlayer();
    offPrefs();
    offClock();
    window.removeEventListener('online', check);
    drop();
    useTransition.setState({ fromFileId: null, toFileId: null, result: null });
  };
}
