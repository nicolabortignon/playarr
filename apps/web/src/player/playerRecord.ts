import type { MixMode } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { getMany, setMany } from 'idb-keyval';
import { canSave, forgetLegacy, isObject, readLegacy, writer } from '../lib/saved';
import { healQueue } from './healQueue';
import { compactQueue, expandQueue } from './queueCodec';
import { MIX_MODES, type PlayerState, type PlaySource, QUEUE_EDITS, type QueueEdit, type RepeatMode, usePlayer } from './store';
import { isLeader, onLeaving, onTabMessage, post, takeOver, useTabs } from './tabs';

/*
 * The player's saved record (plan 3 §3), in IndexedDB. The queue, compacted (queueCodec.ts), is under
 * playarr.player.queue and written only when the queue changes; the play order, the position and the player's
 * settings are under playarr.player; where the song is, which changes as it plays, is under playarr.player.resumeAt on
 * its own, so the queue isn't written again every few seconds. Only the leader tab writes it (player/tabs.ts); the
 * others read it again whenever it's written, and follow it. It's read once at startup (hydratePlayer): until then the
 * queue is empty, so nothing resumes on an unread record.
 */

const KEYS = { queue: 'playarr.player.queue', state: 'playarr.player', resumeAt: 'playarr.player.resumeAt' } as const;
type Slice = keyof typeof KEYS;
const SLICES = Object.keys(KEYS) as Slice[];
/** Where zustand's persist kept the player in localStorage, until IndexedDB has it. */
const LEGACY = 'playarr.player';

const FIELDS = {
  queue: ['queue'],
  state: ['order', 'pos', 'shuffle', 'repeat', 'volume', 'muted', 'source', 'mixMode'],
  resumeAt: ['resumeAt'],
} as const satisfies Record<Slice, readonly (keyof PlayerState)[]>;
const SAVED_FIELDS: readonly (keyof PlayerState)[] = SLICES.flatMap((slice) => FIELDS[slice]);
/** What belongs to the queue played, rather than to the player's settings: taken or left together. */
const QUEUE_FIELDS = new Set<keyof PlayerState>(['queue', 'order', 'pos', 'source', 'mixMode', 'resumeAt']);
const REPEATS: readonly RepeatMode[] = ['off', 'all', 'one'];

/** Changed here and not written yet. */
const dirty = new Set<Slice>();
/** Fields changed before the record was read (something played at once): they keep what they are now. */
const touched = new Set<keyof PlayerState>();
/** The localStorage copy goes once the IndexedDB one is written. */
let migrating = false;
/** Taking in the leader's record: not a change of this tab's to write. */
let following = false;
/** This tab is letting go of the lead: it says nothing more of what it plays. */
let leaving = false;
let healed = false;

const record = writer(
  'the queue',
  async () => {
    if (!usePlayer.getState().hydrated || !isLeader() || !dirty.size) return;
    const slices = [...dirty];
    dirty.clear();
    const s = usePlayer.getState();
    const entries = slices.map((slice): [string, unknown] => [KEYS[slice], encode(slice, s)]);
    try {
      await setMany(entries);
    } catch (err) {
      for (const slice of slices) dirty.add(slice);
      throw err;
    }
    if (migrating && slices.length === SLICES.length) {
      forgetLegacy(LEGACY);
      migrating = false;
    }
    post({ type: 'saved', keys: entries.map(([key]) => key) });
  },
  500,
);

function encode(slice: Slice, s: PlayerState): unknown {
  if (slice === 'queue') return compactQueue(s.queue);
  if (slice === 'resumeAt') return s.resumeAt;
  return { order: s.order, pos: s.pos, shuffle: s.shuffle, repeat: s.repeat, volume: s.volume, muted: s.muted, source: s.source, mixMode: s.mixMode };
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const finiteOr = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const isSource = (v: unknown): v is PlaySource => isObject(v) && typeof v.label === 'string' && typeof v.href === 'string';

/** The play order, position and settings, made to fit a queue of `length` songs. */
function readState(v: unknown, length: number): Partial<PlayerState> {
  const s = isObject(v) ? v : {};
  const order = Array.isArray(s.order) ? s.order.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < length) : range(length);
  const pos = Number.isInteger(s.pos) ? Math.max(-1, Math.min(s.pos as number, order.length - 1)) : order.length ? 0 : -1;
  return {
    order,
    pos,
    shuffle: s.shuffle === true,
    repeat: REPEATS.includes(s.repeat as RepeatMode) ? (s.repeat as RepeatMode) : 'off',
    volume: Math.min(1, Math.max(0, finiteOr(s.volume, 1))),
    muted: s.muted === true,
    source: isSource(s.source) ? s.source : undefined,
    // A mix mode this version doesn't know (or none, from before mixing) plays as Auto.
    mixMode: MIX_MODES.includes(s.mixMode as MixMode) ? (s.mixMode as MixMode) : 'auto',
  };
}

/** The player as some of its slices say, read back; the rest as it is now. */
function decode(read: Partial<Record<Slice, unknown>>): Partial<PlayerState> {
  const out: Partial<PlayerState> = {};
  let length = usePlayer.getState().queue.length;
  if ('queue' in read) {
    out.queue = expandQueue(read.queue) ?? [];
    length = out.queue.length;
  }
  if ('state' in read) Object.assign(out, readState(read.state, length));
  if ('resumeAt' in read) out.resumeAt = Math.max(0, finiteOr(read.resumeAt, 0));
  return out;
}

