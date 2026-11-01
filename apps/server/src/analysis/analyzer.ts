import type { DatabaseSync } from 'node:sqlite';
import { MIX_HEAD_SECONDS, MIX_MAP_VERSION, MIX_TAIL_SECONDS, type CuePoints, type MixMap } from '@playarr/mix';
import { RateLimited, recordingTags, type LbRecordingMetadata, type LbTag } from '../discover/listenbrainz.ts';
import type { FileResolver } from '../catalog/files.ts';
import type { Library } from '../library/library.ts';
import { seeksInexactly } from '../media/source.ts';
import { ANALYSIS_VERSION, SAMPLE_RATE, type AudioFeatures } from './dsp.ts';
import { DspThread, DspWorkerLost } from './dspThread.ts';

export interface TrackMeta {
  /** Strongest first. */
  tags: [tag: string, weight: number][];
  year?: number;
}

/**
 * The features and the mix map share one decode of the song's beginning (all of a shorter song).
 * The features are measured over exactly this much, so changing it needs an ANALYSIS_VERSION bump.
 */
const MAX_SECONDS = MIX_HEAD_SECONDS;
/** A decode still going after this is stuck (a hung share or ffmpeg): the song fails, to be tried another day. */
const DECODE_TIMEOUT_MS = 5 * 60_000;
/**
 * Finding a long song's end. Its last MIX_TAIL_SECONDS are decoded from a known position, so where
 * they sit in the song is exact: the library's length is MusicBrainz's (rounded, sometimes another
 * release's), and ffmpeg's -sseof goes by the container's idea of the length, which a VBR MP3
 * without a header gets wrong. The mix analysis carries the beat grid from the start of the song to
 * its end and allows 25 ms of difference, so the end has to be placed to the sample.
 *
 * The first window starts TAIL_MARGIN_SECONDS before where the library says the last 3 minutes
 * begin and runs TAIL_SPARE_SECONDS past them: a length off by up to half a minute either way is
 * found in one decode.
 */
const TAIL_MARGIN_SECONDS = 30;
const TAIL_SPARE_SECONDS = 60;
/**
 * A window that doesn't reach the end means the song runs longer than the library says (or it has
 * no length at all): the next starts 3 minutes before that one ended, so it still holds the last 3
 * minutes if the song ends just after, and is twice as long, up to MAX_TAIL_WINDOW_SECONDS (32
 * minutes: 42 MB of PCM, well within what one decode may return). After TAIL_TRIES windows, past
 * about 1 h 50 min, the map fails: a song that long is a DJ set, not something to mix.
 */
const MAX_TAIL_WINDOW_SECONDS = 1920;
const TAIL_TRIES = 6;
/** Decoded audio this close to what was asked for is all of it (ffmpeg's last frame may come up a little short). */
const FULL_SLACK_SECONDS = 0.05;
/** A song whose DSP worker went away is measured again this often before its failure is stored: it may be what kills the worker. */
const WORKER_LOST_RETRIES = 2;
const RETRY_FAILED_MS = 24 * 60 * 60_000;
const REFRESH_META_MS = 30 * 24 * 60 * 60_000;
const TAG_BATCH = 25;
/** Between tag requests when ListenBrainz isn't asking us to wait. */
const TAG_PAUSE_MS = 250;
const TAG_TRIES = 3;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Background analysis of songs: audio features and mix maps (ffmpeg where the files are, then dsp.ts
 * and @playarr/mix) and ListenBrainz tags. Everything is stored in SQLite, so each song is analyzed once.
 */
