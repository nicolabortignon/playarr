import type { Camelot } from '@playarr/mix';
import type { MixKind, MixSettings, Track } from '@playarr/shared';
import { describe, expect, it } from 'vitest';
import type { AudioFeatures } from '../analysis/dsp.ts';
import { generateMix, usable, type MixContext } from './generators.ts';
import { MIX_DEFAULTS } from './settings.ts';
import { buildTaste, calibrateSongs, toSong, type Song } from './taste.ts';
import { localTime } from './time.ts';

// A library of archetypes, each a handful of artists with two songs apiece, measured as analysis would measure them.

const NOVEMBER = Date.parse('2026-11-01T21:30:00Z');
const DECEMBER = Date.parse('2026-12-10T21:30:00Z');

const HIGH = [0.5, 0.9, 0.95, 1, 0.92, 0.97, 0.9, 1, 0.95, 0.6];
const STEADY = [0.6, 0.85, 0.9, 0.88, 0.92, 0.9, 0.87, 0.9, 0.6];
const GENTLE = [0.5, 0.7, 0.8, 0.75, 0.85, 0.8, 0.72, 0.78, 0.5];
const VERSE_CHORUS = [0.3, 0.5, 0.55, 1, 0.55, 0.5, 1, 0.95, 0.4];
const CRESCENDO = [0.05, 0.1, 0.12, 0.15, 0.2, 0.3, 0.9, 1, 0.6];
/** A quiet piece that builds slowly, about 3 dB a phrase: no one jump, but 26 dB in all. */
const SWELL = [0.04, 0.05, 0.07, 0.1, 0.14, 0.2, 0.28, 0.4, 0.56, 0.8, 1, 0.6];

interface Archetype {
  tags: string[];
  year: number;
  meanDb: number;
  onsets: number;
  centroid: number;
  lowShare: number;
  rangeDb: number;
  /** No beat analysis for beatless music: its tempo stays unknown. */
  bpm?: number;
  pulse?: number;
  key?: Camelot;
  phrases: number[];
  title?: string;
  duration?: number;
  /** Tags of their own weight, beside `tags` (weighted 1, 0.8, 0.6…). */
  extraTags?: [string, number][];
  /** The release's MusicBrainz secondary types ("Live"…). */
  releaseTypes?: string[];
  /** False: never analyzed, known by its tags alone. */
  measured?: boolean;
}

