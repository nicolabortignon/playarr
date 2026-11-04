import { blendScore, type Camelot } from '@playarr/mix';
import type { MixSettings, Track } from '@playarr/shared';
import { describe, expect, it } from 'vitest';
import { Rng } from '../cover/random.ts';
import { blendable, blendOrder, generateMix, planHues, planMixes, type MixContext, type MixPlan } from './generators.ts';
import type { Play } from './history.ts';
import { MIX_DEFAULTS } from './settings.ts';
import { buildTaste, hourProfile, toSong, type Song } from './taste.ts';
import { localTime, nextBoundary } from './time.ts';

const NOW = Date.parse('2026-11-01T21:30:00Z');
let nextId = 1;

function track(artistId: number, over: Partial<Track> = {}): Track {
  const id = nextId++;
  return {
    id,
    recordingId: `rec-${id}`,
    fileId: id,
    albumId: artistId * 100 + Math.floor(id / 10),
    artistId,
    title: `Song ${id}`,
    artistName: `Artist ${artistId}`,
    albumTitle: `Album ${artistId}`,
    trackNumber: 1,
    discNumber: 1,
    duration: 200,
    explicit: false,
    format: { codec: 'FLAC', lossless: true },
    size: 1,
    streamUrl: `/stream/${id}`,
    ...over,
  } as Track;
}

/** `n` songs by each of `artists` artists, tagged with `tags`, from `year`. */
function library(artists: number[], n: number, opts: { tags?: string[]; year?: number; energy?: number; addedAt?: string; releaseDate?: string } = {}): Song[] {
  return artists.flatMap((a) =>
    Array.from({ length: n }, () =>
      toSong({
        track: track(a),
        tags: (opts.tags ?? []).map((t): [string, number] => [t, 1]),
        genres: [],
        ...(opts.energy !== undefined
          ? {
              features: {
                version: 1,
                bpm: 120,
                pulse: opts.energy,
                loudness: opts.energy,
                dynamics: 0.5,
                brightness: 0.5,
                busyness: opts.energy,
                bass: 0.5,
                envelope: [],
                seconds: 200,
                raw: { meanDb: 0, rangeDb: 0, centroidHz: 0, onsetsPerSec: 0, lowShare: 0 },
              },
            }
          : {}),
        albumYear: opts.year,
        addedAt: opts.addedAt,
        releaseDate: opts.releaseDate,
      }),
    ),
  );
}

function play(song: Song, daysAgo: number, hour = 21, extra: Partial<Play> = {}): Play {
  return {
    recordingId: song.track.recordingId,
    trackId: song.track.id,
    artistId: song.track.artistId,
    playedAt: new Date(NOW - daysAgo * 86_400_000).toISOString(),
    hour,
    weekday: 0,
    seconds: 200,
    skipped: false,
    ...extra,
  };
}

/** Settings for a test; short mix lengths keep the fixtures small. */
type TestSettings = Partial<Omit<MixSettings, 'length'>> & { length?: number };

function context(songs: Song[], plays: Play[] = [], settings: TestSettings = {}, favorites: string[] = []): MixContext {
  const s = { ...MIX_DEFAULTS, length: 25, ...settings } as unknown as MixSettings;
  return {
    songs,
    plays,
    taste: buildTaste(songs, plays, new Set(favorites), new Map(), NOW),
    local: localTime(new Date(NOW), 'UTC'),
    now: NOW,
    settings: s,
    neighbours: new Map(),
  };
}

const songsOf = (ctx: MixContext, ids: number[]) => ids.map((id) => ctx.songs.find((s) => s.track.id === id)!);

