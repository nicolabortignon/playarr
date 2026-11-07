import type { AudioFeatures } from '../analysis/dsp.ts';
import type { StyleFamily } from '../analysis/styles.ts';
import type { LocalTime } from './time.ts';

/**
 * What a song is like to listen to, for the mood mixes (Energy boost, Chill, Deep focus, Wind down) and everything else
 * that goes by energy: how intense it is, how bright its mood, how tense, how steady, whether anyone sings, whether it
 * grooves, and what it should never be picked for (an interlude, a Christmas song in July). Measured sound comes first;
 * tags, the title and the style fill in. What each quality is for: docs/plans/2026-11-07-8-mood-mixes.md.
 */

/** How a song's level moves over time: from its mix map's phrase energy, else its loudness envelope. */
export interface SongShape {
  /** Share of the song's middle at full tilt: within 6 dB of its loudest. */
  sustain: number;
  /** How much its level moves over its middle, in dB (standard deviation). */
  swingDb: number;
  /** Its biggest rise over a phrase (about ten seconds), in dB. The first and last phrases don't count: fading in isn't a jolt. */
  surgeDb: number;
}

/** What sound analysis measured, as the mood qualities read it. */
export interface SongSound {
  /** The raw measurements, which `calibrate` places in the library. */
  meanDb: number;
  onsetsPerSec: number;
  centroidHz: number;
  lowShare: number;
  rangeDb: number;
  /**
   * Each 0 … 1: analysis's own scales until `calibrate` makes them where the song stands in the library (loudness next
   * to music of its time).
   */
  loud: number;
  busy: number;
  bright: number;
  bass: number;
  range: number;
  /** How sure the beat is (0 … 1), and its tempo: only once beat analysis has run. */
  pulse?: number;
  bpm?: number;
  gridStable?: boolean;
}

/** A phrase this much quieter than the loudest (6 dB, a verse under its chorus) still counts as full tilt; a breakdown doesn't. */
const FULL_TILT_DB = 6;
const FULL_TILT = 10 ** (-FULL_TILT_DB / 20);
/** Phrase energies this low are as good as silence: their rises are measured from here. */
const QUIETEST = 0.05;

/** The shape of a song from its phrase energy (each 16-beat phrase's level next to the loudest), when there are enough phrases. */
export function shapeOfPhrases(energy: (number | null)[]): SongShape | undefined {
  const middle = energy.slice(1, -1);
  const known = middle.filter((e): e is number => e !== null && e > 0);
  if (known.length < 4) return undefined;
  const loudest = Math.max(...known);
  const db = known.map((e) => 20 * Math.log10(Math.max(QUIETEST, e) / loudest));
  let surge = 0;
  for (let i = 1; i < middle.length; i++) {
    const before = middle[i - 1];
    const now = middle[i];
    if (before === null || before === undefined || now === null || now === undefined) continue;
    surge = Math.max(surge, 20 * Math.log10(Math.max(QUIETEST, now) / Math.max(QUIETEST, before)));
  }
  return { sustain: known.filter((e) => e >= loudest * FULL_TILT).length / known.length, swingDb: deviation(db), surgeDb: surge };
}

/** The envelope's points span −50 … −6 dB. */
const ENVELOPE_DB = 44;

/** The shape of a song from its loudness envelope (48 points over the song), for songs without phrase energy. */
export function shapeOfEnvelope(envelope: number[]): SongShape | undefined {
  const middle = envelope.slice(2, -2).map((v) => v * ENVELOPE_DB);
  if (middle.length < 8) return undefined;
  const loudest = Math.max(...middle);
  let surge = 0;
  // Two points apart: the envelope is smoothed, so a jump shows over about two points (eight to ten seconds).
  for (let i = 2; i < middle.length; i++) surge = Math.max(surge, middle[i]! - middle[i - 2]!);
  return { sustain: middle.filter((v) => v >= loudest - FULL_TILT_DB).length / middle.length, swingDb: deviation(middle), surgeDb: surge };
}

/** What sound analysis measured, on its own scales, or nothing for a song not measured (or measured silent). */
export function soundOf(features: AudioFeatures | undefined, gridStable?: boolean): SongSound | undefined {
  if (!features || features.raw.meanDb <= -100) return undefined;
  const { raw } = features;
  const beat = features.bpm > 0;
  return {
    meanDb: raw.meanDb,
    onsetsPerSec: raw.onsetsPerSec,
    centroidHz: raw.centroidHz,
    lowShare: raw.lowShare,
    rangeDb: raw.rangeDb,
    loud: features.loudness,
    busy: features.busyness,
    bright: features.brightness,
    bass: features.bass,
    range: features.dynamics,
    ...(beat ? { pulse: features.pulse, bpm: features.bpm, ...(gridStable !== undefined ? { gridStable } : {}) } : {}),
  };
}

