import type { DatabaseSync } from 'node:sqlite';
import { BEAT_THIS_RATE, LoudnessFrames, MIX_HEAD_SECONDS, MIX_MAP_VERSION, MIX_TAIL_SECONDS, type CuePoints, type MixMap, type MixMapSummary } from '@playarr/mix';
import { RateLimited, recordingTags, type LbRecordingMetadata, type LbTag } from '../discover/listenbrainz.ts';
import type { FileResolver } from '../catalog/files.ts';
import type { Library } from '../library/library.ts';
import { seeksInexactly } from '../media/source.ts';
import type { BeatModelThread } from './beatModelThread.ts';
import { ANALYSIS_VERSION, pcmToFloat, SAMPLE_RATE, type AudioFeatures, type SoundFeatures } from './dsp.ts';
import { DspThread, DspWorkerLost, type MiddleLoudness, type SongBeats } from './dspThread.ts';
import { LOUDNESS_VERSION, LoudnessJobs, type SongLoudness } from './loudnessJobs.ts';
import { selectIn } from './sql.ts';

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
/**
 * Songs are decoded at the beat model's rate (22050 Hz); the DSP thread halves it for the features and
 * the rest of the mix analysis (SAMPLE_RATE).
 */
const DECODE_RATE = BEAT_THIS_RATE;
/** A long song's middle is decoded this much at a time where the source can't stream it. */
const MIDDLE_CHUNK_SECONDS = 120;
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
 * minutes: 85 MB of PCM at 22050 Hz, within what one decode may return). After TAIL_TRIES windows, past
 * about 1 h 50 min, the map fails: a song that long is a DJ set, not something to mix.
 */
const MAX_TAIL_WINDOW_SECONDS = 1920;
const TAIL_TRIES = 6;
/** Decoded audio this close to what was asked for is all of it (ffmpeg's last frame may come up a little short). */
const FULL_SLACK_SECONDS = 0.05;
/** A song whose DSP worker went away is measured again this often before its failure is stored: it may be what kills the worker. */
const WORKER_LOST_RETRIES = 2;
const RETRY_FAILED_MS = 24 * 60 * 60_000;
/**
 * app_settings keys: when each kind of analysis was last asked to run again on every song (Settings →
 * Analysis; an ISO time). What was made before doesn't count as done or ready, though it stays in use
 * until its song is redone.
 */
const REDO_KEYS = { beats: 'mixMapsRedoneFrom', sound: 'featuresRedoneFrom', loudness: 'loudnessRedoneFrom', tags: 'tagsRedoneFrom' } as const;
/** The analyses Settings → Analysis runs: beat analysis (mix maps), sound analysis (features), loudness analysis, tag lookup. */
export type AnalysisKind = keyof typeof REDO_KEYS;
/** A MusicBrainz recording id, as SQL LIKE sees one: only those have tags to look up. */
const MBID_LIKE = '________-____-____-____-____________';
/**
 * Mix maps from this version on have today's shape and meaning (version 2 put firstBeat up to three
 * beats before the music's first downbeat). An older map than the current one stays in use until its
 * song is measured again, so a new version doesn't leave the library without DJ mix for the hours
 * that takes; it just doesn't count as ready.
 */
