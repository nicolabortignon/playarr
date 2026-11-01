import { describe, expect, it } from 'vitest';
import { camelotDistance, isCamelot, keysCompatible, toCamelot } from './camelot.ts';
import type { Camelot } from './types.ts';

describe('camelotDistance', () => {
  it.each<[Camelot, Camelot, number]>([
    ['8A', '8A', 0],
    ['8A', '9A', 1],
    ['9A', '8A', 1],
    ['12A', '1A', 1], // the wheel wraps
    ['1B', '12B', 1],
    ['8A', '8B', 1], // relative major / minor
    ['8A', '9B', 2],
    ['8A', '10A', 2],
    ['8A', '3A', 5],
    ['8A', '2A', 6],
    ['1B', '12A', 2],
  ])('%s to %s is %i', (a, b, distance) => {
    expect(camelotDistance(a, b)).toBe(distance);
  });

  it('refuses something that is not a Camelot code', () => {
    expect(() => camelotDistance('13A' as Camelot, '8A')).toThrow(RangeError);
    expect(() => camelotDistance('8A', '0B' as Camelot)).toThrow(RangeError);
  });
});

describe('keysCompatible', () => {
  it.each<[Camelot, Camelot, boolean]>([
    ['8A', '8A', true],
    ['8A', '7A', true],
    ['8A', '8B', true],
    ['8A', '7B', false],
    ['8A', '3B', false],
  ])('%s with %s: %s', (a, b, compatible) => {
    expect(keysCompatible(a, b)).toBe(compatible);
  });
});

describe('isCamelot', () => {
  it.each([
    ['1A', true],
    ['12B', true],
    ['0A', false],
    ['13B', false],
    ['8C', false],
    ['08A', false],
    ['', false],
  ])('%s: %s', (code, valid) => {
    expect(isCamelot(code)).toBe(valid);
  });
});

describe('toCamelot', () => {
  // The standard Camelot wheel (Mixed In Key), written out by hand rather than computed, so the
  // test checks the formula against the published chart. Pitch classes count semitones from C.
  const wheel: [pitchClass: number, name: string, major: Camelot, minor: Camelot][] = [
    [0, 'C', '8B', '5A'],
    [1, 'C#/Db', '3B', '12A'],
    [2, 'D', '10B', '7A'],
    [3, 'D#/Eb', '5B', '2A'],
    [4, 'E', '12B', '9A'],
    [5, 'F', '7B', '4A'],
    [6, 'F#/Gb', '2B', '11A'],
    [7, 'G', '9B', '6A'],
    [8, 'G#/Ab', '4B', '1A'],
    [9, 'A', '11B', '8A'],
    [10, 'A#/Bb', '6B', '3A'],
    [11, 'B', '1B', '10A'],
  ];

  it.each(wheel)('pitch class %i (%s): major %s, minor %s', (pitchClass, _name, major, minor) => {
    expect(toCamelot(pitchClass, false)).toBe(major);
    expect(toCamelot(pitchClass, true)).toBe(minor);
  });

  it('gives every one of the 24 codes exactly once', () => {
    const codes = wheel.flatMap(([pitchClass]) => [toCamelot(pitchClass, false), toCamelot(pitchClass, true)]);
    expect(new Set(codes).size).toBe(24);
  });

  it('refuses a pitch class outside 0–11', () => {
    expect(() => toCamelot(12, false)).toThrow(RangeError);
    expect(() => toCamelot(-1, true)).toThrow(RangeError);
    expect(() => toCamelot(1.5, true)).toThrow(RangeError);
  });
});
