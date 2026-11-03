import { blendScore } from '@playarr/mix';
import type { MixDetail, MixKind, MixSettings, MixSummary, PlaylistDetail, Track } from '@playarr/shared';
import type { DatabaseSync } from 'node:sqlite';
import type { Analyzer } from '../analysis/analyzer.ts';
import type { CatalogStore } from '../catalog/store.ts';
import { hash32, Rng } from '../cover/random.ts';
import { similarRecordings } from '../discover/listenbrainz.ts';
import type { Library, LibraryView } from '../library/library.ts';
import type { Playlists } from '../playlists.ts';
import { blendOrder, choose, generateMix, planMixes, spread, tempoAndKey, type GeneratedMix, type MixContext, type MixPlan } from './generators.ts';
import type { History } from './history.ts';
import { MIXES_KEY, readMixSettings } from './settings.ts';
import { buildTaste, familySimilarity, toSong, type Song, type Taste } from './taste.ts';
import type { StyleFamily } from '../analysis/styles.ts';
import { localTime, nextBoundary, validTimeZone, type LocalTime } from './time.ts';

const PLAN_KEY = '_plan';
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Most played songs that seed Discovery Weekly's ListenBrainz neighbours. */
const NEIGHBOUR_SEEDS = 10;
/** How often the background check looks for mixes that are due. */
const CHECK_EVERY_MS = 60_000;

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
 * per hour, day or week, in the household's time zone, by a background check; requests read what's
 * stored and only wait when there's nothing yet. Making them yields between mixes, so the server keeps
 * answering meanwhile.
 */
export class Mixes {
  /** Mixes being made, by account. */
  private inflight = new Map<number, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  /** Songs as the mixes see them, per set of sources, until the library or what's known about its songs changes. */
  private songCache = new Map<string, { key: string; songs: Song[] }>();

  constructor(
    private readonly deps: {
      db: DatabaseSync;
      store: Pick<CatalogStore, 'appSetting' | 'setAppSetting'>;
      library: Library;
      analyzer: Pick<Analyzer, 'ensure' | 'features' | 'meta' | 'mixSummaries' | 'progress'>;
      history: History;
      playlists: Pick<Playlists, 'create'>;
      /** ListenBrainz neighbours of a recording (swappable in tests). */
      similar?: (recordingMbid: string) => Promise<{ recording_mbid: string; recording_name: string; artist_credit_name: string; score: number }[]>;
      log?: { warn: (msg: string) => void };
      /** Everyone listening (account ids): each has their own mixes. */
      accounts?: () => number[];
      /** The library as each account may hear it (its sources); the whole library without it. */
      libraryFor?: (account: number) => LibraryView;
    },
  ) {}