// ── Intensity ────────────────────────────────────────────────────────────────

/**
 * What makes a song feel intense, and how much each counts: loud (next to music of its time), busy (notes and hits a
 * second), a strong beat, a fast one, and a bright sound. A part that wasn't measured (the beat, before beat analysis)
 * is left out and the rest share its weight. How a song moves (its shape) isn't intensity: a quiet drone is as steady
 * as a wall of noise. It decides who belongs instead (Energy boost wants full tilt, Wind down no surges).
 */
const INTENSITY = { loud: 0.3, busy: 0.25, pulse: 0.15, tempo: 0.15, bright: 0.15 };
/** Tags move intensity this far at most: energetic up, calm down. */
const ENERGETIC_TAGS_LIFT = 0.08;
const CALM_TAGS_DROP = 0.1;

/** How intense a song sounds, 0 … 1, on whatever scale its parts are on (see `calibrate`). */
export function intensityOf(sound: SongSound, words: Words): number {
  const parts: [number, number | undefined][] = [
    [INTENSITY.loud, sound.loud],
    [INTENSITY.busy, sound.busy],
    [INTENSITY.pulse, sound.pulse],
    [INTENSITY.tempo, tempoFeel(sound)],
    [INTENSITY.bright, sound.bright],
  ];
  let sum = 0;
  let weight = 0;
  for (const [w, v] of parts) {
    if (v === undefined) continue;
    sum += w * v;
    weight += w;
  }
  return clamp(sum / weight + ENERGETIC_TAGS_LIFT * words.energetic - CALM_TAGS_DROP * words.calm);
}

/** Tempo as it's felt: 70 BPM is slow, 170 fast, and it only counts as far as there's a beat to hear it in. */
function tempoFeel(sound: SongSound): number | undefined {
  if (sound.bpm === undefined || sound.pulse === undefined) return undefined;
  return clamp((sound.bpm - 70) / 100) * ramp(sound.pulse, 0.2, 0.6);
}

// ── Mood, tension, groove, steadiness ────────────────────────────────────────

/** 0 (bleak) … 1 (bright and happy): a major or minor key, mood tags, and a bright or dark sound. 0.5 when nothing says. */
export function moodOf(key: { camelot: string; confidence: number } | undefined, words: Words, bright: number | undefined): number {
  const mode = key ? (key.camelot.endsWith('B') ? 1 : -1) * ramp(key.confidence, 0.3, 0.6) : 0;
  return clamp(0.5 + 0.15 * mode + 0.3 * words.warmth + (bright === undefined ? 0 : 0.1 * (bright - 0.5)));
}

/** 0 … 1: dark, eerie, aggressive or harsh, from the tags (any such tag counts three times its share) and the style. */
export function tensionOf(words: Words, families: Partial<Record<StyleFamily, number>>): number {
  return clamp(3 * words.tense + 0.4 * (families.metal ?? 0) + 0.25 * (families.experimental ?? 0));
}

/** 0 … 1: a steady beat to move to, at a tempo that sways (85–130 BPM, at half or double time), fuller with bass. */
export function grooveOf(sound: SongSound | undefined): number | undefined {
  if (!sound || sound.pulse === undefined || sound.bpm === undefined) return undefined;
  let bpm = sound.bpm;
  while (bpm > 150) bpm /= 2;
  while (bpm < 70) bpm *= 2;
  const sway = bpm >= 85 && bpm <= 130 ? 1 : bpm < 85 ? 0.6 + (0.4 * (bpm - 70)) / 15 : 1 - (0.4 * (bpm - 130)) / 20;
  return clamp(sound.pulse * (sound.gridStable === false ? 0.75 : 1) * sway * (0.6 + 0.4 * sound.bass));
}

/** 0 … 1: how little a song's level moves (1.5 dB of swing or less is steady, 6.5 dB or more is anything but). */
export function steadinessOf(shape: SongShape | undefined): number | undefined {
  return shape ? 1 - clamp((shape.swingDb - 1.5) / 5) : undefined;
}

// ── Words: tags and titles ───────────────────────────────────────────────────

/** What a song's tags say about its mood, each 0 … 1 (warmth −1 … +1), and its style's calm. */
export interface Words {
  energetic: number;
  calm: number;
  /** Share of the tags' weight that's dark, eerie, aggressive or harsh. */
  tense: number;
  warmth: number;
}

