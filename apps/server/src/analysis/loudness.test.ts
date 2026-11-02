import { describe, expect, it } from 'vitest';
import { LOUDNESS_RATE, LoudnessMeter } from './loudness.ts';

/**
 * A 1 kHz sine `seconds` long at `dbfs` (its peak), as interleaved stereo 16-bit PCM: in both
 * channels, or only the left.
 */
function sine(seconds: number, dbfs: number, opts: { rate?: number; leftOnly?: boolean } = {}): Buffer {
  const { rate = LOUDNESS_RATE, leftOnly = false } = opts;
  const amplitude = 10 ** (dbfs / 20);
  const frames = Math.round(seconds * rate);
  const out = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(amplitude * Math.sin((2 * Math.PI * 1000 * i) / rate) * 32767);
    out.writeInt16LE(v, i * 4);
    out.writeInt16LE(leftOnly ? 0 : v, i * 4 + 2);
  }
  return out;
}

function measure(pieces: Buffer[], rate = LOUDNESS_RATE) {
  const meter = new LoudnessMeter(rate);
  for (const piece of pieces) meter.push(piece);
  return meter.result();
}

describe('loudness (EBU Tech 3341 test signals)', () => {
  it.each([44_100, 48_000])('reads a stereo 1 kHz sine at −23 dBFS as −23 LUFS, at %i Hz', (rate) => {
    expect(measure([sine(20, -23, { rate })], rate).lufs).toBeCloseTo(-23, 1);
  });

  it('leaves out the quiet passages: −36, −23, −36 dBFS for 10, 60 and 10 s read as −23 LUFS', () => {
    expect(measure([sine(10, -36), sine(60, -23), sine(10, -36)]).lufs).toBeCloseTo(-23, 1);
  });

  it('leaves out near silence: −72, −36, −23, −36, −72 dBFS read as −23 LUFS', () => {
    expect(measure([sine(10, -72), sine(10, -36), sine(60, -23), sine(10, -36), sine(10, -72)]).lufs).toBeCloseTo(-23, 1);
  });

  it('averages passages within 10 LU of each other: −26, −20, −26 dBFS for 20 s each read as −23 LUFS', () => {
    expect(measure([sine(20, -26), sine(20.1, -20), sine(20, -26)]).lufs).toBeCloseTo(-23, 1);
  });

  it('sums the channels’ power: the same sine in one channel only is 3 dB quieter', () => {
    expect(measure([sine(20, -23, { leftOnly: true })]).lufs).toBeCloseTo(-26, 1);
  });

  it('finds the peak and counts the frames', () => {
    const result = measure([sine(5, -6)]);
    expect(result.peak).toBeCloseTo(-6, 1);
    expect(result.samples).toBe(5 * LOUDNESS_RATE);
  });

  it('says silence has no loudness', () => {
    expect(measure([Buffer.alloc(10 * LOUDNESS_RATE * 4)])).toEqual({ lufs: null, peak: -Infinity, samples: 10 * LOUDNESS_RATE });
  });

  it('gives the same answer for a song fed in pieces that split its frames', () => {
    const whole = Buffer.concat([sine(3, -30), sine(7, -12)]);
    const pieces = [whole.subarray(0, 1001), whole.subarray(1001, 77_777), whole.subarray(77_777, 77_779), whole.subarray(77_779)];
    expect(measure(pieces)).toEqual(measure([whole]));
  });
});
