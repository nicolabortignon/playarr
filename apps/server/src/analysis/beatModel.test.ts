import { analyzeOnsets, BEAT_THIS_RATE, halveRate, neuralGrid } from '@playarr/mix';
import { afterAll, describe, expect, it } from 'vitest';
import { BeatModel } from './beatModel.ts';
import { SAMPLE_RATE } from './dsp.ts';

/**
 * `seconds` of a 120 BPM drum machine at the model's rate, beats at 0.25 s + n · 0.5 s: a kick on every
 * beat (a click, then a pitch falling from 160 to 50 Hz), a snare on 2 and 4, eighth-note hats, and a
 * bass note that changes at every bar.
 */
function drums(seconds: number, rate = BEAT_THIS_RATE): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const add = (at: number, length: number, f: (t: number) => number) => {
    const start = Math.round(at * rate);
    for (let i = 0; i < length * rate && start + i < out.length; i++) out[start + i]! += f(i / rate);
  };
  const bassNotes = [55, 43.65, 65.41, 49];
  for (let beat = 0; 0.25 + beat * 0.5 < seconds; beat++) {
    const at = 0.25 + beat * 0.5;
    add(at, 0.002, () => 0.5 * noise());
    add(at, 0.25, (t) => 0.8 * Math.exp(-t * 18) * Math.sin(2 * Math.PI * (50 * t + (110 / 30) * (1 - Math.exp(-30 * t)))));
    if (beat % 2 === 1) add(at, 0.15, (t) => Math.exp(-t * 30) * (0.3 * noise() + 0.2 * Math.sin(2 * Math.PI * 200 * t)));
    for (const half of [0, 0.25]) add(at + half, 0.03, (t) => 0.06 * Math.exp(-t * 200) * noise());
    if (beat % 4 === 0) {
      const hz = bassNotes[(beat / 4) % bassNotes.length]!;
      add(at, 2, (t) => 0.25 * Math.min(1, t * 50) * Math.exp(-t * 0.8) * Math.sign(Math.sin(2 * Math.PI * hz * t)));
    }
  }
  return out;
}

let model: BeatModel | undefined;
afterAll(() => model?.close());

describe('BeatModel', () => {
  it('hears the beats and bars of a drum machine, across the 30 s chunks it listens in', async () => {
    model = await BeatModel.load();
    const samples = drums(70);
    const odds = await model.activations(samples);
    expect(odds.fps).toBe(50);
    expect(odds.beat.length).toBe(Math.floor(samples.length / 441) + 1);
    expect(odds.downbeat.length).toBe(odds.beat.length);
    // Every frame answered, the chunks' joins included.
    expect(odds.beat.every((v) => v > -1000)).toBe(true);
    const grid = neuralGrid(analyzeOnsets(halveRate(samples), SAMPLE_RATE), odds, 70);
    expect(Math.abs(grid.bpm - 120)).toBeLessThan(0.05);
    expect(grid.gridStable).toBe(true);
    // On the kicks (0.25 s + n · 0.5 s), and bars starting on the louder one.
    const off = (((grid.firstBeat - 0.25) % 0.5) + 0.5) % 0.5;
    expect(Math.min(off, 0.5 - off)).toBeLessThan(0.02);
    expect(Math.round((grid.firstBeat + grid.downbeatOffset * 0.5 - 0.25) / 0.5) % 4).toBe(0);
  }, 60_000);

  it('fails to load from a file that isn’t there', async () => {
    await expect(BeatModel.load('/nowhere/model.onnx')).rejects.toThrow();
  });
});
