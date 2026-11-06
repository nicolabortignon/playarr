import { blendScore, type Blendable } from '@playarr/mix';
import type { MixKind, MixSettings } from '@playarr/shared';
import { FAMILIES, type StyleFamily } from '../analysis/styles.ts';
import { hash32, Rng } from '../cover/random.ts';
import type { Play } from './history.ts';
import { isEnabled } from './settings.ts';
import { familySimilarity, hourProfile, topFamilies, type Song, type Taste } from './taste.ts';
import type { LocalTime } from './time.ts';

/** Everything a mix is made from. */
export interface MixContext {
  songs: Song[];
  taste: Taste;
  /** The last year of listening. */
  plays: Play[];
  local: LocalTime;
  now: number;
  settings: MixSettings;
  /** Library songs ListenBrainz finds alike to the most played ones (track id → 0 … 1). */
  neighbours: Map<number, number>;
}

/** A mix to make: its kind, and for genre and decade mixes which one. */
export interface MixPlan {
  key: string;
  kind: MixKind;
  param?: string;
}

export interface GeneratedMix {
  key: string;
  kind: MixKind;
  title: string;
  subtitle: string;
  description: string;
  /** Only Vibes, Discovery and On Repeat have one of their own (the rest take theirs from `planHues`). */
  hue?: number;
  trackIds: number[];
  /** The same songs by recording: they survive a song getting a new track id (matched on MusicBrainz). */
  recordingIds?: string[];
}

/** Under this many songs, a mix isn't worth showing. */
export const MIN_TRACKS = 8;
/** At least this many songs of a style or decade before it gets its own mix. */
const MIN_POOL = 30;
const DAY = 86_400_000;

/** Which mixes to make now, in the order Home shows them. */
export function planMixes(ctx: MixContext): MixPlan[] {
  const { settings } = ctx;
  const plan: MixPlan[] = [];
  const add = (kind: MixKind, param?: string) => {
    if (isEnabled(settings, kind)) plan.push({ key: param ? `${kind}-${param}` : kind, kind, ...(param ? { param } : {}) });
  };
  add('vibes');
  add('discovery');
  add('repeat');
  add('blast');
  for (const family of genrePicks(ctx, settings.genreMixes)) add('genre', family);
  add('deepcuts');
  add('fresh');
  for (const decade of decadePicks(ctx, settings.decadeMixes)) add('decade', String(decade));
  add('energy');
  add('focus');
  add('winddown');
  add('onthisday');
  return plan;
}

/**
 * Each kind of mix owns a stretch of the colour wheel (OKLCH hue), so a shelf of them doesn't repeat a colour: the
 * fixed mixes the pinks, reds and ambers (one each), genres the greens to azures, decades the blues to violets. Genres
 * and decades are spread evenly over theirs (decades oldest first), so two of them are never close. Vibes, Discovery
 * and On Repeat keep a hue of their own, which the apps only show until they've blended the colours of the mix's
 * first two covers.
 */
const FIXED_HUES: Partial<Record<MixKind, number>> = { focus: 338, winddown: 356, energy: 14, blast: 32, deepcuts: 50, onthisday: 68, fresh: 86 };
const GENRE_HUES = { from: 110, to: 225 };
const DECADE_HUES = { from: 240, to: 320 };
const FAMILY_ORDER = Object.keys(FAMILIES) as StyleFamily[];

export function planHues(plan: MixPlan[]): Map<string, number> {
  const hues = new Map<string, number>();
  const spread = (entries: MixPlan[], band: { from: number; to: number }) =>
    entries.forEach((p, i) => hues.set(p.key, Math.round(band.from + ((band.to - band.from) * (i + 0.5)) / entries.length)));
  for (const p of plan) if (FIXED_HUES[p.kind] !== undefined) hues.set(p.key, FIXED_HUES[p.kind]!);
  const order = (p: MixPlan) => FAMILY_ORDER.indexOf(p.param as StyleFamily);
  spread(plan.filter((p) => p.kind === 'genre').sort((a, b) => order(a) - order(b)), GENRE_HUES);
  spread(plan.filter((p) => p.kind === 'decade').sort((a, b) => Number(a.param) - Number(b.param)), DECADE_HUES);
  return hues;
}

