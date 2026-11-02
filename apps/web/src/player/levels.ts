import type { Track, TrackLevel } from '@playarr/shared';
import { create } from 'zustand';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { levelDb, type QueueState } from './decks';
import { useOffline } from './offline';

/** Songs not measured yet are asked about again after this long: measuring one takes a second or two. */
const RETRY_MS = 15_000;

interface Levels {
  levels: Record<string, TrackLevel>;
  /**
   * The gain (dB) each file was last loaded at, by file id: its levelled stream's, or null for its own
   * file. A transition out of or into it is made at the same level.
   */
  loaded: Record<number, number | null>;
}

/** How loud each song is, as far as the server has measured: for even volume. */
export const useLevels = create<Levels>()(() => ({ levels: {}, loaded: {} }));

const asked = new Map<string, number>();

/** Learn the levels of these songs, unless known or asked lately. */
export async function loadLevels(tracks: (Track | undefined)[]): Promise<void> {
  const now = Date.now();
  const known = useLevels.getState().levels;
  const ids = [...new Set(tracks.flatMap((t) => (t ? [t.recordingId] : [])))].filter(
    (id) => !known[id] && now - (asked.get(id) ?? 0) > RETRY_MS,
  );
  if (!ids.length) return;
  for (const id of ids) asked.set(id, now);
  try {
    const found = await api.levels(ids);
    if (Object.keys(found).length) useLevels.setState((s) => ({ levels: { ...s.levels, ...found } }));
  } catch {
    for (const id of ids) asked.delete(id);
  }
}

/** Songs whose levelled stream wouldn't play this session: they play their own file. */
const unlevelled = new Set<number>();

/** The levelled stream of this song failed: its own file from now on. */
export function levelledStreamFailed(t: Track) {
  unlevelled.add(t.fileId);
}

/**
 * The gain (dB) a song plays at from its levelled stream (the server's copy at its even-volume level,
 * turned up as well as down, and on iPhones too); undefined for its own file at its own volume:
 * levelling off, not measured yet, kept on this device (the kept file plays), or its stream failed.
 */
export function streamGain(t: Track, s: QueueState): number | undefined {
  const level = useLevels.getState().levels[t.recordingId];
  if (!level || !usePrefs.getState().levelVolume || unlevelled.has(t.fileId) || t.fileId in useOffline.getState().songs) return undefined;
  return t.streamUrl?.startsWith('/stream/') ? levelDb(t, level, s) : undefined;
}

/** A song's levelled stream at this gain. */
export const levelledUrl = (t: Track, db: number) => `${t.streamUrl}/levelled.wav?gain=${db}`;

/** An element was loaded with this song at this gain (null: its own file). */
export function loadedAt(t: Track, db: number | undefined) {
  const now = db ?? null;
  if (useLevels.getState().loaded[t.fileId] !== now) useLevels.setState((s) => ({ loaded: { ...s.loaded, [t.fileId]: now } }));
}

/**
 * The gain (dB) a song plays at: as it was loaded, if it was (a song started before its level was
 * known plays its own file to its end), else as it will be (see streamGain). Undefined: its own volume.
 */
export function playsAt(t: Track, s: QueueState): number | undefined {
  const loaded = useLevels.getState().loaded[t.fileId];
  return loaded !== undefined ? (loaded ?? undefined) : streamGain(t, s);
}

