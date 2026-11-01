import { describe, expect, it } from 'vitest';
import { chord, clickTrack, noise, song } from '../testSignals.ts';
import { beatGrid } from './beatGrid.ts';
import { analyzeOnsets } from './onset.ts';

const RATE = 11025;

function gridOf(samples: Float32Array) {
  return beatGrid(analyzeOnsets(samples, RATE));
}

/** Distance (s) from `firstBeat` to the nearest true beat, on the grid's own period. */
function phaseError(firstBeat: number, bpm: number, trueBeat: number): number {
  const period = 60 / bpm;
  const d = (((firstBeat - trueBeat) % period) + period) % period;
  return Math.min(d, period - d);
}

/** `x` wrapped into −period/2 … period/2. */
const wrapSeconds = (x: number, period: number) => x - Math.round(x / period) * period;

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

  it('keeps fast songs with a backbeat snare at their tempo, beats on the kicks', () => {
    for (const bpm of [160, 174, 190]) {
      const { samples, beats } = song({ bpm, rate: RATE, introBeats: 32, bodyBeats: 128, outroBeats: 32 });
      const grid = gridOf(samples);
      expect(Math.abs(grid.bpm - bpm)).toBeLessThanOrEqual(0.05);
      expect(phaseError(grid.firstBeat, grid.bpm, beats[0]!)).toBeLessThanOrEqual(0.012);
    }
  });

  it('keeps a slow 70.5 BPM click track at 70.5, not doubled', () => {
    const grid = gridOf(clickTrack({ bpm: 70.5, seconds: 70, rate: RATE }).samples);
    expect(Math.abs(grid.bpm - 70.5)).toBeLessThanOrEqual(0.05);
  });

  it('still finds the beat from the full envelope when no bass envelope is given', () => {
    const { beatOnset, fps } = analyzeOnsets(clickTrack({ bpm: 124, seconds: 60, rate: RATE }).samples, RATE);
    expect(Math.abs(beatGrid(beatOnset, fps).bpm - 124)).toBeLessThanOrEqual(0.05);
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
      expect(phaseError(grid.firstBeat, grid.bpm, beats[0]!)).toBeLessThanOrEqual(0.012);
    }
  });

  it('puts beats on the transients without bias, within a few ms', () => {
    const errors: number[] = [];
    for (const [bpm, firstBeat] of [[124, 0.05], [124, 0.2], [97.3, 0.31], [140.2, 0.31], [123.456, 0.4]] as const) {
      const { samples, beats } = clickTrack({ bpm, seconds: 40, rate: RATE, firstBeat });
      const grid = gridOf(samples);
      const period = 60 / grid.bpm;
      errors.push(wrapSeconds(grid.firstBeat - beats[0]!, period));
    }
    for (const e of errors) expect(Math.abs(e)).toBeLessThanOrEqual(0.006);
    const bias = errors.reduce((s, e) => s + e, 0) / errors.length;
    expect(Math.abs(bias)).toBeLessThanOrEqual(0.0025);
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

  it('calls a minute that jumps from 120 to 124.8 BPM halfway unstable', () => {
    const jump = gridOf(clickTrack({ bpm: 120, seconds: 60, rate: RATE, tempoAt: (t) => (t < 30 ? 120 : 124.8) }).samples);
    expect(jump.gridStable).toBe(false);
  });

  it('keeps a steady song stable through a 40 s breakdown without drums', () => {
    const { samples, beats } = song({ bpm: 124, rate: RATE, introBeats: 16, bodyBeats: 224, outroBeats: 16 });
    const pad = chord({ root: 'A', minor: true, seconds: 40, rate: RATE });
    samples.set(pad, 40 * RATE); // 40–80 s: only a chord
    const grid = gridOf(samples);
    expect(Math.abs(grid.bpm - 124)).toBeLessThanOrEqual(0.05);
    expect(phaseError(grid.firstBeat, grid.bpm, beats[0]!)).toBeLessThanOrEqual(0.012);
    expect(grid.gridStable).toBe(true);
  });

  it('is confident about a clean click track and not about noise', () => {
    expect(gridOf(clickTrack({ bpm: 124, seconds: 60, rate: RATE }).samples).beatConfidence).toBeGreaterThan(0.7);
    for (const seed of [1, 2, 3]) {
      const random = gridOf(noise(60, RATE, seed));
      expect(random.beatConfidence).toBeLessThan(0.3);
      expect(random.gridStable).toBe(false);
    }
  });

  it('never calls noise stable, however short', () => {
    expect(gridOf(noise(20, RATE, 4)).gridStable).toBe(false);
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