/** Make one mix; null when there aren't enough songs for it. `period` and `variant` seed the randomness. */
export function generateMix(plan: MixPlan, ctx: MixContext, period: string, variant = 0): GeneratedMix | null {
  const rng = new Rng(hash32(`${plan.key}|${period}|${variant}`));
  const made = GENERATORS[plan.kind](ctx, rng, plan.param);
  if (!made || made.songs.length < MIN_TRACKS) return null;
  return {
    key: plan.key,
    kind: plan.kind,
    title: made.title,
    subtitle: made.subtitle,
    description: made.description,
    ...(made.hue === undefined ? {} : { hue: made.hue }),
    trackIds: made.songs.map((s) => s.track.id),
    recordingIds: made.songs.map((s) => s.track.recordingId),
  };
}

interface Made {
  title: string;
  subtitle: string;
  description: string;
  hue?: number;
  songs: Song[];
}

type Generator = (ctx: MixContext, rng: Rng, param?: string) => Made | null;

const GENERATORS: Record<MixKind, Generator> = {
  vibes,
  discovery,
  repeat,
  blast,
  deepcuts,
  fresh,
  decade,
  genre,
  energy,
  winddown,
  focus,
  onthisday,
};

// ── The mixes ──────────────────────────────────────────────────────────────

/** Default moods by time of day, for when there's no listening history around this hour yet. */
const DAYPARTS: { from: number; to: number; name: string; energy: number; families: StyleFamily[]; hue: number; words: string }[] = [
  { from: 5, to: 10, name: 'Morning', energy: 0.45, families: ['folk', 'soul', 'pop', 'jazz', 'chill'], hue: 70, words: 'easy and bright' },
  { from: 10, to: 17, name: 'Daytime', energy: 0.65, families: ['pop', 'rock', 'electronic', 'hiphop', 'soul'], hue: 35, words: 'upbeat' },
  { from: 17, to: 22, name: 'Evening', energy: 0.5, families: ['soul', 'jazz', 'rock', 'pop', 'electronic'], hue: 330, words: 'warm' },
  { from: 22, to: 29, name: 'Late night', energy: 0.25, families: ['chill', 'jazz', 'classical', 'cinematic', 'electronic'], hue: 265, words: 'quiet and deep' },
];

function daypart(hour: number) {
  const h = hour < 5 ? hour + 24 : hour;
  return DAYPARTS.find((d) => h >= d.from && h < d.to)!;
}

function vibes(ctx: MixContext, rng: Rng): Made | null {
  const { local, taste, settings } = ctx;
  const part = daypart(local.hour);
  const profile = hourProfile(ctx.songs, ctx.plays, local.hour, local.weekday);
  const targetFamilies = profile?.families ?? Object.fromEntries(part.families.map((f, i) => [f, (5 - i) / 15]));
  const targetEnergy = profile?.energy ?? part.energy;
  const scored = ctx.songs.map((song) => {
    const heardHere = profile?.songs.get(song.track.recordingId) ?? 0;
    const artistHere = profile?.artists.get(song.track.artistId) ?? 0;
    const energyFit = song.energy === undefined ? 0.4 : 1 - Math.abs(song.energy - targetEnergy) * 1.6;
    const score =
      0.3 * artistHere +
      0.3 * familySimilarity(song.families, targetFamilies) +
      0.2 * energyFit +
      0.1 * (taste.artists.get(song.track.artistId) ?? 0) +
      0.1 * Math.min(1, heardHere / 3) -
      skipPenalty(ctx, song) +
      rng.next() * 0.15;
    return { song, score };
  });
  // Half what you play at this hour, half like it.
  const familiar = scored.filter((s) => profile?.songs.has(s.song.track.recordingId));
  const fresh = scored.filter((s) => !profile?.songs.has(s.song.track.recordingId));
  const known = choose(familiar, Math.ceil(settings.length / 2), 2);
  const picked = [...known, ...choose(fresh, settings.length - known.length, 2)];
  const time = hourLabel(local.hour);
  const styles = familyNames(topFamilies(targetFamilies, 2));
  return {
    title: 'Vibes of the hour',
    subtitle: profile ? `Your ${time} sound` : `${part.name}: ${part.words}`,
    description: profile
      ? `What you usually play around ${time}${styles ? ` — ${styles}` : ''}, with ${artistsLine(picked)}. Half familiar, half in the same mood. A new one every hour.`
      : `Music for ${part.name.toLowerCase()} (${part.words}${styles ? `: ${styles}` : ''}). Play more around this hour and it learns your own ${time} sound. A new one every hour.`,
    hue: part.hue,
    songs: smooth(picked, rng),
  };
}

