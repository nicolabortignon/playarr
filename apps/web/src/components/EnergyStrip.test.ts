import type { MixMap } from '@playarr/mix';
import { describe, expect, it } from 'vitest';
import { beatGrid, phrasesAndBars } from './EnergyStrip';

/** 120 BPM: a beat every 0.5 s, a bar every 2 s, a phrase every 8 s. */
const map = (extra: Partial<MixMap> = {}): MixMap => ({
  version: 1,
  duration: 40,
  bpm: 120,
  firstBeat: 1,
  downbeatOffset: 0,
  gridStable: true,
  beatConfidence: 0.9,
  introEnd: 8,
  outroStart: 32,
  coldStart: false,
  coldEnd: false,
  soundEnd: 40,
  phraseEnergy: [0.2, 0.4, 0.6, 0.8],
  ...extra,
});

const whole = (m: MixMap) => phrasesAndBars(m, (t) => t, 0, m.duration);

describe('phrasesAndBars', () => {
  it('starts bars and phrases on the first downbeat, a few beats after the first beat', () => {
    // Three beats in: the first downbeat is at 1 + 3 × 0.5 = 2.5 s.
    const m = map({ downbeatOffset: 3 });
    expect(beatGrid(m)).toEqual({ beat: 0.5, firstBar: 2.5 });
    const { phrases, bars } = whole(m);
    expect(phrases.map((p) => p.at)).toEqual([2.5, 10.5, 18.5, 26.5]);
    expect(phrases[0]).toMatchObject({ start: 2.5, end: 10.5, left: 2.5 / 40, width: 8 / 40, energy: 0.2 });
    // A bar line every 2 s from the downbeat (none before it: there's no bar to count from), every fourth a phrase.
    expect(bars.slice(0, 5)).toEqual([
      { left: 2.5 / 40, phrase: true },
      { left: 4.5 / 40, phrase: false },
      { left: 6.5 / 40, phrase: false },
      { left: 8.5 / 40, phrase: false },
      { left: 10.5 / 40, phrase: true },
    ]);
    expect(bars.at(-1)).toEqual({ left: 38.5 / 40, phrase: false });
  });

  it('cuts the last phrase at the song’s end', () => {
    const { phrases } = whole(map({ downbeatOffset: 3, duration: 30 }));
    expect(phrases.at(-1)).toMatchObject({ at: 26.5, end: 30 });
  });

  it('keeps only what falls in the window, placed on its clock', () => {
    // A window from 10 to 20 s on a clock 10 s behind the song (the song's 20 s is the picture's 10).
    const { phrases, bars } = phrasesAndBars(map({ downbeatOffset: 2 }), (t) => t - 10, 10, 20);
    // Phrases at 2, 10, 18, 26 s of the song: on this clock -8, 0, 8, 16; the window keeps 8 and 16.
    expect(phrases.map((p) => p.at)).toEqual([18, 26]);
    expect(phrases[0]).toMatchObject({ start: 8, end: 16, left: 0, width: 0.6 });
    expect(bars.map((b) => b.left)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  it('has nothing to draw without a beat', () => {
    expect(beatGrid(map({ bpm: 0 }))).toBeUndefined();
    expect(whole(map({ bpm: 0 }))).toEqual({ phrases: [], bars: [] });
  });
});
