import { create } from 'zustand';

/**
 * One leader tab (plan 3 §3). Of the tabs open on this device, one plays, downloads, loads ahead, reports plays and
 * deletes kept audio: the one holding the Web Lock "playarr.leader". The others wait in line for it, so one takes
 * over when it closes. They follow the records it saves, pass it their queue edits, and say "Playing in another tab".
 * Playing anything in one of them takes the lock at once: the old leader pauses and lets go, and the new one carries
 * on its downloads. Without Web Locks every tab is its own leader, as before. Tabs tell each other what changed over
 * a BroadcastChannel.
 */

const LOCK = 'playarr.leader';
const CHANNEL = 'playarr.tabs';

/** Where the player bar says what's playing, in a tab that follows one playing. */
export const PLAYING_ELSEWHERE = 'Playing in another tab';

export type TabMessage =
  /** Records written in IndexedDB: read them again. */
  | { type: 'saved'; keys: string[] }
  /** The leader started or stopped playing (also its answer to hello). */
  | { type: 'status'; playing: boolean }
  /** A tab opened: the leader says whether it's playing. */
  | { type: 'hello' }
  /** A follower's queue edit, for the leader to make (player/store.ts). `at`: the queue it was made on. */
  | { type: 'do'; action: string; args: unknown[]; at?: { pos: number; length: number } }
  /** Remove all, pressed in a follower: the leader deletes the audio. */
  | { type: 'clear' }
  /** How far the leader's download is, for the rings in other tabs. */
  | { type: 'progress'; active: { fileId: number; loaded: number; total: number } | null };

interface TabsState {
  /** This tab plays and keeps the device's songs; the others follow it. */
  leading: boolean;
  /** Another tab leads, and is playing. */
  elsewhere: boolean;
}

/** Web Locks, where the browser has them (not happy-dom, nor browsers before 2022). */
export function lockManager(): LockManager | null {
  const locks = typeof navigator === 'undefined' ? null : (navigator as { locks?: LockManager | null }).locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

export const useTabs = create<TabsState>()(() => ({ leading: !lockManager(), elsewhere: false }));

export const isLeader = () => useTabs.getState().leading;

let channel: BroadcastChannel | null = null;
const handlers = new Map<TabMessage['type'], Set<(msg: TabMessage) => void>>();
const leavingHooks = new Set<() => void>();

/** Tell the other tabs. */
export function post(msg: TabMessage) {
  channel?.postMessage(msg);
}

/** Hear what other tabs say of this type. Returns the undo. */
export function onTabMessage<T extends TabMessage['type']>(type: T, fn: (msg: Extract<TabMessage, { type: T }>) => void): () => void {
  let set = handlers.get(type);
  if (!set) handlers.set(type, (set = new Set()));
  const handler = fn as (msg: TabMessage) => void;
  set.add(handler);
  return () => set.delete(handler);
}

/** Run `fn` as this tab stops leading, while it still counts as the leader (the last report of a song, say). */
export function onLeaving(fn: () => void): () => void {
  leavingHooks.add(fn);
  return () => leavingHooks.delete(fn);
}

let started = false;
/** The request whose lock this tab holds, if it holds one. */
let holding: number | null = null;
/** Its request waiting in line, withdrawn when it takes the lock instead. */
let inLine: AbortController | null = null;
let requests = 0;

/** At startup: get in line for the lead (or take it, if no tab has it), and listen to the other tabs. */
export function startTabs() {
  if (started) return;
  started = true;
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<TabMessage>) => {
      for (const fn of handlers.get(event.data?.type) ?? []) fn(event.data);
    };
  }
  if (!lockManager()) return;
  ask(false);
  post({ type: 'hello' });
}

/** Lead from now on: playing something here. The old leader pauses and lets go once it hears its lock was taken. */
export function takeOver() {
  if (isLeader() || !lockManager()) return;
  // At once, not when the lock comes: the press that plays must start the audio itself (browsers allow it only then).
  useTabs.setState({ leading: true, elsewhere: false });
  ask(true);
}

function ask(steal: boolean) {
  const id = ++requests;
  inLine?.abort();
  inLine = null;
  const withdraw = new AbortController();
  if (!steal) inLine = withdraw;
  let granted = false;
  lockManager()!
    .request(LOCK, steal ? { steal: true } : { signal: withdraw.signal }, () => {
      granted = true;
      if (inLine === withdraw) inLine = null;
      holding = id;
      if (!isLeader()) useTabs.setState({ leading: true, elsewhere: false });
      // Held until the tab closes, or another tab takes it.
      return new Promise<void>(() => {});
    })
    .catch(() => {
      // Withdrawn (this tab took the lock instead), or taken by a tab that plays now.
      if (granted && holding === id) lose();
    });
}

function lose() {
  holding = null;
  for (const fn of leavingHooks) {
    try {
      fn();
    } catch (err) {
      console.error(err);
    }
  }
  // The tab that took it is playing.
  useTabs.setState({ leading: false, elsewhere: true });
  // In line again, for when that tab closes.
  ask(false);
}