/** The first song of a Feeling Lucky press, and what it was picked for ("Your 9 PM sound", "Evening: warm"). */
export interface LuckySeed {
  song: Song;
  subtitle: string;
}

/**
 * Feeling Lucky's first song: one that suits this hour, scored as Vibes of the hour scores its songs (what this account
 * plays around now once there's enough history at this hour, else the time of day's mood), but picked with a big dose
 * of chance among the best, so every press starts somewhere else. One press in four wanders: a song not heard at this
 * hour, in the same mood. `avoid`: recent first songs and the last press's songs.
 */
export function luckySeed(ctx: MixContext, rng: Rng, avoid: Set<string>): LuckySeed | null {
  const { local, taste } = ctx;
  const part = daypart(local.hour);
  const profile = hourProfile(ctx.songs, ctx.plays, local.hour, local.weekday);
  const targetFamilies = profile?.families ?? Object.fromEntries(part.families.map((f, i) => [f, (5 - i) / 15]));
  const targetEnergy = profile?.energy ?? part.energy;
  const wander = !profile || rng.next() < 0.25;
  const candidates = ctx.songs.filter((s) => !avoid.has(s.track.recordingId) && (!wander || !profile?.songs.has(s.track.recordingId)));
  const pool = candidates.length ? candidates : ctx.songs;
  const scored = pool.map((song) => {
    const heardHere = profile?.songs.get(song.track.recordingId) ?? 0;
    const artistHere = profile?.artists.get(song.track.artistId) ?? 0;
    const energyFit = song.energy === undefined ? 0.4 : 1 - Math.abs(song.energy - targetEnergy) * 1.6;
    const score =
      0.3 * artistHere +
      0.3 * familySimilarity(song.families, targetFamilies) +
      0.2 * energyFit +
      0.1 * (taste.artists.get(song.track.artistId) ?? 0) +
      (wander ? 0 : 0.1 * Math.min(1, heardHere / 3)) -
      skipPenalty(ctx, song) +
      rng.next() * 0.45;
    return { song, score };
  });
  // Any of the best sixteen: chance has already shuffled which those are.
  const best = scored.sort((a, b) => b.score - a.score).slice(0, 16);
  const pick = best[Math.floor(rng.next() * best.length)];
  if (!pick) return null;
  return { song: pick.song, subtitle: profile ? `Your ${hourLabel(local.hour)} sound` : `${part.name}: ${part.words}` };
}

function discovery(ctx: MixContext, rng: Rng): Made | null {
  const { taste, settings } = ctx;
  const a = settings.adventurous;
  const candidates = ctx.songs.filter((s) => !taste.songs.has(s.track.recordingId) && !taste.songAffinity.has(s.track.recordingId));
  const scored = candidates.map((song) => {
    const known = taste.artists.get(song.track.artistId) ?? 0;
    const style = familySimilarity(song.families, taste.families);
    const neighbour = ctx.neighbours.get(song.track.id) ?? 0;
    const unknownArtist = known === 0 ? 1 : 0;
    const score = (1 - a) * 0.4 * known + 0.3 * style + 0.3 * neighbour + a * 0.35 * unknownArtist * (0.4 + style) + rng.next() * (0.1 + a * 0.15);
    return { song, score };
  });
  const songs = choose(scored, settings.length, 2);
  return {
    title: 'Discovery Weekly',
    subtitle: 'Your library, unheard',
    description: `Songs in your library you haven’t played yet, ${a < 0.34 ? 'close to what you love' : a > 0.66 ? 'reaching beyond your usual' : 'some close to what you love, some further out'}: ${artistsLine(songs)}. A new one every Monday.`,
    hue: 165,
    songs: flow(songs, rng),
  };
}

function repeat(ctx: MixContext): Made | null {
  const since = ctx.now - 30 * DAY;
  const counts = new Map<string, { n: number; last: number }>();
  for (const p of ctx.plays) {
    const at = Date.parse(p.playedAt);
    if (p.skipped || at < since) continue;
    const c = counts.get(p.recordingId) ?? { n: 0, last: 0 };
    c.n++;
    c.last = Math.max(c.last, at);
    counts.set(p.recordingId, c);
  }
  const songs = ctx.songs
    .filter((s) => (counts.get(s.track.recordingId)?.n ?? 0) >= 2)
    .sort((x, y) => {
      const a = counts.get(x.track.recordingId)!;
      const b = counts.get(y.track.recordingId)!;
      return b.n - a.n || b.last - a.last;
    })
    .slice(0, ctx.settings.length);
  // Most played first is what this mix is: not reordered to blend.
  return {
    title: 'On Repeat',
    subtitle: 'Your most played lately',
    description: `The songs you’ve played most in the last 30 days, most played first: ${artistsLine(songs)}.`,
    hue: 18,
    songs,
  };
}