const ENERGETIC = ['energetic', 'upbeat', 'party', 'intense', 'powerful', 'driving', 'workout', 'anthem', 'banger', 'hype', 'high energy', 'fast'];
const TENSE = ['dark', 'eerie', 'haunting', 'ominous', 'creepy', 'horror', 'aggressive', 'angry', 'harsh', 'abrasive', 'noise', 'industrial',
  'sinister', 'menacing', 'disturbing', 'chaotic', 'brutal', 'dissonant', 'tense'];

/** The tags' energetic and tense shares (each tag counted by its weight), with the calm and warmth styles.ts reads. */
export function wordsOf(tags: [string, number][], style: { calm: number; warmth: number }): Words {
  let total = 0;
  let energetic = 0;
  let tense = 0;
  for (const [raw, weight] of tags) {
    const tag = raw.toLowerCase();
    total += weight;
    if (ENERGETIC.some((w) => tag.includes(w))) energetic += weight;
    if (TENSE.some((w) => tag.includes(w))) tense += weight;
  }
  return {
    energetic: total ? Math.min(1, (energetic / total) * 4) : 0,
    calm: style.calm,
    tense: total ? tense / total : 0,
    warmth: style.warmth,
  };
}

/**
 * How likely a tag says there's singing or rapping (0 … 1). A tag takes its longest hint ("vocal jazz" before "jazz",
 * "post-rock" before "rock", "lo-fi hip hop" before "hip hop").
 */
const VOCAL_HINTS: [string, number][] = [
  ['instrumental', 0.03], ['instrumental hip hop', 0.05], ['post-rock', 0.12], ['post rock', 0.12], ['math rock', 0.35],
  ['ambient', 0.2], ['dark ambient', 0.1], ['drone', 0.08], ['new age', 0.15], ['meditation', 0.12], ['study', 0.2],
  ['classical', 0.15], ['modern classical', 0.12], ['contemporary classical', 0.12], ['neoclassical', 0.15], ['baroque', 0.12],
  ['orchestral', 0.12], ['piano', 0.18], ['solo piano', 0.08], ['guitar', 0.4], ['soundtrack', 0.2], ['score', 0.15],
  ['film score', 0.12], ['video game', 0.2], ['video game music', 0.15], ['lo-fi', 0.35], ['lofi', 0.35], ['lo-fi hip hop', 0.2],
  ['lofi hip hop', 0.2], ['chillhop', 0.25], ['jazzhop', 0.25], ['beats', 0.3], ['jazz', 0.45], ['bebop', 0.15], ['hard bop', 0.15],
  ['cool jazz', 0.2], ['jazz fusion', 0.25], ['fusion', 0.3], ['free jazz', 0.15], ['techno', 0.2], ['minimal', 0.2], ['idm', 0.2],
  ['electronica', 0.4], ['electronic', 0.5], ['house', 0.55], ['deep house', 0.4], ['trance', 0.4], ['drum and bass', 0.4],
  ['dubstep', 0.45], ['downtempo', 0.45], ['trip hop', 0.65], ['trip-hop', 0.65], ['surf', 0.4], ['flamenco', 0.5],
  ['bossa nova', 0.7], ['vocal', 0.95], ['vocals', 0.95], ['vocal jazz', 0.95], ['female vocalists', 0.95], ['male vocalists', 0.95],
  ['female vocalist', 0.95], ['male vocalist', 0.95], ['singer-songwriter', 0.97], ['singer/songwriter', 0.97], ['rap', 0.98],
  ['hip hop', 0.9], ['hip-hop', 0.9], ['pop', 0.92], ['r&b', 0.95], ['soul', 0.9], ['neo soul', 0.95], ['gospel', 0.95],
  ['opera', 0.95], ['choral', 0.95], ['a cappella', 1], ['folk', 0.85], ['country', 0.92], ['rock', 0.85], ['indie', 0.85],
  ['punk', 0.9], ['metal', 0.85], ['emo', 0.95], ['dream pop', 0.85], ['shoegaze', 0.8], ['reggae', 0.85], ['disco', 0.85],
  ['funk', 0.75], ['blues', 0.85],
];
const VOCAL_PATTERNS = VOCAL_HINTS.map(([hint, p]) => ({ hint, p, regex: new RegExp(`(^|[^a-z])${escape(hint)}($|[^a-z])`) })).sort(
  (a, b) => b.hint.length - a.hint.length,
);
/** Without a telling tag, the style's: how often each family's songs have singing. */
const FAMILY_VOCALS: Record<StyleFamily, number> = {
  classical: 0.15,
  cinematic: 0.2,
  chill: 0.4,
  jazz: 0.45,
  experimental: 0.45,
  electronic: 0.5,
  world: 0.75,
  folk: 0.85,
  rock: 0.85,
  metal: 0.85,
  soul: 0.9,
  pop: 0.92,
  hiphop: 0.95,
};
/** Nothing to go on: more songs have singing than not. */
const UNKNOWN_VOCALS = 0.6;
const vocalHintCache = new Map<string, number | null>();