  /** Keep the mixes made in the background: at each new hour, day and week. */
  start(everyMs = CHECK_EVERY_MS) {
    const check = async () => {
      const tz = readMixSettings(this.deps.store).timeZone;
      // One account at a time: making mixes is background work.
      for (const account of this.deps.accounts?.() ?? [1]) {
        if (!this.storedPlan(account) || !this.isStale(account, tz, new Date())) continue;
        await this.ensure(account, tz, new Date()).catch((err: Error) => this.deps.log?.warn(`Making mixes failed: ${err.message}`));
      }
    };
    this.timer = setInterval(check, everyMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** The songs an account's mixes and radio come from. */
  private view(account: number): LibraryView {
    return this.deps.libraryFor?.(account) ?? this.deps.library;
  }

  async list(clientTimeZone?: string, now = new Date(), account = 1): Promise<MixSummary[]> {
    const tz = this.timeZone(clientTimeZone);
    await this.ready(account, tz, now);
    const local = localTime(now, tz);
    const plan = this.storedPlan(account)?.plan ?? [];
    const rows = this.rows(account);
    const out: MixSummary[] = [];
    for (const p of plan) {
      const row = rows.get(p.key);
      const mix = row && (JSON.parse(row.data) as Stored).mix;
      if (!row || !mix) continue;
      const tracks = await this.tracksOf(mix, this.view(account));
      if (tracks.length) out.push(summary(mix, tracks, row, now, local));
    }
    return out;
  }

  async get(key: string, clientTimeZone?: string, now = new Date(), account = 1): Promise<MixDetail> {
    const tz = this.timeZone(clientTimeZone);
    await this.ready(account, tz, now);
    const row = this.rows(account).get(key);
    const mix = row && (JSON.parse(row.data) as Stored).mix;
    if (!row || !mix) throw new MixError('This mix isn’t available right now', 404);
    const tracks = await this.tracksOf(mix, this.view(account));
    return { ...summary(mix, tracks, row, now, localTime(now, tz)), tracks };
  }

  /** Draw the mix again for the same hour, day or week ("New mix"). */
  async regenerate(key: string, clientTimeZone?: string, now = new Date(), account = 1): Promise<MixDetail> {
    const tz = this.timeZone(clientTimeZone);
    await this.ready(account, tz, now);
    await this.inflight.get(account)?.catch(() => {});
    const plan = this.storedPlan(account)?.plan.find((p) => p.key === key);
    const row = this.rows(account).get(key);
    if (!plan || !row) throw new MixError('This mix isn’t available right now', 404);
    const settings = readMixSettings(this.deps.store);
    const ctx = await this.context(account, localTime(now, tz), now, settings, plan.kind === 'discovery');
    const variant = row.variant + 1;
    const mix = generateMix(plan, ctx, row.period, variant);
    if (mix) this.write(account, key, row.period, variant, { settings: settingsHash(settings), mix }, now);
    return this.get(key, tz, now, account);
  }

  /**
   * Radio: library songs like `seeds` (their styles, energy, tempo and key, and ListenBrainz neighbours),
   * for keeping the music going after the queue ends or "Start radio" on a song. Leaves out `exclude`.
   * Ordered to blend on from the last seed, the song playing when the queue runs out.
   */
  async radio(seeds: string[], exclude: string[], count = 25, account = 1): Promise<Track[]> {
    const library = this.view(account);
    const songs = await this.songs(readMixSettings(this.deps.store), library);
    const byRecording = new Map(songs.map((s) => [s.track.recordingId, s]));
    const seedSongs = seeds.flatMap((id) => byRecording.get(id) ?? []);
    if (!seedSongs.length) return [];
    const families: Partial<Record<StyleFamily, number>> = {};
    for (const s of seedSongs) {
      for (const [f, w] of Object.entries(s.families)) families[f as StyleFamily] = (families[f as StyleFamily] ?? 0) + w! / seedSongs.length;
    }
    const energies = seedSongs.flatMap((s) => (s.energy === undefined ? [] : [s.energy]));
    const energy = energies.length ? energies.reduce((a, b) => a + b, 0) / energies.length : undefined;
    const artists = new Set(seedSongs.map((s) => s.track.artistId));
    const neighbours = await this.neighboursOf(seeds.filter((id) => MBID.test(id)).slice(0, 5), library);
    const skip = new Set([...seeds, ...exclude]);
    // Energy has its own term: this one is how well a song's tempo and key go with the seeds'. The song
    // playing (the last seed) is what the radio follows on from, so it weighs as much as the rest together.
    const playing = tempoAndKey(seedSongs.at(-1)!);
    const earlier = seedSongs.slice(0, -1).map(tempoAndKey);
    const blendsWithSeeds = (song: Song) => {
      const own = tempoAndKey(song);
      const withPlaying = blendScore(playing, own);
      if (!earlier.length) return withPlaying;
      return 0.5 * withPlaying + (0.5 * earlier.reduce((sum, seed) => sum + blendScore(seed, own), 0)) / earlier.length;
    };
    const rng = new Rng(Date.now() >>> 0);
    const scored = songs
      .filter((s) => !skip.has(s.track.recordingId))
      .map((song) => ({
        song,
        score:
          0.35 * familySimilarity(song.families, families) +
          0.25 * (energy === undefined || song.energy === undefined ? 0.4 : 1 - Math.abs(song.energy - energy) * 1.6) +
          0.3 * (neighbours.get(song.track.id) ?? 0) +
          0.3 * blendsWithSeeds(song) +
          (artists.has(song.track.artistId) ? 0.1 : 0) +
          rng.next() * 0.2,
      }));
    // The walk starts from the last seed so the first radio song blends with it; the seed itself is dropped.
    return blendOrder([seedSongs.at(-1)!, ...spread(choose(scored, count, 2), rng)])
      .slice(1)
      .map((s) => s.track);
  }

  /** Keep the mix as an ordinary playlist. */
  async saveAsPlaylist(key: string, clientTimeZone?: string, now = new Date(), account = 1): Promise<PlaylistDetail> {
    const tz = this.timeZone(clientTimeZone);
    const mix = await this.get(key, tz, now, account);
    const day = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: tz });
    return this.deps.playlists.create(`${mix.title} · ${day}`, mix.description.slice(0, 300), mix.tracks.map((t) => t.recordingId));
  }