function blast(ctx: MixContext, rng: Rng): Made | null {
  const { taste, settings } = ctx;
  const cutoff = ctx.now - settings.blastDays * DAY;
  const old = ctx.songs
    .filter((s) => {
      const st = taste.songs.get(s.track.recordingId);
      return st && st.plays >= 3 && st.last < cutoff;
    })
    .map((song) => {
      const st = taste.songs.get(song.track.recordingId)!;
      return { song, score: Math.log2(1 + st.plays) * Math.log10(10 + (ctx.now - st.last) / DAY) + rng.next() * 0.5 };
    });
  let songs = choose(old, settings.length, 3);
  let source = 'played a lot, then not for a while';
  if (songs.length < MIN_TRACKS) {
    // Not enough history yet: loved songs not heard lately, then albums from the library's early days.
    // "From the past" needs a past: only songs in the library for at least as long as the window.
    const loved = ctx.songs
      .filter((s) => (taste.songAffinity.get(s.track.recordingId) ?? 0) > 0 && s.addedAt !== undefined && s.addedAt < cutoff)
      .filter((s) => (taste.songs.get(s.track.recordingId)?.last ?? 0) < cutoff)
      .map((song) => ({ song, score: taste.songAffinity.get(song.track.recordingId)! + rng.next() * 0.3 }));
    const early = ctx.songs
      .filter((s) => s.addedAt !== undefined && s.addedAt < ctx.now - 365 * DAY && !taste.songs.has(s.track.recordingId))
      .map((song) => ({ song, score: rng.next() * 0.5 + (taste.artists.get(song.track.artistId) ?? 0) * 0.3 }));
    songs = choose([...old, ...loved.map((x) => ({ ...x, score: x.score + 2 })), ...early], settings.length, 3);
    source = 'loved, or from your library’s early days, and not heard lately';
  }
  return {
    title: 'Blast from the past',
    subtitle: `Not heard for ${daysLabel(settings.blastDays)}`,
    description: `Songs you ${source}: ${artistsLine(songs)}.`,
    songs: flow(songs, rng),
  };
}

function deepcuts(ctx: MixContext, rng: Rng): Made | null {
  const { taste } = ctx;
  const favourites = [...taste.artists].sort((a, b) => b[1] - a[1]).slice(0, 20);
  if (favourites.length < 2) return null;
  const top = new Map(favourites);
  const scored = ctx.songs
    .filter((s) => top.has(s.track.artistId))
    .filter((s) => (taste.songs.get(s.track.recordingId)?.plays ?? 0) <= 1 && !taste.songAffinity.has(s.track.recordingId))
    .map((song) => ({ song, score: top.get(song.track.artistId)! * (0.6 + rng.next() * 0.8) - skipPenalty(ctx, song) }));
  const songs = choose(scored, ctx.settings.length, 3);
  return {
    title: 'Deep cuts',
    subtitle: 'The other songs of artists you love',
    description: `Songs you’ve barely played, by the artists you play most: ${artistsLine(songs)}.`,
    songs: flow(songs, rng),
  };
}

function fresh(ctx: MixContext, rng: Rng): Made | null {
  const since = ctx.now - 30 * DAY;
  const byAlbum = new Map<number, Song[]>();
  for (const s of ctx.songs) {
    if (s.addedAt === undefined || s.addedAt < since || ctx.taste.songs.has(s.track.recordingId)) continue;
    byAlbum.set(s.track.albumId, [...(byAlbum.get(s.track.albumId) ?? []), s]);
  }
  // Newest albums first, a few songs from each.
  const albums = [...byAlbum.values()].sort((a, b) => b[0]!.addedAt! - a[0]!.addedAt!);
  const songs: Song[] = [];
  for (const album of albums) {
    songs.push(...shuffle(album, rng).slice(0, 3));
    if (songs.length >= ctx.settings.length) break;
  }
  return {
    title: 'Fresh arrivals',
    subtitle: 'New in your library',
    description: `A few songs from each album added in the last 30 days that you haven’t played yet: ${artistsLine(songs)}.`,
    songs: flow(songs.slice(0, ctx.settings.length), rng),
  };
}

