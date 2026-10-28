import type { RecommendedTrack, Recommendations as RecommendationsResult } from '@playarr/shared';
import type { Library } from '../library/library.ts';
import { songKey } from '../library/library.ts';
import { normalize, primaryArtist } from '../library/search.ts';
import type { Playlists } from '../playlists.ts';
import { remoteArtUrl } from './art.ts';
import { recordingMetadata, similarRecordings, type LbSimilarRecording } from './listenbrainz.ts';
import type { Requests } from './requests.ts';

const MAX_SEEDS = 10;
const MAX_OWNED = 10;
const MAX_MISSING = 20;
/** Owned picks come from a small library, so they get a looser per-artist cap. */
const OWNED_PER_ARTIST = 3;
const MISSING_PER_ARTIST = 2;

/** "Songs like these": ListenBrainz similar recordings, pooled across a playlist's songs. */
export class Recommendations {
  constructor(
    private readonly playlists: Playlists,
    private readonly library: Library,
    private readonly requests: Requests,
  ) {}

  /** `variant` picks a different random set of seeds (0 = evenly spread through the playlist). */
  async forPlaylist(playlistId: number, variant = 0, signal?: AbortSignal): Promise<RecommendationsResult> {
    const playlist = await this.playlists.get(playlistId);
    const songs = uniqueBy(playlist.items, (i) => i.recordingId).filter((i) => !i.recordingId.startsWith('track:'));
    const random = seededRandom(variant);
    const seeds = pickSeeds(songs, MAX_SEEDS, variant, random);
    const seedTitle = new Map(seeds.map((s) => [s.recordingId, s.title]));

    const results = await Promise.allSettled(seeds.map((s) => similarRecordings(s.recordingId, signal)));
    const lists = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (seeds.length && !lists.length) {
      const reason = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
      throw new Error(`ListenBrainz is unavailable: ${(reason?.reason as Error)?.message ?? 'unknown error'}`);
    }

    // Pool: normalize each seed's scores so one seed with huge numbers doesn't drown the rest;
    // songs similar to several playlist songs accumulate and rise.
    const inPlaylist = new Set(playlist.items.map((i) => i.recordingId));
    const inPlaylistByName = new Set(playlist.items.map((i) => songKey(primaryArtist(i.artistName), i.title)));
    const pooled = new Map<string, { rec: LbSimilarRecording; score: number; best: number; because: string }>();
    for (const list of lists) {
      const max = Math.max(1, ...list.map((r) => r.score));
      for (const rec of list) {
        const nameKey = songKey(primaryArtist(rec.artist_credit_name), rec.recording_name);
        if (inPlaylist.has(rec.recording_mbid) || inPlaylistByName.has(nameKey)) continue;
        const weight = rec.score / max;
        const entry = pooled.get(nameKey);
        if (!entry) pooled.set(nameKey, { rec, score: weight, best: weight, because: rec.reference_mbid });
        else {
          entry.score += weight;
          // "Similar to …" names the playlist song it's most similar to.
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
        (await this.library.trackByRecording(rec.recording_mbid)) ??
        (await this.library.trackByName(rec.artist_credit_name, rec.recording_name));
      const base = {
        recordingId: rec.recording_mbid,
        title: rec.recording_name,
        artistName: rec.artist_credit_name,
        albumTitle: rec.release_name ?? '',
        because: seedTitle.get(because) ?? '',
      };
      if (track) {
        if (owned.length >= MAX_OWNED || (ownedPerArtist.get(artistKey) ?? 0) >= OWNED_PER_ARTIST) continue;
        if (inPlaylist.has(track.recordingId) || owned.some((o) => o.track!.id === track.id)) continue;
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
          m.artistId = await this.library.artistIdByMbid(artistMbid);
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

function uniqueBy<T>(items: T[], key: (t: T) => string): T[] {
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

/** Evenly spread seeds for variant 0; a seeded shuffle otherwise, so "refresh" gives a new mix. */
function pickSeeds<T>(items: T[], count: number, variant: number, random: () => number): T[] {
  if (items.length <= count && variant === 0) return items;
  if (variant === 0) {
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