  /** Forget someone's mixes (everyone's, without an account), so they're made again: after the history was cleared, say. */
  async reset(account?: number) {
    // A mix being made now would otherwise be written back from the old history.
    await Promise.all([...this.inflight.values()].map((job) => job.catch(() => {})));
    if (account === undefined) this.deps.db.exec('DELETE FROM mixes');
    else this.deps.db.prepare('DELETE FROM mixes WHERE account_id = ?').run(account);
  }

  /**
   * The household's time zone: hours, days and Mondays are the same for every device, or two devices
   * in different zones would remake the mixes on every request. Settings → Mixes, else the first device
   * to ask (remembered), else the server's.
   */
  private timeZone(clientTimeZone?: string): string | undefined {
    const settings = readMixSettings(this.deps.store);
    if (settings.timeZone) return settings.timeZone;
    const tz = validTimeZone(clientTimeZone);
    if (tz) this.deps.store.setAppSetting(MIXES_KEY, JSON.stringify({ ...settings, timeZone: tz }));
    return tz;
  }

  /** Wait for mixes only when there are none yet; otherwise serve what's stored and remake in the background. */
  private async ready(account: number, tz: string | undefined, now: Date) {
    if (!this.storedPlan(account)) await this.ensure(account, tz, now);
    else if (this.isStale(account, tz, now)) void this.ensure(account, tz, now).catch((err: Error) => this.deps.log?.warn(`Making mixes failed: ${err.message}`));
  }

  /** Whether any mix (or the day's plan) is due: cheap, from the stored rows alone. */
  private isStale(account: number, tz: string | undefined, now: Date): boolean {
    const local = localTime(now, tz);
    const hash = settingsHash(readMixSettings(this.deps.store));
    const rows = this.rows(account);
    const plan = this.storedPlan(account);
    if (!plan || plan.settings !== hash || rows.get(PLAN_KEY)?.period !== local.date) return true;
    return plan.plan.some((p) => {
      const row = rows.get(p.key);
      return !row || row.period !== periodOf(p.kind, local) || (JSON.parse(row.data) as Stored).settings !== hash;
    });
  }

  private ensure(account: number, tz: string | undefined, now: Date): Promise<void> {
    let job = this.inflight.get(account);
    if (!job) {
      job = this.refresh(account, localTime(now, tz), now).finally(() => this.inflight.delete(account));
      this.inflight.set(account, job);
    }
    return job;
  }

  /** Make whatever is due: the plan once a day (or when settings change), each mix on its schedule. */
  private async refresh(account: number, local: LocalTime, now: Date) {
    const settings = readMixSettings(this.deps.store);
    const hash = settingsHash(settings);
    const rows = this.rows(account);
    const due = (p: MixPlan) => {
      const row = rows.get(p.key);
      return !row || row.period !== periodOf(p.kind, local) || (JSON.parse(row.data) as Stored).settings !== hash;
    };

    let plan = this.storedPlan(account);
    const newPlan = !plan || plan.settings !== hash || rows.get(PLAN_KEY)?.period !== local.date;
    // Discovery Weekly's ListenBrainz neighbours are only fetched when it's being made.
    let ctx = await this.context(account, local, now, settings, newPlan || plan!.plan.some((p) => p.kind === 'discovery' && due(p)));
    if (newPlan) {
      plan = { settings: hash, plan: planMixes(ctx) };
      this.write(account, PLAN_KEY, local.date, 0, plan, now);
      if (plan.plan.some((p) => p.kind === 'discovery' && due(p)) && !ctx.neighbours.size) ctx = { ...ctx, neighbours: await this.neighbours(ctx.taste, this.view(account)) };
    }
    for (const p of plan!.plan) {
      if (!due(p)) continue;
      const period = periodOf(p.kind, local);
      this.write(account, p.key, period, 0, { settings: hash, mix: generateMix(p, ctx, period, 0) }, now);
      // Let requests waiting meanwhile through between mixes.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private write(account: number, key: string, period: string, variant: number, stored: Stored | StoredPlan, now: Date) {
    this.deps.db
      .prepare(
        `INSERT INTO mixes (account_id, key, period, variant, data, generated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, key) DO UPDATE SET period = excluded.period, variant = excluded.variant, data = excluded.data, generated_at = excluded.generated_at`,
      )
      .run(account, key, period, variant, JSON.stringify(stored), now.toISOString());
  }

  private async context(account: number, local: LocalTime, now: Date, settings: MixSettings, neighbours: boolean): Promise<MixContext> {
    const { history, db } = this.deps;
    const library = this.view(account);
    const songs = await this.songs(settings, library);
    const plays = history.since(365, now.getTime(), account);
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
      neighbours: neighbours ? await this.neighbours(taste, library) : new Map(),
    };
  }

