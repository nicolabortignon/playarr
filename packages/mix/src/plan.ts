import { integrate } from './automation.ts';
import { isCamelot, keysCompatible } from './camelot.ts';
import { beatHolds } from './drift.ts';
import type { Automation, Camelot, CuePoints, MixMap, MixMode, TransitionPlan } from './types.ts';

// The planner decides how song A hands over to song B: which style, where in each song,
// how fast B plays, and the gain and EQ moves. It is pure and deterministic so the server
// (which renders the transition file) and the desktop live mixer always agree on a plan.

/**
 * Bump when the planner would plan the same two songs differently, so plans the server remembered
 * (and rendered) are made afresh rather than kept while the songs' maps stay the same.
 */
export const PLANNER_VERSION = 2;

export interface PlanInput {
  a: MixMap & { cues?: CuePoints };
  b: MixMap & { cues?: CuePoints };
  mode: MixMode;
  /** B follows A on the same album, in order (decided by the caller from the tracks). */
  sameAlbumInOrder: boolean;
  /** Where A's playback is now (a plan never starts in the past). */
  aPosition?: number;
  /**
   * The listener skipped: leave A as soon as possible from `at` (seconds into A), the earliest the
   * transition can start (the caller allows for its own rendering). Then only a quick mix will do: see
   * skipPlan. `aPosition` is not used.
   */
  skip?: { at: number };
  /**
   * How long a plain fade lasts, in seconds: the listener's fade length (Settings → Playback).
   * LONGEST_FADE when not given. Beat-matched mixes keep their own lengths, in beats.
   */
  fadeSeconds?: number;
}

type Song = PlanInput['a'];

/** Below this a beat grid is a guess: don't beatmatch, at most crossfade. */
export const STEADY_BEAT_CONFIDENCE = 0.35;
/** A quick mix cuts on a downbeat, so it needs a grid we mostly trust. */
const QUICK_MIX_CONFIDENCE = 0.5;
/**
 * Below this the bar starts (downbeatConfidence) are a guess: equal kicks with a clap on 2 and 4 can put
 * the bar a beat or two off, so phrase lines can't be trusted. No long blend then (its whole point is
 * phrases meeting), and a quick mix lands on a beat of that song instead of claiming a phrase or bar.
 */
export const MIN_DOWNBEAT_CONFIDENCE = 0.4;
/** Stretching B more than this is audible: beyond it, no long blend. */
export const LARGEST_TEMPO_GAP = 0.08;
/**
 * Tempos this close count as the same: over the longest blend B, at its own speed, drifts less than
 * this from A, so it isn't stretched, nor eased back afterwards (an analysis's 128.0006 and 128.0009
 * BPM are one tempo, and stretching for them would only cost the render time and add a ramp).
 */
const SAME_TEMPO_DRIFT_S = 0.002;
/** A quick mix only stretches B when the tempos are this close (otherwise it cuts unstretched). */
const QUICK_MIX_STRETCH_GAP = 0.02;
/** Keys detected with less confidence than this don't count against a blend. */
export const KEY_CONFIDENCE = 0.3;
const LONGEST_BLEND_BEATS = 64;
const AUTO_BLEND_BEATS = 32;
const SHORTEST_BLEND_BEATS = 16;
/** Long blend lengths in A's beats, longest first. */
const BLEND_BEATS = [LONGEST_BLEND_BEATS, AUTO_BLEND_BEATS, SHORTEST_BLEND_BEATS];
/** Auto keeps blends to 32 beats unless both songs have this much room (party always takes the longest that fits). */
const ROOM_FOR_AUTO_LONGEST_BLEND = 2 * LONGEST_BLEND_BEATS;
/** After a long blend, B eases back to its own tempo over 16 of its own bars. */
const EASE_BACK_BEATS = 64;
/** Quick mix lengths in A's beats, preferred first. */
const QUICK_MIX_BEATS = [8, 4];
/** Dropping a long blend's ease-back makes B snap to its own tempo on resuming: only tolerable this close. */
const SNAP_BACK_GAP = 0.03;
/** A stretched quick mix crossfades over its last two beats. */
const QUICK_CROSSFADE_BEATS = 2;
/** An unstretched quick mix lets A ring on, filtered, for one beat after the cut. */
const CUT_TAIL_BEATS = 1;
/** How fast B comes in at a cut: short enough to land on the downbeat, long enough not to click. */
const CUT_SECONDS = 0.02;
/** A plain fade's length when the listener hasn't picked one, and the range a picked one is kept within. */
const LONGEST_FADE = 8;
const LONGEST_CHOSEN_FADE = 30;
/** A skip with no beat to mix on crossfades this long: quick, but not an abrupt cut. */
const SKIP_FADE = 2.5;
/** A skip's lead-in in A's beats, preferred first: the second only when it lands a bar sooner. */
const SKIP_LEAD_BEATS = [4, 2];
/** A fade shorter than this is pointless: go straight on. */
const SHORTEST_FADE = 1;
/** A plan starts at least this far ahead of A's position, so there's time to render and load it. */
const PLANNING_LEAD = 5;
const BASS_CUT_DB = -24;
const HIGH_PASS_OFF_HZ = 20;
const HIGH_PASS_SWEEP_HZ = 800;
/**
 * Every plan that stretches B ends with B back at exactly its own speed for this long. The renderer's
 * time-stretch only reproduces its input sample for sample once a few of its 23 ms frames in a row play at
 * rate 1, and the transition must end on exactly the sample where B's own playback picks up.
 */
