import { describe, expect, it } from 'vitest';
import { beatModelAnswer as answer, clickTrack } from '../testSignals.ts';
import { neuralGrid } from './neuralGrid.ts';
import { ANALYSIS_RATE, analyzeOnsets } from './onset.ts';

const RATE = ANALYSIS_RATE;
/** How far (s) `t` is from the grid's nearest beat. */
const offGrid = (t: number, { firstBeat, bpm }: { firstBeat: number; bpm: number }) => {
  const period = 60 / bpm;
  const x = t - firstBeat;
  return Math.abs(x - Math.round(x / period) * period);
};

/** The grid beat index (0–3) of `downbeat` on a grid from `firstBeat`. */
const barPosition = (downbeat: number, firstBeat: number, bpm: number) => Math.round((downbeat - firstBeat) / (60 / bpm)) % 4;

describe('neuralGrid', () => {
  it('finds the tempo, the beats and the bars of a steady song', () => {
    const song = clickTrack({ bpm: 128, seconds: 60, rate: RATE, firstBeat: 0.3, accentOffset: 1 });
    const grid = neuralGrid(analyzeOnsets(song.samples, RATE), answer(song.beats, song.downbeats, 60), 60);
    expect(Math.abs(grid.bpm - 128)).toBeLessThanOrEqual(0.02);
    expect(grid.firstBeat).toBeCloseTo(0.3, 2);
    expect(grid.downbeatOffset).toBe(barPosition(song.downbeats[0]!, grid.firstBeat, grid.bpm));
    expect(grid.gridStable).toBe(true);
    expect(grid.beatConfidence).toBeGreaterThan(0.95);
    expect(grid.barConfidence).toBeGreaterThan(0.95);
  });

  it('puts the beats on the transients when the model hears them a frame early', () => {
    const song = clickTrack({ bpm: 124, seconds: 60, rate: RATE, firstBeat: 0.4 });
    const grid = neuralGrid(analyzeOnsets(song.samples, RATE), answer(song.beats, song.downbeats, 60, -0.02), 60);
    expect(Math.abs(grid.firstBeat - 0.4)).toBeLessThan(0.006);
  });

  it('stays on the beat the model hears when the off-beats are louder than the kicks', () => {
    const beat = clickTrack({ bpm: 130, seconds: 60, rate: RATE, firstBeat: 0.5 });
    const offbeats = clickTrack({ bpm: 130, seconds: 60, rate: RATE, firstBeat: 0.5 + 60 / 130 / 2, kickHz: 2500 });
    const samples = beat.samples.map((v, i) => v + 3 * offbeats.samples[i]!);
    const grid = neuralGrid(analyzeOnsets(samples, RATE), answer(beat.beats, beat.downbeats, 60), 60);
    expect(offGrid(0.5, grid)).toBeLessThan(0.01);
    expect(grid.gridStable).toBe(true);
  });

  it('doubles a tempo below 70 BPM, as beatGrid does', () => {
    const song = clickTrack({ bpm: 128, seconds: 60, rate: RATE });
    const everyOther = song.beats.filter((_, i) => i % 2 === 0);
    const grid = neuralGrid(analyzeOnsets(song.samples, RATE), answer(everyOther, song.downbeats, 60), 60);
    expect(grid.bpm).toBeCloseTo(128, 1);
  });

  it('calls a tempo that drifts unstable', () => {
    const song = clickTrack({ bpm: 120, seconds: 90, rate: RATE, tempoAt: (t) => 120 + t / 15 });
    const grid = neuralGrid(analyzeOnsets(song.samples, RATE), answer(song.beats, song.downbeats, 90), 90);
    expect(grid.bpm).toBeGreaterThan(120);
    expect(grid.gridStable).toBe(false);
  });

  it('hears no beat in a few hits', () => {
    const song = clickTrack({ bpm: 120, seconds: 60, rate: RATE });
    const grid = neuralGrid(analyzeOnsets(song.samples, RATE), answer(song.beats.slice(0, 10), [], 60), 60);
    expect(grid).toMatchObject({ bpm: 0, gridStable: false, beatConfidence: 0 });
  });
});
