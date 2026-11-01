import { describe, expect, it } from 'vitest';
import { integrate } from '../automation.ts';
import { clickTrack, noise, stereo } from '../testSignals.ts';
import type { TransitionPlan } from '../types.ts';
import { RENDER_RATE } from './stretch.ts';
import { excerptRanges, renderTransition, softLimit, type Excerpt } from './transition.ts';

const rate = RENDER_RATE;

// Two click tracks a DJ would blend: A at 120 BPM with a 60 Hz kick, B at 124 BPM with a 90 Hz
// kick, both with their first beat at 0.5 s.
const A_BPM = 120;
const B_BPM = 124;
const trackA = clickTrack({ bpm: A_BPM, seconds: 40, rate, kickHz: 60 });
const trackB = clickTrack({ bpm: B_BPM, seconds: 40, rate, kickHz: 90 });
const songA = stereo(trackA.samples);
const songB = stereo(trackB.samples);
/** B slowed to A's tempo during the overlap. */
const MATCHED = A_BPM / B_BPM;

/**
 * A long blend, built by hand so these tests don't follow the planner's choices: 32 beats of
 * overlap with B slowed to A's tempo (A's beat 20 against B's beat 4, so the beats line up), the
 * bass swapped at 8 s, A faded out by 16 s, then 8 s of B easing back to its own tempo.
 */
function longPlan(overrides: Partial<TransitionPlan> = {}): TransitionPlan {
  const plan: TransitionPlan = {
    style: 'long',
    aStart: trackA.beats[20]!,
    bStart: trackB.beats[4]!,
    length: 24,
    bResume: 0,
    switchAt: 8,
    bRate: [
      { at: 0, value: MATCHED },
      { at: 16, value: MATCHED },
      { at: 24, value: 1 },
    ],
    aGain: [
      { at: 0, value: 1 },
      { at: 12, value: 1 },
      { at: 16, value: 0 },
    ],
    bGain: [
      { at: 0, value: 0 },
      { at: 0.5, value: 0 },
      { at: 4, value: 1 },
    ],
    aLowDb: [
      { at: 0, value: 0 },
      { at: 8, value: 0 },
      { at: 8.1, value: -24 },
    ],
    bLowDb: [
      { at: 0, value: -24 },
      { at: 7.9, value: -24 },
      { at: 8, value: 0 },
    ],
    aHighPassHz: [{ at: 0, value: 20 }],
    reason: 'test',
    beats: 32,
    ...overrides,
  };
  return { ...plan, bResume: plan.bStart + integrate(plan.bRate, 0, plan.length) };
}

/** The part of a whole song from `from` to `to` seconds (snapped outwards to samples). */
function excerpt(song: { left: Float32Array; right: Float32Array }, from: number, to: number): Excerpt {
  const first = Math.max(0, Math.floor(from * rate));
  const last = Math.min(song.left.length, Math.ceil(to * rate));
  return { left: song.left.slice(first, last), right: song.right.slice(first, last), start: first / rate };
}

function excerptsFor(plan: TransitionPlan): { a: Excerpt; b: Excerpt } {
  const ranges = excerptRanges(plan);
  return { a: excerpt(songA, ...ranges.a), b: excerpt(songB, ...ranges.b) };
}

const silent = [{ at: 0, value: 0 }];

/**
 * When the kick near `around` (seconds) starts: the first sample within ±20 ms reaching 30% of
 * the loudest sample there. Relative to the kick's own peak, so a fade doesn't move it.
 */
function kickOnset(signal: Float32Array, around: number): number {
  const from = Math.max(0, Math.round((around - 0.02) * rate));
  const to = Math.min(signal.length, Math.round((around + 0.02) * rate));
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(signal[i]!));
  for (let i = from; i < to; i++) if (Math.abs(signal[i]!) >= 0.3 * peak) return i / rate;
  return NaN;
}

/** Mean square of `signal` between two times, after a low-pass (two one-poles at 150 Hz). */
function lowBandEnergy(signal: Float32Array, from: number, to: number): number {
  const k = 1 - Math.exp((-2 * Math.PI * 150) / rate);
  let s1 = 0;
  let s2 = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < Math.round(to * rate); i++) {
    s1 += k * (signal[i]! - s1);
    s2 += k * (s1 - s2);
    if (i >= Math.round(from * rate)) {
      sum += s2 * s2;
      count++;
    }
  }
  return sum / count;
}

function maxDifference(x: Float32Array, y: Float32Array): number {
  expect(x.length).toBe(y.length);
  let max = 0;
  for (let i = 0; i < x.length; i++) max = Math.max(max, Math.abs(x[i]! - y[i]!));
  return max;
}

function sine(hz: number, amplitude: number, seconds: number): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate));
}

