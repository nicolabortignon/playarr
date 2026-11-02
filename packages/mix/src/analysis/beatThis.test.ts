import { describe, expect, it } from 'vitest';
import { BEAT_THIS_BANDS, BEAT_THIS_RATE, beatThisSpectrogram } from './beatThis.ts';

/** One second of 220 Hz at 0.3 plus 3 kHz at 0.2, at the model's rate. */
function twoTones(): Float32Array {
  return Float32Array.from({ length: BEAT_THIS_RATE }, (_, i) => {
    const t = i / BEAT_THIS_RATE;
    return 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 3000 * t);
  });
}

describe('beatThisSpectrogram', () => {
  // Reference values from Beat This!'s own preprocessing (beat_this.preprocessing.LogMelSpect, torchaudio)
  // on the same signal.
  it('matches the model’s Python preprocessing', () => {
    const spect = beatThisSpectrogram(twoTones());
    expect(spect.length / BEAT_THIS_BANDS).toBe(51);
    const frame = (f: number) => spect.subarray(f * BEAT_THIS_BANDS, (f + 1) * BEAT_THIS_BANDS);
    const middle = frame(25);
    const loudest = [...middle.keys()].sort((a, b) => middle[b]! - middle[a]!).slice(0, 2);
    expect(loudest).toEqual([79, 6]);
    const expected: [number, number][] = [
      [79, 7.6844],
      [6, 7.6371],
      [0, 0.7037],
      [40, 0.01272],
      [64, 0.01471],
      [100, 0.00194],
    ];
    // Within 0.1% where there's sound; near-silent bands differ by torch's float32 rounding.
    for (const [band, value] of expected) expect(Math.abs(middle[band]! - value)).toBeLessThan(Math.max(0.001 * value, 1e-4));
    // The mirrored edges: the first and last frames.
    expect(frame(0)[79]).toBeCloseTo(7.7999, 3);
    expect(frame(50)[79]).toBeCloseTo(7.6444, 3);
  });

  it('gives nothing for (almost) no audio', () => {
    expect(beatThisSpectrogram(new Float32Array(0)).length).toBe(0);
    expect(beatThisSpectrogram(new Float32Array(1)).length).toBe(0);
  });
});