export const OWN_TEMPO_HOLD = 0.1;
/**
 * A steady stretch gets back to B's own speed over this long rather than in a step: the time-stretch
 * integrates the rate per 23 ms frame assuming it's smooth there, and a step inside a frame would put B's
 * end a few samples off where the plan says it resumes. A ramp this gentle keeps that under half a sample.
 */
export const OWN_TEMPO_RAMP = 0.2;
/** Points used to draw an equal-power or exponential curve with straight lines. */
const CURVE_POINTS = 8;
const PHRASE_BEATS = 16;
const BAR_BEATS = 4;
/** Slack for comparing times and ratios that went through floating-point arithmetic. */
const EPSILON = 1e-9;
/**
 * A time this close to a grid line counts as on it. Section times are placed on the analysis's grid
 * before its tempo's last digits are settled, so an outro "on" a phrase line can sit a hair past it.
 */
const LINE_SLACK_S = 0.01;

const FLAT_DB: Automation = [{ at: 0, value: 0 }];
const HIGH_PASS_OFF: Automation = [{ at: 0, value: HIGH_PASS_OFF_HZ }];

/**
 * B's playback rate that matches A's tempo: a.bpm / b.bpm, doubled or halved when that brings it
 * closer to 1, so a 174 BPM song mixes with an 87 BPM one beat for every half beat.
 */
export function tempoRatio(aBpm: number, bBpm: number): number {
  const plain = aBpm / bBpm;
  const candidates = [plain, plain * 2, plain / 2];
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate - 1) < Math.abs(best - 1) ? candidate : best,
  );
}

export function planTransition(input: PlanInput): TransitionPlan {
  const pair = describePair(input);
  if (input.skip) return skipPlan(pair, input.skip.at);
  const decision = chooseStyle(pair);
  switch (decision.style) {
    case 'straight':
      return straightPlan(pair, decision.reason);
    case 'fade':
      return fadePlan(pair, decision.reason);
    case 'quick':
      return quickPlan(pair, decision.reason);
    case 'long':
      return longPlan(pair, decision.beats, decision.reason);
  }
}

// ——— The beat grid ———

const beatLength = (song: MixMap) => 60 / song.bpm;

/** A grid we can do arithmetic with: a real, positive tempo and a finite first beat. */
const hasUsableTempo = (song: MixMap) =>
  Number.isFinite(song.bpm) && song.bpm > 0 && Number.isFinite(song.firstBeat) && Number.isFinite(song.downbeatOffset);

/** Time of grid line `index` counted from the first downbeat; lines are `beatsPerLine` apart (4: bars, 16: phrases). */
function gridLine(song: MixMap, beatsPerLine: number, index: number): number {
  return song.firstBeat + (song.downbeatOffset + index * beatsPerLine) * beatLength(song);
}

/** Position of time t on the grid, in lines from the first downbeat (whole numbers fall on a line). */
function linesAt(song: MixMap, beatsPerLine: number, t: number): number {
  return (t - gridLine(song, beatsPerLine, 0)) / (beatsPerLine * beatLength(song));
}

/** `slack`: seconds before `t` a line may be and still count (LINE_SLACK_S where `t` is a section time). */
function firstLineAtOrAfter(song: MixMap, beatsPerLine: number, t: number, slack = 0): number {
  const index = Math.max(0, Math.ceil(linesAt(song, beatsPerLine, t - slack) - EPSILON));
  return gridLine(song, beatsPerLine, index);
}

function lastLineAtOrBefore(song: MixMap, beatsPerLine: number, t: number): number | undefined {
  const index = Math.floor(linesAt(song, beatsPerLine, t) + EPSILON);
  return index < 0 ? undefined : gridLine(song, beatsPerLine, index);
}

/** The line nearest to `target` that isn't before `notBefore` (nor before the first downbeat). */
function nearestLine(song: MixMap, beatsPerLine: number, target: number, notBefore: number): number {
  const nearest = Math.round(linesAt(song, beatsPerLine, target));
  const earliest = Math.ceil(linesAt(song, beatsPerLine, notBefore) - EPSILON);
  return gridLine(song, beatsPerLine, Math.max(nearest, earliest, 0));
}

// Song positions as the planner uses them. A broken map (NaN, or times outside the song) must never
// turn into a broken plan, so each falls back to something harmless.
const finiteOr = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
const durationOf = (song: Song) => Math.max(0, finiteOr(song.duration, 0));
/** Where sound ends, kept within the song. */
const soundEndOf = (song: Song) => Math.min(Math.max(finiteOr(song.soundEnd, durationOf(song)), 0), durationOf(song));
/** Where sound starts, kept before where it ends (maps from before version 4 don't say: 0). */
const soundStartOf = (song: Song) => Math.min(Math.max(finiteOr(song.soundStart ?? 0, 0), 0), soundEndOf(song));
/** Where A can be left: the hand-set mix-out point, else the detected outro. */
const mixOutPoint = (a: Song) => finiteOr(a.cues?.mixOut ?? a.outroStart, soundEndOf(a));
/** Where B is fully in: the hand-set mix-in point, else the end of the detected intro. */
const mixInPoint = (b: Song) => finiteOr(b.cues?.mixIn ?? b.introEnd, 0);
/** B mustn't resume normal playback inside (or past) its own outro: that's where the next mix begins. */
const resumeLimit = (b: Song) => finiteOr(b.cues?.mixOut ?? b.outroStart, soundEndOf(b));

