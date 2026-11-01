import { integrate } from './automation.ts';
import { isCamelot, keysCompatible } from './camelot.ts';
import type { Automation, Camelot, CuePoints, MixMap, MixMode, TransitionPlan } from './types.ts';

// The planner decides how song A hands over to song B: which style, where in each song,
// how fast B plays, and the gain and EQ moves. It is pure and deterministic so the server
// (which renders the transition file) and the desktop live mixer always agree on a plan.

export interface PlanInput {
  a: MixMap & { cues?: CuePoints };
  b: MixMap & { cues?: CuePoints };
  mode: MixMode;
  /** B follows A on the same album, in order (decided by the caller from the tracks). */
  sameAlbumInOrder: boolean;
  /** Where A's playback is now (a plan never starts in the past). */
  aPosition?: number;
}

type Song = PlanInput['a'];

/** Below this a beat grid is a guess: don't beatmatch, at most crossfade. */
const STEADY_BEAT_CONFIDENCE = 0.35;
/** A quick mix cuts on a downbeat, so it needs a grid we mostly trust. */
const QUICK_MIX_CONFIDENCE = 0.5;
/** Stretching B more than this is audible: beyond it, no long blend. */
const LARGEST_TEMPO_GAP = 0.08;
/** A quick mix only stretches B when the tempos are this close (otherwise it cuts unstretched). */
const QUICK_MIX_STRETCH_GAP = 0.02;
/** Keys detected with less confidence than this don't count against a blend. */
const KEY_CONFIDENCE = 0.3;
/** Long blend lengths in A's beats, longest first. */
const BLEND_BEATS = [64, 32, 16];
/** Auto keeps blends to 32 beats unless both songs have this much room (party always takes the longest that fits). */
const ROOM_FOR_AUTO_64_BEATS = 128;
/** After a long blend, B eases back to its own tempo over 16 bars. */
const EASE_BACK_BEATS = 64;
/** Quick mix lengths in A's beats, preferred first. */
const QUICK_MIX_BEATS = [8, 4];
/** A quick mix crossfades over its last two beats. */
const QUICK_CUT_BEATS = 2;
const LONGEST_FADE = 8;
/** A fade shorter than this is pointless: go straight on. */
const SHORTEST_FADE = 1;
/** A plan starts at least this far ahead of A's position, so there's time to render and load it. */
const PLANNING_LEAD = 5;
/** The last-resort quick mix needs less notice. */
const LAST_RESORT_LEAD = 2;
const BASS_CUT_DB = -24;
const HIGH_PASS_OFF_HZ = 20;
const HIGH_PASS_SWEEP_HZ = 800;
/** Points used to draw an equal-power or exponential curve with straight lines. */
const CURVE_POINTS = 8;
const PHRASE_BEATS = 16;
const BAR_BEATS = 4;
/** Slack for comparing times that went through floating-point arithmetic. */
const EPSILON = 1e-9;

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

/** Time of grid line `index` counted from the first downbeat; lines are `beatsPerLine` apart (4: bars, 16: phrases). */
function gridLine(song: MixMap, beatsPerLine: number, index: number): number {
  return song.firstBeat + (song.downbeatOffset + index * beatsPerLine) * beatLength(song);
}

/** Position of time t on the grid, in lines from the first downbeat (whole numbers fall on a line). */
function linesAt(song: MixMap, beatsPerLine: number, t: number): number {
  return (t - gridLine(song, beatsPerLine, 0)) / (beatsPerLine * beatLength(song));
}

