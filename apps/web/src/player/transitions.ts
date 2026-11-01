import type { MixMode } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { useEffect } from 'react';
import { create } from 'zustand';
import { api, ApiError, type TransitionAnswer } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { upNext } from './decks';
import { type KeptTransition, offlineTransition } from './offline';
import { useSleep } from './sleep';
import { currentTrack, useClock, usePlayer } from './store';

/** Ask only once a song has played this long, so skipping through songs doesn't render each pair. */
const MIN_PLAYED_S = 5;
/** A new pair waits this long before its first ask, so a burst of queue edits or mode changes renders nothing. */
const FIRST_ASK_DELAY_MS = 2000;
/** While the server renders, ask again this often… */
const POLL_MS = 3000;
/** …and this often after a few polls, or while paused (it isn't needed soon). */
const SLOW_POLL_MS = 10_000;
const FAST_POLLS = 5;
/** After a lost connection or a server error, try again after these waits (the last one repeats). */
const RETRY_MS = [3000, 10_000];
/** "Unavailable" is asked once more after this long: the songs' analysis may have finished meanwhile. */
const UNAVAILABLE_RETRY_MS = 60_000;
/** Not ready this close to the mix point: too late to load it, so the pair plays the usual way. */
const GIVE_UP_S = 20;
/**
 * A ready transition survives a seek that lands at least this long before its mix point: the engine
 * has its file loaded well ahead, and only needs a moment to start it.
 */
const READY_LEAD_S = 1;
/** After giving up, a jump back this far before the cut-off (a restart) is worth asking again. */
const RESTART_MARGIN_S = 10;

/** What's known of the transition into the next song: the server's answer, or "gave up" (fall back). */
export type UpcomingResult = TransitionAnswer | { status: 'gave up' };

export type ReadyTransition = Extract<TransitionAnswer, { status: 'ready' }> & { fromFileId: number; toFileId: number };

interface TransitionState {
  /**
   * The current → next pair, by file (as the decks know them). Null when no transition is wanted:
   * transitions aren't DJ mix, this queue's mix mode is off, there's no next song, or the sleep timer
   * stops at the end of this song. The songs then follow each other the usual way.
   */
  fromFileId: number | null;
  toFileId: number | null;
  /** Null until the server answers for this pair (and again while it's asked afresh after a seek). */
  result: UpcomingResult | null;
  /** The ready answer with its pair, kept as one object so components can select it without re-rendering. */
  ready: ReadyTransition | undefined;
}

/** The DJ transition from the song playing into the next one. */
export const useTransition = create<TransitionState>()(() => ({ fromFileId: null, toFileId: null, result: null, ready: undefined }));

/** The transition file to play between the two songs, once rendered. */
export const readyTransition = (s: TransitionState) => s.ready;

/** One pair being asked about. */
interface Pair {
  key: string;
  from: Track;
  to: Track;
  mode: MixMode;
  /**
   * Where the song was at the first ask, sent unchanged on every ask after: the server's plan (and so
   * its render) depends on it, and a later position could make it start over. Only a seek or restart
   * that leaves the answer behind changes it.
   */
  position?: number;
  /** Counts asks, so the answer to an ask that's been overtaken is ignored. */
  asks: number;
  asking: boolean;
  /** The next ask: the first one's short wait, a poll, a retry. */
  timer?: ReturnType<typeof setTimeout>;
  /** The plan's mix point in the song playing, once the server has planned it. */
  aStart?: number;
  polls: number;
  errors: number;
  askedAgainUnavailable: boolean;
  /** No more asking: answered for good, too late (a restart can undo it), or refused by the server. */
  ended?: 'answered' | 'late' | 'refused';
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
  /** The song whose listening time is counted (and its restarts), and how long it has played. */
  let playingFileId: number | undefined;
  let restartToken: number | undefined;
  let played = 0;
  /** The clock's last reading, and when (epoch ms) it came. */
  let lastTime: number | null = null;
  let lastAt = Date.now();

