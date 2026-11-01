import type { MixDetail, MixKind, MixSettings, MixSummary, PlaylistDetail, Track } from '@playarr/shared';
import type { DatabaseSync } from 'node:sqlite';
import type { Analyzer } from '../analysis/analyzer.ts';
import type { CatalogStore } from '../catalog/store.ts';
import { hash32 } from '../cover/random.ts';
import { similarRecordings } from '../discover/listenbrainz.ts';
import type { Library } from '../library/library.ts';
import type { Playlists } from '../playlists.ts';
import { generateMix, planMixes, type GeneratedMix, type MixContext, type MixPlan } from './generators.ts';
import type { History } from './history.ts';
import { readMixSettings } from './settings.ts';
import { buildTaste, toSong, type Taste } from './taste.ts';
import { localTime, nextBoundary, type LocalTime } from './time.ts';

const PLAN_KEY = '_plan';
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Most played songs that seed Discovery Weekly's ListenBrainz neighbours. */
const NEIGHBOUR_SEEDS = 10;

/** How often each kind of mix is made again. */
const CADENCE: Record<MixKind, 'hour' | 'day' | 'week'> = {
  vibes: 'hour',
  discovery: 'week',
  repeat: 'day',
  blast: 'day',
  deepcuts: 'day',
  fresh: 'day',
  decade: 'day',
  genre: 'day',
  energy: 'day',
  winddown: 'day',
  focus: 'day',
  onthisday: 'day',
};

interface Row {
  key: string;
  period: string;
  variant: number;
  data: string;
  generated_at: string;
}

interface Stored {
  settings: number;
  mix: GeneratedMix | null;
}

interface StoredPlan {
  settings: number;
  plan: MixPlan[];
}

