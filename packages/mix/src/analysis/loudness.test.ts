import { describe, expect, it } from 'vitest';
import { noise } from '../testSignals.ts';
import { LoudnessFrames, songPhraseEnergy } from './loudness.ts';
import { analyzeOnsets } from './onset.ts';

const RATE = 11025;

describe('loudness frames, fed in pieces', () => {
  it('measures exactly what analyzeOnsets does, however the audio is cut up', () => {
    const audio = noise(7, RATE, 3);
    const whole = analyzeOnsets(audio, RATE).rms;
    const frames = new LoudnessFrames();
    for (const [from, to] of [
      [0, 1000],
      [1000, 1001],
      [1001, 33_333],
      [33_333, audio.length],
    ] as const) {
      frames.push(audio.subarray(from, to));
    }
    const pieces = frames.frames();
    expect(pieces.length).toBe(whole.length);
    for (let f = 0; f < whole.length; f += 37) expect(pieces[f]).toBeCloseTo(whole[f]!, 9);
  });
});

describe('phrase energy over the whole song', () => {
  const fps = RATE / 256;
  const period = 0.5; // 120 BPM: phrases of 8 s
  /** Frame loudness `level` for `seconds` (frames counted from 0). */
  const flat = (seconds: number, level: number) => new Float64Array(Math.round(seconds * fps)).fill(level);

  it('joins stretches measured apart onto the song’s phrases, relative to the loudest of all', () => {
    const energy = songPhraseEnergy(
      [
        { start: 0, rms: flat(24, 0.2), from: 0, to: 24 },
        { start: 24, rms: flat(16, 0.05), from: 24, to: 40 }, // a quiet middle
        { start: 40, rms: flat(16, 0.4), from: 40, to: Infinity }, // the loudest at the end
      ],
      fps,
      0,
      period,
      56,
    );
    expect(energy).toHaveLength(7);
    expect(energy.slice(0, 3)).toEqual([0.5, 0.5, 0.5]);
    expect(energy.slice(3, 5)).toEqual([0.125, 0.125]);
    expect(energy.slice(5)).toEqual([1, 1]);
  });

  it('leaves the phrases nothing measured as null, and counts a frame only where its stretch says', () => {
    const energy = songPhraseEnergy(
      [
        { start: 0, rms: flat(16, 0.3), from: 0, to: 16 },
        // The tail starts before where it counts from (it overlaps the head): only from 32 s on.
        { start: 24, rms: flat(24, 0.6), from: 32, to: Infinity },
      ],
      fps,
      0,
      period,
      48,
    );
    expect(energy).toEqual([0.5, 0.5, null, null, 1, 1]);
  });
});