// ——— Choosing the style ———

/** What the style rules need to know about the two songs. */
interface Pair {
  input: PlanInput;
  a: Song;
  b: Song;
  /** B's rate while matched to A (see tempoRatio); 1 when either tempo is unusable. */
  ratio: number;
  /** How far apart the tempos are, as a fraction (0.03 = 3%). */
  tempoGap: number;
  /** The tempos only match at half or double time. */
  halfTime: boolean;
  /** The earliest A may start the transition. */
  earliestStart: number;
  /** Where A may start leaving: its outro (or mix-out cue), and not before earliestStart. */
  leaveFrom: number;
  /** Room for a blend from A's first phrase line at leaveFrom, and in B's intro, both in A's beats (the blend's beats). */
  outroRoomBeats: number;
  introRoomBeats: number;
  /** The song's bar starts can be trusted (see MIN_DOWNBEAT_CONFIDENCE). */
  aBarsSure: boolean;
  bBarsSure: boolean;
  keys: { kind: 'compatible' } | { kind: 'unknown' } | { kind: 'clash'; a: Camelot; b: Camelot };
}

function describePair(input: PlanInput): Pair {
  const { a, b, aPosition } = input;
  const tempos = hasUsableTempo(a) && hasUsableTempo(b);
  const matched = tempos ? tempoRatio(a.bpm, b.bpm) : 1;
  const ratio = Math.abs(matched - 1) * LONGEST_BLEND_BEATS * (tempos ? beatLength(a) : 0) < SAME_TEMPO_DRIFT_S ? 1 : matched;
  const earliestStart = aPosition === undefined || !Number.isFinite(aPosition) ? 0 : Math.max(0, aPosition + PLANNING_LEAD);
  const leaveFrom = Math.max(mixOutPoint(a), earliestStart);
  let outroRoomBeats = 0;
  let introRoomBeats = 0;
  if (tempos) {
    // A long blend starts on a phrase line, so its room runs from the first one A may leave on.
    outroRoomBeats = (soundEndOf(a) - firstLineAtOrAfter(a, PHRASE_BEATS, leaveFrom, LINE_SLACK_S)) / beatLength(a);
    // B can start no earlier than its first downbeat; its seconds pass `ratio` times faster than the blend's.
    introRoomBeats = (mixInPoint(b) - gridLine(b, BAR_BEATS, 0)) / ratio / beatLength(a);
  }
  return {
    input,
    a,
    b,
    ratio,
    tempoGap: Math.abs(ratio - 1),
    halfTime: tempos && Math.abs(matched - a.bpm / b.bpm) > EPSILON,
    earliestStart,
    leaveFrom,
    outroRoomBeats,
    introRoomBeats,
    aBarsSure: barsSure(a),
    bBarsSure: barsSure(b),
    keys: keyRelation(a, b),
  };
}

/** Bar starts are trusted unless the analysis said it's unsure of them (no confidence at all: older maps, hand-made ones). */
const barsSure = (song: Song) => song.downbeatConfidence === undefined || song.downbeatConfidence >= MIN_DOWNBEAT_CONFIDENCE;

function keyRelation(a: Song, b: Song): Pair['keys'] {
  const trusted = (song: Song) =>
    song.key && song.key.confidence >= KEY_CONFIDENCE && isCamelot(song.key.camelot) ? song.key.camelot : undefined;
  const aKey = trusted(a);
  const bKey = trusted(b);
  if (!aKey || !bKey) return { kind: 'unknown' };
  return keysCompatible(aKey, bKey) ? { kind: 'compatible' } : { kind: 'clash', a: aKey, b: bKey };
}

type Decision =
  | { style: 'straight' | 'fade' | 'quick'; reason: string }
  | { style: 'long'; beats: number; reason: string };

/** Fading into or out of an abrupt edge sounds like a mistake; better to play the songs back to back. */
const abruptEdgeAtTheJoin = ({ a, b }: Pair) => a.coldEnd || b.coldStart;