  function publish(p: Pair, result: UpcomingResult | null) {
    const ready = result?.status === 'ready' ? { ...result, fromFileId: p.from.fileId, toFileId: p.to.fileId } : undefined;
    useTransition.setState({ result, ready });
  }

  function later(p: Pair, ms: number) {
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      p.timer = undefined;
      maybeAsk();
    }, ms);
  }

  function drop() {
    clearTimeout(pair?.timer);
    pair = null;
  }

  /** Too close to the mix point to still be useful (before a plan, the song's end is as late as it gets). */
  const tooLate = (p: Pair) => useClock.getState().time >= (p.aStart ?? p.from.duration) - GIVE_UP_S;

  function giveUp(p: Pair, why: 'late' | 'refused') {
    clearTimeout(p.timer);
    p.timer = undefined;
    p.asking = false;
    p.ended = why;
    publish(p, { status: 'gave up' });
  }

  /** The answer no longer fits where the song is (a seek, a restart): ask afresh from here. */
  function startOver(p: Pair) {
    clearTimeout(p.timer);
    Object.assign(p, { timer: undefined, position: undefined, aStart: undefined, asking: false, ended: undefined, polls: 0, errors: 0 });
    p.asks++;
    publish(p, null);
  }

  /**
   * The pair's transition kept with a download, if any. Offline a Party queue takes the Auto one: a
   * mix beats none. Its plan assumes the song played from the start.
   */
  function keptTransition(p: Pair, online: boolean): KeptTransition | undefined {
    const kept = offlineTransition(p.from.fileId, p.to.fileId, p.mode);
    return kept ?? (!online && p.mode === 'party' ? offlineTransition(p.from.fileId, p.to.fileId, 'auto') : undefined);
  }

  function maybeAsk() {
    const p = pair;
    if (!p || p.ended) return;
    // A kept transition costs nothing to look up, so there's no waiting for it. Online, one whose mix
    // point is already too close is passed over, so the server can plan from where the song is.
    const online = navigator.onLine;
    const kept = keptTransition(p, online);
    if (kept && (!online || useClock.getState().time < kept.plan.aStart - GIVE_UP_S)) {
      clearTimeout(p.timer);
      p.timer = undefined;
      p.asking = false;
      p.asks++; // an ask still out is for nothing now
      return answered(p, kept);
    }
    if (p.asking || p.timer !== undefined || played < MIN_PLAYED_S || !online) return;
    if (tooLate(p)) return giveUp(p, 'late');
    p.asking = true;
    p.position ??= useClock.getState().time;
    const ask = ++p.asks;
    // The pair changed, started over or gave up meanwhile: this answer is for nothing now.
    const current = () => pair === p && p.asks === ask && !p.ended;
    api.transition(p.from.id, p.to.id, p.mode, p.position).then(
      (answer) => {
        if (!current()) return;
        p.asking = false;
        p.errors = 0;
        answered(p, answer);
      },
      (err: unknown) => {
        if (!current()) return;
        p.asking = false;
        failed(p, err);
      },
    );
  }

  function answered(p: Pair, answer: TransitionAnswer) {
    if (answer.status === 'pending' || answer.status === 'ready') {
      p.aStart = answer.plan.aStart;
      if (tooLate(p)) return giveUp(p, 'late');
    }
    publish(p, answer);
    if (answer.status === 'pending') {
      p.polls++;
      return later(p, p.polls >= FAST_POLLS || !usePlayer.getState().playing ? SLOW_POLL_MS : POLL_MS);
    }
    if (answer.status === 'unavailable' && !p.askedAgainUnavailable) {
      p.askedAgainUnavailable = true;
      return later(p, UNAVAILABLE_RETRY_MS);
    }
    p.ended = 'answered';
  }

  function failed(p: Pair, err: unknown) {
    // Offline: the 'online' event asks again.
    if (!navigator.onLine) return;
    const status = err instanceof ApiError ? err.status : 0;
    // A lost connection, too many requests, the server's own trouble: likely to pass.
    if (status === 0 || status === 429 || status >= 500) return later(p, RETRY_MS[Math.min(p.errors++, RETRY_MS.length - 1)]!);
    giveUp(p, 'refused');
  }

  /** The pair to ask about now, if any; a different one starts over. */
  function check() {
    const s = usePlayer.getState();
    const from = currentTrack(s);
    const to = upNext(s);
    if (from?.fileId !== playingFileId || s.restartToken !== restartToken) {
      // A new song, or this one from the start: its listening time starts from nothing (the clock may
      // still show where it was).
      playingFileId = from?.fileId;
      restartToken = s.restartToken;
      played = 0;
      lastTime = null;
    }
    const wanted =
      usePrefs.getState().transitions === 'dj' && s.mixMode !== 'off' && !useSleep.getState().endOfSong && !!from && !!to && from.fileId !== to.fileId;
    const key = wanted ? JSON.stringify([from.id, from.fileId, to.id, to.fileId, s.mixMode]) : null;
    if (key !== (pair?.key ?? null)) {
      drop();
      if (wanted) {
        pair = { key: key!, from: from!, to: to!, mode: s.mixMode, asks: 0, asking: false, polls: 0, errors: 0, askedAgainUnavailable: false };
        later(pair, FIRST_ASK_DELAY_MS);
      }
      useTransition.setState({ fromFileId: wanted ? from!.fileId : null, toFileId: wanted ? to!.fileId : null, result: null, ready: undefined });
    }
    maybeAsk();
  }

  /**
   * After a jump, the answer is for a mix point now behind (ready) or too close to render in time
   * (pending), or (given up) a restart left time again.
   */
  function outOfStep(p: Pair, time: number): boolean {
    const { result } = useTransition.getState();
    if (result?.status === 'ready' && time >= result.plan.aStart - READY_LEAD_S) return true;
    if (result?.status === 'pending' && time >= result.plan.aStart - GIVE_UP_S) return true;
    return p.ended === 'late' && time < (p.aStart ?? p.from.duration) - GIVE_UP_S - RESTART_MARGIN_S;
  }

  function onClock(time: number, seeked: boolean) {
    const now = Date.now();
    const step = lastTime === null ? NaN : time - lastTime;
    const elapsed = (now - lastAt) / 1000;
    // Listening moves the clock about as fast as time passes, even in the rare steps of a locked phone;
    // a seek, the slider dragged, or a new song's reset doesn't.
    const listening = !seeked && step > 0 && step <= elapsed * 1.25 + 0.5;
    if (listening) played += step;
    lastTime = time;
    lastAt = now;
    const p = pair;
    if (!p) return;
    if (!listening && outOfStep(p, time)) startOver(p);
    else if (!p.ended && tooLate(p)) return giveUp(p, 'late');
    maybeAsk();
  }

  check();
  // At mount the clock is the song playing's own; after a song change it isn't until the engine resets it.
  lastTime = useClock.getState().time;
  const offPlayer = usePlayer.subscribe(check);
  const offPrefs = usePrefs.subscribe((s, prev) => s.transitions !== prev.transitions && check());
  const offSleep = useSleep.subscribe((s, prev) => s.endOfSong !== prev.endOfSong && check());
  const offClock = useClock.subscribe((s, prev) => {
    const seeked = s.seekRequest !== prev.seekRequest;
    if (s.time !== prev.time || seeked) onClock(s.time, seeked);
  });
  // Back online the server can be asked; offline a download's kept transition may stand in.
  window.addEventListener('online', check);
  window.addEventListener('offline', check);
  return () => {
    offPlayer();
    offPrefs();
    offSleep();
    offClock();
    window.removeEventListener('online', check);
    window.removeEventListener('offline', check);
    drop();
    useTransition.setState({ fromFileId: null, toFileId: null, result: null, ready: undefined });
  };
}
