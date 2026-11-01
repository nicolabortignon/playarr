import { describe, expect, it } from 'vitest';
import { chord, clickTrack, noise, song, stereo } from './testSignals.ts';

const RATE = 11025;

/** Time (s) of the loudest sample in [from, to). */
function peakTime(samples: Float32Array, rate: number, from: number, to: number): number {
  let best = Math.max(0, Math.floor(from * rate));
  for (let i = best; i < Math.min(samples.length, Math.ceil(to * rate)); i++) {
    if (Math.abs(samples[i]!) > Math.abs(samples[best]!)) best = i;
  }
  return best / rate;
}

function rms(samples: Float32Array, rate: number, from: number, to: number): number {
  let sum = 0;
  const a = Math.floor(from * rate);
  const b = Math.floor(to * rate);
  for (let i = a; i < b; i++) sum += samples[i]! ** 2;
  return Math.sqrt(sum / (b - a));
}

const peak = (samples: Float32Array) => samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('clickTrack', () => {
  it('places beats evenly at the tempo, starting at firstBeat', () => {
    const { samples, beats } = clickTrack({ bpm: 120, seconds: 10, rate: RATE });
    expect(samples.length).toBe(10 * RATE);
    expect(beats[0]).toBeCloseTo(0.5, 9);
    for (let i = 1; i < beats.length; i++) expect(beats[i]! - beats[i - 1]!).toBeCloseTo(60 / 120, 9);
    expect(beats.at(-1)!).toBeLessThan(10);
    expect(beats.length).toBe(19);
  });

  it('puts the loudest sample a few ms after every beat', () => {
    const bpm = 128;
    const { samples, beats } = clickTrack({ bpm, seconds: 8, rate: RATE });
    const quarter = 60 / bpm / 4;
    for (const beat of beats.slice(0, -1)) {
      const lag = peakTime(samples, RATE, beat - quarter, beat + quarter) - beat;
      expect(lag).toBeGreaterThanOrEqual(0);
      expect(lag).toBeLessThan(0.008);
    }
  });

  it('marks downbeats every accentEvery beats from accentOffset, and makes them louder', () => {
    const { samples, beats, downbeats } = clickTrack({ bpm: 120, seconds: 10, rate: RATE, accentOffset: 1 });
    expect(downbeats).toEqual(beats.filter((_, i) => (i - 1) % 4 === 0));
    const level = (t: number) => Math.abs(samples[Math.round((t + 1 / 240) * RATE)]!);
    expect(level(beats[1]!)).toBeGreaterThan(1.3 * level(beats[2]!));
  });

  it('has a quiet tick halfway between beats', () => {
    const { samples, beats } = clickTrack({ bpm: 120, seconds: 4, rate: RATE });
    const half = (beats[0]! + beats[1]!) / 2;
    const tick = rms(samples, RATE, half, half + 0.01);
    expect(tick).toBeGreaterThan(0.005);
    expect(tick).toBeLessThan(rms(samples, RATE, beats[0]!, beats[0]! + 0.01));
    // Silence just before the tick: the kick has died away.
    expect(rms(samples, RATE, half - 0.05, half - 0.01)).toBeLessThan(1e-3);
  });

  it('speeds up when tempoAt rises over time', () => {
    const { beats } = clickTrack({ bpm: 120, seconds: 30, rate: RATE, tempoAt: (t) => 120 + t });
    const first = beats[1]! - beats[0]!;
    const last = beats.at(-1)! - beats.at(-2)!;
    expect(first).toBeCloseTo(60 / 120.5, 9);
    expect(last).toBeLessThan(first * 0.85);
  });

  it('can thump at a different pitch', () => {
    const low = clickTrack({ bpm: 120, seconds: 2, rate: RATE });
    const high = clickTrack({ bpm: 120, seconds: 2, rate: RATE, kickHz: 120 });
    // A 120 Hz kick peaks after an eighth of its period, earlier than a 60 Hz one.
    const at = (s: Float32Array) => peakTime(s, RATE, 0.45, 0.55) - 0.5;
    expect(at(high.samples)).toBeLessThan(at(low.samples));
  });
});

describe('chord', () => {
  it('sounds the triad of the root, minor or major', () => {
    const a = chord({ root: 'A', minor: true, seconds: 2, rate: RATE });
    expect(a.length).toBe(2 * RATE);
    // Correlating with each note's sine tells which notes are present.
    const strength = (hz: number) => {
      let re = 0;
      let im = 0;
      for (let i = 0; i < a.length; i++) {
        re += a[i]! * Math.cos((2 * Math.PI * hz * i) / RATE);
        im += a[i]! * Math.sin((2 * Math.PI * hz * i) / RATE);
      }
      return Math.hypot(re, im) / a.length;
    };
    const A3 = 220;
    const C4 = A3 * 2 ** (3 / 12);
    const Cs4 = A3 * 2 ** (4 / 12);
    const E4 = A3 * 2 ** (7 / 12);
    expect(strength(A3)).toBeGreaterThan(0.02);
    expect(strength(C4)).toBeGreaterThan(0.02);
    expect(strength(E4)).toBeGreaterThan(0.02);
    expect(strength(Cs4)).toBeLessThan(0.1 * strength(C4));
    expect(peak(a)).toBeLessThanOrEqual(1);
  });
});

