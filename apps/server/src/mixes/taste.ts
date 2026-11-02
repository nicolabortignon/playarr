import type { MixMapSummary } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import type { AudioFeatures } from '../analysis/dsp.ts';
import { styleProfile, type StyleFamily } from '../analysis/styles.ts';
import type { Play } from './history.ts';
import { hourDistance } from './time.ts';

/** A library song with what the mixes know about it. */
export interface Song {
  track: Track;
  /** Style families, weights summing to 1 (empty when nothing is known). */
  families: Partial<Record<StyleFamily, number>>;
  /** 0 (still) … 1 (intense), from the measured sound, else estimated from tags; undefined if unknown. */
  energy?: number;
  /** 0 … 1: how much its tags say calm, soft, relaxing. */
  calm: number;
  /** 0 … 1: instrumental, steady music to work to. */
  focus: number;
  year?: number;
  /** When its album arrived in the library (ms). */
  addedAt?: number;
  /** The album's release date (YYYY-MM-DD) when it's a real one (not just a year). */
  releaseDate?: string;
  /** Its tempo and key, when its mix map is measured: for ordering mixes so neighbours blend. */
  mix?: MixMapSummary;
}

/** What a song is known by, from the catalog and from analysis. */
export interface SongFacts {
  track: Track;
  tags: [string, number][];
  /** Genres from the catalog (album or artist), when ListenBrainz has no tags for the song. */
  genres: string[];
  features?: AudioFeatures;
  albumYear?: number;
  tagYear?: number;
  addedAt?: string;
  releaseDate?: string;
  mix?: MixMapSummary;
}

/** How intense each style feels, for songs whose sound hasn't been measured. */
const FAMILY_ENERGY: Record<StyleFamily, number> = {
  metal: 0.88,
  electronic: 0.68,
  rock: 0.66,
  hiphop: 0.6,
  pop: 0.6,
  world: 0.5,
  soul: 0.48,
  experimental: 0.45,
  jazz: 0.38,
  folk: 0.34,
  cinematic: 0.3,
  chill: 0.24,
  classical: 0.2,
};
const FOCUS_FAMILIES: Partial<Record<StyleFamily, number>> = { chill: 1, classical: 1, cinematic: 0.8, jazz: 0.6, experimental: 0.4, electronic: 0.3 };
const FOCUS_TAGS = ['instrumental', 'post-rock', 'ambient', 'soundtrack', 'piano', 'lo-fi', 'lofi', 'minimal', 'neoclassical', 'study'];

export function toSong(f: SongFacts): Song {
  // Tags from ListenBrainz describe the song; the catalog's genres are a fallback.
  const tags = f.tags.length ? f.tags : f.genres.map((g): [string, number] => [g, 1]);
  const style = styleProfile(tags);
  const families = style.families;
  let energy: number | undefined;
  if (f.features) {
    const x = f.features;
    if (x.bpm > 0) {
      const tempo = Math.min(1, Math.max(0, (x.bpm - 70) / 110)) * x.pulse;
      energy = clamp(0.35 * x.loudness + 0.3 * x.busyness + 0.2 * x.pulse + 0.15 * tempo);
    } else {
      // No beat analysis yet, so no tempo: from how loud and busy it sounds alone, on the same scale.
      energy = clamp((0.35 * x.loudness + 0.3 * x.busyness) / 0.65);
    }
  } else if (Object.keys(families).length) {
    let e = 0;
    for (const [family, w] of Object.entries(families)) e += FAMILY_ENERGY[family as StyleFamily] * w!;
    energy = clamp(e - style.calm * 0.25);
  }
  const tagFocus = tags.some(([t]) => FOCUS_TAGS.some((w) => t.toLowerCase().includes(w))) ? 0.5 : 0;
  let familyFocus = 0;
  for (const [family, w] of Object.entries(families)) familyFocus += (FOCUS_FAMILIES[family as StyleFamily] ?? 0) * w!;
  const year = f.albumYear ?? f.tagYear;
  const date = f.releaseDate?.slice(0, 10);
  return {
    track: f.track,
    families,
    ...(energy !== undefined ? { energy } : {}),
    calm: style.calm,
    focus: clamp(familyFocus * 0.7 + tagFocus + (energy !== undefined && energy < 0.5 ? 0.15 : 0)),
    ...(year ? { year } : {}),
    ...(f.addedAt ? { addedAt: Date.parse(f.addedAt) } : {}),
    // "YYYY-01-01" is how a bare year is stored: not a real day.
    ...(date && !date.endsWith('-01-01') ? { releaseDate: date } : {}),
    ...(f.mix ? { mix: f.mix } : {}),
  };
}

export interface SongStats {
  /** Times heard in full (not skipped). */
  plays: number;
  /** Plays weighted by how recent they are (half-life 60 days). */
  weight: number;
  skips: number;
  /** Last heard (ms). */
  last: number;
}

/** What the listener likes, from history, favorites and playlists. */
export interface Taste {
  songs: Map<string, SongStats>;
  /** Artist id → affinity, 0 … 1 (the favourite artist is 1). */
  artists: Map<number, number>;
  /** Song (recording id) → affinity, 0 … 1. */
  songAffinity: Map<string, number>;
  /** Style families, weighted by affinity, summing to 1. */
  families: Partial<Record<StyleFamily, number>>;
  /** Songs heard in full at all. */
  plays: number;
}

