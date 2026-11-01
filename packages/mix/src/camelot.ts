import type { Camelot } from './types.ts';

// The Camelot wheel lays the 24 keys out so that neighbours mix well: one step round the
// wheel (same letter) is a fifth away, and the same number with the other letter is the
// relative major or minor. DJs treat anything within one such step as compatible.

const CAMELOT_PATTERN = /^(1[0-2]|[1-9])([AB])$/;

/** Whether a string is a Camelot code such as "8A" (1–12, then A for minor or B for major). */
export function isCamelot(code: string): code is Camelot {
  return CAMELOT_PATTERN.test(code);
}

function parse(code: Camelot): { number: number; letter: string } {
  const match = CAMELOT_PATTERN.exec(code);
  if (!match) throw new RangeError(`Not a Camelot code: ${code}`);
  return { number: Number(match[1]), letter: match[2]! };
}

/**
 * Steps between two keys on the Camelot wheel: 0 for the same key, 1 for a neighbour
 * (±1 with the same letter, 12 wrapping to 1, or the same number with the other letter),
 * more the further apart they are. Switching letter counts as one step.
 */
export function camelotDistance(a: Camelot, b: Camelot): number {
  const first = parse(a);
  const second = parse(b);
  const apart = Math.abs(first.number - second.number);
  const roundTheWheel = Math.min(apart, 12 - apart);
  return roundTheWheel + (first.letter === second.letter ? 0 : 1);
}

/** Keys a DJ would blend without a clash: the same key or a neighbour on the wheel. */
export function keysCompatible(a: Camelot, b: Camelot): boolean {
  return camelotDistance(a, b) <= 1;
}

/**
 * The Camelot code of a key, given its tonic as a pitch class (0 = C, 1 = C♯ … 11 = B) and whether
 * it is minor. Going up a fifth (7 semitones) is one step clockwise, and C major sits at 8B; a minor
 * key shares its number with its relative major, three semitones up (A minor = C major's 8, so 8A).
 */
export function toCamelot(pitchClass: number, minor: boolean): Camelot {
  if (!Number.isInteger(pitchClass) || pitchClass < 0 || pitchClass > 11) {
    throw new RangeError(`Not a pitch class (0–11): ${pitchClass}`);
  }
  const majorTonic = minor ? (pitchClass + 3) % 12 : pitchClass;
  const fifthsFromC = (majorTonic * 7) % 12;
  const number = ((fifthsFromC + 7) % 12) + 1; // C (0 fifths) lands on 8
  return `${number}${minor ? 'A' : 'B'}`;
}
