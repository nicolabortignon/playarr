import { describe, expect, it } from 'vitest';
import { integrate, valueAt } from './automation.ts';
import type { Automation } from './types.ts';

const ramp: Automation = [
  { at: 1, value: 0 },
  { at: 3, value: 4 },
];

describe('valueAt', () => {
  it.each([
    ['before the first point: held', 0, 0],
    ['on the first point', 1, 0],
    ['between points: linear', 2, 2],
    ['on the last point', 3, 4],
    ['after the last point: held', 10, 4],
  ])('%s', (_label, t, expected) => {
    expect(valueAt(ramp, t)).toBeCloseTo(expected, 12);
  });

  it('a single point is a constant', () => {
    expect(valueAt([{ at: 5, value: 0.7 }], -3)).toBe(0.7);
    expect(valueAt([{ at: 5, value: 0.7 }], 30)).toBe(0.7);
  });

  it('two points at the same time are a step: the later value from that time on', () => {
    const step: Automation = [
      { at: 0, value: 1 },
      { at: 2, value: 1 },
      { at: 2, value: 3 },
    ];
    expect(valueAt(step, 1.999)).toBeCloseTo(1, 12);
    expect(valueAt(step, 2)).toBe(3);
    expect(valueAt(step, 5)).toBe(3);
  });

  it('refuses an automation with no points', () => {
    expect(() => valueAt([], 0)).toThrow(RangeError);
  });
});

describe('integrate', () => {
  it('a constant integrates to value × width', () => {
    expect(integrate([{ at: 0, value: 1.03 }], 0, 10)).toBeCloseTo(10.3, 12);
  });

  it('a ramp integrates to its trapezoid', () => {
    expect(integrate(ramp, 1, 3)).toBeCloseTo(4, 12);
    expect(integrate(ramp, 2, 3)).toBeCloseTo(3, 12);
  });

  it('includes the held values beyond the ends', () => {
    // 0 held from -1 to 1, ramp area 4, then 4 held from 3 to 5.
    expect(integrate(ramp, -1, 5)).toBeCloseTo(4 + 8, 12);
  });

  it('is exact across several segments and a step', () => {
    const shape: Automation = [
      { at: 0, value: 1 },
      { at: 2, value: 1 },
      { at: 2, value: 3 },
      { at: 4, value: 1 },
    ];
    // 2 (flat) + 4 (trapezoid from 3 down to 1)
    expect(integrate(shape, 0, 4)).toBeCloseTo(6, 12);
    expect(integrate(shape, 1, 3)).toBeCloseTo(1 + 2.5, 12);
  });

  it('runs backwards to a negative area and is zero over nothing', () => {
    expect(integrate(ramp, 3, 1)).toBeCloseTo(-4, 12);
    expect(integrate(ramp, 2, 2)).toBe(0);
  });
});
