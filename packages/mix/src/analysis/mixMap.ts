// The whole mix analysis of a song: one onset pass over its beginning (and one over its end, for a
// long song) feeding the beat grid, bars, sections and key, combined into the MixMap the planner
// reads. This is where the pieces have to agree with each other: the planner draws its bar and
// phrase lines from the map's grid, so the grid must be counted from where the music's phrases start.

import type { MixMap } from '../types.ts';
import { MIX_MAP_VERSION } from '../types.ts';
import type { BeatActivations } from './beatThis.ts';
import { beatGrid } from './beatGrid.ts';
import { downbeats, phraseEnergyFrom } from './downbeats.ts';
import { detectKey } from './key.ts';
import { ANALYSIS_RATE, BEAT_ONSET_LATENCY_FRAMES, analyzeOnsets, type Onsets } from './onset.ts';
import { neuralGrid, type NeuralGrid } from './neuralGrid.ts';
import { sections } from './sections.ts';
import { BEATS_PER_BAR, BEATS_PER_PHRASE, mod, soundStartOf } from './shared.ts';

/** How much of a song's beginning the server decodes for the mix analysis (all of a shorter song). */
export const MIX_HEAD_SECONDS = 420;
/** How much of a longer song's end it decodes as well: where the outro is, and where it is mixed out. */
export const MIX_TAIL_SECONDS = 180;

/**
 * The tail's beats may sit this far from the head's grid carried on to them before the grid counts
 * as drifting (the same tolerance as beatGrid's own stability check): 25 ms is where a blend's
 * kicks start to flam.
 */
const STABLE_PHASE_SECONDS = 0.025;
/**
 * How much the tail may correct the head's tempo. beatGrid rounds to 0.01 BPM, which over ten
 * minutes moves the grid by up to ~40 ms at 70 BPM: the head and tail together measure the tempo
 * far more precisely, and a correction of about that size is rounding, not drift.
 */
const MAX_TEMPO_CORRECTION = 0.01;
/** The tail is checked against the grid in windows this long (as beatGrid checks the head). */
const WINDOW_SECONDS = 30;
/** A window whose beat stands out less than this (beatGrid's 0–1 confidence) has no beat to check. */
const WINDOW_MIN_CONFIDENCE = 0.3;
/** Phase resolution, in frames, of the tail's grid fit. */
const PHASE_STEP = 0.05;
/** Frames either side of a beat that count as "at the beat" for a window's confidence. */
const BEAT_HALF_WIDTH = 2;

/**
 * Measures a song for mixing. `head` is its first min(duration, 420) s, mono at `rate`; `tail`, only
 * for a song longer than that, is its last 180 s (null otherwise). `duration` is the whole song's.
 *
 * Grid, bars, intro, first drop, cold start, phrase energy and key come from the head. With a tail,
 * the outro, cold end and sound end come from it, on the head's grid carried over to the tail: the
 * tail's own beats re-fit that grid's phase (correcting the tempo's last digits), and if they still
 * stray from it by more than 25 ms the tempo drifts over the song and the grid isn't stable.
 *
 * `beats`, the beat model's answer for the head (and the tail, when there is one), puts the grid
 * and the bars in its hands (see neuralGrid): the onset analysis then only puts the beats on the
 * transients. Without it (the model couldn't run), the onset analysis finds them all as before.
 *
 * Silence or too little audio gives a map without a beat (bpm 0) whose sound ends at 0.
 */