/** The style rules in order: the first that has something to say decides. The last always does. */
const STYLE_RULES: ((pair: Pair) => Decision | undefined)[] = [
  function noMixingWanted({ input }) {
    if (input.mode === 'off') return { style: 'straight', reason: 'No mixing: straight on' };
    if (input.sameAlbumInOrder) return { style: 'straight', reason: 'Same album, in order: straight on' };
    return undefined;
  },
  function noSteadyBeat(pair) {
    const steady = (song: Song) => hasUsableTempo(song) && song.beatConfidence >= STEADY_BEAT_CONFIDENCE;
    if (steady(pair.a) && steady(pair.b)) return undefined;
    if (abruptEdgeAtTheJoin(pair)) return { style: 'straight', reason: 'No steady beat and an abrupt edge: straight on' };
    return { style: 'fade', reason: 'No steady beat: crossfade' };
  },
  function abruptJoinAtDifferentTempos({ a, b, tempoGap }) {
    if (a.coldEnd && b.coldStart && tempoGap > LARGEST_TEMPO_GAP + EPSILON) {
      return { style: 'straight', reason: 'Abrupt end into abrupt start at different tempos: straight on' };
    }
    return undefined;
  },
  function unsureBars(pair) {
    if (pair.aBarsSure && pair.bBarsSure) return undefined;
    const which =
      !pair.aBarsSure && !pair.bBarsSure
        ? 'Neither song’s bar starts are sure'
        : pair.aBarsSure
          ? 'B’s bar starts are unsure'
          : 'A’s bar starts are unsure';
    // Without phrases to meet on, a quick mix on the beat, if the beat itself is sure and steady there.
    const { a, b } = pair;
    const solidBeats = Math.min(a.beatConfidence, b.beatConfidence) >= QUICK_MIX_CONFIDENCE && steadyWhereQuick(pair);
    if (solidBeats) return { style: 'quick', reason: `${which}: quick mix` };
    if (abruptEdgeAtTheJoin(pair)) {
      return { style: 'straight', reason: `${which}, the beat isn’t solid and an edge is abrupt: straight on` };
    }
    return { style: 'fade', reason: `${which} and the beat isn’t solid: crossfade` };
  },
  function temposTooFarApart(pair) {
    if (pair.tempoGap <= LARGEST_TEMPO_GAP + EPSILON) return undefined;
    const sureOfBothBeats = Math.min(pair.a.beatConfidence, pair.b.beatConfidence) >= QUICK_MIX_CONFIDENCE;
    if (sureOfBothBeats) return { style: 'quick', reason: `${tempoText(pair)}: quick mix` };
    if (abruptEdgeAtTheJoin(pair)) {
      return { style: 'straight', reason: `${tempoText(pair)}, an unsure beat and an abrupt edge: straight on` };
    }
    return { style: 'fade', reason: `${tempoText(pair)} and an unsure beat: crossfade` };
  },
  function longBlendOrQuickMix(pair) {
    // Whether the beats hold where the songs would play together is longPlan's to judge: it knows where that is.
    const beats = blendBeats(pair);
    if (pair.keys.kind === 'clash') {
      // Over A's outro and B's intro only (mostly drums, little to clash), and briefly.
      const clashing = `Keys clash (${pair.keys.a}, ${pair.keys.b})`;
      if (beats === undefined) return { style: 'quick', reason: `${clashing}: quick mix` };
      return { style: 'long', beats: SHORTEST_BLEND_BEATS, reason: `${clashing}, intro and outro: ${SHORTEST_BLEND_BEATS}-beat blend` };
    }
    if (beats === undefined) return { style: 'quick', reason: 'Not enough intro or outro room for a blend: quick mix' };
    return { style: 'long', beats, reason: longReason(pair, beats) };
  },
];

function chooseStyle(pair: Pair): Decision {
  for (const rule of STYLE_RULES) {
    const decision = rule(pair);
    if (decision) return decision;
  }
  throw new Error('The last style rule always decides');
}

/** The longest blend that fits both rooms; auto stops at 32 beats unless both songs are roomy. */
function blendBeats({ input, outroRoomBeats, introRoomBeats }: Pair): number | undefined {
  const room = Math.min(outroRoomBeats, introRoomBeats);
  const longest = BLEND_BEATS.find((beats) => beats <= room + EPSILON);
  if (longest === undefined || input.mode === 'party') return longest;
  return Math.min(longest, room >= ROOM_FOR_AUTO_LONGEST_BLEND ? LONGEST_BLEND_BEATS : AUTO_BLEND_BEATS);
}

/**
 * Both beats hold around where a quick mix would join the songs: A's phrase from where it may leave,
 * B's 8 beats either side of its mix-in point (see beatHolds).
 */
function steadyWhereQuick(pair: Pair): boolean {
  const { a, b } = pair;
  const leave = firstLineAtOrAfter(a, PHRASE_BEATS, pair.leaveFrom, LINE_SLACK_S);
  const land = mixInPoint(b);
  const half = (PHRASE_BEATS / 2) * beatLength(b);
  return beatHolds(a, leave, leave + PHRASE_BEATS * beatLength(a)) && beatHolds(b, land - half, land + half);
}

function tempoText({ tempoGap, halfTime }: Pair): string {
  // One decimal under 10% ("2.4% apart"), where the difference between 2% and 3% matters; whole numbers above.
  const percent = tempoGap < 0.1 ? Number((tempoGap * 100).toFixed(1)) : Math.round(tempoGap * 100);
  if (halfTime) return percent === 0 ? 'Half-time tempos' : `Tempos ${percent}% apart at half time`;
  return percent === 0 ? 'Same tempo' : `Tempos ${percent}% apart`;
}

function longReason(pair: Pair, beats: number): string {
  const keys = pair.keys.kind === 'compatible' ? 'keys compatible' : 'key unknown';
  return `${tempoText(pair)}, ${keys}: ${beats}-beat blend`;
}

// ——— The plans ———

/** The listener's fade length, kept to something that can be heard as a fade; LONGEST_FADE when not given. */
function chosenFade({ fadeSeconds }: PlanInput): number {
  if (fadeSeconds === undefined || !Number.isFinite(fadeSeconds)) return LONGEST_FADE;
  return Math.min(LONGEST_CHOSEN_FADE, Math.max(SHORTEST_FADE, fadeSeconds));
}

/** Straight lines through an equal-power curve (sin/cos), so the loudness holds steady through a crossfade. */
function equalPowerCurve(from: number, to: number, direction: 'in' | 'out'): Automation {
  return sampleCurve(from, to, (progress) =>
    direction === 'in' ? Math.sin((progress * Math.PI) / 2) : Math.cos((progress * Math.PI) / 2),
  );
}

