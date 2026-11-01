import { camelotDistance, isCamelot, keysCompatible } from './camelot.ts';
import { KEY_CONFIDENCE, LARGEST_TEMPO_GAP, STEADY_BEAT_CONFIDENCE, tempoRatio } from './plan.ts';
import type { Camelot, MixMap } from './types.ts';

// How well one song would blend into another, for ordering mixes and picking radio songs: close
// tempos (a long beatmatched blend is possible), keys that don't clash and no jump in energy.
// Whatever isn't known about a song (no beat, an unsure key, unmeasured energy) counts as
// "fine, not a match": it neither jumps the queue nor sinks to the end.

/** What blending needs to know about a song: from its mix map, plus its overall energy (0–1) if known. */
export type Blendable = Pick<MixMap, 'bpm' | 'key' | 'beatConfidence'> & { energy?: number };

/** Each part's score when it can't be judged: as good as a pair at the edge of blending well. */
const NEUTRAL = 0.8;
/** Within the planner's limit the tempos blend; at the limit (the most stretch) they score NEUTRAL. */
const AT_TEMPO_LIMIT = NEUTRAL;
/** Past the planner's limit only a quick mix or a fade is left: the score halves every 3% further apart. */
const TEMPO_HALVING_GAP = 0.03;
/** Tempos far apart still score something, so key and energy can choose between such pairs. */
const FARTHEST_TEMPO = 0.1;
/** A beat is fully trusted from this confidence; between the planner's threshold and here, partly. */
const SURE_BEAT_CONFIDENCE = 0.6;
/** Keys two steps apart on the wheel are bearable; further apart they clash. */
const TWO_STEPS_KEY = 0.8;
const CLASHING_KEY = 0.6;
/** A key is fully trusted from this confidence; between the planner's threshold and here, partly. */
const SURE_KEY_CONFIDENCE = 0.6;
/** Energy steps cost what they are; from still to intense is as bad as it gets. */
const LARGEST_ENERGY_JUMP = 0.4;

/** How well `a` blends into `b`, 0–1 (1: the same tempo, a compatible key and the same energy). Symmetric. */
export function blendScore(a: Blendable, b: Blendable): number {
  return tempoCloseness(a, b) * keyCompatibility(a, b) * energyContinuity(a, b);
}

function tempoCloseness(a: Blendable, b: Blendable): number {
  if (!hasTempo(a) || !hasTempo(b)) return NEUTRAL;
  const certainty = ramp(Math.min(a.beatConfidence, b.beatConfidence), STEADY_BEAT_CONFIDENCE, SURE_BEAT_CONFIDENCE);
  if (certainty === 0) return NEUTRAL;
  // The planner stretches B to A; taking the larger gap of either way round keeps the score symmetric
  // (reversing a stretch of a mix mustn't change how well it blends) and never kinder than the planner.
  const ratio = tempoRatio(a.bpm, b.bpm);
  const gap = Math.max(Math.abs(ratio - 1), Math.abs(1 / ratio - 1));
  const closeness =
    gap <= LARGEST_TEMPO_GAP
      ? 1 - (1 - AT_TEMPO_LIMIT) * (gap / LARGEST_TEMPO_GAP) ** 2
      : Math.max(FARTHEST_TEMPO, AT_TEMPO_LIMIT * 0.5 ** ((gap - LARGEST_TEMPO_GAP) / TEMPO_HALVING_GAP));
  return NEUTRAL + (closeness - NEUTRAL) * certainty;
}

function keyCompatibility(a: Blendable, b: Blendable): number {
  const first = keyOf(a);
  const second = keyOf(b);
  if (!first || !second) return NEUTRAL;
  const certainty = ramp(Math.min(first.confidence, second.confidence), KEY_CONFIDENCE, SURE_KEY_CONFIDENCE);
  const match = keysCompatible(first.camelot, second.camelot)
    ? 1
    : camelotDistance(first.camelot, second.camelot) === 2
      ? TWO_STEPS_KEY
      : CLASHING_KEY;
  return NEUTRAL + (match - NEUTRAL) * certainty;
}

function energyContinuity(a: Blendable, b: Blendable): number {
  if (!isEnergy(a.energy) || !isEnergy(b.energy)) return NEUTRAL;
  return Math.max(LARGEST_ENERGY_JUMP, 1 - Math.abs(a.energy - b.energy));
}

const hasTempo = (song: Blendable) => Number.isFinite(song.bpm) && song.bpm > 0 && Number.isFinite(song.beatConfidence);

/** A key worth weighing: a real Camelot code detected with at least the planner's confidence. */
function keyOf(song: Blendable): { camelot: Camelot; confidence: number } | undefined {
  const key = song.key;
  return key && isCamelot(key.camelot) && key.confidence >= KEY_CONFIDENCE ? key : undefined;
}

const isEnergy = (energy: number | undefined): energy is number => energy !== undefined && Number.isFinite(energy);

/** 0 below `from`, 1 from `to`, straight in between. */
function ramp(value: number, from: number, to: number): number {
  return Math.min(1, Math.max(0, (value - from) / (to - from)));
}