function decade(ctx: MixContext, rng: Rng, param?: string): Made | null {
  const from = Number(param);
  if (!from) return null;
  const scored = ctx.songs
    .filter((s) => s.year !== undefined && s.year >= from && s.year < from + 10)
    .map((song) => ({ song, score: affinity(ctx, song) * 0.5 + familySimilarity(song.families, ctx.taste.families) * 0.2 + rng.next() * 0.4 - skipPenalty(ctx, song) }));
  const songs = choose(scored, ctx.settings.length, 2);
  return {
    title: `The ${decadeName(from)}`,
    subtitle: `Your ${decadeName(from)}, ${from}–${from + 9}`,
    description: `Songs from ${from} to ${from + 9} in your library, leaning towards what you play: ${artistsLine(songs)}.`,
    songs: flow(songs, rng),
  };
}

function genre(ctx: MixContext, rng: Rng, param?: string): Made | null {
  const family = param as StyleFamily;
  const info = FAMILIES[family];
  if (!info) return null;
  const scored = ctx.songs
    .filter((s) => (s.families[family] ?? 0) >= 0.4)
    .map((song) => ({ song, score: song.families[family]! * 0.3 + affinity(ctx, song) * 0.4 + rng.next() * 0.3 - skipPenalty(ctx, song) }));
  const songs = choose(scored, ctx.settings.length, 2);
  const label = info.label[0]!.toUpperCase() + info.label.slice(1);
  return {
    title: `${label} mix`,
    subtitle: `Your ${info.label}`,
    description: `${label} from your library, favorites and songs you haven’t heard mixed together: ${artistsLine(songs)}.`,
    songs: smooth(songs, rng),
  };
}

function energy(ctx: MixContext, rng: Rng): Made | null {
  const scored = ctx.songs
    .filter((s) => s.energy !== undefined && s.energy >= 0.62 && s.calm < 0.3)
    .map((song) => ({ song, score: song.energy! * 0.5 + affinity(ctx, song) * 0.3 + rng.next() * 0.2 - skipPenalty(ctx, song) }));
  const songs = choose(scored, ctx.settings.length, 2);
  return {
    title: 'Energy boost',
    subtitle: 'Loud, fast, building up',
    description: `Your most intense songs — loud, busy, a strong beat — building as it goes: ${artistsLine(songs)}.`,
    songs: blendOrder([...songs].sort((a, b) => a.energy! - b.energy!), energyStep(MIDDLE_ENERGY)),
  };
}

/** A Wind down song's energy when only its tags say it's calm: low, but not the stillest. */
const CALM_ENERGY = 0.3;

function winddown(ctx: MixContext, rng: Rng): Made | null {
  const scored = ctx.songs
    .filter((s) => (s.energy !== undefined && s.energy <= 0.38) || s.calm >= 0.5)
    .map((song) => ({ song, score: (1 - (song.energy ?? CALM_ENERGY)) * 0.35 + song.calm * 0.2 + affinity(ctx, song) * 0.25 + rng.next() * 0.2 - skipPenalty(ctx, song) }));
  const songs = choose(scored, ctx.settings.length, 2);
  return {
    title: 'Wind down',
    subtitle: 'Calm, soft, slowing down',
    description: `Quiet, gentle songs, settling as it goes: ${artistsLine(songs)}.`,
    songs: blendOrder([...songs].sort((a, b) => (b.energy ?? CALM_ENERGY) - (a.energy ?? CALM_ENERGY)), energyStep(CALM_ENERGY)),
  };
}

function focus(ctx: MixContext, rng: Rng): Made | null {
  const scored = ctx.songs
    .filter((s) => s.focus >= 0.5 && (s.energy === undefined || (s.energy >= 0.12 && s.energy <= 0.6)))
    .map((song) => ({ song, score: song.focus * 0.4 + affinity(ctx, song) * 0.3 + rng.next() * 0.3 - skipPenalty(ctx, song) }));
  const songs = choose(scored, ctx.settings.length, 2);
  return {
    title: 'Deep focus',
    subtitle: 'Steady, mostly instrumental',
    description: `Steady, mostly instrumental music to work or read to: ${artistsLine(songs)}.`,
    songs: smooth(songs, rng),
  };
}

