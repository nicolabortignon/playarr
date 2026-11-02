/**
 * Loudness analysis: each song's loudness and peak (see loudness.ts), measured from its whole file in
 * one decoding pass, a second or two a song. It has its own queue, apart from beat and sound analysis
 * (most of a minute a song on a small server), so the next song's level never waits behind them.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { FileResolver } from '../catalog/files.ts';
import type { Library } from '../library/library.ts';
import type { MediaSource } from '../media/source.ts';
import { LOUDNESS_RATE, LoudnessMeter, type Loudness } from './loudness.ts';
import { selectIn } from './sql.ts';

/** Bump when the measurement changes: every song is measured again (what's there stays in use meanwhile). */
export const LOUDNESS_VERSION = 1;
/** A failed measurement is tried again after this long. */
const RETRY_FAILED_MS = 24 * 60 * 60_000;
/** Longest a song's measurement may take: a long DJ mix on a busy NAS included. */
const MEASURE_TIMEOUT_MS = 10 * 60_000;
/** A song is measured over at most this much of it: hours-long files are recordings, not songs. */
const MAX_SECONDS = 4 * 3600;
/** Where a source can't stream a decode (over SSH from a dev machine), it's decoded this much at a time. */
const CHUNK_SECONDS = 60;
/** A chunk this much shorter than asked for was the file's end. */
const CHUNK_SLACK_SECONDS = 0.05;

/** A song's measured loudness, as stored: which file it was measured from, and that file's size and time. */
export interface SongLoudness {
  recordingId: string;
  fileId: number;
  /** Integrated loudness (LUFS); null for silence. */
  lufs: number | null;
  /** Peak sample (dBFS); null for silence. */
  peak: number | null;
  /** Sample frames the file decodes to at LOUDNESS_RATE. */
  samples: number;
  size: number;
  mtimeMs: number;
}

interface Row {
  recording_id: string;
  file_id: number;
  lufs: number | null;
  peak: number | null;
  samples: number;
  size: number;
  mtime_ms: number;
}

const toSong = (r: Row): SongLoudness => ({ recordingId: r.recording_id, fileId: r.file_id, lufs: r.lufs, peak: r.peak, samples: r.samples, size: r.size, mtimeMs: r.mtime_ms });

export class LoudnessJobs {
  private readonly urgent = new Set<string>();
  private readonly backlog = new Set<string>();
  private readonly running = new Set<string>();
  private readonly stop = new AbortController();

  constructor(
    private readonly db: DatabaseSync,
    private readonly library: Pick<Library, 'trackByRecording' | 'file'>,
    private readonly files: FileResolver,
    private readonly log: { warn: (obj: object, msg: string) => void },
    /** When Settings → Analysis last asked for every song again (an ISO time, '' if never). */
    private readonly redoneFrom: () => string,
  ) {}

  close() {
    this.stop.abort();
    this.urgent.clear();
    this.backlog.clear();
  }

  /** Songs waiting to be measured, and being measured now. */
  get waiting() {
    return this.urgent.size + this.backlog.size;
  }
  get working() {
    return this.running.size;
  }

  /**
   * Queues the songs not measured yet (by this version, since the last Analyse all again; failures a
   * day old are tried again): `urgent` ones, a song about to play, ahead of the rest. Answers how many
   * were queued (those already waiting or being measured aren't counted again).
   */
  ensure(ids: string[], opts: { urgent?: boolean } = {}): number {
    const done = this.done(ids);
    let queued = 0;
    for (const id of ids) {
      if (done.has(id) || this.running.has(id) || this.urgent.has(id)) continue;
      if (opts.urgent) {
        if (!this.backlog.delete(id)) queued++;
        this.urgent.add(id);
      } else if (!this.backlog.has(id)) {
        this.backlog.add(id);
        queued++;
      }
    }
    this.pump();
    return queued;
  }

  /** The songs measured (by any version: an older one's level is still a level), silent ones included. */
  measured(ids: string[]): Map<string, SongLoudness> {
    const rows = selectIn<Row>(
      this.db,
      'SELECT recording_id, file_id, lufs, peak, samples, size, mtime_ms FROM track_loudness WHERE error IS NULL AND recording_id IN',
      ids,
    );
    return new Map(rows.map((r) => [r.recording_id, toSong(r)]));
  }