export function analyzeMix(
  head: Float32Array,
  tail: Float32Array | null,
  duration: number,
  rate = ANALYSIS_RATE,
  beats?: { head: BeatActivations; tail?: BeatActivations | null },
): MixMap {
  const songSeconds = Math.max(0, Number.isFinite(duration) ? duration : 0);
  const headSeconds = Math.min(head.length / rate, songSeconds);
  const frames = analyzeOnsets(head, rate);
  const neural = beats ? neuralGrid(frames, beats.head, headSeconds) : undefined;
  const grid = neural ?? beatGrid(frames);
  const beatsFrom = beats ? 'model' : 'onsets';
  const key = detectKey(head, rate);
  const tailPart = tail && tail.length && songSeconds > headSeconds ? measureTail(tail, songSeconds, rate) : undefined;
  const soundStart = soundStartOf(frames);

  if (!(grid.bpm > 0)) {
    // No beat: nothing to mix on, but where the sound ends and whether the song starts and ends on
    // full sound still matter for a plain crossfade.
    const noGrid = { bpm: 0, firstBeat: 0 };
    const nothing = { downbeatOffset: 0, phraseEnergy: [] };
    const start = sections(frames, noGrid, nothing, headSeconds);
    const end = tailPart ? sections(tailPart.frames, noGrid, nothing, tailPart.seconds) : undefined;
    const fromTail = end !== undefined && end.soundEnd > 0;
    const soundEnd = fromTail ? tailPart!.start + end.soundEnd : Math.min(start.soundEnd, tailPart?.start ?? Infinity);
    return finish(songSeconds, {
      bpm: 0,
      firstBeat: 0,
      downbeatOffset: 0,
      downbeatConfidence: 0,
      gridStable: false,
      beatConfidence: 0,
      beatsFrom,
      ...(key ? { key } : {}),
      introEnd: 0,
      outroStart: soundEnd,
      coldStart: start.coldStart,
      coldEnd: fromTail ? end.coldEnd : !tailPart && start.coldEnd,
      soundStart,
      soundEnd,
      phraseEnergy: [],
    });
  }

  // The model's bars stand as they are (sections only measures how sure they are); the onset analysis's
  // are provisional, and sections may move them.
  const found = neural
    ? { downbeatOffset: neural.downbeatOffset, phraseEnergy: phraseEnergyFrom(frames, grid, neural.downbeatOffset, headSeconds) }
    : downbeats(frames, grid, headSeconds);
  const start = sections(frames, grid, found, headSeconds, undefined, neural ? { confidence: neural.barConfidence } : undefined);

  // Phrase alignment. The planner draws phrase lines at firstBeat + (downbeatOffset + 16k) beats,
  // k ≥ 0; sections counts phrases from the music's first downbeat (`firstPhrase`), which after
  // leading silence can be many beats into the grid. So the map's grid starts at that downbeat:
  // firstBeat is the grid beat up to three beats before it (as many as fit after 0) and
  // downbeatOffset is how many beats that is, so phrase line 0 is the music's first downbeat and
  // every 16 beats after it is one of sections' phrase starts.
  const headPeriod = 60 / grid.bpm;
  const beatsBefore = Math.max(0, Math.min(BEATS_PER_BAR - 1, Math.floor(start.firstPhrase / headPeriod + 1e-6)));
  const firstBeat = Math.max(0, round(start.firstPhrase - beatsBefore * headPeriod, 4));

  let bpm = grid.bpm;
  let gridStable = grid.gridStable;
  let outroStart = start.outroStart;
  let soundEnd = start.soundEnd;
  let coldEnd = start.coldEnd;
  if (tailPart) {
    const firstPhrase = firstBeat + beatsBefore * headPeriod;
    const tailBeats = beats?.tail ? neuralGrid(tailPart.frames, beats.tail, tailPart.seconds) : undefined;
    const fit = fitTailGrid(tailPart, grid.bpm, firstPhrase, tailBeats);
    bpm = fit.bpm;
    gridStable &&= fit.stable;
    // The tail's grid in tail time, with a phrase line carried over from the head so its phrases are
    // the song's phrases, not ones counted from wherever the tail happens to begin.
    const tailGrid = { bpm, firstBeat: fit.tailFirstBeat };
    const phraseLine = fit.tailFirstBeat - mod(fit.tailFirstBeatIndex, BEATS_PER_PHRASE) * (60 / bpm);
    const offset = { downbeatOffset: mod(-fit.tailFirstBeatIndex, BEATS_PER_BAR), phraseEnergy: [] };
    const end = sections(tailPart.frames, tailGrid, offset, tailPart.seconds, phraseLine);
    if (end.soundEnd > 0) {
      outroStart = tailPart.start + end.outroStart;
      soundEnd = tailPart.start + end.soundEnd;
      coldEnd = end.coldEnd;
    } else {
      // A silent tail: the sound ended before it.
      soundEnd = Math.min(soundEnd, tailPart.start);
      outroStart = Math.min(outroStart, soundEnd);
      coldEnd = false;
    }
  }

  return finish(songSeconds, {
    bpm,
    firstBeat,
    downbeatOffset: beatsBefore,
    downbeatConfidence: start.downbeatConfidence,
    gridStable,
    beatConfidence: grid.beatConfidence,
    beatsFrom,
    ...(key ? { key } : {}),
    introEnd: start.introEnd,
    outroStart,
    ...(start.firstDrop !== undefined ? { firstDrop: start.firstDrop } : {}),
    coldStart: start.coldStart,
    coldEnd,
    soundStart,
    soundEnd,
    // Counted from `firstPhrase`, so phraseEnergy[k] is the phrase from the planner's phrase line k.
    phraseEnergy: start.phraseEnergy,
  });
}