function onthisday(ctx: MixContext, rng: Rng): Made | null {
  const { local } = ctx;
  const today = Date.UTC(2000, local.month - 1, local.day);
  const byAlbum = new Map<number, Song[]>();
  for (const s of ctx.songs) {
    if (!s.releaseDate) continue;
    const [, m, d] = s.releaseDate.split('-').map(Number);
    if (!m || !d) continue;
    const gap = Math.abs(Date.UTC(2000, m - 1, d) - today) / DAY;
    if (Math.min(gap, 366 - gap) > 3) continue;
    byAlbum.set(s.track.albumId, [...(byAlbum.get(s.track.albumId) ?? []), s]);
  }
  const songs: Song[] = [];
  for (const album of shuffle([...byAlbum.values()], rng)) songs.push(...shuffle(album, rng).slice(0, 3));
  // Oldest first tells the story of the week: not reordered to blend.
  const picked = songs.slice(0, ctx.settings.length).sort((a, b) => Number(a.releaseDate!.slice(0, 4)) - Number(b.releaseDate!.slice(0, 4)));
  const years = picked.map((s) => Number(s.releaseDate!.slice(0, 4)));
  return {
    title: 'On this day',
    subtitle: years.length ? `Released this week, ${Math.min(...years)}–${Math.max(...years)}` : 'Released this week',
    description: `Songs from albums released this week in years past, oldest first: ${artistsLine(picked)}.`,
    songs: picked,
  };
}

// ── Choosing which genres and decades get a mix ────────────────────────────

function genrePicks(ctx: MixContext, n: number): StyleFamily[] {
  if (!n) return [];
  const weight: Partial<Record<StyleFamily, number>> = {};
  const pool: Partial<Record<StyleFamily, number>> = {};
  for (const s of ctx.songs) {
    const a = 0.3 + affinity(ctx, s);
    for (const [family, w] of Object.entries(s.families) as [StyleFamily, number][]) {
      weight[family] = (weight[family] ?? 0) + w * a;
      if (w >= 0.4) pool[family] = (pool[family] ?? 0) + 1;
    }
  }
  return topFamilies(weight, 13)
    .filter((f) => (pool[f] ?? 0) >= MIN_POOL)
    .slice(0, n);
}

function decadePicks(ctx: MixContext, n: number): number[] {
  if (!n) return [];
  const weight = new Map<number, number>();
  const pool = new Map<number, number>();
  for (const s of ctx.songs) {
    if (!s.year) continue;
    const d = Math.floor(s.year / 10) * 10;
    weight.set(d, (weight.get(d) ?? 0) + 0.3 + affinity(ctx, s));
    pool.set(d, (pool.get(d) ?? 0) + 1);
  }
  return [...weight]
    .filter(([d]) => (pool.get(d) ?? 0) >= MIN_POOL)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([d]) => d);
}

// ── Picking and ordering ───────────────────────────────────────────────────

/** How much the listener likes a song: its own affinity, and its artist's. */
function affinity(ctx: MixContext, song: Song): number {
  return Math.max(ctx.taste.songAffinity.get(song.track.recordingId) ?? 0, (ctx.taste.artists.get(song.track.artistId) ?? 0) * 0.8);
}

/** Songs skipped more often than played sink. */
function skipPenalty(ctx: MixContext, song: Song): number {
  const st = ctx.taste.songs.get(song.track.recordingId);
  return st && st.skips > st.plays ? 0.3 : 0;
}

/** The best scored songs, at most `perArtist` by any one artist, no song twice. */
export function choose(scored: { song: Song; score: number }[], n: number, perArtist: number): Song[] {
  const seen = new Set<number>();
  const perArtistCount = new Map<number, number>();
  const out: Song[] = [];
  for (const { song } of [...scored].sort((a, b) => b.score - a.score)) {
    if (out.length >= n) break;
    if (seen.has(song.track.id)) continue;
    const count = perArtistCount.get(song.track.artistId) ?? 0;
    if (count >= perArtist) continue;
    seen.add(song.track.id);
    perArtistCount.set(song.track.artistId, count + 1);
    out.push(song);
  }
  return out;
}