/** The player as zustand's persist kept it in localStorage: whole tracks, and everything else beside them. */
function fromLegacy(legacy: Record<string, unknown>): Partial<PlayerState> {
  const queue = Array.isArray(legacy.queue) && legacy.queue.every(isObject) ? (legacy.queue as unknown as Track[]) : [];
  return { queue, ...readState(legacy, queue.length), resumeAt: Math.max(0, finiteOr(legacy.resumeAt, 0)) };
}

function follow(next: Partial<PlayerState>) {
  following = true;
  try {
    usePlayer.setState(next);
  } finally {
    following = false;
  }
}

let hydration: Promise<void> | undefined;

/** Read the saved player once, at startup (from localStorage the first time, then IndexedDB). */
export function hydratePlayer(): Promise<void> {
  return (hydration ??= load());
}

async function load() {
  if (usePlayer.getState().hydrated) return;
  let saved: Partial<PlayerState> = {};
  try {
    const [queue, state, resumeAt] = await getMany(SLICES.map((slice) => KEYS[slice]));
    if (queue === undefined && state === undefined && resumeAt === undefined) {
      const legacy = readLegacy(LEGACY);
      if (legacy) {
        saved = fromLegacy(legacy);
        migrating = true;
      }
    } else {
      saved = decode({ queue, state, resumeAt });
    }
  } catch (err) {
    console.warn('Playarr couldn’t read the saved queue', err);
    // IndexedDB won't open (an older browser's private window): the copy localStorage may still have.
    const legacy = readLegacy(LEGACY);
    if (legacy) {
      saved = fromLegacy(legacy);
      migrating = true;
    }
  }
  // Something played before the record was read: that queue stays, and the saved one is left (settings changed meanwhile too).
  const queueTouched = [...touched].some((f) => QUEUE_FIELDS.has(f));
  const kept = (f: keyof PlayerState) => touched.has(f) || (queueTouched && QUEUE_FIELDS.has(f));
  follow({ ...Object.fromEntries(Object.entries(saved).filter(([f]) => !kept(f as keyof PlayerState))), hydrated: true });
  // What stays is written over what was saved, even where it didn't change (a new queue starting at 0 as the saved one did not).
  for (const slice of SLICES) if (migrating || FIELDS[slice].some(kept)) dirty.add(slice);
  if (dirty.size) record.schedule();
  heal();
}

/** A queue saved by an older version, refreshed once by the tab that plays (player/healQueue.ts). */
function heal() {
  if (healed || !isLeader() || !usePlayer.getState().hydrated) return;
  healed = true;
  void healQueue();
}

let reloads: Promise<void> = Promise.resolve();

/** Read again what the leader wrote, one read after another, and follow it. */
function reload(keys: string[]) {
  const slices = SLICES.filter((slice) => keys.includes(KEYS[slice]));
  if (!slices.length) return;
  reloads = reloads.then(async () => {
    if (isLeader() || !usePlayer.getState().hydrated) return;
    try {
      const values = await getMany(slices.map((slice) => KEYS[slice]));
      if (isLeader()) return;
      follow(decode(Object.fromEntries(slices.map((slice, i) => [slice, values[i]]))));
    } catch (err) {
      console.warn('Playarr couldn’t read the queue saved by another tab', err);
    }
  });
}

usePlayer.subscribe((s, prev) => {
  if (s.playing !== prev.playing) {
    // Playing anything here makes this the tab that plays: the other one pauses and lets go (player/tabs.ts).
    if (s.playing && !isLeader()) takeOver();
    if (isLeader() && !leaving) post({ type: 'status', playing: s.playing });
  }
  if (following) return;
  if (!s.hydrated) for (const f of SAVED_FIELDS) if (s[f] !== prev[f]) touched.add(f);
  let changed = false;
  for (const slice of SLICES) {
    if (FIELDS[slice].some((f) => s[f] !== prev[f])) {
      dirty.add(slice);
      changed = true;
    }
  }
  if (changed && canSave()) record.schedule();
});

useTabs.subscribe((s, prev) => {
  if (s.leading === prev.leading) return;
  if (s.leading) {
    post({ type: 'status', playing: usePlayer.getState().playing });
    if (dirty.size && canSave()) record.schedule();
    heal();
  } else {
    // The tab that took the lead writes the record now: this one follows it.
    dirty.clear();
    reload(Object.values(KEYS));
  }
});

onLeaving(() => {
  leaving = true;
  try {
    usePlayer.setState({ playing: false });
  } finally {
    leaving = false;
  }
});

onTabMessage('saved', ({ keys }) => reload(keys));
onTabMessage('hello', () => isLeader() && post({ type: 'status', playing: usePlayer.getState().playing }));
onTabMessage('status', ({ playing }) => !isLeader() && useTabs.setState({ elsewhere: playing }));
onTabMessage('do', ({ action, args, at }) => {
  if (!isLeader() || !(QUEUE_EDITS as readonly string[]).includes(action)) return;
  const s = usePlayer.getState();
  // Made on a queue that has moved on since: it would land on other songs.
  if (at && (at.pos !== s.pos || at.length !== s.order.length)) return;
  (s[action as QueueEdit] as (...a: unknown[]) => void)(...args);
});