/** The tail's onset pass and where it sits in the song. */
interface Tail {
  frames: Onsets;
  /** Its length in seconds. */
  seconds: number;
  /** Song time of its first sample. */
  start: number;
}

function measureTail(tail: Float32Array, duration: number, rate: number): Tail {
  const seconds = Math.min(tail.length / rate, duration);
  return { frames: analyzeOnsets(tail, rate), seconds, start: duration - seconds };
}

/**
 * The head's grid carried over to the tail. Beat n of the head's grid is at
 * firstPhrase + n·60/bpm (song time; n counts from the music's first downbeat); tail time t is song
 * time `tail.start + t`.
 *
 * The tail's beats over its whole length fix the phase there; the number of beats between the
 * head's first downbeat and the tail's middle beat is then known, and with it the tempo to far
 * better than 0.01 BPM. If that correction is bigger than rounding could explain, or a 30 s window
 * of the tail with a clear beat strays more than 25 ms from the corrected grid, the tempo drifts.
 *
 * With the beat model's grid for the tail (`model`), its beats fix the phase there instead of the
 * onsets (which can sit on the off-beats), and its own stability replaces the window check.
 *
 * Returns the tempo, whether the grid holds, and the tail's first grid beat (tail time) with its
 * beat number n on the head's grid.
 */
function fitTailGrid(tail: Tail, headBpm: number, firstPhrase: number, model?: NeuralGrid) {
  if (model && model.bpm > 0) return fitTailToModel(tail, headBpm, firstPhrase, model);
  const { beatOnset, fps } = tail.frames;
  const n = beatOnset.length;
  const toSong = (frame: number) => tail.start + (frame + BEAT_ONSET_LATENCY_FRAMES) / fps;
  let bpm = headBpm;
  let stable = true;

  const whole = fitPhase(beatOnset, 0, n, periodOf(headBpm, fps));
  if (whole.confidence >= WINDOW_MIN_CONFIDENCE) {
    const middle = whole.phase + Math.floor((n / 2 - whole.phase) / whole.period) * whole.period;
    const span = toSong(middle) - firstPhrase;
    const beats = Math.round(span / (60 / headBpm));
    const corrected = (60 * beats) / span;
    if (Math.abs(corrected - headBpm) <= MAX_TEMPO_CORRECTION) bpm = round(corrected, 4);
    else stable = false;
  }

  const period = 60 / bpm;
  const offGrid = (t: number) => Math.abs(wrap(t - firstPhrase, period));
  const windowFrames = WINDOW_SECONDS * fps;
  const windows = Math.max(1, Math.floor(n / windowFrames));
  for (let w = 0; w < windows && stable; w++) {
    const from = Math.round((w * n) / windows);
    const to = Math.round(((w + 1) * n) / windows);
    const local = fitPhase(beatOnset, from, to, periodOf(bpm, fps));
    if (local.confidence < WINDOW_MIN_CONFIDENCE) continue; // a breakdown: no beat to check
    const middle = local.phase + Math.floor((to - from) / 2 / local.period) * local.period;
    if (offGrid(toSong(middle)) > STABLE_PHASE_SECONDS) stable = false;
  }

  // The tail's grid: its own phase where it has a beat (right there even if the tempo drifted),
  // else the head's grid carried on.
  const anchor =
    whole.confidence >= WINDOW_MIN_CONFIDENCE ? toSong(fitPhase(beatOnset, 0, n, periodOf(bpm, fps)).phase) : firstPhrase;
  const firstIndex = Math.ceil((tail.start - anchor) / period - 1e-6);
  const tailFirstBeat = anchor + firstIndex * period - tail.start;
  const tailFirstBeatIndex = Math.round((anchor + firstIndex * period - firstPhrase) / period);
  return { bpm, stable, tailFirstBeat: Math.max(0, tailFirstBeat), tailFirstBeatIndex };
}

/**
 * fitTailGrid with the beat model's grid for the tail: the beat nearest the tail's middle, on the
 * model's phase, against the head's first downbeat corrects the tempo (or, corrected by more than
 * rounding explains, shows the tempo drifting), and the model's own window check says whether the
 * tail holds steady.
 */
