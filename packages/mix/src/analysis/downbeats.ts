// Where the bars and phrases of a song start, from the same onset pass and beat grid as the rest of
// the mix analysis. A beatmatched blend that lines up beats but not bars sounds "off" to anyone who
// dances, and dance music changes every 16 beats (a phrase), so transitions start on phrase edges.

import type { BeatGrid } from './beatGrid.ts';
import { BEAT_ONSET_LATENCY_FRAMES, ONSET_LATENCY_FRAMES, type Onsets } from './onset.ts';
import {
  BEATS_PER_BAR,
  BEATS_PER_PHRASE,
  FRAME_CENTRE,
  MIN_BEAT_SOUND,
  MIN_LAST_PHRASE_BEATS,
  mean,
  peak,
  soundEndOf,
} from './shared.ts';

export interface Downbeats {
  /** The grid's beat index (0–3) of the first downbeat: bars start every 4 beats from there. */
  downbeatOffset: number;
  /** Energy 0–1 per 16-beat phrase from the first downbeat, relative to the loudest phrase. */
  phraseEnergy: number[];
  /** The accents the bar was chosen from, so sections.ts can judge the choice without measuring again. */
  accents?: BarAccents;
}

/** The frames the bar is found from. */
export type BarFrames = Pick<Onsets, 'fps' | 'lowOnset' | 'onset' | 'lowEnergy' | 'rms'>;

/**
 * Frames either side of a beat searched for its peak. The kick's bass sits in a few frames around
 * the beat (frames are ~93 ms long and ~23 ms apart), and the grid itself may be ~10 ms off.
 */
const LOW_HALF_WIDTH = 2;
const ONSET_HALF_WIDTH = 1;
/** Two bar positions whose bass accents are within this share of each other are a tie. */
const TIE_SHARE = 0.02;
/**
 * A backbeat: the full-band onsets of two positions two beats apart (2 and 4) both at least this
 * much stronger than those of the other two.
 */
const BACKBEAT_RATIO = 1.5;

const NOTHING: Downbeats = { downbeatOffset: 0, phraseEnergy: [] };

/**
 * Finds the bar and the phrases of a song from one `analyzeOnsets` pass and its `beatGrid`.
 *
 * The downbeat ("one" of the bar) is where most music puts its heaviest kick or a new bass note,
 * so of the four ways to split the beats into bars, the one whose first beats carry the most bass
 * (below ~150 Hz) relative to the rest wins. When the bass level doesn't decide (a four-to-the-floor
 * kick that is equally loud on every beat), the one whose first beats have the strongest bass
 * *onsets* (new bass notes) does. Only when those tie too do the full-band onsets decide, and not
 * simply the strongest: a clap or snare on beats 2 and 4 is the strongest onset of all, so a
 * backbeat (two strong positions two beats apart) rules its own positions out, and of the rest the
 * one with the strongest onsets (a crash on the "one") wins.
 *
 * Phrases are every 16 beats from the first downbeat; each one's energy is its mean loudness,
 * scaled so the loudest phrase is 1. Breakdowns, intros and outros come out low.
 *
 * The result is provisional: `sections` checks the bar against the song's section changes, moves it
 * when the bass barely decided, and counts phrases from the music's first phrase rather than from
 * the grid's first downbeat. `analyzeMix` takes downbeatOffset and phraseEnergy from `sections`.
 */
export function downbeats(frames: BarFrames, grid: Pick<BeatGrid, 'bpm' | 'firstBeat'>, duration: number): Downbeats {
  const accents = barAccents(frames, grid, duration);
  if (!accents) return NOTHING;
  const downbeatOffset = barStart(accents);
  return { downbeatOffset, phraseEnergy: phraseEnergyFrom(frames, grid, downbeatOffset, duration), accents };
}

/** How much the beats at each bar position (0–3) stand out, in bass, bass onsets and all onsets. */
export interface BarAccents {
  /** Per bar position: mean bass at its beats over the mean bass at all beats (1 = no accent). */
  low: number[];
  /** The same measure on the bass onset envelope (new bass notes and kicks). */
  lowOnset: number[];
  /** The same measure on the full-band onset envelope (claps, snares and crashes too). */
  onset: number[];
}

/**
 * The scores `downbeats` picks the bar from, for anything that wants to know how clear the choice
 * was (see sections.ts). Undefined without a grid, without sound, or with less than a bar of beats.
 */
