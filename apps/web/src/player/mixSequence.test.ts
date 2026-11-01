import type { TransitionPlan } from '@playarr/mix';
import { describe, expect, it } from 'vitest';
import { bridgeEntry, bridgeGain, bTimeAt, songTimeDuring, transitionTimeFor } from './mixSequence';

/**
 * A long blend: A from 170 s, B from 8 s, 24 s of transition. B starts 10% fast (at A's tempo) and eases
 * back to its own over the first 16 s, so B covers 16 × 1.05 + 8 = 24.8 s of its own and resumes at 32.8.
 */
const plan = {
  style: 'long',
  aStart: 170,
  bStart: 8,
  length: 24,
  bResume: 32.8,
  switchAt: 12,
  bRate: [
    { at: 0, value: 1.1 },
    { at: 16, value: 1 },
  ],
  aGain: [
    { at: 0, value: 1 },
    { at: 24, value: 0 },
  ],
  bGain: [
    { at: 0, value: 0 },
    { at: 24, value: 1 },
  ],
} as Partial<TransitionPlan> as TransitionPlan;

describe('the songs during a transition', () => {
  it('shows A until the switch, then B at the point of B being heard', () => {
    expect(songTimeDuring(plan, 0)).toEqual({ song: 'a', time: 170 });
    expect(songTimeDuring(plan, 11.9)).toEqual({ song: 'a', time: 181.9 });
    // 12 s in, B has run at 1.1 easing to 1.025, 1.0625 on average: 12.75 s of its own.
    expect(songTimeDuring(plan, 12)).toEqual({ song: 'b', time: expect.closeTo(20.75, 9) });
    expect(songTimeDuring(plan, 24).time).toBeCloseTo(32.8, 9);
  });

  it('knows where B is at any point, for a skip into it before the switch', () => {
    expect(bTimeAt(plan, 0)).toBe(8);
    expect(bTimeAt(plan, 4)).toBeCloseTo(8 + 4 * 1.0875, 9); // 1.1 easing to 1.075: 1.0875 on average
  });

  it('finds the point of the transition for a time in B, inside the part that shows B', () => {
    for (const t of [12, 13.5, 16, 20, 23.99]) expect(transitionTimeFor(plan, songTimeDuring(plan, t).time)).toBeCloseTo(t, 6);
    expect(transitionTimeFor(plan, 20)).toBeNull(); // B before the switch: the transition shows A there
    expect(transitionTimeFor(plan, 32.8)).toBeNull(); // where B's own file takes over
    expect(transitionTimeFor(plan, 100)).toBeNull();
  });

  it('starts the transition at the mix point, or a little late where A would be by then', () => {
    expect(bridgeEntry(plan, 169.97, false)).toBe(0);
    expect(bridgeEntry(plan, 170.5, false)).toBeCloseTo(0.5, 9);
    // Long past the mix point (a seek), or long before it: A plays on.
    expect(bridgeEntry(plan, 175, false)).toBeNull();
    expect(bridgeEntry(plan, 160, false)).toBeNull();
  });

  it('never starts the transition when the sleep timer stops at the end of the song', () => {
    expect(bridgeEntry(plan, 170, true)).toBeNull();
  });

  it('levels the transition by A’s gain, then B’s, as much as each is heard', () => {
    expect(bridgeGain(plan, 0, 0.5, 1)).toBe(0.5);
    expect(bridgeGain(plan, 24, 0.5, 1)).toBe(1);
    // Halfway the two are heard equally: halfway between in decibels.
    expect(bridgeGain(plan, 12, 0.5, 1)).toBeCloseTo(Math.SQRT1_2, 9);
    // A cut: all A before the switch, all B after.
    const cut = { ...plan, aGain: [{ at: 0, value: 0 }], bGain: [{ at: 0, value: 0 }] };
    expect(bridgeGain(cut, 11, 0.5, 1)).toBe(0.5);
    expect(bridgeGain(cut, 12, 0.5, 1)).toBe(1);
  });
});