describe('renderTransition', () => {
  it('is plan.length of audio, and nothing for a straight cut', () => {
    const plan = longPlan();
    const { a, b } = excerptsFor(plan);
    expect(renderTransition(plan, a, b).left.length).toBe(Math.round(24 * rate));
    const straight = renderTransition({ ...plan, style: 'straight', length: 0 }, a, b);
    expect(straight.left.length).toBe(0);
    expect(straight.right.length).toBe(0);
  });

  it("lines up A's and B's kicks through the overlap", () => {
    const plan = longPlan();
    const { a, b } = excerptsFor(plan);
    const onlyA = renderTransition({ ...plan, bGain: silent }, a, b).left;
    const onlyB = renderTransition({ ...plan, aGain: silent }, a, b).left;

    // How far into its waveform each track's kick crosses the onset threshold, measured on the
    // source, so the two tracks' different kicks compare by when they start.
    const intoA = kickOnset(trackA.samples, trackA.beats[20]!) - trackA.beats[20]!;
    const intoB = kickOnset(trackB.samples, trackB.beats[4]!) - trackB.beats[4]!;

    let worst = 0;
    // A's beats at 0, 0.5, …: the overlap while both are audible, 1 s to 15.5 s.
    for (let beat = 2; beat <= 31; beat++) {
      const t = beat * 0.5;
      const kickA = kickOnset(onlyA, t) - intoA;
      const kickB = kickOnset(onlyB, t) - intoB;
      worst = Math.max(worst, Math.abs(kickA - kickB));
    }
    expect(worst).toBeLessThan(0.002);
  });

  it("starts exactly on A's audio and ends exactly on B's", () => {
    const plan = longPlan();
    const { a, b } = excerptsFor(plan);
    const out = renderTransition(plan, a, b);
    const tenMs = Math.round(0.01 * rate);

    const aFrom = Math.round((plan.aStart - a.start) * rate);
    for (const side of ['left', 'right'] as const) {
      expect(maxDifference(out[side].subarray(0, tenMs), a[side].subarray(aFrom, aFrom + tenMs))).toBeLessThan(1e-3);
    }

    // B's position at the end: where the stretch's rate, integrated, has taken it (bResume, to the sample).
    const bEnd = Math.round((plan.bStart - b.start) * rate) + Math.round(integrate(plan.bRate, 0, plan.length) * rate);
    const n = out.left.length;
    for (const side of ['left', 'right'] as const) {
      expect(maxDifference(out[side].subarray(n - tenMs), b[side].subarray(bEnd - tenMs, bEnd))).toBeLessThan(1e-3);
    }
    expect(bEnd / rate + b.start).toBeCloseTo(plan.bResume, 4);
  });

  it("takes A's bass out at the swap", () => {
    const plan = longPlan({ bGain: silent });
    const { a, b } = excerptsFor(plan);
    const onlyA = renderTransition(plan, a, b).left;
    const before = lowBandEnergy(onlyA, 2, 7.9);
    const after = lowBandEnergy(onlyA, 8.3, 11.9);
    expect(10 * Math.log10(before / after)).toBeGreaterThanOrEqual(18);
  });

  it('keeps loud sums inside ±1 without corners, and leaves quiet ones alone', () => {
    const flat: Partial<TransitionPlan> = {
      aStart: 1,
      bStart: 1,
      length: 2,
      bRate: [{ at: 0, value: 1 }],
      aGain: [{ at: 0, value: 1 }],
      bGain: [{ at: 0, value: 1 }],
      aLowDb: silent,
      bLowDb: silent,
    };
    const render = (amplitude: number) => {
      const song = stereo(sine(100, amplitude, 4));
      const plan = longPlan(flat);
      return renderTransition(plan, { ...song, start: 0 }, { ...song, start: 0 }).left;
    };

    const loud = render(0.8); // A + B peak at 1.6
    let peak = 0;
    let step = 0;
    for (let i = 0; i < loud.length; i++) {
      peak = Math.max(peak, Math.abs(loud[i]!));
      if (i > 0) step = Math.max(step, Math.abs(loud[i]! - loud[i - 1]!));
    }
    expect(peak).toBeLessThanOrEqual(1);
    expect(peak).toBeGreaterThan(0.95);
    // The limiter never steepens the waveform: no step bigger than the unlimited sum's.
    expect(step).toBeLessThanOrEqual((1.6 * 2 * Math.PI * 100) / rate);

    const quiet = render(0.4); // peaks at 0.8, under −1 dBFS
    expect(maxDifference(quiet, sine(100, 0.8, 4).subarray(rate, 3 * rate))).toBeLessThan(1e-6);
  });

  it('decodes what it reads: nothing outside excerptRanges changes the result', () => {
    const plan = longPlan();
    const ranges = excerptRanges(plan);
    const exact = renderTransition(plan, excerpt(songA, ...ranges.a), excerpt(songB, ...ranges.b));
    // A second more on both sides (a whole number of samples, so the excerpts stay aligned).
    const wider = renderTransition(
      plan,
      excerpt(songA, ranges.a[0] - 1, ranges.a[1] + 1),
      excerpt(songB, ranges.b[0] - 1, ranges.b[1] + 1),
    );
    expect(maxDifference(exact.left, wider.left)).toBeLessThan(1e-6);
    expect(maxDifference(exact.right, wider.right)).toBeLessThan(1e-6);
  });

  it("plays silence where A's excerpt runs out", () => {
    const plan = longPlan({ bGain: silent });
    const { a, b } = excerptsFor(plan);
    const full = renderTransition(plan, a, b).left;
    const short = renderTransition(plan, excerpt(songA, a.start, plan.aStart + 5), b).left;
    const fiveSeconds = 5 * rate;
    expect(maxDifference(short.subarray(0, fiveSeconds - 1), full.subarray(0, fiveSeconds - 1))).toBeLessThan(1e-6);
    expect(maxDifference(short.subarray(fiveSeconds + 1), new Float32Array(short.length - fiveSeconds - 1))).toBe(0);
  });

  it("refuses excerpts that start after the plan's start", () => {
    const plan = longPlan();
    const { a, b } = excerptsFor(plan);
    expect(() => renderTransition(plan, excerpt(songA, plan.aStart + 0.01, plan.aStart + 20), b)).toThrow(/A excerpt starts/);
    expect(() => renderTransition(plan, a, excerpt(songB, plan.bStart + 0.01, plan.bResume))).toThrow(/B excerpt starts/);
  });

  it('renders a 90 s blend in well under 10 s', () => {
    const dense = (bpm: number, kickHz: number, seed: number) => {
      const mono = clickTrack({ bpm, seconds: 100, rate, kickHz }).samples;
      const hiss = noise(100, rate, seed);
      for (let i = 0; i < mono.length; i++) mono[i]! += 0.2 * hiss[i]!;
      return stereo(mono);
    };
    const plan = longPlan({
      aStart: 2,
      bStart: 2,
      length: 90,
      bRate: [
        { at: 0, value: MATCHED },
        { at: 60, value: MATCHED },
        { at: 90, value: 1 },
      ],
      aGain: [
        { at: 0, value: 1 },
        { at: 50, value: 1 },
        { at: 60, value: 0 },
      ],
      aLowDb: [
        { at: 0, value: 0 },
        { at: 30, value: 0 },
        { at: 30.1, value: -24 },
      ],
      bLowDb: [
        { at: 0, value: -24 },
        { at: 29.9, value: -24 },
        { at: 30, value: 0 },
      ],
      aHighPassHz: [
        { at: 0, value: 20 },
        { at: 40, value: 20 },
        { at: 60, value: 800 },
      ],
    });
    const a = { ...dense(A_BPM, 60, 1), start: 0 };
    const b = { ...dense(B_BPM, 90, 2), start: 0 };
    const began = performance.now();
    const out = renderTransition(plan, a, b);
    const seconds = (performance.now() - began) / 1000;
    console.log(`90 s transition rendered in ${seconds.toFixed(2)} s`);
    expect(out.left.length).toBe(90 * rate);
    expect(seconds).toBeLessThan(10);
  }, 30_000);
});