describe('mixes', () => {
  it('plans a mix per kind, the styles and decades played most, and skips kinds turned off', () => {
    const songs = [
      ...library([1, 2, 3, 4], 10, { tags: ['techno'], year: 1995 }),
      ...library([5, 6, 7, 8], 10, { tags: ['jazz'], year: 1962 }),
    ];
    const ctx = context(songs, songs.slice(0, 20).map((s) => play(s, 3)), { genreMixes: 1, decadeMixes: 1, enabled: { onthisday: false } });
    const keys = planMixes(ctx).map((p) => p.key);
    expect(keys).toContain('vibes');
    expect(keys).toContain('genre-electronic');
    expect(keys).not.toContain('genre-jazz'); // only one genre mix asked for, and techno is what's played
    expect(keys).toContain('decade-1990');
    expect(keys).not.toContain('onthisday');
  });

  it('gives each kind of mix its own stretch of colours, genres and decades spread evenly over theirs', () => {
    const plan: MixPlan[] = [
      { key: 'vibes', kind: 'vibes' },
      { key: 'energy', kind: 'energy' },
      { key: 'blast', kind: 'blast' },
      { key: 'genre-rock', kind: 'genre', param: 'rock' },
      { key: 'genre-electronic', kind: 'genre', param: 'electronic' },
      { key: 'decade-2000', kind: 'decade', param: '2000' },
      { key: 'decade-1970', kind: 'decade', param: '1970' },
    ];
    expect(Object.fromEntries(planHues(plan))).toEqual({
      energy: 14,
      blast: 32,
      // In the families' order (electronic before rock), a quarter and three quarters into 110–225.
      'genre-electronic': 139,
      'genre-rock': 196,
      // Oldest first, over 240–320.
      'decade-1970': 260,
      'decade-2000': 300,
    });
    // One genre alone sits mid-stretch, whichever it is; Vibes keeps a hue of its own.
    expect(planHues([{ key: 'genre-jazz', kind: 'genre', param: 'jazz' }]).get('genre-jazz')).toBe(168);
    expect(generateMix({ key: 'genre-rock', kind: 'genre', param: 'rock' }, context(library([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5, { tags: ['rock'] })), 'p')!.hue).toBeUndefined();
  });

  it('is the same for the same period, different for another, and leaves out mixes with too few songs', () => {
    const songs = library([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5, { tags: ['rock'] });
    const ctx = context(songs);
    const a = generateMix({ key: 'genre-rock', kind: 'genre', param: 'rock' }, ctx, '2026-11-01');
    const b = generateMix({ key: 'genre-rock', kind: 'genre', param: 'rock' }, ctx, '2026-11-01');
    const c = generateMix({ key: 'genre-rock', kind: 'genre', param: 'rock' }, ctx, '2026-11-02');
    expect(a!.trackIds).toEqual(b!.trackIds);
    expect(a!.trackIds).not.toEqual(c!.trackIds);
    expect(generateMix({ key: 'repeat', kind: 'repeat' }, ctx, 'p')).toBeNull(); // nothing played yet
  });

  it('never has more than two songs by one artist, nor the same artist twice in a row', () => {
    const songs = library([1, 2, 3, 4, 5, 6, 7, 8], 10, { tags: ['rock'] });
    const mix = generateMix({ key: 'genre-rock', kind: 'genre', param: 'rock' }, context(songs), 'p')!;
    const artists = songsOf(context(songs), mix.trackIds).map((s) => s.track.artistId);
    for (const a of new Set(artists)) expect(artists.filter((x) => x === a).length).toBeLessThanOrEqual(2);
    artists.slice(1).forEach((a, i) => expect(a).not.toBe(artists[i]));
  });

  it('Vibes of the hour follows what is played at this hour', () => {
    const night = library([1, 2, 3, 4], 6, { tags: ['ambient'] });
    const day = library([5, 6, 7, 8], 6, { tags: ['metal'] });
    const unheard = library([9, 10, 11, 12], 6, { tags: ['ambient'] });
    const plays = [...night.map((s) => play(s, 2, 21)), ...day.map((s) => play(s, 2, 9))];
    const ctx = context([...night, ...day, ...unheard], plays, { length: 12 });
    expect(hourProfile(ctx.songs, plays, 21, 0)!.families).toEqual({ chill: 1 });
    const mix = generateMix({ key: 'vibes', kind: 'vibes' }, ctx, 'p')!;
    const picked = songsOf(ctx, mix.trackIds);
    expect(picked.filter((s) => s.families.chill).length).toBe(picked.length);
    expect(picked.filter((s) => unheard.includes(s)).length).toBe(6); // half the mix is new in that mood
    expect(mix.subtitle).toBe('Your 9 PM sound');
  });

  it('Discovery Weekly has only songs never played, from artists that are liked', () => {
    const liked = library([1, 2, 3], 10, { tags: ['rock'] });
    const other = library([4, 5, 6, 7, 8, 9], 4, { tags: ['classical'] });
    const played = liked.filter((_, i) => i % 3 === 0);
    const ctx = context([...liked, ...other], played.flatMap((s) => [play(s, 1), play(s, 2)]), { adventurous: 0, length: 10 });
    const mix = generateMix({ key: 'discovery', kind: 'discovery' }, ctx, 'p')!;
    const picked = songsOf(ctx, mix.trackIds);
    expect(picked.some((s) => played.includes(s))).toBe(false);
    expect(picked.filter((s) => s.track.artistId <= 3).length).toBeGreaterThanOrEqual(6);
  });

  it('On Repeat lists the most played of the last 30 days, most played first', () => {
    const songs = library([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 1);
    const plays = songs.flatMap((s, i) => Array.from({ length: 10 - i }, () => play(s, 5)));
    plays.push(...Array.from({ length: 20 }, () => play(songs[9]!, 60))); // long ago: doesn't count
    const mix = generateMix({ key: 'repeat', kind: 'repeat' }, context(songs, plays), 'p')!;
    expect(mix.trackIds.slice(0, 3)).toEqual(songs.slice(0, 3).map((s) => s.track.id));
    expect(mix.trackIds).not.toContain(songs[9]!.track.id);
  });

  it('Blast from the past brings back songs played a lot and not for a while', () => {
    const songs = library([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 2);
    const plays = songs.flatMap((s, i) => Array.from({ length: 4 }, () => play(s, i % 2 ? 200 : 2)));
    const mix = generateMix({ key: 'blast', kind: 'blast' }, context(songs, plays, { blastDays: 90 }), 'p')!;
    const ctx = context(songs, plays);
    expect(songsOf(ctx, mix.trackIds).every((s) => songs.indexOf(s) % 2 === 1)).toBe(true);
  });

  it('Blast from the past has no songs that only just arrived, however loved', () => {
    const recent = library([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 2, { addedAt: new Date(NOW - 5 * 86_400_000).toISOString() });
    const ctx = context(recent, [], {}, recent.map((s) => s.track.recordingId));
    expect(generateMix({ key: 'blast', kind: 'blast' }, ctx, 'p')).toBeNull();
    const older = library([11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 2, { addedAt: new Date(NOW - 400 * 86_400_000).toISOString() });
    const ctx2 = context([...recent, ...older], [], {}, [...recent, ...older].map((s) => s.track.recordingId));
    const mix = generateMix({ key: 'blast', kind: 'blast' }, ctx2, 'p')!;
    expect(songsOf(ctx2, mix.trackIds).every((s) => older.includes(s))).toBe(true);
  });

  it('Energy boost builds up, Wind down settles', () => {
    const songs = [...library([1, 2, 3, 4, 5], 2, { energy: 0.9 }), ...library([6, 7, 8, 9, 10], 2, { energy: 0.7 }), ...library([11, 12, 13, 14, 15, 16], 2, { energy: 0.1 })];
    const ctx = context(songs);
    const up = songsOf(ctx, generateMix({ key: 'energy', kind: 'energy' }, ctx, 'p')!.trackIds).map((s) => s.energy!);
    expect(up).toEqual([...up].sort((a, b) => a - b));
    expect(Math.min(...up)).toBeGreaterThan(0.6);
    const down = songsOf(ctx, generateMix({ key: 'winddown', kind: 'winddown' }, ctx, 'p')!.trackIds).map((s) => s.energy!);
    expect(down).toEqual([...down].sort((a, b) => b - a));
    expect(Math.max(...down)).toBeLessThan(0.4);
  });

  it('On this day finds albums released this week in other years, but not bare years', () => {
    const songs = [
      ...library([1, 2, 3], 3, { releaseDate: '1997-11-03' }),
      ...library([4, 5, 6], 3, { releaseDate: '2004-10-30' }),
      ...library([7, 8], 3, { releaseDate: '1999-01-01' }),
      ...library([9], 3, { releaseDate: '2010-06-01' }),
    ];
    const ctx = context(songs);
    const mix = generateMix({ key: 'onthisday', kind: 'onthisday' }, ctx, 'p')!;
    expect(new Set(songsOf(ctx, mix.trackIds).map((s) => s.track.artistId))).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(mix.subtitle).toBe('Released this week, 1997–2004');
  });

  it('knows when the next hour, day and week start in the listener’s time zone', () => {
    const now = new Date('2026-11-01T21:30:00Z'); // a Sunday
    const local = localTime(now, 'UTC');
    expect(local).toMatchObject({ date: '2026-11-01', hour: 21, weekday: 0, week: '2026-W44' });
    expect(nextBoundary(now, local, 'hour').toISOString()).toBe('2026-11-01T22:00:00.000Z');
    expect(nextBoundary(now, local, 'day').toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(nextBoundary(now, local, 'week').toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(localTime(now, 'Asia/Tokyo')).toMatchObject({ date: '2026-11-02', hour: 6, weekday: 1, week: '2026-W45' });
  });
});

const TEMPOS = [90, 100, 120, 128, 140, 174];
const KEYS: Camelot[] = ['8A', '3B', '11A', '6B', '1A', '9B'];

/** A sure mix map with this tempo and key. */
const mixMap = (bpm: number, camelot: Camelot) => ({ bpm, beatConfidence: 0.9, gridStable: true, key: { camelot, confidence: 0.9 } });

/** Mix maps with tempos and keys drawn from a spread, so a few pairs blend and most don't; every `unmappedEvery`th song has none. */
function withMaps(songs: Song[], unmappedEvery = 0, rng = new Rng(7)): Song[] {
  return songs.map((s, i) => (unmappedEvery && i % unmappedEvery === 0 ? s : { ...s, mix: mixMap(rng.pick(TEMPOS), rng.pick(KEYS)) }));
}

/** How well a mix's neighbours blend, on average. */
function neighbourBlend(songs: Song[]): number {
  const pairs = songs.slice(1).map((s, i) => blendScore(blendable(songs[i]!), blendable(s)));
  return pairs.reduce((a, b) => a + b, 0) / pairs.length;
}

function shuffled<T>(items: T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

describe('mix-friendly order', () => {
  const plans = [
    { key: 'genre-rock', kind: 'genre', param: 'rock' },
    { key: 'discovery', kind: 'discovery' },
    { key: 'decade-1990', kind: 'decade', param: '1990' },
  ] as const;

  it.each(plans)('$key: neighbours blend better than in a random order of the same songs, mapped or not', (plan) => {
    const ctx = context(withMaps(library([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 6, { tags: ['rock'], year: 1995 }), 4));
    const songs = songsOf(ctx, generateMix(plan, ctx, 'p')!.trackIds);
    expect(songs).toHaveLength(20);
    expect(songs.some((s) => !s.mix)).toBe(true);
    const rng = new Rng(1);
    const random = Array.from({ length: 200 }, () => neighbourBlend(shuffled(songs, rng)));
    expect(neighbourBlend(songs)).toBeGreaterThan(random.reduce((a, b) => a + b, 0) / random.length);
  });

  it.each(plans)('$key: never the same artist twice in a row, even when each artist’s songs blend best with each other', (plan) => {
    // Every artist has one tempo and key of their own: the blend alone would play their songs back to back.
    const songs = library([1, 2, 3, 4, 5, 6, 7, 8], 10, { tags: ['rock'], year: 1995 }).map((s) =>
      s.track.artistId === 8 ? s : { ...s, mix: mixMap(TEMPOS[s.track.artistId % TEMPOS.length]!, KEYS[s.track.artistId % KEYS.length]!) },
    );
    const ctx = context(songs);
    const artists = songsOf(ctx, generateMix(plan, ctx, 'p')!.trackIds).map((s) => s.track.artistId);
    artists.slice(1).forEach((a, i) => expect(a).not.toBe(artists[i]));
  });

  it('keeps the planned first song and goes on to the one that blends with it', () => {
    const [a, b, c] = library([1, 2, 3], 1);
    const order = blendOrder([
      { ...a!, mix: mixMap(120, '8A') },
      { ...b!, mix: mixMap(140, '3B') },
      { ...c!, mix: mixMap(121, '9A') },
    ]);
    expect(order.map((s) => s.track.artistId)).toEqual([1, 3, 2]);
  });

  it.each([
    [200, 0.5],
    [300, 0.45],
    [300, 0.5],
  ])('never the same artist twice in a row in %i songs, %d of them by one artist whose songs all blend', (count, share) => {
    // One artist's songs are all 124 BPM in 8A, so the blend alone would play them back to back; everyone else's
    // are scattered. Energies all differ, as in a real library: there's always a little blend to gain somewhere.
    const rng = new Rng(count);
    const songs = Array.from({ length: count }, (_, i) => {
      const own = i < count * share;
      const [song] = library([own ? 1 : 2 + (i % 10)], 1);
      return { ...song!, energy: rng.next(), mix: own ? mixMap(124, '8A') : mixMap(rng.pick(TEMPOS), rng.pick(KEYS)) };
    });
    const artists = blendOrder(shuffled(songs, rng)).map((s) => s.track.artistId);
    expect(artists).toHaveLength(count);
    expect(artists.slice(1).filter((a, i) => a === artists[i])).toEqual([]);
  });

  it('Energy boost still builds up and Wind down still settles, whatever the tempos', () => {
    const songs = withMaps([...library([1, 2, 3, 4, 5], 2, { energy: 0.9 }), ...library([6, 7, 8, 9, 10], 2, { energy: 0.7 }), ...library([11, 12, 13, 14, 15, 16], 2, { energy: 0.1 })]);
    const ctx = context(songs);
    const up = songsOf(ctx, generateMix({ key: 'energy', kind: 'energy' }, ctx, 'p')!.trackIds).map((s) => s.energy!);
    expect(up).toEqual([...up].sort((a, b) => a - b));
    const down = songsOf(ctx, generateMix({ key: 'winddown', kind: 'winddown' }, ctx, 'p')!.trackIds).map((s) => s.energy!);
    expect(down).toEqual([...down].sort((a, b) => b - a));
  });
});