const KINDS = {
  edm: { tags: ['house', 'electronic'], year: 2015, meanDb: -8, onsets: 4.5, centroid: 1500, lowShare: 0.6, rangeDb: 5, bpm: 126, pulse: 0.95, key: '8A', phrases: HIGH },
  metal: { tags: ['thrash metal', 'metal'], year: 2005, meanDb: -8.5, onsets: 4.2, centroid: 1900, lowShare: 0.4, rangeDb: 6, bpm: 165, pulse: 0.75, phrases: HIGH },
  punk: { tags: ['punk'], year: 1977, meanDb: -14, onsets: 4, centroid: 1700, lowShare: 0.35, rangeDb: 8, bpm: 178, pulse: 0.8, phrases: HIGH },
  garage: { tags: ['garage rock', 'rock'], year: 1965, meanDb: -15, onsets: 3.6, centroid: 1550, lowShare: 0.3, rangeDb: 9, bpm: 150, pulse: 0.7, phrases: HIGH },
  pop: { tags: ['dance-pop', 'pop', 'happy'], year: 2018, meanDb: -8, onsets: 3.2, centroid: 1400, lowShare: 0.5, rangeDb: 6, bpm: 118, pulse: 0.9, key: '5B', phrases: HIGH },
  ballad: { tags: ['pop', 'ballad'], year: 2015, meanDb: -9, onsets: 1.4, centroid: 1000, lowShare: 0.4, rangeDb: 10, bpm: 72, pulse: 0.45, phrases: VERSE_CHORUS },
  jazzBallad: { tags: ['vocal jazz', 'jazz', 'mellow'], year: 1958, meanDb: -21, onsets: 1.1, centroid: 900, lowShare: 0.3, rangeDb: 13, bpm: 66, pulse: 0.35, phrases: STEADY },
  ambient: { tags: ['ambient', 'drone'], year: 2010, meanDb: -23, onsets: 0.4, centroid: 700, lowShare: 0.3, rangeDb: 7, phrases: STEADY },
  darkAmbient: { tags: ['dark ambient', 'horror'], year: 2012, meanDb: -23, onsets: 0.5, centroid: 650, lowShare: 0.35, rangeDb: 9, phrases: STEADY },
  piano: { tags: ['piano', 'neoclassical'], year: 2014, meanDb: -24, onsets: 1.6, centroid: 850, lowShare: 0.2, rangeDb: 16, bpm: 72, pulse: 0.25, phrases: GENTLE },
  postRock: { tags: ['post-rock'], year: 2008, meanDb: -13, onsets: 2, centroid: 1300, lowShare: 0.35, rangeDb: 22, bpm: 110, pulse: 0.6, phrases: CRESCENDO },
  lofi: { tags: ['lo-fi hip hop', 'chillhop', 'chill'], year: 2019, meanDb: -14, onsets: 2.6, centroid: 800, lowShare: 0.55, rangeDb: 7, bpm: 86, pulse: 0.85, key: '2B', phrases: STEADY },
  bossa: { tags: ['bossa nova', 'relaxing'], year: 1963, meanDb: -19, onsets: 2.2, centroid: 1000, lowShare: 0.3, rangeDb: 11, bpm: 130, pulse: 0.6, key: '9B', phrases: STEADY },
  tripHop: { tags: ['trip hop', 'dark'], year: 1997, meanDb: -12, onsets: 1.8, centroid: 900, lowShare: 0.5, rangeDb: 10, bpm: 80, pulse: 0.7, phrases: STEADY },
  orchestral: { tags: ['orchestral', 'classical'], year: 1990, meanDb: -18, onsets: 2, centroid: 1300, lowShare: 0.25, rangeDb: 27, phrases: CRESCENDO },
  techno: { tags: ['minimal techno', 'techno'], year: 2016, meanDb: -10, onsets: 3.4, centroid: 1200, lowShare: 0.55, rangeDb: 5, bpm: 124, pulse: 0.95, phrases: HIGH },
} satisfies Record<string, Archetype>;
type Special = 'skit' | 'interlude' | 'live' | 'liveAlbum' | 'christmas' | 'swell' | 'minorLofi' | 'minorBossa' | 'quietAmbient' | 'quietPiano';
type Kind = keyof typeof KINDS | Special;

const SPECIALS: Record<Special, Archetype> = {
  skit: { ...KINDS.lofi, tags: ['hip hop'], title: 'Skit', duration: 45 },
  interlude: { ...KINDS.ambient, title: 'Interlude', duration: 95 },
  live: { ...KINDS.jazzBallad, title: 'Autumn Leaves (Live at the Village Vanguard)' },
  // A live album's songs aren't titled "(Live)": its release says so.
  liveAlbum: { ...KINDS.jazzBallad, releaseTypes: ['Live'] },
  christmas: { ...KINDS.jazzBallad, title: 'Have Yourself a Merry Little Christmas' },
  swell: { tags: ['orchestral', 'classical'], year: 1990, meanDb: -22, onsets: 1.2, centroid: 900, lowShare: 0.25, rangeDb: 20, phrases: SWELL },
  // Lo-fi and bossa in minor keys, with a stray mood tag or two, as real tags have them.
  minorLofi: { ...KINDS.lofi, key: '2A', extraTags: [['atmospheric', 0.03], ['melancholic', 0.03]] },
  minorBossa: { ...KINDS.bossa, key: '9A' },
  // Never analyzed: only their tags say what they are.
  quietAmbient: { ...KINDS.ambient, tags: ['ambient', 'drone', 'calm'], measured: false },
  quietPiano: { ...KINDS.piano, tags: ['piano', 'neoclassical', 'relaxing'], measured: false },
};

const scale = (v: number, lo: number, hi: number) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
let nextId = 1;
let nextArtist = 1;
const kindOf = new Map<number, Kind>();