/** Exponential, so the sweep sounds even: each step raises the cutoff by the same musical interval. */
function highPassSweep(from: number, to: number): Automation {
  return sampleCurve(from, to, (progress) => HIGH_PASS_OFF_HZ * (HIGH_PASS_SWEEP_HZ / HIGH_PASS_OFF_HZ) ** progress);
}

/** CURVE_POINTS points of `shape` (progress 0–1 → value) from `from` to `to`, with exact ends. */
function sampleCurve(from: number, to: number, shape: (progress: number) => number): Automation {
  const points: Automation = [];
  for (let i = 0; i < CURVE_POINTS; i++) {
    const progress = i / (CURVE_POINTS - 1);
    const value = shape(progress);
    // sin/cos/pow land a hair off round numbers at the ends: snap them so "fully in" and "silent" are exact.
    const snapped = Math.abs(value - Math.round(value)) < EPSILON ? Math.round(value) : value;
    points.push({ at: from + (to - from) * progress, value: snapped });
  }
  return points;
}

/**
 * Straight on: A plays to where its sound ends and B starts where its sound starts, so neither song's
 * silence is heard. Not with mixing off, nor within an album played in order: its gaps are the album's.
 */
function straightPlan({ a, b, input }: Pair, reason: string): TransitionPlan {
  const asRecorded = input.mode === 'off' || input.sameAlbumInOrder;
  const bStart = asRecorded ? 0 : soundStartOf(b);
  return {
    style: 'straight',
    aStart: asRecorded ? durationOf(a) : soundEndOf(a),
    bStart,
    length: 0,
    bResume: bStart,
    switchAt: 0,
    bRate: [{ at: 0, value: 1 }],
    aGain: [{ at: 0, value: 0 }],
    bGain: [{ at: 0, value: 1 }],
    aLowDb: FLAT_DB,
    bLowDb: FLAT_DB,
    aHighPassHz: HIGH_PASS_OFF,
    reason,
    beats: 0,
  };
}

/**
 * A plain crossfade, with no beat to match (so no beats counted), as long as the listener's fade length:
 * A fades out up to where its sound ends (from its hand-set mix-out point, if it has one), while B fades
 * in from where its sound starts. Neither song's silence is heard. `from`: a skip's, leaving A there.
 */
function fadePlan(pair: Pair, reason: string, from?: number, longest = chosenFade(pair.input)): TransitionPlan {
  const { a, b } = pair;
  const end = soundEndOf(a);
  const aStart = from ?? Math.max(pair.earliestStart, finiteOr(a.cues?.mixOut ?? NaN, end - longest));
  const roomInA = end - aStart;
  // B plays at its own speed and resumes `length` after its start, which mustn't be inside its outro.
  const bStart = soundStartOf(b);
  const roomInB = resumeLimit(b) - bStart;
  if (!(roomInA >= SHORTEST_FADE)) return straightPlan(pair, 'Too close to the end to fade: straight on');
  if (!(roomInB >= SHORTEST_FADE)) return straightPlan(pair, 'B’s outro comes too soon to mix: straight on');
  const length = Math.min(longest, roomInA, roomInB);
  return {
    style: 'fade',
    aStart,
    bStart,
    length,
    bResume: bStart + length,
    switchAt: length / 2,
    bRate: [{ at: 0, value: 1 }],
    aGain: equalPowerCurve(0, length, 'out'),
    bGain: equalPowerCurve(0, length, 'in'),
    aLowDb: FLAT_DB,
    bLowDb: FLAT_DB,
    aHighPassHz: HIGH_PASS_OFF,
    reason,
    beats: 0,
  };
}

/**
 * A long blend: A leaves from a phrase line inside its outro and B's phrase line lands on that same downbeat.
 * B is stretched to A's tempo through the overlap, then eases back to its own over 16 of its bars.
 *
 * Both beats must hold where the songs play together (see beatHolds): B's over the stretch of its intro the
 * overlap covers, A's over the overlap from its phrase line. A leaves from the first phrase line of its outro
 * where its beat holds; a later one when the first's drifts. When no line holds for this length, a shorter
 * blend is tried (it covers fewer phrases), then a quick mix.
 *
 * B mustn't resume inside its own outro: then the ease-back goes (all of it: a shortened ramp would be a
 * second, odd-sounding tempo move; and only for tempos within 3%, as B then snaps to its own tempo), then
 * shorter blends are tried, then a quick mix. Shorter blends rarely rescue that: B's start is picked so the
 * overlap ends near its mix-in point whatever the length, and the ease-back's length doesn't depend on the
 * blend's, so B resumes at about the same place. They help only when phrase rounding falls differently.
 */