function firstLineAtOrAfter(song: MixMap, beatsPerLine: number, t: number): number {
  const index = Math.max(0, Math.ceil(linesAt(song, beatsPerLine, t) - EPSILON));
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

/**
 * A phrase line of A for a transition: the first at or after `preferFrom` (inside the outro) if it is
 * no later than `latest`; otherwise the last one before `latest`, as long as it isn't before `earliest`.
 */
function phraseLine(
  song: MixMap,
  { preferFrom, latest, earliest }: { preferFrom: number; latest: number; earliest: number },
): number | undefined {
  const inside = firstLineAtOrAfter(song, PHRASE_BEATS, preferFrom);
  if (inside <= latest + EPSILON) return inside;
  const before = lastLineAtOrBefore(song, PHRASE_BEATS, latest);
  return before !== undefined && before >= earliest - EPSILON ? before : undefined;
}

/** Where A can be left: the hand-set mix-out point, else the detected outro. */
const mixOutPoint = (a: Song) => a.cues?.mixOut ?? a.outroStart;
/** Where B is fully in: the hand-set mix-in point, else the end of the detected intro. */
const mixInPoint = (b: Song) => b.cues?.mixIn ?? b.introEnd;

// ——— Choosing the style ———

/** What the style rules need to know about the two songs. */
interface Pair {
  input: PlanInput;
  a: Song;
  b: Song;
  /** B's rate while matched to A (see tempoRatio). */
  ratio: number;
  /** How far apart the tempos are, as a fraction (0.03 = 3%). */
  tempoGap: number;
  /** The tempos only match at half or double time. */
  halfTime: boolean;
  /** The earliest A may start the transition. */
  earliestStart: number;
  /** Room for a blend in A's outro and B's intro, both counted in A's beats (the blend's beats). */
  outroRoomBeats: number;
  introRoomBeats: number;
  keys: { kind: 'compatible' } | { kind: 'unknown' } | { kind: 'clash'; a: Camelot; b: Camelot };
}

function describePair(input: PlanInput): Pair {
  const { a, b, aPosition } = input;
  const ratio = tempoRatio(a.bpm, b.bpm);
  const earliestStart = aPosition === undefined ? 0 : aPosition + PLANNING_LEAD;
  const outroRoom = a.soundEnd - Math.max(mixOutPoint(a), earliestStart);
  // B can start no earlier than its first downbeat; its seconds pass `ratio` times faster than the blend's.
  const introRoomInB = mixInPoint(b) - gridLine(b, BAR_BEATS, 0);
  return {
    input,
    a,
    b,
    ratio,
    tempoGap: Math.abs(ratio - 1),
    halfTime: Math.abs(ratio - a.bpm / b.bpm) > EPSILON,
    earliestStart,
    outroRoomBeats: outroRoom / beatLength(a),
    introRoomBeats: introRoomInB / ratio / beatLength(a),
    keys: keyRelation(a, b),
  };
}

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

/** The style rules in order: the first that has something to say decides. The last always does. */
const STYLE_RULES: ((pair: Pair) => Decision | undefined)[] = [
  function noMixingWanted({ input }) {
    if (input.mode === 'off') return { style: 'straight', reason: 'No mixing: straight on' };
    if (input.sameAlbumInOrder) return { style: 'straight', reason: 'Same album, in order: straight on' };
    return undefined;
  },
  function noSteadyBeat({ a, b }) {
    if (a.beatConfidence >= STEADY_BEAT_CONFIDENCE && b.beatConfidence >= STEADY_BEAT_CONFIDENCE) return undefined;
    // Fading into or out of an abrupt edge sounds like a mistake; better to play them back to back.
    if (a.coldEnd || b.coldStart) return { style: 'straight', reason: 'No steady beat and an abrupt edge: straight on' };
    return { style: 'fade', reason: 'No steady beat: crossfade' };
  },
  function abruptJoinAtDifferentTempos({ a, b, tempoGap }) {
    if (a.coldEnd && b.coldStart && tempoGap > LARGEST_TEMPO_GAP) {
      return { style: 'straight', reason: 'Abrupt end into abrupt start at different tempos: straight on' };
    }
    return undefined;
  },
  function temposTooFarApart(pair) {
    if (pair.tempoGap <= LARGEST_TEMPO_GAP) return undefined;
    const sureOfBothBeats = Math.min(pair.a.beatConfidence, pair.b.beatConfidence) >= QUICK_MIX_CONFIDENCE;
    return sureOfBothBeats
      ? { style: 'quick', reason: `${tempoText(pair)}: quick mix` }
      : { style: 'fade', reason: `${tempoText(pair)} and an unsure beat: crossfade` };
  },
  function longBlendOrQuickMix(pair) {
    if (!pair.a.gridStable || !pair.b.gridStable) return { style: 'quick', reason: 'Beat drifts: quick mix' };
    if (pair.keys.kind === 'clash') {
      return { style: 'quick', reason: `Keys clash (${pair.keys.a}, ${pair.keys.b}): quick mix` };
    }
    const beats = blendBeats(pair);
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
  return Math.min(longest, room >= ROOM_FOR_AUTO_64_BEATS ? 64 : 32);
}

function tempoText({ tempoGap, halfTime }: Pair): string {
  const percent = Math.round(tempoGap * 100);
  if (halfTime) return percent === 0 ? 'Half-time tempos' : `Tempos ${percent}% apart at half time`;
  return percent === 0 ? 'Same tempo' : `Tempos ${percent}% apart`;
}

function longReason(pair: Pair, beats: number): string {
  const keys = pair.keys.kind === 'compatible' ? 'keys compatible' : 'key unknown';
  return `${tempoText(pair)}, ${keys}: ${beats}-beat blend`;
}

// ——— The plans ———

/** Straight lines through an equal-power curve (sin/cos), so the loudness holds steady through a crossfade. */
function equalPowerCurve(from: number, to: number, direction: 'in' | 'out'): Automation {
  return sampleCurve(from, to, (progress) =>
    direction === 'in' ? Math.sin((progress * Math.PI) / 2) : Math.cos((progress * Math.PI) / 2),
  );
}

/** CURVE_POINTS points of `shape` (progress 0–1 → value) from `from` to `to`, with exact ends. */
function sampleCurve(from: number, to: number, shape: (progress: number) => number): Automation {
  const points: Automation = [];
  for (let i = 0; i < CURVE_POINTS; i++) {
    const progress = i / (CURVE_POINTS - 1);
    const value = shape(progress);
    // sin/cos/pow land a hair off 0 and 1 at the ends: snap them so "fully in" and "silent" are exact.
    const snapped = Math.abs(value - Math.round(value)) < EPSILON ? Math.round(value) : value;
    points.push({ at: from + (to - from) * progress, value: snapped });
  }
  return points;
}

function straightPlan({ a }: Pair, reason: string): TransitionPlan {
  return {
    style: 'straight',
    aStart: a.duration,
    bStart: 0,
    length: 0,
    bResume: 0,
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

/** Today's crossfade, from where A's outro begins: no beat to match, so no beats counted. */
function fadePlan(pair: Pair, reason: string): TransitionPlan {
  const { a } = pair;
  const aStart = Math.max(mixOutPoint(a), pair.earliestStart);
  const length = Math.min(LONGEST_FADE, a.soundEnd - aStart);
  if (length < SHORTEST_FADE) return straightPlan(pair, 'Too close to the end to fade: straight on');
  return {
    style: 'fade',
    aStart,
    bStart: 0,
    length,
    bResume: length,
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
 * A long blend: A leaves from a phrase line in its outro and B's phrase line lands on that same downbeat.
 * B is stretched to A's tempo through the overlap, then eases back to its own over 16 bars.
 * If A's position leaves no phrase line for the chosen length, shorter blends are tried, then a quick mix.
 */
function longPlan(pair: Pair, chosenBeats: number, reason: string): TransitionPlan {
  const { a, b, ratio, earliestStart } = pair;
  const beat = beatLength(a);
  for (const beats of BLEND_BEATS.filter((candidate) => candidate <= chosenBeats)) {
    const overlap = beats * beat;
    const aStart = phraseLine(a, {
      preferFrom: Math.max(mixOutPoint(a), earliestStart),
      latest: a.soundEnd - overlap,
      earliest: earliestStart,
    });
    if (aStart === undefined) continue;

    // B plays `ratio` of its own seconds per second of blend; its intro should end about when the overlap does.
    const overlapInB = overlap * ratio;
    const bStart = nearestLine(b, PHRASE_BEATS, mixInPoint(b) - overlapInB, gridLine(b, BAR_BEATS, 0));

    const easeBack = Math.abs(ratio - 1) < EPSILON ? 0 : EASE_BACK_BEATS * beat;
    const bRate: Automation =
      easeBack === 0
        ? [{ at: 0, value: ratio }]
        : [
            { at: 0, value: ratio },
            { at: overlap, value: ratio },
            { at: overlap + easeBack, value: 1 },
          ];
    const length = overlap + easeBack;

    // aStart is a downbeat of A, so A's bar lines fall on whole bars of transition time.
    const bar = BAR_BEATS * beat;
    const bassSwap = Math.round(overlap / 2 / bar) * bar;
    return {
      style: 'long',
      aStart,
      bStart,
      length,
      bResume: bStart + integrate(bRate, 0, length),
      switchAt: bassSwap,
      bRate,
      aGain: [{ at: 0, value: 1 }, ...equalPowerCurve(overlap * 0.75, overlap, 'out')],
      bGain: equalPowerCurve(0, overlap * 0.25, 'in'),
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
      reason: beats === chosenBeats ? reason : longReason(pair, beats),
      beats,
    };
  }
  return quickPlan(pair, 'Too close to the end for a blend: quick mix');
}

/**
 * A quick mix: a high-pass sweep over A, then a cut to B over the last two beats. The cut finishes on a
 * phrase line of A, and B is lined up so that one of its downbeats (a phrase line when one is near its
 * mix-in point) lands exactly there, where B is fully in. B is stretched only when the tempos are within
 * 2%; otherwise it plays at its own speed and only the landing downbeat is matched.
 */
function quickPlan(pair: Pair, reason: string): TransitionPlan {
  const { a, b, ratio } = pair;
  const placement = quickPlacement(pair);
  if (!placement) return straightPlan(pair, 'Too close to the end to mix: straight on');
  const { aStart, beats } = placement;
  const beat = beatLength(a);
  const overlap = beats * beat;
  const rate = pair.tempoGap <= QUICK_MIX_STRETCH_GAP ? ratio : 1;
  const overlapInB = overlap * rate;

  // B must have played `overlapInB` seconds by the landing, so the landing can't come before that.
  const target = mixInPoint(b);
  const phraseLanding = nearestLine(b, PHRASE_BEATS, target, overlapInB);
  const landing =
    Math.abs(phraseLanding - target) <= (PHRASE_BEATS / 2) * beatLength(b)
      ? phraseLanding
      : nearestLine(b, BAR_BEATS, target, overlapInB);
  const bStart = landing - overlapInB;
  const bRate: Automation = [{ at: 0, value: rate }];

  const cut = overlap - QUICK_CUT_BEATS * beat;
  return {
    style: 'quick',
    aStart,
    bStart,
    length: overlap,
    bResume: bStart + integrate(bRate, 0, overlap),
    switchAt: cut,
    bRate,
    aGain: [{ at: 0, value: 1 }, ...equalPowerCurve(cut, overlap, 'out')],
    bGain: [{ at: 0, value: 0 }, ...equalPowerCurve(cut, overlap, 'in')],
    aLowDb: FLAT_DB,
    bLowDb: FLAT_DB,
    // Exponential, so the sweep sounds even: each step raises the cutoff by the same musical interval.
    aHighPassHz: sampleCurve(0, overlap, (progress) => HIGH_PASS_OFF_HZ * (HIGH_PASS_SWEEP_HZ / HIGH_PASS_OFF_HZ) ** progress),
    reason,
    beats,
  };
}

/**
 * Where a quick mix goes: ending on a phrase line of A (inside the outro when it fits), else, as a last
 * resort when A's position is too late for that, from the next downbeat at least 2 s ahead of it.
 */
function quickPlacement({ input, a, earliestStart }: Pair): { aStart: number; beats: number } | undefined {
  const beat = beatLength(a);
  for (const beats of QUICK_MIX_BEATS) {
    const overlap = beats * beat;
    const end = phraseLine(a, {
      preferFrom: Math.max(mixOutPoint(a), earliestStart) + overlap,
      latest: a.soundEnd,
      earliest: earliestStart + overlap,
    });
    if (end !== undefined) return { aStart: end - overlap, beats };
  }
  const from = input.aPosition === undefined ? mixOutPoint(a) : input.aPosition + LAST_RESORT_LEAD;
  const aStart = firstLineAtOrAfter(a, BAR_BEATS, from);
  const beats = QUICK_MIX_BEATS.find((candidate) => aStart + candidate * beat <= a.duration);
  return beats === undefined ? undefined : { aStart, beats };
}
