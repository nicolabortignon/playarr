import type { DatabaseSync } from 'node:sqlite';
import { MIX_HEAD_SECONDS, MIX_MAP_VERSION, MIX_TAIL_SECONDS, type CuePoints, type MixMap } from '@playarr/mix';
import { RateLimited, recordingTags, type LbRecordingMetadata, type LbTag } from '../discover/listenbrainz.ts';
import type { FileResolver } from '../catalog/files.ts';
import type { Library } from '../library/library.ts';
import { ANALYSIS_VERSION, SAMPLE_RATE, type AudioFeatures } from './dsp.ts';
import { DspThread } from './dspThread.ts';

export interface TrackMeta {
  /** Strongest first. */
  tags: [tag: string, weight: number][];
  year?: number;
}

/** The features and the mix map share one decode of the song's beginning (all of a shorter song). */
const MAX_SECONDS = MIX_HEAD_SECONDS;
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
  private readonly running = new Set<string>();
  private readonly metaQueue = new Set<string>();
  private metaTimer: NodeJS.Timeout | undefined;
  private metaRunning = false;
  /** The number crunching runs off the main thread. */
  private readonly dsp: Pick<DspThread, 'analyze' | 'mixMap'>;

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
    this.dsp = opts.dsp ?? new DspThread();
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

  /** Queue whatever hasn't been analyzed (or tagged) yet; `audio: false` only fetches tags (cheap). */
  ensure(ids: string[], opts: { audio?: boolean } = {}) {
    const unique = [...new Set(ids)].filter((id) => !id.startsWith('track:'));
    if (!unique.length) return;
    if (this.canAnalyzeAudio && opts.audio !== false) {
      // Done once both the features and the mix map are measured by their current versions (or
      // failed recently): a song measured before mix maps existed, or before a version bump, is
      // measured again in the background.
      const retryAfter = new Date(Date.now() - RETRY_FAILED_MS).toISOString();
      const done = new Set(
        this.select<{ recording_id: string }>(
          `SELECT f.recording_id FROM track_features f JOIN mix_maps m ON m.recording_id = f.recording_id
           WHERE f.version = ? AND (f.features IS NOT NULL OR f.analyzed_at > ?)
             AND m.version = ? AND (m.data IS NOT NULL OR m.analyzed_at > ?) AND f.recording_id IN`,
          unique,
          [ANALYSIS_VERSION, retryAfter, MIX_MAP_VERSION, retryAfter],
        ).map((r) => r.recording_id),
      );
      for (const id of unique) if (!done.has(id) && !this.running.has(id)) this.audioQueue.add(id);
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

  /** How many of `ids` are still waiting for analysis or tags. */
  pending(ids: string[]): number {
    return new Set(ids.filter((id) => this.audioQueue.has(id) || this.running.has(id) || this.metaQueue.has(id))).size;
  }

  private pump() {
    // One song at a time: decoding and measuring are background work, the NAS has other things to do.
    const limit = this.opts.concurrency ?? 1;
    while (this.running.size < limit && this.audioQueue.size) {
      const id = this.audioQueue.values().next().value!;
      this.audioQueue.delete(id);
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
    // Only what's missing: a song measured before mix maps existed keeps its features.
    const needsFeatures = !this.features([id]).has(id);
    const needsMixMap = !this.mixMaps([id]).has(id);
    const fail = (save: typeof saveFeatures, version: number, what: string, err: unknown) => {
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
    const { pcm, duration, decodeTail } = decoded;

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
        // A long song's outro is past the head: its end is decoded too. Without it the map's outro
        // would be somewhere in the middle of the song, so a failed tail fails the map.
        const tail = duration > MIX_HEAD_SECONDS ? await decodeTail() : null;
        const map = await this.dsp.mixMap(pcm, tail, duration);
        saveMixMap.run(id, MIX_MAP_VERSION, JSON.stringify(map), null, new Date().toISOString());
      } catch (err) {
        fail(saveMixMap, MIX_MAP_VERSION, 'mix analysis', err);
      }
    }
  }

  /**
   * The song's first MAX_SECONDS as mono PCM at SAMPLE_RATE, its duration (the library's, else what
   * was decoded), and a way to decode its last MIX_TAIL_SECONDS as well.
   */
  private async decodeHead(id: string) {
    const track = await this.library.trackByRecording(id);
    const file = track && (await this.library.file(track.fileId));
    if (!file) throw new Error('Not in the library');
    const { media, path } = this.files.resolve(file);
    const decode = media.pcm?.bind(media);
    if (!decode) throw new Error('This source can’t decode audio for analysis');
    const pcm = await decode(path, { sampleRate: SAMPLE_RATE, maxSeconds: MAX_SECONDS });
    const decodedSeconds = pcm.length / 2 / SAMPLE_RATE;
    const duration = track.duration > 0 ? track.duration : decodedSeconds;
    const decodeTail = () => decode(path, { sampleRate: SAMPLE_RATE, maxSeconds: MIX_TAIL_SECONDS, fromEnd: true });
    return { pcm, duration, decodeTail };
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());
