import { describe, expect, it } from 'vitest';
import { camelotDistance, isCamelot, keysCompatible } from './camelot.ts';
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