/** `artists` artists of this kind, `each` songs apiece, each a little different from the next (as real songs are). */
function songsOf(kind: Kind, artists = 6, each = 2): Song[] {
  const a: Archetype = kind in KINDS ? KINDS[kind as keyof typeof KINDS] : SPECIALS[kind as keyof typeof SPECIALS];
  return Array.from({ length: artists }, () => nextArtist++).flatMap((artistId) =>
    Array.from({ length: each }, (_, i) => {
      const id = nextId++;
      const jitter = ((id * 37) % 11) / 10 - 0.5; // −0.5 … 0.5
      const meanDb = a.meanDb + jitter;
      const features: AudioFeatures = {
        version: 1,
        loudness: scale(meanDb, -28, -9),
        dynamics: scale(a.rangeDb, 4, 30),
        brightness: scale(a.centroid + jitter * 40, 500, 1800),
        busyness: scale(a.onsets + jitter * 0.1, 1, 4),
        bass: scale(a.lowShare, 0.15, 0.7),
        envelope: [],
        seconds: 240,
        raw: { meanDb, rangeDb: a.rangeDb, centroidHz: a.centroid + jitter * 40, onsetsPerSec: a.onsets + jitter * 0.1, lowShare: a.lowShare },
        bpm: a.bpm ? a.bpm + jitter : 0,
        pulse: a.bpm ? (a.pulse ?? 0.5) : 0,
      };
      const track = {
        id,
        recordingId: `rec-${id}`,
        fileId: id,
        albumId: artistId * 10 + i,
        artistId,
        title: a.title ?? `${kind} ${id}`,
        artistName: `${kind} artist ${artistId}`,
        albumTitle: `${kind} album`,
        trackNumber: i + 1,
        discNumber: 1,
        duration: a.duration ?? 240,
        explicit: false,
        format: { codec: 'FLAC', lossless: true },
        size: 1,
        streamUrl: `/stream/${id}`,
      } as Track;
      kindOf.set(id, kind);
      const tags = [...a.tags.map((t, k): [string, number] => [t, 1 - k * 0.2]), ...(a.extraTags ?? [])];
      if (a.measured === false) return toSong({ track, tags, genres: [], albumYear: a.year, releaseTypes: a.releaseTypes });
      return toSong({
        track,
        tags,
        genres: [],
        features,
        albumYear: a.year,
        phraseEnergy: a.phrases,
        releaseTypes: a.releaseTypes,
        ...(a.bpm ? { mix: { bpm: a.bpm + jitter, beatConfidence: a.pulse ?? 0.5, gridStable: true, ...(a.key ? { key: { camelot: a.key, confidence: 0.8 } } : {}) } } : {}),
      });
    }),
  );
}

function library(): Song[] {
  return [
    ...(Object.keys(KINDS) as (keyof typeof KINDS)[]).flatMap((k) => songsOf(k)),
    ...songsOf('skit', 3, 1),
    ...songsOf('interlude', 3, 1),
    ...songsOf('live', 3, 1),
    ...songsOf('liveAlbum', 3, 1),
    ...songsOf('christmas', 3, 1),
    ...songsOf('swell', 3, 2),
  ];
}

function context(songs: Song[], { now = NOVEMBER, length = 25 }: { now?: number; length?: number } = {}): MixContext {
  const calibrated = calibrateSongs(songs);
  return {
    songs: calibrated,
    plays: [],
    taste: buildTaste(calibrated, [], new Set(), new Map(), now),
    local: localTime(new Date(now), 'UTC'),
    now,
    settings: { ...MIX_DEFAULTS, length } as unknown as MixSettings,
    neighbours: new Map(),
  };
}

const LIBRARY = library();
const CTX = context(LIBRARY);

function mix(kind: MixKind, ctx = CTX, period = 'p', previous?: Set<string>) {
  const made = generateMix({ key: kind, kind }, ctx, period, 0, previous);
  if (!made) throw new Error(`No ${kind} mix`);
  const byId = new Map(ctx.songs.map((s) => [s.track.id, s]));
  return { made, songs: made.trackIds.map((id) => byId.get(id)!), kinds: new Set(made.trackIds.map((id) => kindOf.get(id)!)) };
}

/** The mean energy of each fifth of a mix, in order. */
function fifths(songs: Song[]): number[] {
  return Array.from({ length: 5 }, (_, f) => {
    const part = songs.slice(Math.floor((f * songs.length) / 5), Math.floor(((f + 1) * songs.length) / 5));
    return part.reduce((sum, s) => sum + s.energy!, 0) / part.length;
  });
}