/** Shuffle, then never the same artist twice in a row where it can be helped. */
export function spread(songs: Song[], rng: Rng): Song[] {
  const rest = shuffle(songs, rng);
  const out: Song[] = [];
  while (rest.length) {
    const prev = out.at(-1)?.track.artistId;
    const i = rest.findIndex((s) => s.track.artistId !== prev);
    out.push(rest.splice(i === -1 ? 0 : i, 1)[0]!);
  }
  return out;
}

/** Shuffled for a different start each time, then ordered so neighbours blend. */
function flow(songs: Song[], rng: Rng): Song[] {
  return blendOrder(spread(songs, rng));
}

/** A gentle rise and fall of energy (where it's known) instead of jumps, ordered to blend within each step of it. */
function smooth(songs: Song[], rng: Rng): Song[] {
  const known = songs.filter((s) => s.energy !== undefined);
  if (known.length < songs.length / 2) return flow(songs, rng);
  const sorted = [...songs].sort((a, b) => (a.energy ?? MIDDLE_ENERGY) - (b.energy ?? MIDDLE_ENERGY));
  // Low → high → low: alternate ends of the sorted list into the front and back.
  const front: Song[] = [];
  const back: Song[] = [];
  sorted.forEach((s, i) => (i % 2 ? back : front).push(s));
  return blendOrder([...front, ...back.reverse()], energyStep(MIDDLE_ENERGY));
}

/** What blending knows of a song without its energy: tempo and key from its mix map, unknown without one. */
export function tempoAndKey(song: Song): Blendable {
  return song.mix ?? NO_MIX_MAP;
}

/** What blending knows of a song: tempo and key (see tempoAndKey) and its energy. */
export function blendable(song: Song): Blendable {
  return song.energy === undefined ? tempoAndKey(song) : { ...tempoAndKey(song), energy: song.energy };
}

/** No beat and no key: blendScore counts both as neutral, so the song is placed by its energy alone. */
const NO_MIX_MAP: Blendable = { bpm: 0, beatConfidence: 0, gridStable: false };
/**
 * Enough 2-opt swaps for blending to settle a mix of a hundred songs, few enough that making mixes stays
 * quick. Swaps that keep an artist from playing twice in a row don't count: that rule always comes first.
 */
const MAX_BLEND_SWAPS = 200;
/** Energy that builds or settles goes in steps this wide; within a step, songs are ordered to blend. */
const ENERGY_STEP = 0.15;
/** Blend gains smaller than this are rounding, not a better order. */
const BLEND_EPSILON = 1e-9;

/** Where songs of unknown energy go in a mix shaped by energy, unless it says otherwise. */
const MIDDLE_ENERGY = 0.5;

/** A song's step of energy; `unknown` must be what the mix sorted songs of unknown energy as, or they'd split its steps. */
const energyStep = (unknown: number) => (song: Song) => Math.floor((song.energy ?? unknown) / ENERGY_STEP);

/**
 * Orders songs so each blends into the next (blendScore): from the first song (the planned start), a
 * greedy walk to the song left that blends best, then 2-opt passes (reversing a stretch of the order when
 * its two ends blend better that way round), at most MAX_BLEND_SWAPS of them. Never the same artist twice
 * in a row where it can be helped: that comes before blending. With `stepOf`, the order of steps is kept
 * (energy that builds, say): only songs next to each other in the same step trade places.
 */