const HALF_LIFE_DAYS = 60;

export function buildTaste(
  songs: Song[],
  plays: Play[],
  favorites: Set<string>,
  inPlaylists: Map<string, number>,
  now = Date.now(),
): Taste {
  const byRecording = new Map(songs.map((s) => [s.track.recordingId, s]));
  const stats = new Map<string, SongStats>();
  let heard = 0;
  for (const p of plays) {
    const s = stats.get(p.recordingId) ?? { plays: 0, weight: 0, skips: 0, last: 0 };
    const at = Date.parse(p.playedAt);
    if (p.skipped) s.skips++;
    else {
      s.plays++;
      s.weight += 0.5 ** ((now - at) / 86_400_000 / HALF_LIFE_DAYS);
      s.last = Math.max(s.last, at);
      heard++;
    }
    stats.set(p.recordingId, s);
  }

  const songScore = new Map<string, number>();
  const add = (id: string, v: number) => songScore.set(id, (songScore.get(id) ?? 0) + v);
  for (const [id, s] of stats) add(id, s.weight - s.skips * 0.5);
  for (const id of favorites) add(id, 3);
  for (const [id, n] of inPlaylists) add(id, Math.min(3, n));

  const artistScore = new Map<number, number>();
  const familyScore: Partial<Record<StyleFamily, number>> = {};
  for (const [id, v] of songScore) {
    const song = byRecording.get(id);
    if (!song || v <= 0) continue;
    artistScore.set(song.track.artistId, (artistScore.get(song.track.artistId) ?? 0) + v);
    for (const [family, w] of Object.entries(song.families)) {
      familyScore[family as StyleFamily] = (familyScore[family as StyleFamily] ?? 0) + v * w!;
    }
  }
  return {
    songs: stats,
    artists: normalized(artistScore),
    songAffinity: normalized(songScore),
    families: shares(familyScore),
    plays: heard,
  };
}

/** What gets played around this hour: artists, styles and energy (null when there isn't enough to go on). */
export interface HourProfile {
  artists: Map<number, number>;
  families: Partial<Record<StyleFamily, number>>;
  energy?: number;
  /** Songs heard around this hour, with how often. */
  songs: Map<string, number>;
  plays: number;
}

const MIN_HOUR_PLAYS = 15;

export function hourProfile(songs: Song[], plays: Play[], hour: number, weekday: number): HourProfile | null {
  const byRecording = new Map(songs.map((s) => [s.track.recordingId, s]));
  const weekend = weekday === 0 || weekday === 6;
  const artists = new Map<number, number>();
  const families: Partial<Record<StyleFamily, number>> = {};
  const heard = new Map<string, number>();
  let energySum = 0;
  let energyWeight = 0;
  let count = 0;
  for (const p of plays) {
    if (p.skipped || hourDistance(p.hour, hour) > 1) continue;
    // The same kind of day (weekday or weekend) counts more: Saturday mornings aren't Monday mornings.
    const w = (hourDistance(p.hour, hour) === 0 ? 1 : 0.6) * ((p.weekday === 0 || p.weekday === 6) === weekend ? 1.5 : 1);
    count++;
    heard.set(p.recordingId, (heard.get(p.recordingId) ?? 0) + w);
    const song = byRecording.get(p.recordingId);
    if (!song) continue;
    artists.set(song.track.artistId, (artists.get(song.track.artistId) ?? 0) + w);
    for (const [family, fw] of Object.entries(song.families)) {
      families[family as StyleFamily] = (families[family as StyleFamily] ?? 0) + w * fw!;
    }
    if (song.energy !== undefined) {
      energySum += song.energy * w;
      energyWeight += w;
    }
  }
  if (count < MIN_HOUR_PLAYS) return null;
  return {
    artists: normalized(artists),
    families: shares(families),
    ...(energyWeight ? { energy: energySum / energyWeight } : {}),
    songs: heard,
    plays: count,
  };
}

/** How alike two style mixes are, 0 … 1 (overlap of their shares). */
export function familySimilarity(a: Partial<Record<StyleFamily, number>>, b: Partial<Record<StyleFamily, number>>): number {
  let overlap = 0;
  for (const [family, w] of Object.entries(a)) overlap += Math.min(w!, b[family as StyleFamily] ?? 0);
  return overlap;
}

/** The strongest style families, strongest first. */
export function topFamilies(families: Partial<Record<StyleFamily, number>>, n: number): StyleFamily[] {
  return (Object.entries(families) as [StyleFamily, number][])
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([f]) => f);
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

function normalized<K>(scores: Map<K, number>): Map<K, number> {
  const max = Math.max(0, ...scores.values());
  const out = new Map<K, number>();
  if (max <= 0) return out;
  for (const [k, v] of scores) if (v > 0) out.set(k, v / max);
  return out;
}

function shares<K extends string>(scores: Partial<Record<K, number>>): Partial<Record<K, number>> {
  const total = Object.values<number>(scores as Record<K, number>).reduce((s, v) => s + v, 0);
  const out: Partial<Record<K, number>> = {};
  if (total <= 0) return out;
  for (const [k, v] of Object.entries(scores) as [K, number][]) out[k] = v / total;
  return out;
}
