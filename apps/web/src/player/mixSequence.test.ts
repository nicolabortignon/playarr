import type { MixMap, TransitionPlan } from '@playarr/mix';
import { describe, expect, it } from 'vitest';
import { beatCut, bridgeEntry, bridgeGain, bTimeAt, songTimeDuring, transitionTimeFor } from './mixSequence';

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

/** A 120 BPM song (a beat every half second, a bar every 2 s) whose first downbeat is at 1 s. */
const song = (over: Partial<MixMap> = {}): MixMap => ({
  version: 1,
  duration: 200,
  bpm: 120,
  firstBeat: 0.5,
  downbeatOffset: 1,
  downbeatConfidence: 0.9,
  gridStable: true,
  beatConfidence: 0.9,
  introEnd: 9,
  outroStart: 180,
  coldStart: false,
  coldEnd: false,
  soundEnd: 196.4,
  phraseEnergy: [],
  ...over,
});
const options = { aDuration: 200, mode: 'auto' as const, sameAlbumInOrder: false };

describe('the cut on the beat, with no transition ready', () => {
  it('leaves A on its last downbeat before its sound ends, and starts B on its first', () => {
    // A's bars fall at 1, 3, 5 … 195 s: the last before 196.4 is 195.
    expect(beatCut(song(), song({ firstBeat: 0.2, downbeatOffset: 2 }), options)).toEqual({ aEnd: 195, bStart: 1.2 });
  });

  it('cuts on a beat, not a bar, of a song whose bars are unsure', () => {
    expect(beatCut(song({ downbeatConfidence: 0.3 }), song(), options)?.aEnd).toBe(196);
  });

  it('starts B a bar before the end of a long intro, on a bar line', () => {
    // Intro to 40.5 s: from 38.5 s, on the first bar line at or after it (1 + 19 × 2 = 39).
    expect(beatCut(song(), song({ introEnd: 40.5 }), options)?.bStart).toBe(39);
    // A hand-set mix-in point counts as the intro's end: from 28 s, the bar at 29.
    expect(beatCut(song(), { ...song(), cues: { mixIn: 30 } }, options)?.bStart).toBe(29);
    // A short intro plays whole.
    expect(beatCut(song(), song({ introEnd: 12 }), options)?.bStart).toBe(1);
  });

  it('never cuts more than 20 s before A’s end, nor before its outro or mix-out point', () => {
    expect(beatCut(song({ soundEnd: 150 }), song(), options)).toBeNull();
    expect(beatCut(song({ outroStart: 196 }), song(), options)).toBeNull();
    expect(beatCut({ ...song(), cues: { mixOut: 195.5 } }, song(), options)).toBeNull();
  });

  it('plays the songs the usual way without a steady beat, within an album, or with mixing off', () => {
    expect(beatCut(song({ bpm: 0 }), song(), options)).toBeNull();
    expect(beatCut(song(), song({ beatConfidence: 0.2 }), options)).toBeNull();
    expect(beatCut(song(), song(), { ...options, sameAlbumInOrder: true })).toBeNull();
    expect(beatCut(song(), song(), { ...options, mode: 'off' })).toBeNull();
  });
});