export class MixError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Made for you: playlists generated from the library and the listening history. Each mix is made once
 * per hour, day or week (in the listener's time zone) and stored, so it stays put in between.
 */
export class Mixes {
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      db: DatabaseSync;
      store: Pick<CatalogStore, 'appSetting'>;
      library: Library;
      analyzer: Pick<Analyzer, 'ensure' | 'features' | 'meta'>;
      history: History;
      playlists: Pick<Playlists, 'create'>;
      /** ListenBrainz neighbours of a recording (swappable in tests). */
      similar?: (recordingMbid: string) => Promise<{ recording_mbid: string; recording_name: string; artist_credit_name: string; score: number }[]>;
      log?: { warn: (msg: string) => void };
    },
  ) {}

  async list(timeZone?: string, now = new Date()): Promise<MixSummary[]> {
    const local = localTime(now, timeZone);
    await this.ensure(local, now);
    const plan = this.storedPlan()?.plan ?? [];
    const rows = this.rows();
    const out: MixSummary[] = [];
    for (const p of plan) {
      const row = rows.get(p.key);
      const mix = row && (JSON.parse(row.data) as Stored).mix;
      if (!row || !mix) continue;
      const tracks = await this.deps.library.tracksByIds(mix.trackIds);
      if (tracks.length) out.push(summary(mix, tracks, row, now, local));
    }
    return out;
  }

  async get(key: string, timeZone?: string, now = new Date()): Promise<MixDetail> {
    const local = localTime(now, timeZone);
    await this.ensure(local, now);
    const row = this.rows().get(key);
    const mix = row && (JSON.parse(row.data) as Stored).mix;
    if (!row || !mix) throw new MixError('This mix isn’t available right now', 404);
    const tracks = await this.deps.library.tracksByIds(mix.trackIds);
    return { ...summary(mix, tracks, row, now, local), tracks };
  }

  /** Draw the mix again for the same hour, day or week ("New mix"). */
  async regenerate(key: string, timeZone?: string, now = new Date()): Promise<MixDetail> {
    const local = localTime(now, timeZone);
    await this.ensure(local, now);
    const plan = this.storedPlan()?.plan.find((p) => p.key === key);
    const row = this.rows().get(key);
    if (!plan || !row) throw new MixError('This mix isn’t available right now', 404);
    const settings = readMixSettings(this.deps.store);
    const ctx = await this.context(local, now, settings, plan.kind === 'discovery');
    const variant = row.variant + 1;
    const mix = generateMix(plan, ctx, row.period, variant);
    if (mix) this.write(key, row.period, variant, { settings: settingsHash(settings), mix }, now);
    return this.get(key, timeZone, now);
  }

  private write(key: string, period: string, variant: number, stored: Stored, now: Date) {
    this.deps.db
      .prepare(
        `INSERT INTO mixes (key, period, variant, data, generated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET period = excluded.period, variant = excluded.variant, data = excluded.data, generated_at = excluded.generated_at`,
      )
      .run(key, period, variant, JSON.stringify(stored), now.toISOString());
  }

  /** Keep the mix as an ordinary playlist. */
  async saveAsPlaylist(key: string, timeZone?: string, now = new Date()): Promise<PlaylistDetail> {
    const mix = await this.get(key, timeZone, now);
    const day = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone });
    return this.deps.playlists.create(`${mix.title} · ${day}`, mix.description.slice(0, 300), mix.tracks.map((t) => t.recordingId));
  }

  /** Forget every mix, so they're made again (after the history was cleared, say). */
  reset() {
    this.deps.db.exec('DELETE FROM mixes');
  }

  /** Make whatever is out of date: the plan once a day (or when settings change), each mix on its schedule. */
  private ensure(local: LocalTime, now: Date): Promise<void> {
    this.inflight ??= this.refresh(local, now).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(local: LocalTime, now: Date) {
    const settings = readMixSettings(this.deps.store);
    const hash = settingsHash(settings);
    const rows = this.rows();
    let ctx: MixContext | undefined;
    let withNeighbours = false;
    const context = async (neighbours: boolean) => {
      if (!ctx || (neighbours && !withNeighbours)) {
        ctx = await this.context(local, now, settings, neighbours);
        withNeighbours = neighbours;
      }
      return ctx;
    };

    let plan = this.storedPlan();
    if (!plan || plan.settings !== hash || rows.get(PLAN_KEY)?.period !== local.date) {
      plan = { settings: hash, plan: planMixes(await context(false)) };
      this.deps.db
        .prepare(
          `INSERT INTO mixes (key, period, variant, data, generated_at) VALUES (?, ?, 0, ?, ?)
           ON CONFLICT (key) DO UPDATE SET period = excluded.period, data = excluded.data, generated_at = excluded.generated_at`,
        )
        .run(PLAN_KEY, local.date, JSON.stringify(plan), now.toISOString());
    }
    for (const p of plan.plan) {
      const period = periodOf(p.kind, local);
      const row = rows.get(p.key);
      const stored = row ? (JSON.parse(row.data) as Stored) : undefined;
      if (row && stored && row.period === period && stored.settings === hash) continue;
      const mix = generateMix(p, await context(p.kind === 'discovery'), period, 0);
      this.write(p.key, period, 0, { settings: hash, mix }, now);
    }
  }

  private async context(local: LocalTime, now: Date, settings: MixSettings, neighbours: boolean): Promise<MixContext> {
    const { library, analyzer, history, db } = this.deps;
    const [tracks, albums, artists] = await Promise.all([library.allTracks(), library.albums(), library.artists()]);
    const ids = tracks.map((t) => t.recordingId);
    // Tags are cheap and fetched for everything; measuring sound only when Settings → Mixes asks for it.
    analyzer.ensure(ids, { audio: settings.analyzeLibrary });
    const features = analyzer.features(ids);
    const meta = analyzer.meta(ids);
    const albumById = new Map(albums.map((a) => [a.id, a]));
    const genres = new Map(artists.map((a) => [a.id, a.genres]));
    const songs = tracks.map((track) => {
      const album = albumById.get(track.albumId);
      const m = meta.get(track.recordingId);
      return toSong({
        track,
        tags: m?.tags ?? [],
        // The album's genres (its tags, else the artist's), else the artist's.
        genres: album?.genres?.length ? album.genres : (genres.get(track.artistId) ?? []),
        features: features.get(track.recordingId),
        albumYear: album?.year,
        tagYear: m?.year,
        addedAt: album?.addedAt,
        releaseDate: album?.releaseDate,
      });
    });
    const plays = history.since(365, now.getTime());
    const favorites = new Set(
      (db.prepare('SELECT recording_id FROM favorites').all() as { recording_id: string }[]).map((r) => r.recording_id),
    );
    const inPlaylists = new Map(
      (db.prepare('SELECT recording_id, COUNT(*) AS n FROM playlist_items GROUP BY recording_id').all() as { recording_id: string; n: number }[]).map(
        (r) => [r.recording_id, r.n],
      ),
    );
    const taste = buildTaste(songs, plays, favorites, inPlaylists, now.getTime());
    return {
      songs,
      taste,
      plays,
      local,
      now: now.getTime(),
      settings,
      neighbours: neighbours ? await this.neighbours(taste) : new Map(),
    };
  }

  /** Library songs ListenBrainz finds alike to the most played (or loved) ones, for Discovery Weekly. */
  private async neighbours(taste: Taste): Promise<Map<number, number>> {
    const similar = this.deps.similar ?? ((id: string) => similarRecordings(id));
    const seeds = [...taste.songAffinity]
      .filter(([id]) => MBID.test(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, NEIGHBOUR_SEEDS)
      .map(([id]) => id);
    const out = new Map<number, number>();
    const lists = await Promise.allSettled(seeds.map((id) => similar(id)));
    for (const list of lists) {
      if (list.status !== 'fulfilled') continue;
      const max = Math.max(1, ...list.value.map((r) => r.score));
      for (const rec of list.value) {
        const track =
          (await this.deps.library.trackByRecording(rec.recording_mbid)) ??
          (await this.deps.library.trackByName(rec.artist_credit_name, rec.recording_name));
        if (track) out.set(track.id, Math.max(out.get(track.id) ?? 0, rec.score / max));
      }
    }
    if (seeds.length && lists.every((l) => l.status === 'rejected')) this.deps.log?.warn('ListenBrainz unavailable for Discovery Weekly');
    return out;
  }

  private rows(): Map<string, Row> {
    const rows = this.deps.db.prepare('SELECT key, period, variant, data, generated_at FROM mixes').all() as unknown as Row[];
    return new Map(rows.map((r) => [r.key, r]));
  }

  private storedPlan(): StoredPlan | undefined {
    const row = this.deps.db.prepare('SELECT data FROM mixes WHERE key = ?').get(PLAN_KEY) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as StoredPlan) : undefined;
  }
}

function periodOf(kind: MixKind, local: LocalTime): string {
  const cadence = CADENCE[kind];
  return cadence === 'hour' ? `${local.date}T${String(local.hour).padStart(2, '0')}` : cadence === 'week' ? local.week : local.date;
}

const settingsHash = (s: MixSettings) => hash32(JSON.stringify(s));

function summary(mix: GeneratedMix, tracks: Track[], row: Row, now: Date, local: LocalTime): MixSummary {
  const covers: string[] = [];
  const albums = new Set<number>();
  for (const t of tracks) {
    if (!t.coverUrl || albums.has(t.albumId)) continue;
    albums.add(t.albumId);
    covers.push(t.coverUrl);
    if (covers.length === 4) break;
  }
  return {
    key: mix.key,
    kind: mix.kind,
    title: mix.title,
    subtitle: mix.subtitle,
    description: mix.description,
    trackCount: tracks.length,
    duration: tracks.reduce((s, t) => s + t.duration, 0),
    covers,
    hue: mix.hue,
    generatedAt: row.generated_at,
    refreshesAt: nextBoundary(now, local, CADENCE[mix.kind]).toISOString(),
  };
}