function longPlan(pair: Pair, chosenBeats: number, reason: string): TransitionPlan {
  const { a, b, ratio } = pair;
  const beat = beatLength(a);
  let tooShortForB = false;
  const drifts = { a: false, b: false };
  for (const beats of BLEND_BEATS.filter((candidate) => candidate <= chosenBeats)) {
    const overlap = beats * beat;
    const firstLine = firstLineAtOrAfter(a, PHRASE_BEATS, pair.leaveFrom, LINE_SLACK_S);
    if (firstLine + overlap > soundEndOf(a) + EPSILON) continue;

    // B plays `ratio` of its own seconds per second of blend; its intro should end about when the overlap does.
    const overlapInB = overlap * ratio;
    const bStart = Math.max(0, nearestLine(b, PHRASE_BEATS, mixInPoint(b) - overlapInB, Math.max(0, gridLine(b, BAR_BEATS, 0))));
    if (!beatHolds(b, bStart, bStart + overlapInB)) {
      drifts.b = true;
      continue;
    }
    const aStart = steadyLeavingLine(pair, firstLine, overlap);
    if (aStart === undefined) {
      drifts.a = true;
      continue;
    }

    const eased = easedBack(pair, overlap);
    const candidates = [{ ...eased, note: '' }];
    // Without the ease-back B snaps to its own tempo the moment it resumes: fine for a small step, audible beyond.
    if (eased.length > overlap && pair.tempoGap <= SNAP_BACK_GAP + EPSILON) {
      candidates.push({ bRate: steadyRate(ratio, overlap), length: overlap, note: ' (no ease-back)' });
    }
    for (const { bRate, length, note } of candidates) {
      const bResume = bStart + integrate(bRate, 0, length);
      if (bResume > resumeLimit(b) + EPSILON) {
        tooShortForB = true;
        continue;
      }
      const shorter = beats < chosenBeats && (drifts.a || drifts.b);
      const later = aStart > firstLine + EPSILON;
      const steadier = shorter && later ? ' (shorter and later in the outro, where the beat holds)' : shorter ? ' (the beat drifts over a longer one)' : later ? ' (later in the outro, where the beat holds)' : '';
      const blendReason = (beats === chosenBeats ? reason : longReason(pair, beats)) + note + steadier;
      return longBlend(pair, { beats, aStart, bStart, bRate, length, bResume }, blendReason);
    }
  }
  if (drifts.a || drifts.b) {
    const which = drifts.a && drifts.b ? 'Both beats drift where they’d blend' : drifts.a ? 'A’s beat drifts in its outro' : 'B’s beat drifts in its intro';
    return quickPlan(pair, `${which}: quick mix`);
  }
  return quickPlan(
    pair,
    tooShortForB ? 'B’s outro comes too soon for a blend: quick mix' : 'Too close to the end for a blend: quick mix',
  );
}

/**
 * The first phrase line of A, from `firstLine` on, where its beat holds for `overlap` and the overlap ends
 * before its sound does; undefined when there's none.
 */
function steadyLeavingLine(pair: Pair, firstLine: number, overlap: number): number | undefined {
  const { a } = pair;
  const phrase = PHRASE_BEATS * beatLength(a);
  for (let line = firstLine; line + overlap <= soundEndOf(a) + EPSILON; line += phrase) {
    if (beatHolds(a, line, line + overlap)) return line;
  }
  return undefined;
}

/**
 * B's rate through a long blend: matched to A for the overlap, then a straight ramp back to its own tempo
 * and OWN_TEMPO_HOLD at it, together covering 16 of B's own bars as the listener hears them (∫ rate dt =
 * 64 of B's beats), so B resumes on one of its own bar lines. Nothing to ease back from when B already
 * plays at its own speed.
 */
function easedBack({ b, ratio }: Pair, overlap: number): { bRate: Automation; length: number } {
  if (Math.abs(ratio - 1) < EPSILON) return { bRate: [{ at: 0, value: ratio }], length: overlap };
  // The ramp plays (ratio + 1) / 2 of B's seconds per second; the hold plays one per second.
  const ramp = (2 * (EASE_BACK_BEATS * beatLength(b) - OWN_TEMPO_HOLD)) / (ratio + 1);
  return {
    bRate: [
      { at: 0, value: ratio },
      { at: overlap, value: ratio },
      { at: overlap + ramp, value: 1 },
      { at: overlap + ramp + OWN_TEMPO_HOLD, value: 1 },
    ],
    length: overlap + ramp + OWN_TEMPO_HOLD,
  };
}

/**
 * B held at `rate` for a transition of `length`, then back to its own speed over OWN_TEMPO_RAMP and held
 * there for the last OWN_TEMPO_HOLD (see both). That's a tempo change of at most 3%, in the last 0.3 s,
 * while A is fading out: when the ramp starts, a quick mix's A is down about 6 dB at 124 BPM (only about
 * 2 dB at 174, where its two-beat crossfade is shorter), a long blend's more than 12 dB. It leaves B up to
 * 6 ms off A's beat by the end, and resumes B as far off its bar line (see `ownTempoOvershoot`).
 */
function steadyRate(rate: number, length: number): Automation {
  if (Math.abs(rate - 1) < EPSILON) return [{ at: 0, value: rate }];
  const backToOwn = Math.max(0, length - OWN_TEMPO_HOLD);
  return [
    { at: 0, value: rate },
    { at: Math.max(0, backToOwn - OWN_TEMPO_RAMP), value: rate },
    { at: backToOwn, value: 1 },
  ];
}

/** How much further into B a `steadyRate` transition ends than one at `rate` throughout (negative when faster). */
const ownTempoOvershoot = (rate: number) => (OWN_TEMPO_RAMP / 2 + OWN_TEMPO_HOLD) * (1 - rate);

