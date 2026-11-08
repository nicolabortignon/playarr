import type { AudioFormat, Track } from '@playarr/shared';
import { isObject } from '../lib/saved';

/*
 * The queue as it's saved (plan 3 §3). A Track as the server sends it is about 540 bytes of JSON (490 as IndexedDB
 * keeps it, a structured clone), most of it its album's (title, artist, cover, colors) and its field names: a
 * 10,000-song queue was 5 MB, written whole at every change. Saved, each album's details are written once, each kind
 * of format once, and each song as a row of its own values: about 130 bytes a song, a quarter (queueCodec.test.ts
 * measures it). A song the queue holds twice is one row. Whatever a song has that its row doesn't hold (a field that
 * differs from its album's, a stream other than /stream/<fileId>, a field this version doesn't know) goes with it as
 * it is, so a queue comes back exactly as it went.
 */

const ALBUM_FIELDS = ['albumTitle', 'artistId', 'artistName', 'coverUrl', 'coverColor', 'coverAccent'] as const;
const ROW_FIELDS = ['id', 'recordingId', 'fileId', 'albumId', 'title', 'trackNumber', 'discNumber', 'duration', 'explicit'] as const;
const COVERED = new Set<string>([...ALBUM_FIELDS, ...ROW_FIELDS, 'format', 'size', 'streamUrl']);

type Value = string | number | boolean | null;
/** A format without its bitrate, which differs from file to file. */
type Kind = Omit<AudioFormat, 'bitrate'>;

export interface SavedQueue {
  v: 1;
  /** Each album's details (ALBUM_FIELDS, null where it has none), by album id. */
  albums: Record<string, Value[]>;
  kinds: Kind[];
  /** A song: ROW_FIELDS, its format's kind (-1 for none) and bitrate, its size, then whatever else it has. */
  rows: unknown[][];
  /** The rows in queue order, when a song is in the queue more than once; else the rows are the queue. */
  queue?: number[];
}

const KIND_AT = ROW_FIELDS.length;
const BITRATE_AT = KIND_AT + 1;
const SIZE_AT = KIND_AT + 2;
const REST_AT = KIND_AT + 3;

const field = (t: Track, f: string): Value => (t as unknown as Record<string, Value | undefined>)[f] ?? null;

export function compactQueue(tracks: readonly Track[]): SavedQueue {
  const albums: Record<string, Value[]> = {};
  const kinds: Kind[] = [];
  const kindIndex = new Map<string, number>();
  const rows: unknown[][] = [];
  const rowOf = new Map<Track, number>();
  const queue: number[] = [];
  let repeats = false;

  function rowFor(t: Track): unknown[] {
    const album = (albums[String(t.albumId)] ??= ALBUM_FIELDS.map((f) => field(t, f)));
    const rest: Record<string, unknown> = {};
    ALBUM_FIELDS.forEach((f, i) => {
      if (field(t, f) !== album[i]) rest[f] = field(t, f);
    });
    if (t.streamUrl !== `/stream/${t.fileId}`) rest.streamUrl = field(t, 'streamUrl');
    for (const [key, value] of Object.entries(t)) if (!COVERED.has(key) && value !== undefined) rest[key] = value;
    let kind = -1;
    let bitrate: number | null = null;
    if (t.format) {
      const { bitrate: kbps, ...kindOf } = t.format;
      const key = JSON.stringify(kindOf);
      kind = kindIndex.get(key) ?? kinds.push(kindOf) - 1;
      kindIndex.set(key, kind);
      bitrate = kbps ?? null;
    }
    const row: unknown[] = [...ROW_FIELDS.map((f) => field(t, f)), kind, bitrate, field(t, 'size')];
    return Object.keys(rest).length ? [...row, rest] : row;
  }

  for (const t of tracks) {
    let row = rowOf.get(t);
    if (row === undefined) {
      row = rows.push(rowFor(t)) - 1;
      rowOf.set(t, row);
    } else repeats = true;
    queue.push(row);
  }
  return { v: 1, albums, kinds, rows, ...(repeats ? { queue } : {}) };
}

/** The queue a SavedQueue holds; undefined when it isn't one. */
export function expandQueue(saved: unknown): Track[] | undefined {
  if (!isObject(saved) || saved.v !== 1 || !isObject(saved.albums) || !Array.isArray(saved.kinds) || !Array.isArray(saved.rows)) return undefined;
  const albums = saved.albums;
  const kinds: unknown[] = saved.kinds;
  const tracks: Track[] = [];
  for (const row of saved.rows as unknown[]) {
    if (!Array.isArray(row)) return undefined;
    const t: Record<string, unknown> = {};
    const album: unknown = albums[String(row[3])];
    if (Array.isArray(album)) ALBUM_FIELDS.forEach((f, i) => album[i] != null && (t[f] = album[i]));
    ROW_FIELDS.forEach((f, i) => row[i] != null && (t[f] = row[i]));
    const kind = kinds[row[KIND_AT] as number];
    if (isObject(kind)) t.format = row[BITRATE_AT] != null ? { ...kind, bitrate: row[BITRATE_AT] } : { ...kind };
    if (row[SIZE_AT] != null) t.size = row[SIZE_AT];
    t.streamUrl = `/stream/${String(t.fileId)}`;
    const rest: unknown = row[REST_AT];
    if (isObject(rest)) {
      for (const [key, value] of Object.entries(rest)) {
        if (value === null) delete t[key];
        else t[key] = value;
      }
    }
    tracks.push(t as unknown as Track);
  }
  if (saved.queue === undefined) return tracks;
  if (!Array.isArray(saved.queue)) return undefined;
  return (saved.queue as unknown[]).flatMap((i) => (typeof i === 'number' && tracks[i] ? [tracks[i]] : []));
}