const OLDEST_USABLE_MIX_MAP = 2;
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
  /** Queued for sound analysis only (Settings → Analysis): their mix maps wait for a play or a beat analysis. */
  private readonly soundOnly = new Set<string>();
  private metaTimer: NodeJS.Timeout | undefined;
  private metaRunning = false;
  /** The number crunching runs off the main thread. */
  private readonly dsp: Pick<DspThread, 'analyze' | 'mixMap'>;
  /** The DSP thread this analyzer started itself (none when it was given the shared one). */
  private readonly ownDsp: DspThread | null;
  /** Loudness analysis, on its own queue (it's quick, and the next song's level can't wait). */
  private readonly loudnessJobs: LoudnessJobs;

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
      /** The beat model, which finds the beats and bars of mix maps; without it (or when it can't run), the onset analysis does. */
      beats?: Pick<BeatModelThread, 'activations'>;
      /** false: no loudness analysis (it decodes every song once more, on its own queue). */
      loudness?: boolean;
    },
  ) {
    this.ownDsp = opts.dsp ? null : new DspThread();
    this.dsp = opts.dsp ?? this.ownDsp!;
    this.loudnessJobs = new LoudnessJobs(db, library, files, opts.log, () => this.redoneFrom('loudness'));
  }

  /** Stops background work, and the DSP thread if it's this analyzer's own (not the shared one). */
  close() {
    this.closed = true;
    this.audioQueue.clear();
    this.urgentQueue.clear();
    this.metaQueue.clear();
    this.soundOnly.clear();
    this.loudnessJobs.close();
    clearTimeout(this.metaTimer);
    this.ownDsp?.close();
  }

  /** Whether audio analysis is on. Each song's source must also be able to decode it (ffmpeg). */
  get canAnalyzeAudio(): boolean {
    return this.opts.enabled;
  }

  /**
   * How many songs have been measured, tagged and mapped for mixing: grows as background work finishes.
   * Measurements count only from the current version and when they worked, so a new version (which
   * measures everything again) changes the counts as songs are redone.
   */
  progress(): { features: number; meta: number; mixMaps: number } {
    const count = (sql: string, ...params: number[]) => (this.db.prepare(sql).get(...params) as { n: number }).n;
    return {
      features: count('SELECT COUNT(*) AS n FROM track_features WHERE version = ? AND features IS NOT NULL', ANALYSIS_VERSION),
      meta: count('SELECT COUNT(*) AS n FROM track_meta'),
      mixMaps: count('SELECT COUNT(*) AS n FROM mix_maps WHERE version = ? AND data IS NOT NULL', MIX_MAP_VERSION),
    };
  }

  /**
   * Settings → Analysis: how far each analysis has got over the library (songs with a file in an
   * enabled source, `track:` ids left out), cheap enough to poll.
   * - beats: mix maps from the current version since Analyse all again, those whose beats the beat
   *   model found, and recent failures;
   * - sound: features from the current version since Analyse all again, and recent failures;
   * - loudness: the same for loudness measurements (silent songs count: there's nothing to level);
   * - tags: of the songs with a MusicBrainz id (the only ones ListenBrainz knows), those looked up
   *   since Look up all again (a lookup that found no tags counts: there's nothing more to find);
   * - waiting / working: songs queued for beat or sound analysis and being measured; the same for
   *   loudness; tagsWaiting: for lookup.
   */
  analysisProgress(): {
    songs: number;
    beats: { ready: number; beatModel: number; failed: number };
    sound: { ready: number; failed: number };
    loudness: { ready: number; failed: number };
    tags: { ready: number; songs: number };
    waiting: number;
    working: number;
    loudnessWaiting: number;
    loudnessWorking: number;
    tagsWaiting: number;
  } {
    const retryAfter = new Date(Date.now() - RETRY_FAILED_MS).toISOString();
    const row = this.db
      .prepare(
        `WITH library AS (
           SELECT DISTINCT t.recording_id AS id FROM catalog_tracks t
           JOIN copies c ON c.track_id = t.id JOIN sources s ON s.id = c.source_id
           WHERE s.enabled = 1 AND t.recording_id NOT LIKE 'track:%'
         )
         SELECT COUNT(*) AS songs,
           COUNT(CASE WHEN m.data IS NOT NULL THEN 1 END) AS beatsReady,
           COUNT(CASE WHEN m.data IS NOT NULL AND json_extract(m.data, '$.beatsFrom') = 'model' THEN 1 END) AS beatModel,
           COUNT(CASE WHEN m.recording_id IS NOT NULL AND m.data IS NULL AND m.analyzed_at > ? THEN 1 END) AS beatsFailed,
           COUNT(CASE WHEN f.features IS NOT NULL THEN 1 END) AS soundReady,
           COUNT(CASE WHEN f.recording_id IS NOT NULL AND f.features IS NULL AND f.analyzed_at > ? THEN 1 END) AS soundFailed,
           COUNT(CASE WHEN lo.recording_id IS NOT NULL AND lo.error IS NULL THEN 1 END) AS loudnessReady,
           COUNT(CASE WHEN lo.error IS NOT NULL AND lo.analyzed_at > ? THEN 1 END) AS loudnessFailed,
           COUNT(CASE WHEN l.id LIKE ? THEN 1 END) AS taggable,
           COUNT(CASE WHEN l.id LIKE ? AND tm.recording_id IS NOT NULL THEN 1 END) AS tagsReady
         FROM library l
         LEFT JOIN mix_maps m ON m.recording_id = l.id AND m.version = ? AND m.analyzed_at >= ?
         LEFT JOIN track_features f ON f.recording_id = l.id AND f.version = ? AND f.analyzed_at >= ?
         LEFT JOIN track_loudness lo ON lo.recording_id = l.id AND lo.version = ? AND lo.analyzed_at >= ?
         LEFT JOIN track_meta tm ON tm.recording_id = l.id AND tm.fetched_at >= ?`,
      )
      .get(
        retryAfter,
        retryAfter,
        retryAfter,
        MBID_LIKE,
        MBID_LIKE,
        MIX_MAP_VERSION,
        this.redoneFrom('beats'),
        ANALYSIS_VERSION,
        this.redoneFrom('sound'),
        LOUDNESS_VERSION,
        this.redoneFrom('loudness'),
        this.redoneFrom('tags'),
      ) as Record<
      'songs' | 'beatsReady' | 'beatModel' | 'beatsFailed' | 'soundReady' | 'soundFailed' | 'loudnessReady' | 'loudnessFailed' | 'taggable' | 'tagsReady',
      number
    >;
    return {
      songs: row.songs,
      beats: { ready: row.beatsReady, beatModel: row.beatModel, failed: row.beatsFailed },
      sound: { ready: row.soundReady, failed: row.soundFailed },
      loudness: { ready: row.loudnessReady, failed: row.loudnessFailed },
      tags: { ready: row.tagsReady, songs: row.taggable },
      waiting: this.urgentQueue.size + this.audioQueue.size,
      working: this.running.size,
      loudnessWaiting: this.loudnessJobs.waiting,
      loudnessWorking: this.loudnessJobs.working,
      tagsWaiting: this.metaQueue.size,
    };
  }

  /** The songs' loudness measurements (silent songs included: their lufs is null), and the file each was measured from. */
  loudness(ids: string[]): Map<string, SongLoudness> {
    return this.loudnessJobs.measured(ids);
  }

  /** The loudness measured from this file, if it was: what its levelled stream is made from. */
  loudnessOfFile(fileId: number): SongLoudness | undefined {
    return this.loudnessJobs.ofFile(fileId);
  }

  /** A song's file changed since its loudness was measured: measured again, at once. */
  remeasureLoudness(id: string) {
    if (this.canAnalyzeAudio && !this.closed) this.loudnessJobs.remeasure(id);
  }

  /**
   * The songs' features: how each sounds (sound analysis), with its tempo and how sure the beat is from
   * its beat analysis (its mix map; 0 until it has one). One tempo for every use: the one DJ mix plays by.
   */
  features(ids: string[]): Map<string, AudioFeatures> {
    const rows = this.select<{ recording_id: string; features: string }>(
      'SELECT recording_id, features FROM track_features WHERE version = ? AND features IS NOT NULL AND recording_id IN',
      ids,
      [ANALYSIS_VERSION],
    );
    const beats = this.mixSummaries(rows.map((r) => r.recording_id));
    return new Map(
      rows.map((r) => {
        // Features measured before sound analysis left the tempo to beat analysis still hold their own: left out.
        const { bpm: _bpm, pulse: _pulse, ...sound } = JSON.parse(r.features) as SoundFeatures & { bpm?: number; pulse?: number };
        const beat = beats.get(r.recording_id);
        const bpm = beat && beat.bpm > 0 ? Math.round(beat.bpm * 10) / 10 : 0;
        const pulse = bpm ? Math.round(Math.min(1, Math.max(0, beat!.beatConfidence || 0)) * 100) / 100 : 0;
        return [r.recording_id, { ...sound, bpm, pulse }];
      }),
    );
  }

  /**
   * Each song's mix map: the current version's, or an older one still in use until its song is measured
   * again (see OLDEST_USABLE_MIX_MAP). Older than that, a map may disagree with today's planner.
   */
  mixMaps(ids: string[]): Map<string, MixMap> {
    const rows = this.select<{ recording_id: string; data: string }>(
      'SELECT recording_id, data FROM mix_maps WHERE version >= ? AND data IS NOT NULL AND recording_id IN',
      ids,
      [OLDEST_USABLE_MIX_MAP],
    );
    return new Map(rows.map((r) => [r.recording_id, JSON.parse(r.data) as MixMap]));
  }

  /**
   * What blending needs from the current mix maps (tempo, how sure and steady the beat is, key), for every song a
   * mix might hold: SQLite picks the fields out, so the rest of each map (beat grid, phrase energy) is
   * never parsed. Steady means where the song is mixed (edgesStable), for maps that know it; older ones
   * only know whether it holds over the whole song.
   */
  mixSummaries(ids: string[]): Map<string, MixMapSummary> {
    const rows = this.select<{ recording_id: string; bpm: number; beat_confidence: number; grid_stable: number | null; key: string | null }>(
      `SELECT recording_id, json_extract(data, '$.bpm') AS bpm, json_extract(data, '$.beatConfidence') AS beat_confidence,
         COALESCE(json_extract(data, '$.edgesStable'), json_extract(data, '$.gridStable')) AS grid_stable, json_extract(data, '$.key') AS key
       FROM mix_maps WHERE version >= ? AND data IS NOT NULL AND recording_id IN`,
      ids,
      [OLDEST_USABLE_MIX_MAP],
    );
    return new Map(
      rows.map((r) => [
        r.recording_id,
        {
          bpm: r.bpm,
          beatConfidence: r.beat_confidence,
          // JSON true comes out of SQLite as 1.
          gridStable: r.grid_stable === 1,
          ...(r.key ? { key: JSON.parse(r.key) as NonNullable<MixMap['key']> } : {}),
        },
      ]),
    );
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
   * after an upgrade can be every song in it. Answers how many songs it queued for audio analysis
   * (songs already waiting or being measured aren't counted again).
   */
  ensure(ids: string[], opts: { audio?: boolean; urgent?: boolean; beats?: boolean; sound?: boolean; loudness?: boolean; tags?: boolean } = {}): number {
    const unique = [...new Set(ids)].filter((id) => !id.startsWith('track:'));
    if (!unique.length || this.closed) return 0;
    let queued = 0;
    if (this.canAnalyzeAudio && opts.audio !== false) {
      // Beat and sound analysis share a decode: a song is queued for whichever of the two is asked for
      // and not done by its current version (or failed recently). `beats: false` asks for the features
      // alone, `sound: false` for the mix map (the features come too if they're missing: they're cheap
      // once the song is decoded).
      const beats = opts.beats !== false;
      const sound = opts.sound !== false;
      const features = sound ? this.featuresDone(unique) : new Set<string>();
      const maps = beats ? this.mixMapsDone(unique) : new Set<string>();
      if (beats || sound) {
        for (const id of unique) {
          // Being measured for its sound alone: measured again once that's done, for its mix map.
          const forSoundAlone = beats && this.running.has(id) && this.soundOnly.has(id);
          if (beats) this.soundOnly.delete(id);
          const busy = (this.running.has(id) && !forSoundAlone) || this.urgentQueue.has(id);
          const needed = (beats && !maps.has(id)) || (sound && !features.has(id));
          if (!needed || busy) continue;
          if (!beats && !this.audioQueue.has(id)) this.soundOnly.add(id);
          if (opts.urgent) {
            if (!this.audioQueue.delete(id)) queued++;
            this.urgentQueue.add(id);
          } else if (!this.audioQueue.has(id)) {
            this.audioQueue.add(id);
            queued++;
          }
        }
        this.pump();
      }
      if (opts.loudness !== false && this.opts.loudness !== false) this.loudnessJobs.ensure(unique, { urgent: opts.urgent });
    }
    if (opts.tags === false) return queued;
    // ListenBrainz knows songs by MusicBrainz id only, and one unknown id fails a whole batch.
    const known = unique.filter((id) => MBID.test(id));
    // Tags a month old are looked up again, and all of them after Look up all again.
    const fresh = [new Date(Date.now() - REFRESH_META_MS).toISOString(), this.redoneFrom('tags')].sort().at(-1)!;
    const tagged = new Set(
      this.select<{ recording_id: string }>('SELECT recording_id FROM track_meta WHERE fetched_at > ? AND recording_id IN', known, [fresh]).map(
        (r) => r.recording_id,
      ),
    );
    const before = this.metaQueue.size;
    for (const id of known) if (!tagged.has(id)) this.metaQueue.add(id);
    if (this.metaQueue.size > before) this.scheduleMeta();
    return queued;
  }

  /**
   * Every song in the library still to be measured goes in the backlog (Settings → Analysis → Analyse
   * every song in the library, or a one-off from Analyse all songs now), for one kind of analysis or,
   * left out, beat and sound analysis and tags: songs someone is waiting for still go first. Answers how
   * many were queued.
   */
  async analyzeLibrary(kind: AnalysisKind | 'all' = 'all'): Promise<number> {
    const ids = (await this.library.allTracks()).map((t) => t.recordingId);
    const tagsBefore = this.metaQueue.size;
    const loudnessBefore = this.loudnessJobs.waiting;
    switch (kind) {
      case 'tags':
        this.ensure(ids, { audio: false });
        return this.metaQueue.size - tagsBefore;
      case 'loudness':
        this.ensure(ids, { beats: false, sound: false, tags: false });
        return this.loudnessJobs.waiting - loudnessBefore;
      case 'beats':
        return this.ensure(ids, { sound: false, loudness: false, tags: false });
      case 'sound':
        return this.ensure(ids, { beats: false, loudness: false, tags: false });
      case 'all': {
        // As many songs as the biggest queue got.
        const queued = this.ensure(ids);
        return Math.max(queued, this.loudnessJobs.waiting - loudnessBefore, this.metaQueue.size - tagsBefore);
      }
    }
  }

  /**
   * Settings → Analysis → Analyse all again: every song is analysed again, those the current version
   * already did included (after the analysis changed without a new version, say), queued as
   * analyzeLibrary does; `all`: every kind of analysis (those that can run here). What was made before
   * now stops counting as done and as ready, but stays in use until its song is redone, so mixing
   * carries on meanwhile. Returns how many songs were queued.
   */
  async reanalyzeLibrary(kind: AnalysisKind | 'all' = 'beats'): Promise<number> {
    const kinds = kind !== 'all' ? [kind] : this.canAnalyzeAudio ? (Object.keys(REDO_KEYS) as AnalysisKind[]) : (['tags'] as const);
    const now = new Date().toISOString();
    const mark = this.db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
    for (const k of kinds) mark.run(REDO_KEYS[k], now);
    return this.analyzeLibrary(kind);
  }

  /** When this kind of analysis was last asked to run again on every song ('' if never: everything counts). */
  private redoneFrom(kind: AnalysisKind = 'beats'): string {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(REDO_KEYS[kind]) as { value: string } | undefined;
    return row?.value ?? '';
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
    return this.doneIn('track_features', 'features', ANALYSIS_VERSION, ids, this.redoneFrom('sound'));
  }

  /**
   * Songs whose mix map is made by the current version (since Analyse all again was last pressed), or
   * failed too recently to try again.
   */
  private mixMapsDone(ids: string[]): Set<string> {
    return this.doneIn('mix_maps', 'data', MIX_MAP_VERSION, ids, this.redoneFrom());
  }

  /** `from`: an ISO time; rows analysed before it don't count. */
  private doneIn(table: string, column: string, version: number, ids: string[], from = ''): Set<string> {
    const retryAfter = new Date(Date.now() - RETRY_FAILED_MS).toISOString();
    return new Set(
      this.select<{ recording_id: string }>(
        `SELECT recording_id FROM ${table} WHERE version = ? AND analyzed_at >= ? AND (${column} IS NOT NULL OR analyzed_at > ?) AND recording_id IN`,
        ids,
        [version, from, retryAfter],
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
        this.soundOnly.delete(id);
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
    const needsMixMap = !this.soundOnly.has(id) && !this.mixMapsDone([id]).has(id);
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
        const features = await this.dsp.analyze(pcm, DECODE_RATE);
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
        // A long song's middle, between head and tail, for its phrase energy. Without it the map still serves.
        const middle = tail ? await decoded.middle(secondsOf(pcm), duration - MIX_TAIL_SECONDS).catch(() => undefined) : undefined;
        const map = await this.dsp.mixMap(pcm, tail, duration, DECODE_RATE, await this.songBeats(pcm, tail), middle);
        saveMixMap.run(id, MIX_MAP_VERSION, JSON.stringify(map), null, new Date().toISOString());
      } catch (err) {
        fail(saveMixMap, MIX_MAP_VERSION, 'mix analysis', err);
      }
    }
    if (lost) this.urgentQueue.add(id); // next, once this run is over (see pump)
    else this.workerLosses.delete(id);
  }

  /** The beat model's answer for a song's head and tail; undefined without a model, or when it can't run. */
  private async songBeats(head: Buffer, tail: Buffer | null): Promise<SongBeats | undefined> {
    const model = this.opts.beats;
    const answer = model && (await model.activations(head));
    if (!answer) return undefined;
    return { head: answer, tail: tail && (await model.activations(tail)) };
  }

  /**
   * The song's first MAX_SECONDS as mono PCM at DECODE_RATE, and a way to find its end: its exact
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
    const head = await decode(path, { sampleRate: DECODE_RATE, maxSeconds: MAX_SECONDS, signal: signal() });
    const exactSeek = seeksInexactly(track.format);
    const read = (startSeconds: number, maxSeconds: number) =>
      decode(path, { sampleRate: DECODE_RATE, startSeconds, maxSeconds, ...(exactSeek ? { exactSeek } : {}), signal: signal() });
    const findEnd = async (): Promise<{ tail: Buffer | null; duration: number }> => {
      // Less than asked for: that's the whole song, to the sample.
      if (secondsOf(head) < MAX_SECONDS - FULL_SLACK_SECONDS) return { tail: null, duration: secondsOf(head) };
      return this.findEnd(read, head, track.duration);
    };
    /**
     * The song from `from` to `to` measured for its loudness alone (see LoudnessFrames), decoded at the
     * analysis rate and streamed, so an hour-long set never sits in memory. Seeks needn't be exact for this.
     */
    const middle = async (from: number, to: number): Promise<MiddleLoudness | undefined> => {
      if (!(to - from > 1)) return undefined;
      const frames = new LoudnessFrames();
      let odd: Buffer = Buffer.alloc(0);
      const take = (pcm: Buffer) => {
        const all = odd.length ? Buffer.concat([odd, pcm]) : pcm;
        const whole = all.length - (all.length % 2);
        frames.push(pcmToFloat(all.subarray(0, whole)));
        odd = all.subarray(whole);
      };
      const opts = { sampleRate: SAMPLE_RATE, startSeconds: from, maxSeconds: to - from, signal: signal() };
      if (media.pcmStream) {
        for await (const chunk of media.pcmStream(path, { ...opts, priority: 'low' })) take(chunk as Buffer);
      } else {
        for (let at = from; at < to; at += MIDDLE_CHUNK_SECONDS) {
          take(await decode(path, { ...opts, startSeconds: at, maxSeconds: Math.min(MIDDLE_CHUNK_SECONDS, to - at) }));
        }
      }
      return { start: from, rms: frames.frames() };
    };
    return { pcm: head, findEnd, middle };
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
    return selectIn<T>(this.db, sql, ids, params);
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

/** Seconds of mono s16le PCM at DECODE_RATE. */
const secondsOf = (pcm: Buffer) => pcm.length / 2 / DECODE_RATE;
/** Where `seconds` into mono s16le PCM at DECODE_RATE starts, in bytes. */
const byteAt = (seconds: number) => Math.round(seconds * DECODE_RATE) * 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());
