import type { RecommendedTrack, Recommendations as RecommendationsResult } from '@playarr/shared';
import type { Favorites } from '../favorites.ts';
import { songKey, type LibraryView } from '../library/library.ts';
import { normalize, primaryArtist } from '../library/search.ts';
import type { Playlists, Viewer } from '../playlists.ts';
import { remoteArtUrl } from './art.ts';
import { recordingMetadata, similarRecordings, type LbSimilarRecording } from './listenbrainz.ts';
import type { Requests } from './requests.ts';

const MAX_SEEDS = 10;
const MAX_OWNED = 10;
const MAX_MISSING = 20;
/** Owned picks come from a small library, so they get a looser per-artist cap. */
const OWNED_PER_ARTIST = 3;
const MISSING_PER_ARTIST = 2;

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How sure a MusicBrainz search must be before a song without an id is taken for its result. */
const SEARCH_MIN_SCORE = 90;

/** A song "Songs like these" starts from: one of a playlist's, or a favorite. */
export interface SeedSong {
  recordingId: string;
  title: string;
  artistName: string;
}

/** "Songs like these": ListenBrainz similar recordings, pooled across a playlist's songs or an account's favorites. */
export class Recommendations {
  /** MusicBrainz ids found by name for songs that have none, by artist|title (null: none found). */
  private readonly found = new Map<string, string | null>();

  constructor(
    private readonly playlists: Playlists,
    private readonly favorites: Pick<Favorites, 'list' | 'songs'>,
    private readonly requests: Requests,
    /** Finds a song's MusicBrainz recording by name, for songs known only from their tags. */
    private readonly mb?: { searchRecordings(artistName: string, title: string, signal?: AbortSignal): Promise<{ id: string; score: number }[]> },
  ) {}

  /**
   * The MusicBrainz recording ListenBrainz knows a song by. Folder songs that matching hasn't identified
   * have only a local id, which ListenBrainz knows nothing about: look those up by artist and title.
   */
  private async recordingMbid(song: { recordingId: string; artistName: string; title: string }, signal?: AbortSignal) {
    if (MBID.test(song.recordingId)) return song.recordingId;
    if (!this.mb) return undefined;
    const key = songKey(song.artistName, song.title);
    if (!this.found.has(key)) {
      const hits = await this.mb.searchRecordings(primaryArtist(song.artistName), song.title, signal).catch(() => undefined);
      if (!hits) return undefined; // MusicBrainz unreachable: try again next time
      this.found.set(key, hits.find((h) => h.score >= SEARCH_MIN_SCORE)?.id ?? null);
    }
    return this.found.get(key) ?? undefined;
  }

  /** `variant` picks a different random set of seeds (0 = evenly spread through the playlist). */
  async forPlaylist(viewer: Viewer, playlistId: number, variant = 0, signal?: AbortSignal): Promise<RecommendationsResult> {
    const playlist = await this.playlists.get(playlistId, viewer);
    return this.forSongs(viewer.library, playlist.items, variant, signal);
  }

  /**
   * Songs like the account's favorites, those it can play now (as Favorites lists them), leaving out every song it has
   * favorited, playable or not. `variant` 0 starts from the 10 favorited last, what it's into now; another picks a random
   * set, as for a playlist.
   */
  async forFavorites(viewer: Viewer, variant = 0, signal?: AbortSignal): Promise<RecommendationsResult> {
    const songs = await this.favorites.list(viewer.account, viewer.library);
    return this.forSongs(viewer.library, songs, variant, signal, { newestFirst: true, leaveOut: this.favorites.songs(viewer.account) });
  }