describe('Energy boost', () => {
  it('is driving songs from every era, old rock as much as new dance music, and never a hot-mastered ballad', () => {
    const { kinds } = mix('energy');
    expect([...kinds].every((k) => ['edm', 'metal', 'punk', 'garage', 'pop', 'techno'].includes(k))).toBe(true);
    expect(kinds.has('garage') || kinds.has('punk')).toBe(true);
    expect(kinds.has('ballad')).toBe(false);
  });

  it('leaves out songs that spend most of their time building quietly', () => {
    expect(mix('energy').kinds.has('postRock')).toBe(false);
  });

  it('builds, fifth by fifth, and says its tempos', () => {
    const { songs, made } = mix('energy');
    const parts = fifths(songs);
    parts.slice(1).forEach((p, i) => expect(p).toBeGreaterThanOrEqual(parts[i]!));
    expect(made.description).toMatch(/\d+–\d+ BPM, building to the peak/);
  });
});

describe('Chill', () => {
  it('is laid back but alive: lo-fi beats and bossa nova, nothing intense, nothing dark, nothing that swells', () => {
    const { kinds } = mix('chill');
    expect(kinds.has('lofi')).toBe(true);
    expect(kinds.has('bossa')).toBe(true);
    for (const k of ['edm', 'metal', 'punk', 'garage', 'tripHop', 'darkAmbient', 'postRock', 'orchestral'] as Kind[]) expect(kinds.has(k)).toBe(false);
    expect(mix('chill', context(LIBRARY, { length: 100 })).kinds.has('swell')).toBe(false);
  });

  it('keeps lo-fi and bossa in minor keys, whatever stray mood tag they carry', () => {
    const songs = [...LIBRARY.filter((s) => !['lofi', 'bossa'].includes(kindOf.get(s.track.id)!)), ...songsOf('minorLofi'), ...songsOf('minorBossa')];
    const { kinds } = mix('chill', context(songs));
    expect(kinds.has('minorLofi')).toBe(true);
    expect(kinds.has('minorBossa')).toBe(true);
  });
});

describe('Wind down', () => {
  it('is the softest songs: quiet ballads, ambient and piano, not old rock that only sounds quiet next to today’s masters', () => {
    const { kinds } = mix('winddown');
    for (const k of ['jazzBallad', 'ambient', 'piano'] as Kind[]) expect(kinds.has(k)).toBe(true);
    for (const k of ['garage', 'punk', 'metal', 'edm', 'pop', 'ballad'] as Kind[]) expect(kinds.has(k)).toBe(false);
  });

  it('has nothing eerie, nothing that surges or swells, no applause (live albums too) and no interludes', () => {
    const { kinds } = mix('winddown', context(LIBRARY, { length: 100 }));
    for (const k of ['darkAmbient', 'orchestral', 'postRock', 'swell', 'live', 'liveAlbum', 'interlude', 'skit'] as Kind[]) expect(kinds.has(k)).toBe(false);
  });

  it('settles, fifth by fifth', () => {
    const parts = fifths(mix('winddown').songs);
    parts.slice(1).forEach((p, i) => expect(p).toBeLessThanOrEqual(parts[i]!));
  });
});

describe('Deep focus', () => {
  it('is steady music without words: ambient, piano, lo-fi beats; never vocal jazz, pop, or a crescendo', () => {
    const { kinds, made } = mix('focus');
    for (const k of ['ambient', 'piano', 'lofi'] as Kind[]) expect(kinds.has(k)).toBe(true);
    for (const k of ['jazzBallad', 'ballad', 'pop', 'postRock', 'orchestral', 'darkAmbient', 'live'] as Kind[]) expect(kinds.has(k)).toBe(false);
    expect(made.title).toBe('Deep focus');
  });
});