  /**
   * Every song as the mixes see it, one per recording (a song on its album and on a "best of" is one
   * song). Kept until the library changes or more songs are tagged or measured.
   */
  private async songs(settings: MixSettings, library: LibraryView): Promise<Song[]> {
    const { analyzer } = this.deps;
    const progress = analyzer.progress();
    const sources = library.sources?.join(',') ?? 'all';
    const key = `${library.version}:${progress.features}:${progress.meta}:${progress.mixMaps}:${settings.analyzeLibrary}`;
    const cached = this.songCache.get(sources);
    if (cached?.key === key) return cached.songs;
    const [tracks, albums, artists] = await Promise.all([library.allTracks(), library.albums(), library.artists()]);
    const seen = new Set<string>();
    const unique = tracks.filter((t) => !seen.has(t.recordingId) && seen.add(t.recordingId));
    const ids = unique.map((t) => t.recordingId);
    // Tags are cheap and fetched for everything; measuring sound only when Settings → Analysis asks for it.
    analyzer.ensure(ids, { audio: settings.analyzeLibrary });
    const features = analyzer.features(ids);
    const meta = analyzer.meta(ids);
    // Only what blending needs: whole mix maps (beat grid, phrase energy…) for every song would be slow to read and fill memory.
    const summaries = analyzer.mixSummaries(ids);
    const albumById = new Map(albums.map((a) => [a.id, a]));
    const genres = new Map(artists.map((a) => [a.id, a.genres]));
    const songs = unique.map((track) => {
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
        mix: summaries.get(track.recordingId),
      });
    });
    this.songCache.set(sources, { key, songs });
    return songs;
  }

  /** Library songs ListenBrainz finds alike to the most played (or loved) ones, for Discovery Weekly. */
  private neighbours(taste: Taste, library: LibraryView): Promise<Map<number, number>> {
    return this.neighboursOf(
      [...taste.songAffinity]
        .filter(([id]) => MBID.test(id))
        .sort((a, b) => b[1] - a[1])
        .slice(0, NEIGHBOUR_SEEDS)
        .map(([id]) => id),
      library,
    );
  }

  /** Library songs ListenBrainz finds alike to these recordings (track id → 0 … 1). */
  private async neighboursOf(seeds: string[], library: LibraryView): Promise<Map<number, number>> {
    const similar = this.deps.similar ?? ((id: string) => similarRecordings(id));
    const out = new Map<number, number>();
    const lists = await Promise.allSettled(seeds.map((id) => similar(id)));
    for (const list of lists) {
      if (list.status !== 'fulfilled') continue;
      const max = Math.max(1, ...list.value.map((r) => r.score));
      for (const rec of list.value) {
        const track =
          (await library.trackByRecording(rec.recording_mbid)) ??
          (await library.trackByName(rec.artist_credit_name, rec.recording_name));
        if (track) out.set(track.id, Math.max(out.get(track.id) ?? 0, rec.score / max));
      }
    }
    if (seeds.length && lists.every((l) => l.status === 'rejected')) this.deps.log?.warn('ListenBrainz unavailable for Discovery Weekly');
    return out;
  }

  /** A stored mix's songs as the account's library has them now (by recording, which survives matching). */
  private tracksOf(mix: GeneratedMix, library: LibraryView): Promise<Track[]> {
    return mix.recordingIds ? library.tracksByRecordings(mix.recordingIds) : library.tracksByIds(mix.trackIds);
  }

  private rows(account: number): Map<string, Row> {
    const rows = this.deps.db.prepare('SELECT key, period, variant, data, generated_at FROM mixes WHERE account_id = ?').all(account) as unknown as Row[];
    return new Map(rows.map((r) => [r.key, r]));
  }

  private storedPlan(account: number): StoredPlan | undefined {
    const row = this.deps.db.prepare('SELECT data FROM mixes WHERE account_id = ? AND key = ?').get(account, PLAN_KEY) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as StoredPlan) : undefined;
  }
}

function periodOf(kind: MixKind, local: LocalTime): string {
  const cadence = CADENCE[kind];
  return cadence === 'hour' ? `${local.date}T${String(local.hour).padStart(2, '0')}` : cadence === 'week' ? local.week : local.date;
}

/** Only the settings that shape the mixes: turning history recording off doesn't remake them. */
const settingsHash = (s: MixSettings) =>
  hash32(JSON.stringify([s.enabled, s.length, s.adventurous, s.blastDays, s.genreMixes, s.decadeMixes]));

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
