import type { Track, TrackLevel } from '@playarr/shared';
import { create } from 'zustand';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { playQuality } from '../lib/quality';
import { canSetVolume, isDesktop, levelDb, type QueueState } from './decks';
import { keptCopy } from './offline';

/** Songs not measured yet are asked about again after this long: measuring one takes a second or two. */
const RETRY_MS = 15_000;

interface Levels {
  levels: Record<string, TrackLevel>;
  /**
   * The gain (dB) each file was last loaded at, by file id: its levelled stream's, or the one Web Audio plays
   * it at on a desktop (graphGain); null at its own volume. A transition out of or into it is made at the same
   * level.
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
 * Every element can play through Web Audio here (a desktop browser that can set the volume and route an
 * element: see JoinGraph): joins are lined up on the sound, and even volume is a gain on the way out, up
 * as well as down (graphGain), so songs play their own files, or their encoded streams, never levelled ones.
 */
export function playsThroughGraph(): boolean {
  return (
    isDesktop() &&
    canSetVolume() &&
    typeof AudioContext !== 'undefined' &&
    typeof (AudioContext.prototype as Partial<AudioContext> | undefined)?.createMediaElementSource === 'function'
  );
}

/**
 * The gain (dB) a song plays at from its levelled stream (the server's copy at its even-volume level,
 * turned up as well as down), where nothing else can level it (phones and tablets: see graphGain);
 * undefined for its own file at its own volume: levelling off, not measured yet, a copy kept on this device
 * playing instead (see keptCopy), or its stream failed.
 */
export function streamGain(t: Track, s: QueueState): number | undefined {
  const level = useLevels.getState().levels[t.recordingId];
  if (!level || !usePrefs.getState().levelVolume || unlevelled.has(t.fileId) || keptCopy(t, playQuality()) !== undefined) return undefined;
  if (playsThroughGraph()) return undefined;
  return t.streamUrl?.startsWith('/stream/') ? levelDb(t, level, s) : undefined;
}

/**
 * The gain (dB) Web Audio plays a song at on a desktop (see playsThroughGraph), whatever it plays from: its
 * own file, its encoded stream or a copy kept on this device. Undefined elsewhere, with levelling off, or
 * before the song is measured.
 */
export function graphGain(t: Track, s: QueueState): number | undefined {
  const level = useLevels.getState().levels[t.recordingId];
  if (!level || !usePrefs.getState().levelVolume || !playsThroughGraph()) return undefined;
  return levelDb(t, level, s);
}

/** A song's levelled stream at this gain, uncompressed (Original quality: lib/quality.ts has the encoded ones). */
export const levelledUrl = (t: Track, db: number) => `${t.streamUrl}/levelled.wav?gain=${db}`;

/** An element was loaded with this song at this gain (null: its own file). */
export function loadedAt(t: Track, db: number | undefined) {
  const now = db ?? null;
  if (useLevels.getState().loaded[t.fileId] !== now) useLevels.setState((s) => ({ loaded: { ...s.loaded, [t.fileId]: now } }));
}

/**
 * The gain (dB) a song plays at: as it was loaded, if it was (a song started before its level was
 * known keeps what it started with to its end), else as it will be (see streamGain and graphGain).
 * Undefined: its own volume.
 */
export function playsAt(t: Track, s: QueueState): number | undefined {
  const loaded = useLevels.getState().loaded[t.fileId];
  return loaded !== undefined ? (loaded ?? undefined) : (streamGain(t, s) ?? graphGain(t, s));
}

