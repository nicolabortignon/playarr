import { describe, expect, it } from 'vitest';
import { blendScore, type Blendable } from './blend.ts';

/** A song that blends perfectly with itself: 120 BPM, a sure beat, 8A and middling energy. */
function song(overrides: Partial<Blendable> = {}): Blendable {
  return { bpm: 120, beatConfidence: 0.9, key: { camelot: '8A', confidence: 0.9 }, energy: 0.5, ...overrides };
}

describe('blendScore', () => {
  describe('tempo', () => {
    it.each<[string, Partial<Blendable>, number]>([
      ['the same tempo', {}, 1],
      ['double time', { bpm: 240 }, 1],
      ['half time', { bpm: 60 }, 1],
      ['2.5% apart: barely stretched', { bpm: 123 }, 0.98],
      ['8% apart: the planner’s limit for a long blend', { bpm: 129.6 }, 0.8],
      ['11% apart: no long blend, falling off', { bpm: 133.2 }, 0.4],
      ['120 against 90: far apart', { bpm: 90 }, 0.1],
      ['120 against 174: far apart, even at half time', { bpm: 174 }, 0.1],
    ])('%s', (_, b, expected) => {
      expect(blendScore(song(), song(b))).toBeCloseTo(expected, 2);
    });

    it.each<[string, Partial<Blendable>]>([
      ['no tempo', { bpm: 0 }],
      ['a beat that is a guess', { beatConfidence: 0.1 }],
      ['a tempo that is not a number', { bpm: Number.NaN }],
    ])('is neutral for a song with %s, whatever the other tempo', (_, beatless) => {
      expect(blendScore(song(beatless), song())).toBeCloseTo(0.8, 5);
      expect(blendScore(song(beatless), song({ bpm: 90 }))).toBeCloseTo(0.8, 5);
    });

    it('trusts a half-sure beat halfway', () => {
      const unsure = blendScore(song({ beatConfidence: 0.475 }), song({ bpm: 90 }));
      expect(unsure).toBeCloseTo((0.8 + 0.1) / 2, 5);
    });
  });

  describe('key', () => {
    it.each<[string, Partial<Blendable>, number]>([
      ['the same key', {}, 1],
      ['a neighbour on the wheel', { key: { camelot: '9A', confidence: 0.9 } }, 1],
      ['the relative major', { key: { camelot: '8B', confidence: 0.9 } }, 1],
      ['two steps away', { key: { camelot: '10A', confidence: 0.9 } }, 0.8],
      ['a clash', { key: { camelot: '3B', confidence: 0.9 } }, 0.6],
      ['an unsure key (neutral)', { key: { camelot: '3B', confidence: 0.2 } }, 0.8],
      ['no key (neutral)', { key: undefined }, 0.8],
      ['a broken key code (neutral)', { key: { camelot: '13C' as '8A', confidence: 0.9 } }, 0.8],
      ['a clash, half sure', { key: { camelot: '3B', confidence: 0.45 } }, 0.7],
    ])('%s', (_, b, expected) => {
      expect(blendScore(song(), song(b))).toBeCloseTo(expected, 5);
    });
  });

  describe('energy', () => {
    it.each<[string, Partial<Blendable>, number]>([
      ['the same energy', {}, 1],
      ['a small step', { energy: 0.6 }, 0.9],
      ['a jump', { energy: 1 }, 0.5],
      ['a jump down', { energy: 0 }, 0.5],
      ['unknown energy (neutral)', { energy: undefined }, 0.8],
    ])('%s', (_, b, expected) => {
      expect(blendScore(song(), song(b))).toBeCloseTo(expected, 5);
    });

    it('floors a jump from still to intense', () => {
      expect(blendScore(song({ energy: 0 }), song({ energy: 1 }))).toBeCloseTo(0.4, 5);
    });
  });

  it('multiplies the three parts, and stays between 0 and 1', () => {
    const far = song({ bpm: 90, key: { camelot: '3B', confidence: 0.9 }, energy: 1 });
    expect(blendScore(song({ energy: 0 }), far)).toBeCloseTo(0.1 * 0.6 * 0.4, 5);
    const unknown = { bpm: 0, beatConfidence: 0 };
    expect(blendScore(unknown, unknown)).toBeCloseTo(0.8 ** 3, 5);
  });

  it('is the same either way round', () => {
    const pairs: [Blendable, Blendable][] = [
      [song(), song({ bpm: 126, key: { camelot: '9B', confidence: 0.5 }, energy: 0.7 })],
      [song({ bpm: 100 }), song({ bpm: 108 })],
      [song({ beatConfidence: 0.4 }), song({ bpm: 87, energy: undefined })],
    ];
    for (const [a, b] of pairs) expect(blendScore(a, b)).toBeCloseTo(blendScore(b, a), 12);
  });
});