function longBlend(
  pair: Pair,
  shape: { beats: number; aStart: number; bStart: number; bRate: Automation; length: number; bResume: number },
  reason: string,
): TransitionPlan {
  const beat = beatLength(pair.a);
  const overlap = shape.beats * beat;
  // aStart is a downbeat of A, so A's bar lines fall on whole bars of transition time.
  const bar = BAR_BEATS * beat;
  const bassSwap = Math.round(overlap / 2 / bar) * bar;
  // A crossfade on top of the beatmatch: B comes up over the first half, its bass cut, and A goes down
  // over the second, its bass cut, with the bass swapped where they meet.
  return {
    style: 'long',
    ...shape,
    switchAt: bassSwap,
    aGain: [{ at: 0, value: 1 }, ...equalPowerCurve(bassSwap, overlap, 'out')],
    bGain: equalPowerCurve(0, bassSwap, 'in'),
    // The swap is a quick move over the beat leading into the bar line, done by the downbeat.
    aLowDb: [
      { at: 0, value: 0 },
      { at: bassSwap - beat, value: 0 },
      { at: bassSwap, value: BASS_CUT_DB },
    ],
    bLowDb: [
      { at: 0, value: BASS_CUT_DB },
      { at: bassSwap - beat, value: BASS_CUT_DB },
      { at: bassSwap, value: 0 },
    ],
    aHighPassHz: HIGH_PASS_OFF,
    reason,
  };
}

/**
 * A quick mix: a high-pass sweep over A for 4–8 beats up to a landing downbeat of A (a phrase line inside the
 * outro when one fits), where one of B's downbeats lands (a phrase line when one is near its mix-in point).
 *
 * - Tempos within 2%: B is stretched to A, so both can be heard together: a crossfade over the last two
 *   beats, finishing on the landing.
 * - Further apart, B plays at its own speed and its beats would flam against A's, so it's a cut: B is silent
 *   until the landing, then jumps in within 20 ms; A rings on for one beat, filtered of its kick, fading out.
 *
 * When B's bar starts are unsure, B lands on its beat nearest the mix-in point instead (A's side: see
 * quickPlacement).
 */
function quickPlan(pair: Pair, reason: string, place = quickPlacement): TransitionPlan {
  const { a, b } = pair;
  if (!hasUsableTempo(a) || !hasUsableTempo(b)) return straightPlan(pair, 'No usable beat: straight on');
  const stretched = pair.tempoGap <= QUICK_MIX_STRETCH_GAP + EPSILON;
  const tailBeats = stretched ? 0 : CUT_TAIL_BEATS;
  const placement = place(pair, tailBeats);
  if (!placement) return straightPlan(pair, 'Too close to the end to mix: straight on');

  const { aStart, beats } = placement;
  const beat = beatLength(a);
  const landingAt = beats * beat;
  const rate = stretched ? pair.ratio : 1;
  const leadInB = landingAt * rate;

  const tailInB = tailBeats * beat * rate;
  // Back at its own speed for the last moment, a slowed-down B ends a little past its landing.
  const holdOvershoot = Math.max(0, ownTempoOvershoot(rate));
  // B must have played `leadInB` seconds by the landing, so the landing can't come before that; and the
  // transition must end (B resumes) no later than B's own outro, where the next mix will begin.
  const latestLanding = resumeLimit(b) - tailInB - holdOvershoot;
  const target = mixInPoint(b);
  // Unsure bars: every beat is a "bar line" (and a phrase line) as far as the landing goes.
  const bar = pair.bBarsSure ? BAR_BEATS : 1;
  const phraseLanding = nearestLine(b, pair.bBarsSure ? PHRASE_BEATS : 1, target, leadInB);
  let landing =
    Math.abs(phraseLanding - target) <= (PHRASE_BEATS / 2) * beatLength(b)
      ? phraseLanding
      : nearestLine(b, bar, target, leadInB);
  if (landing > latestLanding + EPSILON) {
    const earlier = lastLineAtOrBefore(b, bar, latestLanding);
    if (earlier === undefined || earlier < leadInB - EPSILON) {
      return straightPlan(pair, 'B’s outro comes too soon to mix: straight on');
    }
    landing = earlier;
  }
  if (!(landing < soundEndOf(b))) return straightPlan(pair, 'B is too short to mix into: straight on');

  // B's beats meet A's through the lead-in; only the last 0.3 s, getting back to B's own speed, drifts (≤ 4 ms).
  const bStart = Math.max(0, landing - leadInB);
  const length = landingAt + tailBeats * beat;
  const bRate = steadyRate(rate, length);
  const common = {
    style: 'quick' as const,
    aStart,
    bStart,
    length,
    bResume: bStart + integrate(bRate, 0, length),
    bRate,
    aLowDb: FLAT_DB,
    bLowDb: FLAT_DB,
    aHighPassHz: highPassSweep(0, landingAt),
    reason,
    beats,
  };
  if (stretched) {
    const crossfade = landingAt - QUICK_CROSSFADE_BEATS * beat;
    return {
      ...common,
      switchAt: crossfade,
      aGain: [{ at: 0, value: 1 }, ...equalPowerCurve(crossfade, landingAt, 'out')],
      bGain: [{ at: 0, value: 0 }, ...equalPowerCurve(crossfade, landingAt, 'in')],
    };
  }
  return {
    ...common,
    switchAt: landingAt,
    aGain: [{ at: 0, value: 1 }, ...equalPowerCurve(landingAt, length, 'out')],
    bGain: [
      { at: 0, value: 0 },
      { at: landingAt, value: 0 },
      { at: landingAt + CUT_SECONDS, value: 1 },
    ],
  };
}