  /** The measurement made from this file, if one was. */
  ofFile(fileId: number): SongLoudness | undefined {
    const row = this.db
      .prepare('SELECT recording_id, file_id, lufs, peak, samples, size, mtime_ms FROM track_loudness WHERE error IS NULL AND file_id = ?')
      .get(fileId) as Row | undefined;
    return row && toSong(row);
  }

  /** A song's file changed (replaced, re-tagged): measured again, at once, as someone is about to hear it. */
  remeasure(id: string) {
    this.db.prepare('DELETE FROM track_loudness WHERE recording_id = ?').run(id);
    this.ensure([id], { urgent: true });
  }

  private done(ids: string[]): Set<string> {
    const retryAfter = new Date(Date.now() - RETRY_FAILED_MS).toISOString();
    return new Set(
      selectIn<{ recording_id: string }>(
        this.db,
        'SELECT recording_id FROM track_loudness WHERE version = ? AND analyzed_at >= ? AND (error IS NULL OR analyzed_at > ?) AND recording_id IN',
        ids,
        [LOUDNESS_VERSION, this.redoneFrom(), retryAfter],
      ).map((r) => r.recording_id),
    );
  }

  private pump() {
    // One song at a time: it's a background job (each is quick, the NAS has other things to do).
    while (!this.stop.signal.aborted && this.running.size === 0 && (this.urgent.size || this.backlog.size)) {
      const queue = this.urgent.size ? this.urgent : this.backlog;
      const id = queue.values().next().value!;
      queue.delete(id);
      this.running.add(id);
      void this.measure(id).finally(() => {
        this.running.delete(id);
        this.pump();
      });
    }
  }

  private async measure(id: string) {
    const save = this.db.prepare(
      `INSERT INTO track_loudness (recording_id, file_id, version, lufs, peak, samples, size, mtime_ms, error, analyzed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (recording_id) DO UPDATE SET file_id = excluded.file_id, version = excluded.version, lufs = excluded.lufs,
         peak = excluded.peak, samples = excluded.samples, size = excluded.size, mtime_ms = excluded.mtime_ms,
         error = excluded.error, analyzed_at = excluded.analyzed_at`,
    );
    let fileId = 0;
    try {
      const track = await this.library.trackByRecording(id);
      const file = track && (await this.library.file(track.fileId));
      if (!track || !file) throw new Error('Not in the library');
      fileId = track.fileId;
      const { media, path } = this.files.resolve(file);
      const { size, mtimeMs } = await media.stat(path);
      const signal = AbortSignal.any([this.stop.signal, AbortSignal.timeout(MEASURE_TIMEOUT_MS)]);
      const result = await measureFile(media, path, signal);
      const peak = Number.isFinite(result.peak) ? result.peak : null;
      save.run(id, fileId, LOUDNESS_VERSION, result.lufs, peak, result.samples, size, mtimeMs, null, new Date().toISOString());
    } catch (err) {
      if (this.stop.signal.aborted) return;
      this.log.warn({ err, recordingId: id }, 'loudness analysis failed');
      save.run(id, fileId, LOUDNESS_VERSION, null, null, null, null, null, (err as Error).message, new Date().toISOString());
    }
  }
}

/** Measures a file's loudness from one decode of all of it: streamed where the source can, else in chunks. */
export async function measureFile(media: MediaSource, path: string, signal: AbortSignal): Promise<Loudness> {
  const meter = new LoudnessMeter(LOUDNESS_RATE);
  const decode = { sampleRate: LOUDNESS_RATE, channels: 2 as const, signal };
  if (media.pcmStream) {
    for await (const chunk of media.pcmStream(path, { ...decode, maxSeconds: MAX_SECONDS })) meter.push(chunk as Buffer);
    return meter.result();
  }
  if (!media.pcm) throw new Error('This source can’t decode audio for analysis');
  // Exact seeks, so the chunks join without a gap or an overlap (and the length comes out exact).
  for (let start = 0; start < MAX_SECONDS; start += CHUNK_SECONDS) {
    const chunk = await media.pcm(path, { ...decode, startSeconds: start, maxSeconds: CHUNK_SECONDS, exactSeek: true });
    meter.push(chunk);
    if (chunk.length / (LOUDNESS_RATE * 4) < CHUNK_SECONDS - CHUNK_SLACK_SECONDS) break;
  }
  return meter.result();
}