export class Analyzer {
  private readonly audioQueue = new Set<string>();
  /** Songs someone is waiting for (the one playing, a playlist being opened): measured before the library's backlog. */
  private readonly urgentQueue = new Set<string>();
  /** How often each song's DSP worker went away mid-measurement. */
  private readonly workerLosses = new Map<string, number>();
  private closed = false;
  private readonly running = new Set<string>();
  private readonly metaQueue = new Set<string>();
  private metaTimer: NodeJS.Timeout | undefined;
  private metaRunning = false;
  /** The number crunching runs off the main thread. */
  private readonly dsp: Pick<DspThread, 'analyze' | 'mixMap'>;
  /** The DSP thread this analyzer started itself (none when it was given the shared one). */
  private readonly ownDsp: DspThread | null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly library: Library,
    private readonly files: FileResolver,
    private readonly opts: {
      enabled: boolean;
      log: { warn: (obj: object, msg: string) => void };
      concurrency?: number;
      /** The server's one DSP thread, shared with transition rendering: the two take turns on one worker rather than both crunching at once. */
      dsp?: Pick<DspThread, 'analyze' | 'mixMap'>;
    },
  ) {
    this.ownDsp = opts.dsp ? null : new DspThread();
    this.dsp = opts.dsp ?? this.ownDsp!;
  }

  /** Stops background work, and the DSP thread if it's this analyzer's own (not the shared one). */
  close() {
    this.closed = true;
    this.audioQueue.clear();
    this.urgentQueue.clear();
    this.metaQueue.clear();
    clearTimeout(this.metaTimer);
    this.ownDsp?.close();
  }

  /** Whether audio analysis is on. Each song's source must also be able to decode it (ffmpeg). */
  get canAnalyzeAudio(): boolean {
    return this.opts.enabled;
  }

  /** How many songs have been measured, tagged and mapped for mixing: grows as background work finishes. */
  progress(): { features: number; meta: number; mixMaps: number } {
    const count = (table: string) => (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { features: count('track_features'), meta: count('track_meta'), mixMaps: count('mix_maps') };
  }

  features(ids: string[]): Map<string, AudioFeatures> {
    const rows = this.select<{ recording_id: string; features: string }>(
      'SELECT recording_id, features FROM track_features WHERE version = ? AND features IS NOT NULL AND recording_id IN',
      ids,
      [ANALYSIS_VERSION],
    );
    return new Map(rows.map((r) => [r.recording_id, JSON.parse(r.features) as AudioFeatures]));
  }

  /** Mix maps measured by the current version: an older one may disagree with today's planner. */
  mixMaps(ids: string[]): Map<string, MixMap> {
    const rows = this.select<{ recording_id: string; data: string }>(
      'SELECT recording_id, data FROM mix_maps WHERE version = ? AND data IS NOT NULL AND recording_id IN',
      ids,
      [MIX_MAP_VERSION],
    );
    return new Map(rows.map((r) => [r.recording_id, JSON.parse(r.data) as MixMap]));
  }

  /** Mix points set by hand, for the songs that have any. */
  cues(ids: string[]): Map<string, CuePoints> {
    const rows = this.select<{ recording_id: string; mix_in: number | null; mix_out: number | null }>(
      'SELECT recording_id, mix_in, mix_out FROM cue_points WHERE recording_id IN',
      ids,
    );
    return new Map(
      rows.map((r) => [
        r.recording_id,
        { ...(r.mix_in !== null ? { mixIn: r.mix_in } : {}), ...(r.mix_out !== null ? { mixOut: r.mix_out } : {}) },
      ]),
    );
  }

  /**
   * Sets a song's hand-set mix points, replacing both: one left out (or null) goes back to the
   * detected point. With neither, the song has no row at all.
   */
  setCues(recordingId: string, cues: { mixIn?: number | null; mixOut?: number | null }) {
    const mixIn = cues.mixIn ?? null;
    const mixOut = cues.mixOut ?? null;
    // The API checks these against the song; this keeps nonsense out of the table whoever calls.
    for (const t of [mixIn, mixOut]) {
      if (t !== null && !(Number.isFinite(t) && t >= 0)) throw new RangeError(`Invalid cue point: ${t}`);
    }
    if (mixIn !== null && mixOut !== null && mixIn >= mixOut) throw new RangeError('The mix-in point must come before the mix-out point');
    if (mixIn === null && mixOut === null) {
      this.db.prepare('DELETE FROM cue_points WHERE recording_id = ?').run(recordingId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO cue_points (recording_id, mix_in, mix_out, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (recording_id) DO UPDATE SET mix_in = excluded.mix_in, mix_out = excluded.mix_out,
           updated_at = excluded.updated_at`,
      )
      .run(recordingId, mixIn, mixOut, new Date().toISOString());
  }

  meta(ids: string[]): Map<string, TrackMeta> {
    const rows = this.select<{ recording_id: string; tags: string; year: number | null }>(
      'SELECT recording_id, tags, year FROM track_meta WHERE recording_id IN',
      ids,
    );
    return new Map(rows.map((r) => [r.recording_id, { tags: JSON.parse(r.tags), year: r.year ?? undefined }]));
  }

  /**
   * Queue whatever hasn't been analyzed (or tagged) yet; `audio: false` only fetches tags (cheap).
   * `urgent` is for songs someone is waiting for: they go ahead of the library's backlog, which
   * after an upgrade can be every song in it.
   */
  ensure(ids: string[], opts: { audio?: boolean; urgent?: boolean } = {}) {
    const unique = [...new Set(ids)].filter((id) => !id.startsWith('track:'));
    if (!unique.length || this.closed) return;
    if (this.canAnalyzeAudio && opts.audio !== false) {
      // Done once both the features and the mix map are measured by their current versions (or
      // failed recently): a song measured before mix maps existed, or before a version bump, is
      // measured again in the background.
      const features = this.featuresDone(unique);
      const maps = this.mixMapsDone(unique);
      for (const id of unique) {
        if ((features.has(id) && maps.has(id)) || this.running.has(id) || this.urgentQueue.has(id)) continue;
        if (opts.urgent) {
          this.audioQueue.delete(id);
          this.urgentQueue.add(id);
        } else this.audioQueue.add(id);
      }
      this.pump();
    }
    // ListenBrainz knows songs by MusicBrainz id only, and one unknown id fails a whole batch.
    const known = unique.filter((id) => MBID.test(id));
    const tagged = new Set(
      this.select<{ recording_id: string }>(
        'SELECT recording_id FROM track_meta WHERE fetched_at > ? AND recording_id IN',
        known,
        [new Date(Date.now() - REFRESH_META_MS).toISOString()],
      ).map((r) => r.recording_id),
    );
    const before = this.metaQueue.size;
    for (const id of known) if (!tagged.has(id)) this.metaQueue.add(id);
    if (this.metaQueue.size > before) this.scheduleMeta();
  }

  /**
   * How many of `ids` are still waiting for analysis or tags. `mixMaps: false` leaves out songs
   * waiting only for their mix map (a playlist cover needs features and tags, nothing more).
   */
  pending(ids: string[], opts: { mixMaps?: boolean } = {}): number {
    let audio = ids.filter((id) => this.urgentQueue.has(id) || this.audioQueue.has(id) || this.running.has(id));
    if (opts.mixMaps === false) {
      const measured = this.featuresDone(audio);
      audio = audio.filter((id) => !measured.has(id));
    }
    return new Set([...audio, ...ids.filter((id) => this.metaQueue.has(id))]).size;
  }

  /** Songs whose features are measured by the current version, or failed too recently to try again. */
  private featuresDone(ids: string[]): Set<string> {
    return this.doneIn('track_features', 'features', ANALYSIS_VERSION, ids);
  }

  /** Songs whose mix map is made by the current version, or failed too recently to try again. */
  private mixMapsDone(ids: string[]): Set<string> {
    return this.doneIn('mix_maps', 'data', MIX_MAP_VERSION, ids);
  }

  private doneIn(table: string, column: string, version: number, ids: string[]): Set<string> {
    const retryAfter = new Date(Date.now() - RETRY_FAILED_MS).toISOString();
    return new Set(
      this.select<{ recording_id: string }>(
        `SELECT recording_id FROM ${table} WHERE version = ? AND (${column} IS NOT NULL OR analyzed_at > ?) AND recording_id IN`,
        ids,
        [version, retryAfter],
      ).map((r) => r.recording_id),
    );
  }

  private pump() {
    // One song at a time: decoding and measuring are background work, the NAS has other things to do.
    const limit = this.opts.concurrency ?? 1;
    while (!this.closed && this.running.size < limit && (this.urgentQueue.size || this.audioQueue.size)) {
      const queue = this.urgentQueue.size ? this.urgentQueue : this.audioQueue;
      const id = queue.values().next().value!;
      queue.delete(id);
      this.running.add(id);
      void this.analyze(id).finally(() => {
        this.running.delete(id);
        this.pump();
      });
    }
  }

  private async analyze(id: string) {
    const saveFeatures = this.db.prepare(
      `INSERT INTO track_features (recording_id, version, features, error, analyzed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (recording_id) DO UPDATE SET version = excluded.version, features = excluded.features,
         error = excluded.error, analyzed_at = excluded.analyzed_at`,
    );
    const saveMixMap = this.db.prepare(
      `INSERT INTO mix_maps (recording_id, version, data, error, analyzed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (recording_id) DO UPDATE SET version = excluded.version, data = excluded.data,
         error = excluded.error, analyzed_at = excluded.analyzed_at`,
    );
    // Only what's missing (or failed long enough ago): a song measured before mix maps existed
    // keeps its features.
    const needsFeatures = !this.featuresDone([id]).has(id);
    const needsMixMap = !this.mixMapsDone([id]).has(id);
    let lost = false;
    const fail = (save: typeof saveFeatures, version: number, what: string, err: unknown) => {
      if (err instanceof DspWorkerLost) {
        // Nothing wrong with the song: measured again (soon) rather than failed for a day. Unless
        // it keeps happening, when the song may be what kills the worker, or the analyzer was closed.
        const losses = (this.workerLosses.get(id) ?? 0) + 1;
        this.workerLosses.set(id, losses);
        if (this.closed) return;
        if (losses <= WORKER_LOST_RETRIES) {
          lost = true;
          return;
        }
      }
      this.opts.log.warn({ err, recordingId: id }, `${what} failed`);
      save.run(id, version, null, (err as Error).message, new Date().toISOString());
    };

    let decoded;
    try {
      decoded = await this.decodeHead(id);
    } catch (err) {
      if (needsFeatures) fail(saveFeatures, ANALYSIS_VERSION, 'audio analysis', err);
      if (needsMixMap) fail(saveMixMap, MIX_MAP_VERSION, 'mix analysis', err);
      return;
    }
    const { pcm, findEnd } = decoded;

    if (needsFeatures) {
      try {
        const features = await this.dsp.analyze(pcm);
        saveFeatures.run(id, ANALYSIS_VERSION, JSON.stringify(features), null, new Date().toISOString());
      } catch (err) {
        fail(saveFeatures, ANALYSIS_VERSION, 'audio analysis', err);
      }
    }
    if (needsMixMap) {
      try {
        const { tail, duration } = await findEnd().catch((err: Error) => {
          throw new Error(`tail: ${err.message}`, { cause: err });
        });
        const map = await this.dsp.mixMap(pcm, tail, duration);
        saveMixMap.run(id, MIX_MAP_VERSION, JSON.stringify(map), null, new Date().toISOString());
      } catch (err) {
        fail(saveMixMap, MIX_MAP_VERSION, 'mix analysis', err);
      }
    }
    if (lost) this.urgentQueue.add(id); // next, once this run is over (see pump)
    else this.workerLosses.delete(id);
  }

  /**
   * The song's first MAX_SECONDS as mono PCM at SAMPLE_RATE, and a way to find its end: its exact
   * duration and, for a song longer than that, its last MIX_TAIL_SECONDS (null for a shorter one,
   * which the head holds all of).
   */
  private async decodeHead(id: string) {
    const track = await this.library.trackByRecording(id);
    const file = track && (await this.library.file(track.fileId));
    if (!file) throw new Error('Not in the library');
    const { media, path } = this.files.resolve(file);
    const decode = media.pcm?.bind(media);
    if (!decode) throw new Error('This source can’t decode audio for analysis');
    const signal = () => AbortSignal.timeout(DECODE_TIMEOUT_MS);
    const head = await decode(path, { sampleRate: SAMPLE_RATE, maxSeconds: MAX_SECONDS, signal: signal() });
    const exactSeek = seeksInexactly(track.format);
    const read = (startSeconds: number, maxSeconds: number) =>
      decode(path, { sampleRate: SAMPLE_RATE, startSeconds, maxSeconds, ...(exactSeek ? { exactSeek } : {}), signal: signal() });
    const findEnd = async (): Promise<{ tail: Buffer | null; duration: number }> => {
      // Less than asked for: that's the whole song, to the sample.
      if (secondsOf(head) < MAX_SECONDS - FULL_SLACK_SECONDS) return { tail: null, duration: secondsOf(head) };
      return this.findEnd(read, head, track.duration);
    };
    return { pcm: head, findEnd };
  }

  /**
   * The last MIX_TAIL_SECONDS of a song whose first MAX_SECONDS are `head`, and its duration, by
   * decoding windows at known positions until one stops short of what was asked: there is the end.
   * `listed` (the library's length, maybe 0) only says where to look first.
   */
  private async findEnd(
    read: (startSeconds: number, maxSeconds: number) => Promise<Buffer>,
    head: Buffer,
    listed: number,
  ): Promise<{ tail: Buffer; duration: number }> {
    const headSeconds = secondsOf(head);
    let start = Math.max(headSeconds, Math.floor(listed - MIX_TAIL_SECONDS - TAIL_MARGIN_SECONDS));
    let window = MIX_TAIL_SECONDS + TAIL_SPARE_SECONDS;
    for (let tries = 0; tries < TAIL_TRIES; tries++) {
      const pcm = await read(start, window);
      const got = secondsOf(pcm);
      if (got >= window - FULL_SLACK_SECONDS) {
        // Not the end yet: the song runs on past where the library says.
        start += got - MIX_TAIL_SECONDS;
        window = Math.min(window * 2, MAX_TAIL_WINDOW_SECONDS);
        continue;
      }
      if (got === 0 && start > headSeconds) {
        // Started past the end: the song is shorter than the library says. It ends after the head.
        start = headSeconds;
        continue;
      }
      const duration = start + got;
      const tailStart = Math.max(0, duration - MIX_TAIL_SECONDS);
      if (tailStart >= start - 1e-6) return { tail: pcm.subarray(byteAt(tailStart - start)), duration };
      // The window began inside the last 3 minutes. Right after the head, their start is in the head.
      if (start <= headSeconds) return { tail: Buffer.concat([head.subarray(byteAt(tailStart), byteAt(start)), pcm]), duration };
      // Else the song is shorter than the library says: decode them again, now that the end is known.
      start = Math.max(headSeconds, tailStart);
    }
    throw new Error(`No end found in the first ${Math.round((start + MIX_TAIL_SECONDS) / 60)} minutes`);
  }

  private scheduleMeta() {
    clearTimeout(this.metaTimer);
    // Short pause so a playlist's songs go out together in a few batches.
    this.metaTimer = setTimeout(() => void this.fetchMeta(), 300);
  }

  private async fetchMeta() {
    if (this.metaRunning) return;
    this.metaRunning = true;
    const save = this.db.prepare(
      `INSERT INTO track_meta (recording_id, tags, year, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (recording_id) DO UPDATE SET tags = excluded.tags, year = excluded.year, fetched_at = excluded.fetched_at`,
    );
    let failures = 0;
    try {
      while (this.metaQueue.size) {
        const batch = [...this.metaQueue].slice(0, TAG_BATCH);
        let data: Record<string, LbRecordingMetadata>;
        try {
          const answer = await recordingTags(batch);
          data = answer.data;
          failures = 0;
          // Pace by what ListenBrainz says is left; a whole library is thousands of requests.
          await sleep(answer.remaining !== undefined && answer.remaining <= 1 ? (answer.resetIn ?? 10) * 1000 : TAG_PAUSE_MS);
        } catch (err) {
          if (err instanceof RateLimited) {
            await sleep(err.retryIn * 1000);
            continue; // the same batch again
          }
          // Unreachable: a few tries a while apart, then leave the rest for the next ensure() (never
          // store "no tags" for songs that weren't asked about).
          if (++failures < TAG_TRIES) {
            await sleep(30_000 * failures);
            continue;
          }
          this.opts.log.warn({ err }, 'ListenBrainz tags unavailable');
          this.metaQueue.clear();
          break;
        }
        const now = new Date().toISOString();
        for (const id of batch) {
          const meta = toMeta(data[id]);
          save.run(id, JSON.stringify(meta.tags), meta.year ?? null, now);
          this.metaQueue.delete(id);
        }
      }
    } finally {
      this.metaRunning = false;
    }
  }

  /** SELECT … IN (ids), chunked to stay under SQLite's parameter limit. */
  private select<T>(sql: string, ids: string[], params: (string | number)[] = []): T[] {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      if (!chunk.length) continue;
      const stmt = this.db.prepare(`${sql} (${chunk.map(() => '?').join(',')})`);
      out.push(...(stmt.all(...params, ...chunk) as T[]));
    }
    return out;
  }
}

/** Recording tags count most, then the album's, then the artist's; each scaled to its strongest tag. */
function toMeta(meta: LbRecordingMetadata | undefined): TrackMeta {
  const weights = new Map<string, number>();
  const scopes: [LbTag[] | undefined, number][] = [
    [meta?.tag?.recording, 1],
    [meta?.tag?.release_group, 0.6],
    [meta?.tag?.artist, 0.4],
  ];
  for (const [tags, scopeWeight] of scopes) {
    const max = Math.max(1, ...(tags ?? []).map((t) => t.count));
    for (const t of tags ?? []) {
      const tag = t.tag.toLowerCase().trim();
      weights.set(tag, (weights.get(tag) ?? 0) + (scopeWeight * t.count) / max);
    }
  }
  const tags = [...weights]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([tag, w]): [string, number] => [tag, Math.round(w * 1000) / 1000]);
  const year = Number(meta?.recording?.first_release_date?.slice(0, 4)) || meta?.release?.year;
  return { tags, year: year && year > 1000 ? year : undefined };
}

/** Seconds of mono s16le PCM at SAMPLE_RATE. */
const secondsOf = (pcm: Buffer) => pcm.length / 2 / SAMPLE_RATE;
/** Where `seconds` into mono s16le PCM at SAMPLE_RATE starts, in bytes. */
const byteAt = (seconds: number) => Math.round(seconds * SAMPLE_RATE) * 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());