describe('excerptRanges', () => {
  it("covers A while it's audible and B up to where it resumes, with margins", () => {
    const plan = longPlan();
    const ranges = excerptRanges(plan);
    expect(ranges.a[0]).toBeCloseTo(plan.aStart - 0.25, 9);
    expect(ranges.a[1]).toBeCloseTo(plan.aStart + 16 + 0.25, 9);
    expect(ranges.b[0]).toBeCloseTo(plan.bStart - 0.25, 9);
    expect(ranges.b[1]).toBeCloseTo(plan.bResume + 0.25, 9);
  });

  it('covers the whole transition of A when A never fades out, and stops at 0', () => {
    const plan = longPlan({ aStart: 0.1, bStart: 0, aGain: [{ at: 0, value: 1 }] });
    const ranges = excerptRanges(plan);
    expect(ranges.a).toEqual([0, 0.1 + 24 + 0.25]);
    expect(ranges.b[0]).toBe(0);
  });
});

describe('softLimit', () => {
  it('passes everything under −1 dBFS, then bends smoothly towards ±1', () => {
    const threshold = 10 ** (-1 / 20);
    expect(softLimit(0.5)).toBe(0.5);
    expect(softLimit(-threshold)).toBe(-threshold);
    expect(softLimit(threshold + 1e-9)).toBeCloseTo(threshold, 8); // continuous at the knee
    let previous = -Infinity;
    for (let x = -20; x <= 20; x += 0.001) {
      const y = softLimit(x);
      expect(Math.abs(y)).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(previous);
      expect(softLimit(-x)).toBe(-y);
      previous = y;
    }
    expect(softLimit(3)).toBeGreaterThan(0.999);
  });
});