  /**
   * Songs like these, those in `library` (owned) and those not (missing), leaving out the songs themselves and those in
   * `leaveOut`. Up to 10 of the songs are the seeds: for `variant` 0 spread evenly through them, or the first 10 when
   * they're listed `newestFirst`; any other variant picks a random set and shakes up the ranking.
   */
  async forSongs(
    library: LibraryView,
    songs: readonly SeedSong[],
    variant = 0,
    signal?: AbortSignal,
    { newestFirst = false, leaveOut = [] }: { newestFirst?: boolean; leaveOut?: readonly SeedSong[] } = {},
  ): Promise<RecommendationsResult> {
    const random = seededRandom(variant);
    const picked = pickSeeds(uniqueBy(songs, (s) => s.recordingId), MAX_SEEDS, variant, random, newestFirst);
    const resolved = await Promise.all(picked.map(async (s) => ({ ...s, recordingId: await this.recordingMbid(s, signal) })));
    const seeds = resolved.filter((s): s is typeof s & { recordingId: string } => !!s.recordingId);
    const seedTitle = new Map(seeds.map((s) => [s.recordingId, s.title]));

    const results = await Promise.allSettled(seeds.map((s) => similarRecordings(s.recordingId, signal)));
    const lists = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (seeds.length && !lists.length) {
      const reason = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
      throw new Error(`ListenBrainz is unavailable: ${(reason?.reason as Error)?.message ?? 'unknown error'}`);
    }

    // Pool: normalize each seed's scores so one seed with huge numbers doesn't drown the rest;
    // songs similar to several of the songs accumulate and rise. The songs themselves are left out.
    const known = [...songs, ...leaveOut];
    const leftOut = new Set([...known.map((s) => s.recordingId), ...seeds.map((s) => s.recordingId)]);
    const leftOutByName = new Set(known.map((s) => songKey(primaryArtist(s.artistName), s.title)));
    const pooled = new Map<string, { rec: LbSimilarRecording; score: number; best: number; because: string }>();
    for (const list of lists) {
      const max = Math.max(1, ...list.map((r) => r.score));
      for (const rec of list) {
        const nameKey = songKey(primaryArtist(rec.artist_credit_name), rec.recording_name);
        if (leftOut.has(rec.recording_mbid) || leftOutByName.has(nameKey)) continue;
        const weight = rec.score / max;
        const entry = pooled.get(nameKey);
        if (!entry) pooled.set(nameKey, { rec, score: weight, best: weight, because: rec.reference_mbid });
        else {
          entry.score += weight;
          // "Similar to …" names the song it's most similar to.
          if (weight > entry.best) Object.assign(entry, { best: weight, because: rec.reference_mbid });
        }
      }
    }

    // A refresh also shakes up the ranking, otherwise the strongest matches always win again.
    const ranked = [...pooled.values()]
      .map((e) => ({ ...e, score: variant ? e.score * (0.5 + random()) : e.score }))
      .sort((a, b) => b.score - a.score);

    const owned: RecommendedTrack[] = [];
    const missing: RecommendedTrack[] = [];
    const ownedPerArtist = new Map<string, number>();
    const missingPerArtist = new Map<string, number>();
    for (const { rec, because } of ranked) {
      if (owned.length >= MAX_OWNED && missing.length >= MAX_MISSING) break;
      const artistKey = normalize(primaryArtist(rec.artist_credit_name));

      const track =
        (await library.trackByRecording(rec.recording_mbid)) ??
        (await library.trackByName(rec.artist_credit_name, rec.recording_name));
      const base = {
        recordingId: rec.recording_mbid,
        title: rec.recording_name,
        artistName: rec.artist_credit_name,
        albumTitle: rec.release_name ?? '',
        because: seedTitle.get(because) ?? '',
      };
      if (track) {
        if (owned.length >= MAX_OWNED || (ownedPerArtist.get(artistKey) ?? 0) >= OWNED_PER_ARTIST) continue;
        if (leftOut.has(track.recordingId) || owned.some((o) => o.track!.id === track.id)) continue;
        owned.push({ ...base, title: track.title, albumTitle: track.albumTitle, coverUrl: track.coverUrl, track, artistId: track.artistId });
        ownedPerArtist.set(artistKey, (ownedPerArtist.get(artistKey) ?? 0) + 1);
      } else {
        if (missing.length >= MAX_MISSING || (missingPerArtist.get(artistKey) ?? 0) >= MISSING_PER_ARTIST) continue;
        if (!rec.release_name) continue;
        missing.push({
          ...base,
          coverUrl: coverUrl(rec),
          album: { releaseMbid: rec.release_mbid, artistName: rec.artist_credit_name, albumTitle: rec.release_name },
        });
        missingPerArtist.set(artistKey, (missingPerArtist.get(artistKey) ?? 0) + 1);
      }
    }

    // Fill in the ids similar-recordings leaves out: the lead artist (for links) and the release
    // group, which is the Lidarr album, so a request needs no extra MusicBrainz lookup.
    const meta = await recordingMetadata(missing.map((m) => m.recordingId), signal);
    await Promise.all(
      missing.map(async (m) => {
        const info = meta.get(m.recordingId);
        const artistMbid = info?.artist?.artists?.[0]?.artist_mbid;
        const groupMbid = info?.release?.release_group_mbid;
        if (artistMbid) {
          m.artistMbid = artistMbid;
          m.artistId = await library.artistIdByMbid(artistMbid);
        }
        if (groupMbid) m.album!.mbid = groupMbid;
        const byMbid = groupMbid ? await this.requests.availability(groupMbid) : undefined;
        m.availability =
          byMbid && byMbid.state !== 'none' ? byMbid : await this.requests.availabilityByName(m.artistName, m.albumTitle);
      }),
    );
    return { owned, missing, seedCount: seeds.length };
  }
}

function coverUrl(rec: LbSimilarRecording): string | undefined {
  if (!rec.caa_id || !rec.caa_release_mbid) return undefined;
  // Through Lidarr's image CDN: one hop instead of Cover Art Archive's redirects.
  return remoteArtUrl(
    `https://images.lidarr.audio/cache/https://coverartarchive.org/release/${rec.caa_release_mbid}/${rec.caa_id}-250.jpg`,
  );
}

function uniqueBy<T>(items: readonly T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(key(i)) ? false : (seen.add(key(i)), true)));
}

/** Deterministic per variant, so the same "refresh" number gives the same (cacheable) answer. */
function seededRandom(seed: number): () => number {
  let state = (seed * 2654435761) % 2147483648;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/**
 * For variant 0, seeds spread evenly through the items, or the first of them when they're listed newest first; a seeded
 * shuffle otherwise, so "refresh" gives a new mix.
 */
function pickSeeds<T>(items: T[], count: number, variant: number, random: () => number, newestFirst = false): T[] {
  if (items.length <= count && variant === 0) return items;
  if (variant === 0) {
    if (newestFirst) return items.slice(0, count);
    const step = items.length / count;
    return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)]!);
  }
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled.slice(0, Math.min(count, Math.max(1, Math.ceil(items.length * 0.7))));
}
