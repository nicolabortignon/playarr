import type { TransitionPlan } from '@playarr/mix';
import { describe, expect, it } from 'vitest';
import { blendShares, isBlend } from './blend';

/** A 16 s blend: the next song comes in over the first 8 s, the first song goes over the last 8. */
const plan = {
  style: 'long',
  aGain: [
    { at: 0, value: 1 },
    { at: 8, value: 1 },
    { at: 16, value: 0 },
  ],
  bGain: [
    { at: 0, value: 0 },
    { at: 8, value: 1 },
  ],
} as Partial<TransitionPlan> as TransitionPlan;

describe('a DJ blend you can see', () => {
  it('gives each song’s cover as much of the picture as its song has of the mix', () => {
    expect(blendShares(plan, 0)).toEqual({ from: 1, to: 0 });
    expect(blendShares(plan, 4)).toEqual({ from: 1, to: 0.5 });
    expect(blendShares(plan, 8)).toEqual({ from: 1, to: 1 });
    expect(blendShares(plan, 12)).toEqual({ from: 0.5, to: 1 });
    expect(blendShares(plan, 16)).toEqual({ from: 0, to: 1 });
  });

  it('is a blend or a quick mix: a fade or straight on plays one song after the other', () => {
    expect(isBlend({ style: 'long' })).toBe(true);
    expect(isBlend({ style: 'quick' })).toBe(true);
    expect(isBlend({ style: 'fade' })).toBe(false);
    expect(isBlend({ style: 'straight' })).toBe(false);
  });
});