export function blendOrder(songs: Song[], stepOf?: (song: Song) => number): Song[] {
  const count = songs.length;
  if (count < 3) return [...songs];
  const blends = songs.map(blendable);
  const score = blends.map((a, i) => blends.map((b, j) => (i === j ? 0 : blendScore(a, b))));
  const artist = songs.map((s) => s.track.artistId);
  // Runs of neighbours in the same step, numbered in order: the walk finishes one before starting the next.
  const run: number[] = [0];
  for (let i = 1; i < count; i++) run.push(stepOf && stepOf(songs[i]!) !== stepOf(songs[i - 1]!) ? run[i - 1]! + 1 : run[i - 1]!);

  const order = [0];
  const left = new Set(songs.keys());
  left.delete(0);
  while (left.size) {
    const previous = order.at(-1)!;
    const current = Math.min(...[...left].map((i) => run[i]!));
    const inRun = [...left].filter((i) => run[i] === current);
    const otherArtists = inRun.filter((i) => artist[i] !== artist[previous]);
    // Ties go to the earlier song, so without anything to go on the planned order stays.
    const next = (otherArtists.length ? otherArtists : inRun).reduce((best, i) => (score[previous]![i]! > score[previous]![best]! ? i : best));
    order.push(next);
    left.delete(next);
  }

  // Reversing order[i..j] only changes its two ends' neighbours; runs stay whole as long as i and j share one.
  const sameArtist = (a: number, b: number | undefined) => (b !== undefined && artist[a] === artist[b] ? 1 : 0);
  const blend = (a: number, b: number | undefined) => (b === undefined ? 0 : score[a]![b]!);
  const repeats = () => order.reduce((n, song, i) => n + (i ? sameArtist(order[i - 1]!, song) : 0), 0);
  let blendSwaps = 0;
  let changed = true;
  // Once blending has had its swaps, passes go on only while an artist still plays twice in a row.
  while (changed && (blendSwaps < MAX_BLEND_SWAPS || repeats() > 0)) {
    changed = false;
    for (let i = 1; i < count - 1; i++) {
      for (let j = i + 1; j < count; j++) {
        if (run[order[j]!] !== run[order[i]!]) break;
        const before = order[i - 1]!;
        const first = order[i]!;
        const last = order[j]!;
        const after = order[j + 1];
        const repeatsNow = sameArtist(before, first) + sameArtist(last, after);
        const repeatsThen = sameArtist(before, last) + sameArtist(first, after);
        const gain = blend(before, last) + blend(first, after) - blend(before, first) - blend(last, after);
        const repairs = repeatsThen < repeatsNow;
        if (repairs || (repeatsThen === repeatsNow && gain > BLEND_EPSILON && blendSwaps < MAX_BLEND_SWAPS)) {
          order.splice(i, j - i + 1, ...order.slice(i, j + 1).reverse());
          if (!repairs) blendSwaps++;
          changed = true;
        }
      }
    }
  }
  breakRuns(order, artist, run);
  return order.map((i) => songs[i]!);
}

/**
 * Breaks up what runs of one artist are left (reversals can't always: say the run is at the very start),
 * swapping in the nearest later song that fits there. Best is one that leaves no new run where it came
 * from, and from the same step, so the mix's shape barely changes; failing that, any song by someone
 * else, and a run that makes further on is broken up when the pass gets there.
 */
function breakRuns(order: number[], artist: number[], run: number[]) {
  const artistAt = (k: number) => (k >= 0 && k < order.length ? artist[order[k]!] : undefined);
  for (let i = 1; i < order.length; i++) {
    const previous = artistAt(i - 1);
    if (artistAt(i) !== previous) continue;
    let best = -1;
    let bestRank = -1;
    for (let k = i + 1; k < order.length && bestRank < 3; k++) {
      if (artistAt(k) === previous) continue;
      const fitsHere = k === i + 1 || artistAt(k) !== artistAt(i + 1);
      const leavesNoRun = (k - 1 === i || artistAt(i) !== artistAt(k - 1)) && artistAt(i) !== artistAt(k + 1);
      const rank = (fitsHere && leavesNoRun ? 2 : 0) + (run[order[k]!] === run[order[i]!] ? 1 : 0);
      if (rank > bestRank) [best, bestRank] = [k, rank];
    }
    if (best !== -1) [order[i], order[best]] = [order[best]!, order[i]!];
  }
}

function shuffle<T>(items: T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ── Words ──────────────────────────────────────────────────────────────────

/** "Massive Attack, Portishead, Björk and more". */
export function artistsLine(songs: Song[], max = 3): string {
  const names: string[] = [];
  for (const s of songs) {
    if (!names.includes(s.track.artistName)) names.push(s.track.artistName);
    if (names.length > max) break;
  }
  if (!names.length) return 'nothing yet';
  if (names.length <= max) return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${names.slice(0, max).join(', ')} and more`;
}

export function hourLabel(hour: number): string {
  if (hour === 0) return 'midnight';
  if (hour === 12) return 'noon';
  return `${hour % 12} ${hour < 12 ? 'AM' : 'PM'}`;
}

function familyNames(families: StyleFamily[]): string {
  return families.map((f) => FAMILIES[f].label).join(' and ');
}

function decadeName(from: number): string {
  return from >= 2000 ? `${from}s` : `${String(from).slice(2)}s`;
}

function daysLabel(days: number): string {
  if (days >= 365) return 'a year';
  if (days >= 180) return 'six months';
  if (days >= 90) return 'three months';
  return 'a month';
}

