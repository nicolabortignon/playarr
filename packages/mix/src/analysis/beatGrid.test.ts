import { describe, expect, it } from 'vitest';
import { clickTrack, noise, song } from '../testSignals.ts';
import { beatGrid } from './beatGrid.ts';
import { analyzeOnsets } from './onset.ts';

const RATE = 11025;

function gridOf(samples: Float32Array) {
  const { beatOnset, fps } = analyzeOnsets(samples, RATE);
  return beatGrid(beatOnset, fps);
}

/** Distance (s) from `firstBeat` to the nearest true beat, on the grid's own period. */
function phaseError(firstBeat: number, bpm: number, trueBeat: number): number {
  const period = 60 / bpm;
  const d = (((firstBeat - trueBeat) % period) + period) % period;
  return Math.min(d, period - d);
}

describe('beatGrid', () => {
  it('measures a 124 BPM click track to a hundredth of a BPM', () => {
    const grid = gridOf(clickTrack({ bpm: 124, seconds: 75, rate: RATE }).samples);
    expect(Math.abs(grid.bpm - 124)).toBeLessThanOrEqual(0.05);
  });

  it('measures odd tempos precisely too', () => {
    for (const bpm of [97.3, 128.55, 140.2]) {
      const grid = gridOf(clickTrack({ bpm, seconds: 70, rate: RATE, firstBeat: 0.31 }).samples);
      expect(Math.abs(grid.bpm - bpm)).toBeLessThanOrEqual(0.05);
    }
  });

  it('keeps 174 BPM at 174, not folded to 87', () => {
    const grid = gridOf(clickTrack({ bpm: 174, seconds: 60, rate: RATE }).samples);
    expect(Math.abs(grid.bpm - 174)).toBeLessThanOrEqual(0.05);
  });

  it('keeps a 90 BPM song at 90, not doubled to 180', () => {
    const { samples } = song({ bpm: 90, rate: RATE, introBeats: 32, bodyBeats: 64, outroBeats: 32 });
    const grid = gridOf(samples);
    expect(Math.abs(grid.bpm - 90)).toBeLessThanOrEqual(0.05);
  });

  it('keeps a 90 BPM click track at 90', () => {
    const grid = gridOf(clickTrack({ bpm: 90, seconds: 60, rate: RATE }).samples);
    expect(Math.abs(grid.bpm - 90)).toBeLessThanOrEqual(0.05);
  });

  it('puts the first beat on the click start, within 12 ms', () => {
    for (const firstBeat of [0.05, 0.2, 0.3333, 0.4871]) {
      const { samples, beats } = clickTrack({ bpm: 124, seconds: 60, rate: RATE, firstBeat });
      const grid = gridOf(samples);
      expect(grid.firstBeat).toBeGreaterThanOrEqual(0);
      expect(grid.firstBeat).toBeLessThan(60 / grid.bpm);
      expect(Math.abs(grid.firstBeat - beats[0]!)).toBeLessThanOrEqual(0.012);
    }
  });

  it('gives the first beat at or after 0 when the music starts later', () => {
    const { samples, beats } = song({ bpm: 128, rate: RATE, introBeats: 32, bodyBeats: 64, outroBeats: 32 });
    const grid = gridOf(samples);
    expect(Math.abs(grid.bpm - 128)).toBeLessThanOrEqual(0.05);
    expect(grid.firstBeat).toBeLessThan(60 / grid.bpm);
    expect(phaseError(grid.firstBeat, grid.bpm, beats[0]!)).toBeLessThanOrEqual(0.012);
  });

  it('calls a steady track stable and a drifting one unstable', () => {
    const steady = gridOf(clickTrack({ bpm: 122, seconds: 90, rate: RATE }).samples);
    expect(steady.gridStable).toBe(true);

    const seconds = 90;
    // 120 → 124.8 BPM: a 4% ramp over the track, like a live drummer pushing.
    const drifting = gridOf(clickTrack({ bpm: 120, seconds, rate: RATE, tempoAt: (t) => 120 * (1 + (0.04 * t) / seconds) }).samples);
    expect(drifting.gridStable).toBe(false);
  });

  it('is confident about a clean click track and not about noise', () => {
    expect(gridOf(clickTrack({ bpm: 124, seconds: 60, rate: RATE }).samples).beatConfidence).toBeGreaterThan(0.7);
    const random = gridOf(noise(60, RATE));
    expect(random.beatConfidence).toBeLessThan(0.3);
  });

  it('reports nothing for silence', () => {
    expect(gridOf(new Float32Array(20 * RATE))).toEqual({ bpm: 0, firstBeat: 0, gridStable: false, beatConfidence: 0 });
  });

  it('rounds bpm to 0.01 and firstBeat to the millisecond', () => {
    const grid = gridOf(clickTrack({ bpm: 123.456, seconds: 40, rate: RATE, firstBeat: 0.2345 }).samples);
    expect(Math.round(grid.bpm * 100) / 100).toBe(grid.bpm);
    expect(Math.round(grid.firstBeat * 1000) / 1000).toBe(grid.firstBeat);
  });
});
