import { describe, expect, it } from 'vitest';
import { clickTrack } from '../testSignals.ts';
import { analyzeOnsets, BEAT_ONSET_LATENCY_FRAMES, ONSET_HOP, ONSET_LATENCY_FRAMES } from './onset.ts';

const RATE = 11025;

describe('analyzeOnsets', () => {
  it('runs at about 43 frames per second at the analysis rate', () => {
    const { fps, onset, beatOnset, lowOnset, rms, lowEnergy, energy, centroid } = analyzeOnsets(new Float32Array(10 * RATE), RATE);
    expect(fps).toBeCloseTo(RATE / ONSET_HOP, 9);
    for (const a of [onset, beatOnset, lowOnset, rms, lowEnergy, energy, centroid]) expect(a.length).toBe(Math.floor((10 * RATE - 1024) / 256) + 1);
  });

  it('gives empty arrays for input shorter than one frame', () => {
    expect(analyzeOnsets(new Float32Array(100), RATE).onset.length).toBe(0);
  });

  it.each([
    ['onset', ONSET_LATENCY_FRAMES],
    ['beatOnset', BEAT_ONSET_LATENCY_FRAMES],
  ] as const)('%s peaks its latency in frames before the frame of each click start', (envelope, latency) => {
    // Odd offsets so the clicks fall at different points between frames.
    for (const firstBeat of [0.5, 0.5113, 0.523, 0.5171]) {
      const { samples, beats } = clickTrack({ bpm: 120, seconds: 12, rate: RATE, firstBeat });
      const frames = analyzeOnsets(samples, RATE);
      const onset = frames[envelope];
      for (const beat of beats.slice(2, -2)) {
        const expected = beat * frames.fps - latency;
        // Centre of mass of the pulse within ±3 frames of where it should be.
        let mass = 0;
        let moment = 0;
        for (let i = Math.round(expected) - 3; i <= Math.round(expected) + 3; i++) {
          mass += onset[i]!;
          moment += onset[i]! * i;
        }
        expect(Math.abs(moment / mass - expected)).toBeLessThan(0.3);
      }
    }
  });

  it('has a bass-only envelope that sees the kicks and not the off-beat ticks', () => {
    const { samples, beats } = clickTrack({ bpm: 120, seconds: 12, rate: RATE });
    const { lowOnset, fps } = analyzeOnsets(samples, RATE);
    const around = (t: number) => Math.max(...lowOnset.subarray(Math.round(t * fps) - 5, Math.round(t * fps)));
    for (let i = 2; i < beats.length - 2; i++) {
      expect(around(beats[i]!)).toBeGreaterThan(1);
      expect(around((beats[i]! + beats[i + 1]!) / 2)).toBeLessThan(0.1 * around(beats[i]!));
    }
  });

  it('sees the kick in the low band and the quiet off-beat tick only above it', () => {
    const { samples, beats } = clickTrack({ bpm: 120, seconds: 6, rate: RATE });
    const { lowEnergy, energy, rms, fps } = analyzeOnsets(samples, RATE);
    const frameAt = (t: number) => Math.round(t * fps) - 1; // a frame that starts just before t
    const kick = frameAt(beats[4]!);
    const tick = frameAt((beats[4]! + beats[5]!) / 2);
    expect(lowEnergy[kick]! / energy[kick]!).toBeGreaterThan(0.9);
    expect(lowEnergy[tick]! / energy[tick]!).toBeLessThan(0.1);
    expect(rms[kick]!).toBeGreaterThan(5 * rms[tick]!);
  });
});