describe('every mix', () => {
  it('leaves Christmas songs for their season', () => {
    const inNovember = mix('winddown', context(LIBRARY, { length: 100 })).kinds;
    const inDecember = mix('winddown', context(LIBRARY, { now: DECEMBER, length: 100 })).kinds;
    expect(inNovember.has('christmas')).toBe(false);
    expect(inDecember.has('christmas')).toBe(true);
  });

  it('never picks skits or interludes, whatever the mix', () => {
    const ctx = context(LIBRARY, { length: 100 });
    for (const kind of ['energy', 'chill', 'winddown', 'focus', 'discovery', 'vibes'] as MixKind[]) {
      const { kinds } = mix(kind, ctx);
      expect(kinds.has('skit')).toBe(false);
      expect(kinds.has('interlude')).toBe(false);
    }
  });

  it('leans away from the songs of the mix it replaces', () => {
    const yesterday = new Set(mix('energy', CTX, 'monday').made.recordingIds);
    const overlap = (previous?: Set<string>) => mix('energy', CTX, 'tuesday', previous).made.recordingIds!.filter((id) => yesterday.has(id)).length;
    expect(overlap(yesterday)).toBeLessThan(overlap());
  });

  it('holds together around a style or two of the day, and not the same ones every day', () => {
    const lanes = new Set<string>();
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat']) {
      const { made } = mix('energy', CTX, day);
      const today = /mostly (.+) today/.exec(made.description)?.[1];
      if (today) lanes.add(today);
    }
    expect(lanes.size).toBeGreaterThan(1);
  });
});

describe('a library measured only in part', () => {
  // Measured: the loud end (what was played or queued). Never measured: the calm songs, known by their tags.
  const PARTIAL = [
    ...(['edm', 'pop', 'metal', 'garage', 'ballad', 'techno'] as const).flatMap((k) => songsOf(k, 10, 2)),
    ...songsOf('quietAmbient', 10, 2),
    ...songsOf('quietPiano', 10, 2),
  ];
  const ctx = context(PARTIAL);

  it('winds down with the calm songs its tags know, not the softest of what happened to be measured', () => {
    const { songs, kinds } = mix('winddown', ctx);
    for (const k of ['pop', 'techno', 'edm', 'metal', 'garage'] as Kind[]) expect(kinds.has(k)).toBe(false);
    const calm = songs.filter((s) => ['quietAmbient', 'quietPiano'].includes(kindOf.get(s.track.id)!));
    expect(calm.length).toBeGreaterThanOrEqual(songs.length * 0.8);
  });

  it('keeps dance-pop and techno out of Chill, and still finds Deep focus its wordless songs', () => {
    const chill = mix('chill', ctx).kinds;
    for (const k of ['pop', 'techno', 'edm', 'ballad'] as Kind[]) expect(chill.has(k)).toBe(false);
    const focus = mix('focus', ctx).kinds;
    expect(focus.has('quietAmbient') || focus.has('quietPiano')).toBe(true);
  });
});

describe('short songs', () => {
  it('picks a 45-second punk song with a sure beat, never a 45-second skit spoken over nothing', () => {
    const [punk] = songsOf('punk', 1, 1).map((s) => ({ ...s, track: { ...s.track, duration: 45 } }));
    const [spoken] = songsOf('jazzBallad', 1, 1).map((s) => ({ ...s, track: { ...s.track, duration: 45 } }));
    const ctx = context([punk!, spoken!]);
    const [p, sp] = ctx.songs;
    expect(usable(ctx, p!)).toBe(true);
    expect(usable(ctx, sp!)).toBe(false);
  });
});

describe('mood mixes without measured sound', () => {
  it('still go by tags: metal and punk for Energy boost, calm tags for Wind down', () => {
    const tagged = (kind: string, tags: string[], n: number) =>
      Array.from({ length: n }, () => {
        const id = nextId++;
        const artistId = nextArtist++;
        kindOf.set(id, kind as Kind);
        return toSong({
          track: { id, recordingId: `rec-${id}`, artistId, albumId: artistId, title: `${kind} ${id}`, artistName: `A${artistId}`, duration: 240 } as Track,
          tags: tags.map((t): [string, number] => [t, 1]),
          genres: [],
        });
      });
    const songs = [...tagged('metal', ['metal'], 12), ...tagged('calm', ['ambient', 'calm', 'relaxing'], 12), ...tagged('pop', ['pop'], 12)];
    const ctx = context(songs);
    expect(mix('energy', ctx).kinds).toEqual(new Set(['metal']));
    expect(mix('winddown', ctx).kinds).toEqual(new Set(['calm']));
  });
});