/** What a song's lyrics lookup found: its words, or that it's instrumental. */
export type LyricsFact = 'words' | 'instrumental';

/** How likely a song has singing or rapping, 0 … 1: its lyrics when they were looked up, its title, its tags, then its style. */
export function vocalsOf(title: string, tags: [string, number][], families: Partial<Record<StyleFamily, number>>, lyrics?: LyricsFact): number {
  if (lyrics === 'instrumental' || /\binstrumental\b/i.test(title)) return 0.03;
  if (lyrics === 'words') return 0.97;
  if (/\bkaraoke\b/i.test(title)) return 0.1;
  let sum = 0;
  let weight = 0;
  for (const [raw, w] of tags) {
    const tag = raw.toLowerCase();
    let p = vocalHintCache.get(tag);
    if (p === undefined) {
      p = VOCAL_PATTERNS.find((h) => h.regex.test(tag))?.p ?? null;
      vocalHintCache.set(tag, p);
    }
    if (p === null) continue;
    sum += p * w;
    weight += w;
  }
  if (weight) return sum / weight;
  let familyWeight = 0;
  for (const [family, w] of Object.entries(families) as [StyleFamily, number][]) {
    sum += FAMILY_VOCALS[family] * w;
    familyWeight += w;
  }
  return familyWeight ? sum / familyWeight : UNKNOWN_VOCALS;
}

/** What a song should never be picked for. */
export interface Traits {
  /** A short intro, interlude, outro or skit, or under a minute long; spoken word, stand-up, an audiobook. Never in a picked mix. */
  filler: boolean;
  /** Recorded live: applause and crowd break a calm or focused mix. */
  live: boolean;
  /** A Christmas song: only in season. */
  christmas: boolean;
}

