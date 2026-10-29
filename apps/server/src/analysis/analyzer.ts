import type { DatabaseSync } from 'node:sqlite';
import { recordingTags, type LbRecordingMetadata, type LbTag } from '../discover/listenbrainz.ts';
import type { Library } from '../library/library.ts';
import { mapPath, type MediaSource } from '../media/index.ts';
import { ANALYSIS_VERSION, analyzePcm, pcmToFloat, SAMPLE_RATE, type AudioFeatures } from './dsp.ts';

export interface TrackMeta {
  /** Strongest first. */
  tags: [tag: string, weight: number][];
  year?: number;
}

const MAX_SECONDS = 420;
const RETRY_FAILED_MS = 24 * 60 * 60_000;
const REFRESH_META_MS = 30 * 24 * 60 * 60_000;
const TAG_BATCH = 25;

/**
 * Background analysis of songs: audio features (ffmpeg where the files are, then dsp.ts) and
 * ListenBrainz tags. Everything is stored in SQLite, so each song is analyzed once.
 */
export class Analyzer {
  private readonly audioQueue = new Set<string>();
  private readonly running = new Set<string>();
  private readonly metaQueue = new Set<string>();
  private metaTimer: NodeJS.Timeout | undefined;
  private metaRunning = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly library: Library,
    private readonly media: MediaSource,
    private readonly opts: {
      enabled: boolean;
      pathMap: [string, string][];
      log: { warn: (obj: object, msg: string) => void };
      concurrency?: number;
    },
  ) {}

  /** Whether audio can be analyzed at all (needs ffmpeg through the media source). */
  get canAnalyzeAudio(): boolean {
    return this.opts.enabled && !!this.media.pcm;
  }

  features(ids: string[]): Map<string, AudioFeatures> {
    const rows = this.select<{ recording_id: string; features: string }>(
      'SELECT recording_id, features FROM track_features WHERE version = ? AND features IS NOT NULL AND recording_id IN',
      ids,
      [ANALYSIS_VERSION],
    );
    return new Map(rows.map((r) => [r.recording_id, JSON.parse(r.features) as AudioFeatures]));
  }

  meta(ids: string[]): Map<string, TrackMeta> {
    const rows = this.select<{ recording_id: string; tags: string; year: number | null }>(
      'SELECT recording_id, tags, year FROM track_meta WHERE recording_id IN',
      ids,
    );
    return new Map(rows.map((r) => [r.recording_id, { tags: JSON.parse(r.tags), year: r.year ?? undefined }]));
  }

  /** Queue whatever hasn't been analyzed (or tagged) yet. */
  ensure(ids: string[]) {
    const unique = [...new Set(ids)].filter((id) => !id.startsWith('track:'));
    if (!unique.length) return;
    if (this.canAnalyzeAudio) {
      const done = new Set(
        this.select<{ recording_id: string }>(
          'SELECT recording_id FROM track_features WHERE version = ? AND (features IS NOT NULL OR analyzed_at > ?) AND recording_id IN',
          unique,
          [ANALYSIS_VERSION, new Date(Date.now() - RETRY_FAILED_MS).toISOString()],
        ).map((r) => r.recording_id),
      );
      for (const id of unique) if (!done.has(id) && !this.running.has(id)) this.audioQueue.add(id);
      this.pump();
    }
    const tagged = new Set(
      this.select<{ recording_id: string }>(
        'SELECT recording_id FROM track_meta WHERE fetched_at > ? AND recording_id IN',
        unique,
        [new Date(Date.now() - REFRESH_META_MS).toISOString()],
      ).map((r) => r.recording_id),
    );
    const before = this.metaQueue.size;
    for (const id of unique) if (!tagged.has(id)) this.metaQueue.add(id);
    if (this.metaQueue.size > before) this.scheduleMeta();
  }

  /** How many of `ids` are still waiting for analysis or tags. */
  pending(ids: string[]): number {
    return new Set(ids.filter((id) => this.audioQueue.has(id) || this.running.has(id) || this.metaQueue.has(id))).size;
  }

  private pump() {
    const limit = this.opts.concurrency ?? 2;
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
    const save = this.db.prepare(
      `INSERT INTO track_features (recording_id, version, features, error, analyzed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (recording_id) DO UPDATE SET version = excluded.version, features = excluded.features,
         error = excluded.error, analyzed_at = excluded.analyzed_at`,
    );
    try {
      const track = await this.library.trackByRecording(id);
      const file = track && (await this.library.file(track.fileId));
      if (!file) throw new Error('Not in the library');
      const path = mapPath(file.path, this.opts.pathMap);
      const roots = this.opts.pathMap.map(([, to]) => (to.endsWith('/') ? to : `${to}/`));
      if (roots.length && !roots.some((root) => path.startsWith(root))) throw new Error('Outside the music folders');
      const pcm = await this.media.pcm!(path, { sampleRate: SAMPLE_RATE, maxSeconds: MAX_SECONDS });
      const features = analyzePcm(pcmToFloat(pcm));
      save.run(id, ANALYSIS_VERSION, JSON.stringify(features), null, new Date().toISOString());
    } catch (err) {
      this.opts.log.warn({ err, recordingId: id }, 'audio analysis failed');
      save.run(id, ANALYSIS_VERSION, null, (err as Error).message, new Date().toISOString());
    }
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
    try {
      while (this.metaQueue.size) {
        const batch = [...this.metaQueue].slice(0, TAG_BATCH);
        let data: Record<string, LbRecordingMetadata>;
        try {
          data = await recordingTags(batch);
        } catch (err) {
          // ListenBrainz unreachable: leave these for the next ensure() rather than storing "no tags".
          this.opts.log.warn({ err }, 'ListenBrainz tags unavailable');
          for (const id of batch) this.metaQueue.delete(id);
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