describe('song', () => {
  const bpm = 125;
  const beat = 60 / bpm;
  const s = song({ bpm, rate: RATE, introBeats: 16, bodyBeats: 32, outroBeats: 16 });

  it('reports truth that is consistent with the beat counts', () => {
    const { introEnd, outroStart, soundEnd, duration } = s.truth;
    expect(introEnd).toBeLessThan(outroStart);
    expect(outroStart).toBeLessThan(soundEnd);
    expect(soundEnd).toBeLessThan(duration);
    expect(s.beats.length).toBe(64);
    expect(introEnd - s.beats[0]!).toBeCloseTo(16 * beat, 9);
    expect(outroStart - introEnd).toBeCloseTo(32 * beat, 9);
    expect(s.beats.filter((t) => t >= outroStart - 1e-9).length).toBe(16);
    expect(duration - soundEnd).toBeCloseTo(1, 9);
    expect(s.samples.length).toBe(Math.round(duration * RATE));
    expect(s.downbeats).toEqual(s.beats.filter((_, i) => i % 4 === 0));
  });

  it('is clearly louder in the body than in the intro and outro, and silent after soundEnd', () => {
    const { introEnd, outroStart, soundEnd, duration } = s.truth;
    const intro = rms(s.samples, RATE, s.beats[0]!, introEnd);
    const body = rms(s.samples, RATE, introEnd, outroStart);
    const outro = rms(s.samples, RATE, outroStart, soundEnd);
    expect(body).toBeGreaterThan(1.5 * intro);
    expect(body).toBeGreaterThan(1.5 * outro);
    expect(rms(s.samples, RATE, soundEnd + 0.01, duration)).toBe(0);
    expect(Math.abs(s.samples[Math.floor(soundEnd * RATE) - 2]!)).toBeGreaterThan(0);
  });

  it('peaks a few ms after each kick-only beat, and every body beat starts a jump in energy', () => {
    const { introEnd, outroStart } = s.truth;
    for (const t of s.beats) {
      if (t < introEnd - 1e-9 || t >= outroStart - 1e-9) {
        const lag = peakTime(s.samples, RATE, t - beat / 4, t + beat / 4) - t;
        expect(lag).toBeGreaterThanOrEqual(0);
        expect(lag).toBeLessThan(0.008);
      } else {
        // Under the sustained chord the kick's second swing can be the loudest sample, so look at energy.
        expect(rms(s.samples, RATE, t, t + 0.02)).toBeGreaterThan(1.5 * rms(s.samples, RATE, t - 0.02, t));
      }
    }
  });

  it('stays inside -1…1', () => {
    expect(peak(s.samples)).toBeLessThanOrEqual(1);
  });

  it('fades the outro out when asked', () => {
    const faded = song({ bpm, rate: RATE, introBeats: 16, bodyBeats: 32, outroBeats: 16, fadeOutSeconds: 4 });
    const { outroStart, soundEnd } = faded.truth;
    const kick = (x: Float32Array, t: number) => rms(x, RATE, t, t + 0.05);
    const lastBeat = faded.beats.at(-1)!;
    expect(kick(faded.samples, outroStart)).toBeCloseTo(kick(s.samples, outroStart), 6);
    expect(kick(faded.samples, lastBeat)).toBeLessThan(0.2 * kick(s.samples, lastBeat));
    expect(soundEnd).toBeCloseTo(s.truth.soundEnd, 9);
  });

  it('starts straight into the body when startDense', () => {
    const dense = song({ bpm, rate: RATE, introBeats: 16, bodyBeats: 32, outroBeats: 16, startDense: true });
    expect(dense.truth.introEnd).toBe(dense.beats[0]);
    expect(dense.beats.length).toBe(48);
    const firstBar = rms(dense.samples, RATE, dense.beats[0]!, dense.beats[4]!);
    expect(firstBar).toBeGreaterThan(1.5 * rms(s.samples, RATE, s.beats[0]!, s.beats[4]!));
  });

  it('plays the requested key in the body', () => {
    const inC = song({ bpm, rate: RATE, introBeats: 4, bodyBeats: 8, outroBeats: 4, key: { root: 'C', minor: false } });
    const inFs = song({ bpm, rate: RATE, introBeats: 4, bodyBeats: 8, outroBeats: 4, key: { root: 'F#', minor: false } });
    expect(inC.samples).not.toEqual(inFs.samples);
  });
});

describe('stereo', () => {
  it('copies the mono signal into two slightly different channels', () => {
    const mono = noise(1, RATE, 3);
    const { left, right } = stereo(mono);
    expect(left).toEqual(mono);
    expect(left).not.toBe(mono);
    expect(right).not.toEqual(left);
    expect(right[100]! / left[100]!).toBeGreaterThan(0.5);
    expect(right[100]! / left[100]!).toBeLessThan(1);
  });
});

describe('noise', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    const a = noise(2, RATE, 42);
    expect(a.length).toBe(2 * RATE);
    expect(a).toEqual(noise(2, RATE, 42));
    expect(a).not.toEqual(noise(2, RATE, 43));
    expect(peak(a)).toBeLessThanOrEqual(1);
    expect(rms(a, RATE, 0, 2)).toBeGreaterThan(0.1);
  });
});
