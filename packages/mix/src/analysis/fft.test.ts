import { describe, expect, it } from 'vitest';
import { Fft, hann } from './fft.ts';

describe('Fft', () => {
  it('puts a pure sine’s energy in the bin of its frequency', () => {
    const n = 1024;
    const rate = 11025;
    const binHz = rate / n;
    const hz = 40 * binHz; // exactly on bin 40, so there's no leakage to argue about
    const re = Float64Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));
    const im = new Float64Array(n);
    new Fft(n).transform(re, im);

    const power = Array.from({ length: n / 2 + 1 }, (_, k) => re[k]! ** 2 + im[k]! ** 2);
    const loudest = power.indexOf(Math.max(...power));
    expect(loudest).toBe(40);
    // A unit sine of length n has magnitude n/2 at its bin.
    expect(Math.sqrt(power[40]!)).toBeCloseTo(n / 2, 6);
    const elsewhere = power.reduce((s, p, k) => (k === 40 ? s : s + p), 0);
    expect(elsewhere).toBeLessThan(1e-12 * power[40]!);
  });
});

describe('hann', () => {
  it('is zero at both ends and one in the middle', () => {
    const w = hann(9);
    expect(w[0]).toBeCloseTo(0);
    expect(w[8]).toBeCloseTo(0);
    expect(w[4]).toBeCloseTo(1);
  });
});