function fitTailToModel(tail: Tail, headBpm: number, firstPhrase: number, model: NeuralGrid) {
  const headPeriod = 60 / headBpm;
  const anchor = tail.start + model.firstBeat;
  const middle = anchor + Math.round((tail.seconds / 2 - model.firstBeat) / headPeriod) * headPeriod;
  const span = middle - firstPhrase;
  const corrected = (60 * Math.round(span / headPeriod)) / span;
  const close = Math.abs(corrected - headBpm) <= MAX_TEMPO_CORRECTION;
  const bpm = close ? round(corrected, 4) : headBpm;
  const period = 60 / bpm;
  const firstIndex = Math.ceil((tail.start - anchor) / period - 1e-6);
  const tailFirstBeat = anchor + firstIndex * period - tail.start;
  const tailFirstBeatIndex = Math.round((anchor + firstIndex * period - firstPhrase) / period);
  return { bpm, stable: close && model.gridStable, tailFirstBeat: Math.max(0, tailFirstBeat), tailFirstBeatIndex };
}

/**
 * The comb phase (a frame in [from, from + period)) that puts teeth `period` frames apart on the
 * most onset energy in frames [from, to), and how much the envelope stands out on those teeth: the
 * mean at the teeth minus the mean elsewhere, in standard deviations, mapped 0.5 → 0 and 3 → 1
 * (as beatGrid's confidence).
 */
function fitPhase(onset: Float64Array, from: number, to: number, period: number) {
  const end = Math.min(to, onset.length - 1);
  const comb = (phase: number) => {
    let sum = 0;
    for (let x = phase; x < end; x += period) sum += sample(onset, x);
    return sum;
  };
  let phase = from;
  let best = -Infinity;
  for (let p = from; p < from + period; p += PHASE_STEP) {
    const score = comb(p);
    if (score > best) {
      best = score;
      phase = p;
    }
  }

  let teeth = 0;
  for (let x = phase; x < end; x += period) teeth++;
  let elsewhere = 0;
  let others = 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = from; i < to; i++) {
    sum += onset[i]!;
    sumSq += onset[i]! ** 2;
    if (Math.abs(wrap(i - phase, period)) > BEAT_HALF_WIDTH) {
      elsewhere += onset[i]!;
      others++;
    }
  }
  const count = to - from;
  const mean = count > 0 ? sum / count : 0;
  const std = count > 0 ? Math.sqrt(Math.max(0, sumSq / count - mean * mean)) : 0;
  const contrast = teeth && others && std ? (best / teeth - elsewhere / others) / std : 0;
  return { phase, period, confidence: Math.min(1, Math.max(0, (contrast - 0.5) / 2.5)) };
}

/**
 * The map with every time inside the song and in order: soundStart ≤ soundEnd, introEnd ≤ outroStart ≤
 * soundEnd ≤ duration. Each analysis step keeps its own times sensible; this guards the combination (a tail
 * and a head that disagree, a duration shorter than the decoded audio).
 */
function finish(duration: number, map: Omit<MixMap, 'version' | 'duration'>): MixMap {
  const clamp = (t: number) => Math.min(duration, Math.max(0, Number.isFinite(t) ? t : 0));
  const soundEnd = clamp(map.soundEnd);
  const outroStart = Math.min(clamp(map.outroStart), soundEnd);
  const introEnd = Math.min(clamp(map.introEnd), outroStart);
  const { firstDrop, ...rest } = map;
  return {
    version: MIX_MAP_VERSION,
    duration,
    ...rest,
    firstBeat: clamp(map.firstBeat),
    introEnd,
    outroStart,
    ...(firstDrop !== undefined ? { firstDrop: clamp(firstDrop) } : {}),
    soundStart: Math.min(clamp(map.soundStart ?? 0), soundEnd),
    soundEnd,
  };
}

/** Linear interpolation of the envelope at a fractional frame. */
function sample(onset: Float64Array, x: number): number {
  const i = Math.floor(x);
  const t = x - i;
  return onset[i]! * (1 - t) + (onset[i + 1] ?? 0) * t;
}

/** `x` wrapped into −period/2 … period/2. */
const wrap = (x: number, period: number) => x - Math.round(x / period) * period;
const periodOf = (bpm: number, fps: number) => (fps * 60) / bpm;
const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