export function barAccents(
  frames: BarFrames,
  grid: Pick<BeatGrid, 'bpm' | 'firstBeat'>,
  duration: number,
): BarAccents | undefined {
  const { fps, rms, lowEnergy, lowOnset, onset } = frames;
  if (!(grid.bpm > 0) || !rms.length || !rms.some((v) => v > 0)) return undefined;

  const period = 60 / grid.bpm;
  const end = Math.min(duration, (rms.length + FRAME_CENTRE) / fps);
  const beatTimes: number[] = [];
  for (let t = grid.firstBeat; t < end; t += period) beatTimes.push(t);
  if (beatTimes.length < BEATS_PER_BAR) return undefined;

  // The bass of a beat is in the frames centred on it; its onset leads it by the envelope's latency.
  const low = beatTimes.map((t) => peak(lowEnergy, t * fps - FRAME_CENTRE, LOW_HALF_WIDTH));
  const bassAttack = beatTimes.map((t) => peak(lowOnset, t * fps - BEAT_ONSET_LATENCY_FRAMES, ONSET_HALF_WIDTH));
  const attack = beatTimes.map((t) => peak(onset, t * fps - ONSET_LATENCY_FRAMES, ONSET_HALF_WIDTH));
  return { low: accents(low), lowOnset: accents(bassAttack), onset: accents(attack) };
}

/**
 * Energy 0–1 of each 16-beat phrase when bars start at grid beat `downbeatOffset`, relative to the
 * loudest phrase. Phrases run to where the sound ends (not into trailing silence), and a last,
 * partial phrase counts when at least 8 of its beats have sound in them (MIN_BEAT_SOUND). Empty
 * without a grid or without sound.
 */
export function phraseEnergyFrom(
  frames: Pick<Onsets, 'fps' | 'rms'>,
  grid: Pick<BeatGrid, 'bpm' | 'firstBeat'>,
  downbeatOffset: number,
  duration: number,
): number[] {
  const { fps, rms } = frames;
  if (!(grid.bpm > 0) || !rms.length) return [];
  const period = 60 / grid.bpm;
  const end = Math.min(duration, soundEndOf(frames));
  return phrases(frames, grid.firstBeat + downbeatOffset * period, period, end);
}

/** Two bar positions whose bass (or bass onset) accents are within TIE_SHARE of each other are a tie. */
export function isBassTie(a: number, b: number): boolean {
  return Math.abs(a - b) <= TIE_SHARE * Math.max(a, b);
}

/**
 * The bar position (0–3) whose beats stand out most: highest mean bass at its beats over the mean
 * bass at all beats; among positions tied on that, the same on the bass onsets; among positions
 * tied on both, the full-band onsets, leaving out a backbeat. Remaining ties go to the earliest.
 */
function barStart({ low, lowOnset, onset }: BarAccents): number {
  const tiedOn = (values: number[], among: number[]) => {
    const best = Math.max(...among.map((o) => values[o]!));
    return among.filter((o) => isBassTie(values[o]!, best));
  };
  let candidates = tiedOn(lowOnset, tiedOn(low, [0, 1, 2, 3]));
  if (candidates.length > 1) {
    const offBackbeat = candidates.filter(
      (o) => Math.min(onset[(o + 1) % 4]!, onset[(o + 3) % 4]!) >= BACKBEAT_RATIO * Math.max(onset[o]!, onset[(o + 2) % 4]!),
    );
    if (offBackbeat.length) candidates = offBackbeat;
  }
  return candidates.reduce((best, o) => (onset[o]! > onset[best]! ? o : best));
}

/** For each bar position, the mean of `values` at beats offset, offset + 4, … over the mean of all. */
function accents(values: number[]): number[] {
  const overall = mean(values) || 1;
  return Array.from({ length: BEATS_PER_BAR }, (_, offset) => {
    const own = values.filter((_, i) => i % BEATS_PER_BAR === offset);
    return mean(own) / overall;
  });
}

/**
 * Mean loudness of each 16-beat phrase from `start` up to `end`, relative to the loudest. Frames
 * count toward the phrase their centre falls in; a last phrase with fewer than 8 beats sounding
 * before `end` is left out.
 */
function phrases(frames: Pick<Onsets, 'fps' | 'rms'>, start: number, period: number, end: number): number[] {
  const { fps, rms } = frames;
  if (!(end > start)) return [];
  const phraseSeconds = BEATS_PER_PHRASE * period;
  const count = Math.floor((end - start) / phraseSeconds);
  const lastBeats = Math.ceil((end - MIN_BEAT_SOUND - start - count * phraseSeconds) / period);
  const sums = new Float64Array(count + (lastBeats >= MIN_LAST_PHRASE_BEATS ? 1 : 0));
  const counts = new Float64Array(sums.length);
  for (let f = 0; f < rms.length; f++) {
    const centre = (f + FRAME_CENTRE) / fps;
    if (centre >= end) break;
    const phrase = Math.floor((centre - start) / phraseSeconds);
    if (phrase < 0 || phrase >= sums.length) continue;
    sums[phrase]! += rms[f]!;
    counts[phrase]!++;
  }
  const energy = Array.from(sums, (s, i) => (counts[i] ? s / counts[i]! : 0));
  const loudest = Math.max(0, ...energy);
  if (!loudest) return [];
  return energy.map((e) => Math.round((e / loudest) * 1000) / 1000);
}