/**
 * Where a quick mix's lead-in starts, and how many beats it lasts before the landing (the transition then
 * runs `tailBeats` more). In order of preference:
 * 1. landing on a phrase line, leaving A no earlier than its outro (or mix-out cue) and its position + 5 s;
 * 2. landing on the next downbeat that allows the same;
 * 3. only without a mix-out cue: landing on A's last phrase line that fits, leaving at most a phrase before
 *    the detected outro (a hand-set cue is never overruled).
 * When A's bar starts are unsure, beats stand in for phrase lines and downbeats: A leaves on its first beat
 * that allows the above.
 */
function quickPlacement(pair: Pair, tailBeats: number): { aStart: number; beats: number } | undefined {
  const { a, leaveFrom, earliestStart } = pair;
  const beat = beatLength(a);
  const phrase = pair.aBarsSure ? PHRASE_BEATS : 1;
  const bar = pair.aBarsSure ? BAR_BEATS : 1;
  const latestLanding = soundEndOf(a) - tailBeats * beat;
  for (const beats of QUICK_MIX_BEATS) {
    const lead = beats * beat;
    const landing = firstLineAtOrAfter(a, phrase, leaveFrom + lead, LINE_SLACK_S);
    if (landing <= latestLanding + EPSILON) return { aStart: landing - lead, beats };
  }
  const downbeat = firstLineAtOrAfter(a, bar, leaveFrom, LINE_SLACK_S);
  for (const beats of QUICK_MIX_BEATS) {
    if (downbeat + beats * beat <= latestLanding + EPSILON) return { aStart: downbeat, beats };
  }
  if (a.cues?.mixOut !== undefined) return undefined;
  const earliest = Math.max(earliestStart, finiteOr(a.outroStart, soundEndOf(a)) - PHRASE_BEATS * beat, 0);
  const landing = lastLineAtOrBefore(a, phrase, latestLanding);
  if (landing === undefined) return undefined;
  for (const beats of QUICK_MIX_BEATS) {
    const aStart = landing - beats * beat;
    if (aStart >= earliest - EPSILON) return { aStart, beats };
  }
  return undefined;
}

// ——— Skips ———

/**
 * The plan when the listener skipped: leave A as soon as possible from `at`, mid-song if need be. A's
 * outro and mix-out cue, the keys and the same-album rule don't count (the listener asked to move on);
 * "No mixing" still does, and B is brought in as in any quick mix, never resuming inside its outro.
 *
 * - Both beats sure enough to cut on: a quick mix (see skipPlacement for where A leaves).
 * - Otherwise a SKIP_FADE crossfade from `at`, or straight on when B starts abruptly (fading into a cold
 *   start sounds like a mistake) or there's no room for even that.
 *
 * Every straight plan here leaves A at `at` (not at its end, as a planned straight cut does), except when
 * `at` isn't a number at all. `at` is kept within A.
 */
function skipPlan(pair: Pair, requested: number): TransitionPlan {
  const { a, b, input } = pair;
  // No time to leave at is a caller's bug: guessing one could cut A anywhere, so A plays on.
  if (!Number.isFinite(requested)) return straightPlan(pair, 'Skipped, but with no time to leave at: straight on');
  const at = Math.min(Math.max(0, requested), durationOf(a));
  const leavingAt = (plan: TransitionPlan): TransitionPlan => (plan.style === 'straight' ? { ...plan, aStart: at } : plan);
  if (input.mode === 'off') return leavingAt(straightPlan(pair, 'Skipped, no mixing: straight on'));

  const sureBeat = (song: Song) => hasUsableTempo(song) && song.beatConfidence >= QUICK_MIX_CONFIDENCE;
  if (!sureBeat(a) || !sureBeat(b)) {
    if (b.coldStart) return leavingAt(straightPlan(pair, 'Skipped, no sure beat and an abrupt start: straight on'));
    const fade = fadePlan(pair, 'Skipped, no sure beat: crossfade', at, SKIP_FADE);
    return leavingAt(fade.style === 'straight' ? { ...fade, reason: `Skipped; ${fade.reason}` } : fade);
  }
  const plan = quickPlan(pair, 'Skipped: quick mix', (p, tailBeats) => skipPlacement(p, tailBeats, at));
  return leavingAt(plan.style === 'straight' ? { ...plan, reason: `Skipped; ${plan.reason}` } : plan);
}

/**
 * Where a skip's quick mix starts and how many beats its lead-in lasts. The landing is a bar line of A
 * (a beat, when A's bar starts are unsure) with the whole lead-in at or after `at`: 4 beats, or 2 when
 * that lands a bar sooner. So the cut comes under 6 beats after `at` (under 5 on beats), not up to a
 * phrase later. Undefined when A ends first.
 */
function skipPlacement(pair: Pair, tailBeats: number, at: number): { aStart: number; beats: number } | undefined {
  const { a } = pair;
  const beat = beatLength(a);
  const line = pair.aBarsSure ? BAR_BEATS : 1;
  let best: { aStart: number; beats: number; landing: number } | undefined;
  for (const beats of SKIP_LEAD_BEATS) {
    const landing = firstLineAtOrAfter(a, line, at + beats * beat);
    // A shorter lead-in only for an earlier landing: on beats, a 4-beat lead-in is never more than a beat away.
    const sooner = best === undefined || (pair.aBarsSure && landing < best.landing - EPSILON);
    if (sooner) best = { aStart: landing - beats * beat, beats, landing };
  }
  if (!best || !(best.landing <= soundEndOf(a) - tailBeats * beat + EPSILON)) return undefined;
  return { aStart: best.aStart, beats: best.beats };
}