const FILLER_TITLE = /^(intro|outro|interlude)\b|\b(interlude|skit)\b/i;
/** An "Intro" this long is a song of its own (M83's runs five minutes): only shorter ones are filler. */
const LONGEST_FILLER = 150;
/** "(Live)", "(Live at …)", "[Live]", "- Live …": not "Live Forever" or "Live in the Moment". */
const LIVE_TITLE = /[([]\s*live\b|\s-\s+live\b|[([]\s*(en vivo|ao vivo)\b/i;
const CHRISTMAS_TITLE =
  /\b(christmas|xmas|santa claus|jingle bells?|sleigh ride|silent night|rudolph|mistletoe|let it snow|winter wonderland|feliz navidad|deck the halls|o holy night|frosty the snowman)\b/i;
/** Not "comedy": that's Weird Al too. */
const NOT_SONGS = ['spoken word', 'stand-up', 'standup', 'audiobook', 'podcast', 'white noise'];
/** A tag this heavy (next to the song's strongest) says what the song is, rather than what its artist sometimes makes. */
const TELLING_TAG = 0.5;
/** A Christmas tag must be about this heavy: an artist with one Christmas album isn't a Christmas artist. */
const CHRISTMAS_TAG = 0.8;
/** Under this many seconds a track is a sketch, an intro or a skit, not a song to pick. */
export const SHORTEST_SONG = 60;

/** What the title, length and tags say a song is. A length of 0 is one not known yet: it doesn't make a song short. */
export function traitsOf(title: string, duration: number, tags: [string, number][]): Traits {
  const strongest = Math.max(0, ...tags.map(([, w]) => w));
  const heavier = (share: number) => tags.filter(([, w]) => w >= strongest * share).map(([t]) => t.toLowerCase());
  const telling = heavier(TELLING_TAG);
  const short = duration > 0 && duration < SHORTEST_SONG;
  return {
    filler:
      short ||
      (FILLER_TITLE.test(title) && (!duration || duration < LONGEST_FILLER)) ||
      telling.some((t) => NOT_SONGS.some((n) => t.includes(n))),
    live: LIVE_TITLE.test(title) || telling.some((t) => t === 'live'),
    christmas: CHRISTMAS_TITLE.test(title) || heavier(CHRISTMAS_TAG).some((t) => t.includes('christmas') || t === 'xmas'),
  };
}

/** Christmas songs belong from 24 November to Epiphany (6 January). */
export function christmasSeason(local: Pick<LocalTime, 'month' | 'day'>): boolean {
  return (local.month === 11 && local.day >= 24) || local.month === 12 || (local.month === 1 && local.day <= 6);
}

// ── Placing songs in the library ─────────────────────────────────────────────

/** What `calibrate` needs from a song. */
export interface Calibratable {
  sound?: SongSound;
  words: Words;
  year?: number;
}

/** Songs released within this many years of each other count as of one time, for loudness. */
const ERA_YEARS = 4;
/** An era needs this many measured songs to judge loudness by; fewer, and it widens. */
const ERA_SONGS = 40;
/** Loudness next to music of its time counts this much; next to the whole library, the rest. */
const ERA_SHARE = 0.6;

/**
 * Each measured song's sound as where it stands in this library (0 … 1, its percentile), loudness next to music of its
 * time as well as all of it (a 1965 single is mastered far quieter than a 2015 one, however hard it rocks), then its
 * intensity as a percentile too: Energy boost is the library's most intense songs, whatever the library. Answers each
 * song's calibrated sound and intensity, in order; undefined for songs whose sound wasn't measured.
 */
export function calibrate(songs: Calibratable[]): ({ sound: SongSound; intensity: number } | undefined)[] {
  const measured = songs.flatMap((s, i) => (s.sound ? [{ i, sound: s.sound, year: s.year }] : []));
  if (!measured.length) return songs.map(() => undefined);
  const placeIn = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return (v: number) => percentileIn(sorted, v);
  };
  const loudAll = placeIn(measured.map((m) => m.sound.meanDb));
  const busy = placeIn(measured.map((m) => m.sound.onsetsPerSec));
  const bright = placeIn(measured.map((m) => m.sound.centroidHz));
  const bass = placeIn(measured.map((m) => m.sound.lowShare));
  const range = placeIn(measured.map((m) => m.sound.rangeDb));
  const loudInEra = eraLoudness(measured);
  const placed = measured.map((m, k) => {
    const all = loudAll(m.sound.meanDb);
    const era = loudInEra[k];
    const sound: SongSound = {
      ...m.sound,
      loud: era === undefined ? all : ERA_SHARE * era + (1 - ERA_SHARE) * all,
      busy: busy(m.sound.onsetsPerSec),
      bright: bright(m.sound.centroidHz),
      bass: bass(m.sound.lowShare),
      range: range(m.sound.rangeDb),
    };
    return { i: m.i, sound, raw: intensityOf(sound, songs[m.i]!.words) };
  });
  const intensity = placeIn(placed.map((p) => p.raw));
  const out: ({ sound: SongSound; intensity: number } | undefined)[] = songs.map(() => undefined);
  for (const p of placed) out[p.i] = { sound: p.sound, intensity: intensity(p.raw) };
  return out;
}

/** Each measured song's loudness percentile among songs of its time (undefined without a year). */
function eraLoudness(measured: { sound: SongSound; year?: number }[]): (number | undefined)[] {
  const byYear = new Map<number, number[]>();
  for (const m of measured) {
    if (!m.year) continue;
    const dbs = byYear.get(m.year);
    if (dbs) dbs.push(m.sound.meanDb);
    else byYear.set(m.year, [m.sound.meanDb]);
  }
  const windows = new Map<number, number[]>();
  const windowOf = (year: number) => {
    let sorted = windows.get(year);
    if (!sorted) {
      for (let span = ERA_YEARS; ; span *= 2) {
        const values: number[] = [];
        for (const [y, dbs] of byYear) if (Math.abs(y - year) <= span) values.push(...dbs);
        if (values.length >= ERA_SONGS || span > 64) {
          sorted = values.sort((a, b) => a - b);
          break;
        }
      }
      windows.set(year, sorted);
    }
    return sorted;
  };
  return measured.map((m) => (m.year ? percentileIn(windowOf(m.year), m.sound.meanDb) : undefined));
}

/** Where `v` stands among `sorted` (0 … 1): the share below it, with ties counting half. */
function percentileIn(sorted: number[], v: number): number {
  if (sorted.length < 2) return 0.5;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < sorted.length && sorted[end] === v) end++;
  return (lo + (end - lo) / 2) / sorted.length;
}

function deviation(values: number[]): number {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** 0 below `from`, 1 from `to`, straight in between. */
function ramp(value: number, from: number, to: number): number {
  return clamp((value - from) / (to - from));
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
