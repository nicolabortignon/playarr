import type { MixMap } from '@playarr/mix';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BAR_REST, barHeights, breath, energyAt, levelsOf, onPulse, setPulseSource, songBeat, type PulseFrame } from './pulse';

/** 120 BPM, its first downbeat at 1 s: beats every half second, bars every 2 s, phrases every 8 s. */
const map = (over: Partial<MixMap> = {}) =>
  ({ bpm: 120, firstBeat: 0.5, downbeatOffset: 1, gridStable: true, beatConfidence: 0.9, phraseEnergy: [0.2, 1, null], ...over }) as MixMap;
const beat = songBeat(map())!;
const loud = [1, 1, 1] as const;

/** A stand-in analyzer at 48 kHz (bins 46.875 Hz apart) whose spectrum the test sets: one byte value per band. */
function analyzer(bands: { bass: number; middle: number; treble: number }) {
  const spectrum = new Uint8Array(512);
  const set = (b: typeof bands) => {
    spectrum.fill(0);
    spectrum.fill(b.bass, 1, 5);
    spectrum.fill(b.middle, 5, 43);
    spectrum.fill(b.treble, 43, 214);
  };
  set(bands);
  const node = {
    fftSize: 1024,
    frequencyBinCount: 512,
    context: { sampleRate: 48_000 },
    getByteFrequencyData: (into: Uint8Array) => into.set(spectrum),
  };
  return { node: node as unknown as AnalyserNode, set };
}

afterEach(() => setPulseSource(null));

describe('a song’s beat', () => {
  it('is its mix map’s grid, its bars from the first downbeat', () => {
    expect(beat).toMatchObject({ beat: 0.5, firstBar: 1 });
  });

  it('is none for a song not analyzed, without a tempo, or whose grid doesn’t hold', () => {
    expect(songBeat(undefined)).toBeNull();
    expect(songBeat(map({ bpm: 0 }))).toBeNull();
    // A wandering tempo, or a beat too unsure to go by (gridStable is false below a confidence of 0.35).
    expect(songBeat(map({ gridStable: false }))).toBeNull();
  });
});

describe('the now-playing bars', () => {
  it('land on each beat and fall away until the next', () => {
    const [bassOn, middleOn] = barHeights(beat, 3.04, loud); // just after the beat at 3 s has landed
    const [bassLate, middleLate] = barHeights(beat, 3.45, loud); // just before the next
    expect(bassOn).toBeGreaterThan(0.95);
    expect(bassLate).toBeLessThan(bassOn - 0.3);
    // The middle falls more slowly than the bass.
    expect(middleLate).toBeGreaterThan(bassLate);
    // Up within a few hundredths of a second: on the beat, not rising to it.
    expect(barHeights(beat, 3.0, loud)[0]).toBeLessThan(barHeights(beat, 3.03, loud)[0]);
    expect(barHeights(beat, 3.03, loud)[0]).toBeCloseTo(1, 2);
  });

  it('land the treble on every half beat, as hi-hats do', () => {
    // Just after the half beat at 3.25 s has landed: the treble is up, the bass well down from its beat.
    expect(barHeights(beat, 3.285, loud)[2]).toBeGreaterThan(0.95);
    expect(barHeights(beat, 3.285, loud)[0]).toBeLessThan(0.75);
  });

  it('stand as tall as each part of the music is loud, and at rest in silence', () => {
    const [bass, middle, treble] = barHeights(beat, 3.04, [1, 0.5, 0]);
    expect(bass).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(treble);
    expect(treble).toBe(BAR_REST);
    expect(barHeights(beat, 3.04, [0, 0, 0])).toEqual([BAR_REST, BAR_REST, BAR_REST]);
  });
});

describe('Now Playing’s glow', () => {
  it('is fullest on each bar’s downbeat, breathes out across the bar and in again before the next', () => {
    expect(breath(beat, 3)).toBeCloseTo(1, 6); // the downbeat of the bar from 3 s
    expect(breath(beat, 4)).toBeLessThan(0.2); // halfway
    expect(breath(beat, 4.5)).toBeLessThan(0.1); // before breathing in
    expect(breath(beat, 4.9)).toBeGreaterThan(0.5); // breathing in for the downbeat at 5 s
    expect(breath(beat, 5)).toBeCloseTo(1, 6);
  });

  it('never flashes: from one frame to the next it changes only a little', () => {
    let biggest = 0;
    for (let t = 1; t < 9; t += 1 / 60) biggest = Math.max(biggest, Math.abs(breath(beat, t + 1 / 60) - breath(beat, t)));
    expect(biggest).toBeLessThan(0.15);
  });

  it('breathes deeper in a loud phrase than a quiet one, and as deep where a phrase wasn’t measured', () => {
    expect(energyAt(beat, 2)).toBe(0.2); // the first phrase, from 1 s
    expect(energyAt(beat, 10)).toBe(1); // the second, from 9 s
    expect(energyAt(beat, 20)).toBe(1); // not measured
    expect(energyAt(beat, 0)).toBe(0.2); // before the first downbeat: as the first phrase
  });
});

describe('what’s heard, from the analyzer', () => {
  it('reads the bass, the middle and the treble apart', () => {
    const { node, set } = analyzer({ bass: 200, middle: 200, treble: 200 });
    expect(levelsOf(node, 0)).toEqual([1, 1, 1]);
    // The bass drops out (a breakdown): its bar falls, the others don't.
    set({ bass: 120, middle: 200, treble: 200 });
    const [bass, middle, treble] = levelsOf(node, 1000)!;
    expect(bass).toBeLessThan(0.6);
    expect(middle).toBeGreaterThan(0.9);
    expect(treble).toBe(1);
  });

  it('reads against how loud the music has lately been: the volume set doesn’t matter, a quiet bridge reads quiet', () => {
    const { node, set } = analyzer({ bass: 230, middle: 230, treble: 230 });
    expect(levelsOf(node, 0)).toEqual([1, 1, 1]);
    // A second after a loud drop, a passage about 16 dB quieter reads low.
    set({ bass: 170, middle: 170, treble: 170 });
    expect(levelsOf(node, 1000)![0]).toBeLessThan(0.5);
    // A quiet song all along moves its bars as much as a loud one.
    const quiet = analyzer({ bass: 140, middle: 140, treble: 140 });
    expect(levelsOf(quiet.node, 0)![0]).toBeGreaterThan(0.8);
  });

  it('reads silence as silence', () => {
    expect(levelsOf(analyzer({ bass: 0, middle: 0, treble: 0 }).node, 0)).toEqual([0, 0, 0]);
    expect(levelsOf(null, 0)).toBeNull();
  });
});

describe('one loop for everything keeping time', () => {
  it('gives every listener the same frame, from the engine, and stops when the last one goes', async () => {
    const { node } = analyzer({ bass: 230, middle: 230, treble: 230 });
    const songTime = vi.fn(() => 42.5);
    setPulseSource({ songTime, meter: () => node, blend: () => null });
    const a: PulseFrame[] = [];
    const b: PulseFrame[] = [];
    const offA = onPulse((f) => a.push(f));
    const offB = onPulse((f) => b.push(f));
    await vi.waitFor(() => expect(a.length).toBeGreaterThan(2));
    expect(a[0]).toEqual({ time: 42.5, levels: [1, 1, 1], blend: null });
    // One reading a frame, for both.
    expect(a).toContain(b[0]);
    offA();
    offB();
    const calls = songTime.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(songTime.mock.calls.length).toBe(calls);
  });
});
