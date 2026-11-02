import { describe, expect, it } from 'vitest';
import { integrate, valueAt } from '../automation.ts';
import { OWN_TEMPO_HOLD, OWN_TEMPO_RAMP, planTransition, type PlanInput } from '../plan.ts';
import { clickTrack, noise, song, stereo } from '../testSignals.ts';
import { MIX_MAP_VERSION, type MixMap, type TransitionPlan, type TransitionStyle } from '../types.ts';
import { FILTER_BLOCK } from './filters.ts';
import { RENDER_RATE } from './stretch.ts';
import { excerptRanges, LIMIT_CEILING, limitLoudness, renderTransition, type Excerpt, type StereoAudio } from './transition.ts';

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
 * bass swapped at 8 s, A faded out by 16 s, then B easing back to its own tempo, reached 0.1 s
 * before the end.
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
      { at: 23.9, value: 1 },
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
function excerpt(whole: StereoAudio, from: number, to: number): Excerpt {
  const first = Math.max(0, Math.floor(from * rate));
  const last = Math.min(whole.left.length, Math.ceil(to * rate));
  return { left: whole.left.slice(first, last), right: whole.right.slice(first, last), start: first / rate };
}

function excerptsFor(plan: TransitionPlan, a: StereoAudio = songA, b: StereoAudio = songB, tail = 0): { a: Excerpt; b: Excerpt } {
  const ranges = excerptRanges(plan, tail)!;
  return { a: excerpt(a, ...ranges.a), b: excerpt(b, ...ranges.b) };
}

const TEN_MS = Math.round(0.01 * rate);

/**
 * The seams with the songs playing on their own: the first `head` samples of the transition are A
 * from aStart, and its last 10 ms are B up to bResume, each rounded to a sample. (The other song's
 * last trace, a fade's tail, is allowed for.)
 */
function expectSeamless(plan: TransitionPlan, a: Excerpt, b: Excerpt, out: StereoAudio, head = TEN_MS): void {
  const aFrom = Math.round((plan.aStart - a.start) * rate);
  const bEnd = Math.round((plan.bResume - b.start) * rate);
  const n = out.left.length;
  for (const side of ['left', 'right'] as const) {
    expect(maxDifference(out[side].subarray(0, head), a[side].subarray(aFrom, aFrom + head)), `${side}: start`).toBeLessThan(1e-3);
    expect(maxDifference(out[side].subarray(n - TEN_MS), b[side].subarray(bEnd - TEN_MS, bEnd)), `${side}: end`).toBeLessThan(1e-3);
  }
}

const silent = [{ at: 0, value: 0 }];
const CEILING = LIMIT_CEILING;

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
    expectSeamless(plan, a, b, renderTransition(plan, a, b));
  });

  it("takes A's bass out at the swap", () => {
    const plan = longPlan({ bGain: silent });
    const { a, b } = excerptsFor(plan);
    const onlyA = renderTransition(plan, a, b).left;
    const before = lowBandEnergy(onlyA, 2, 7.9);
    const after = lowBandEnergy(onlyA, 8.3, 11.9);
    expect(10 * Math.log10(before / after)).toBeGreaterThanOrEqual(18);
  });

  it('keeps loud sums under −1 dBFS without corners, and leaves quiet ones alone', () => {
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
    expect(peak).toBeLessThanOrEqual(CEILING + 1e-6);
    expect(peak).toBeGreaterThan(0.85);
    // The limiter never steepens the waveform: no step bigger than the unlimited sum's.
    expect(step).toBeLessThanOrEqual((1.6 * 2 * Math.PI * 100) / rate);

    const quiet = render(0.4); // peaks at 0.8, under −1 dBFS
    expect(maxDifference(quiet, sine(100, 0.8, 4).subarray(rate, 3 * rate))).toBeLessThan(1e-6);
  });

  it('clamps a song alone that goes past full scale, as playing it on its own would', () => {
    const tooHot = stereo(sine(100, 1.05, 4));
    const plan = longPlan({
      aStart: 1,
      bStart: 1,
      length: 2,
      bRate: [{ at: 0, value: 1 }],
      aGain: [{ at: 0, value: 1 }],
      bGain: silent,
      aLowDb: silent,
      bLowDb: silent,
    });
    const out = renderTransition(plan, { ...tooHot, start: 0 }, { ...tooHot, start: 0 }).left;
    const clamped = tooHot.left.subarray(rate, 3 * rate).map((v) => Math.max(-1, Math.min(1, v)));
    expect(maxDifference(out, clamped)).toBe(0);
    expect(out.reduce((peak, v) => Math.max(peak, v), 0)).toBe(1);
  });

  it('never touches a song playing on its own, however loud: the joins must stay exact', () => {
    const hot = stereo(sine(100, 0.99, 4)); // a master peaking just under 0 dBFS
    const plan = longPlan({
      aStart: 1,
      bStart: 1,
      length: 2,
      bRate: [{ at: 0, value: 1 }],
      aGain: [{ at: 0, value: 1 }],
      bGain: silent,
      aLowDb: silent,
      bLowDb: silent,
    });
    const out = renderTransition(plan, { ...hot, start: 0 }, { ...hot, start: 0 });
    expect(maxDifference(out.left, hot.left.subarray(rate, 3 * rate))).toBe(0);
  });

  it('decodes what it reads: nothing outside excerptRanges changes the result', () => {
    const plan = longPlan();
    const ranges = excerptRanges(plan)!;
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

  it.each(['aStart', 'bStart', 'length', 'bResume'] as const)('refuses a plan whose %s is not a number', (field) => {
    const plan = longPlan();
    const { a, b } = excerptsFor(plan);
    for (const broken of [NaN, Infinity]) {
      expect(() => renderTransition({ ...plan, [field]: broken }, a, b)).toThrow(new RegExp(`plan's ${field} is`));
      expect(() => excerptRanges({ ...plan, [field]: broken })).toThrow(RangeError);
    }
  });

  it('refuses a plan that resumes B somewhere its rate doesn’t take it, even by a sample', () => {
    const plan = longPlan();
    const { a, b } = excerptsFor(plan);
    expect(() => renderTransition({ ...plan, bResume: plan.bResume + 1 / rate }, a, b)).toThrow(/resumes B at/);
    expect(() => renderTransition({ ...plan, bResume: plan.bResume + 0.4 / rate }, a, b)).not.toThrow();
  });

  const curves = ['bRate', 'aGain', 'bGain', 'aLowDb', 'bLowDb', 'aHighPassHz'] as const;
  it.each(curves)('refuses a plan whose %s can’t be read', (curve) => {
    const plan = longPlan();
    const { a, b } = excerptsFor(plan);
    const broken: unknown[] = [
      [], // no points
      [{ at: 0, value: Number.NaN }],
      [{ at: 0, value: 1 }, { at: Number.POSITIVE_INFINITY, value: 1 }],
      JSON.parse('[{ "at": 0, "value": null }]'), // what JSON makes of NaN
      [null],
      [{ at: 2, value: 1 }, { at: 1, value: 1 }], // out of order
    ];
    for (const points of broken) {
      expect(() => renderTransition({ ...plan, [curve]: points } as TransitionPlan, a, b), JSON.stringify(points)).toThrow(
        new RegExp(`plan's ${curve}`),
      );
    }
  });

  it('refuses a plan where B doesn’t move forward', () => {
    const plan = longPlan();
    const { a, b } = excerptsFor(plan);
    const stopped = [{ at: 0, value: 0 }];
    expect(() => renderTransition({ ...plan, bRate: stopped, bResume: plan.bStart }, a, b)).toThrow(/bRate must be positive/);
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
    expect(out.left.length).toBe(90 * rate);
    expect(seconds).toBeLessThan(10);
  }, 30_000);
});

describe('excerptRanges', () => {
  it("covers A while it's audible and B up to where it resumes, with margins", () => {
    const plan = longPlan();
    const ranges = excerptRanges(plan)!;
    expect(ranges.a[0]).toBeCloseTo(plan.aStart - 0.25, 9);
    expect(ranges.a[1]).toBeCloseTo(plan.aStart + 16 + 0.25, 9);
    expect(ranges.b[0]).toBeCloseTo(plan.bStart - 0.25, 9);
    expect(ranges.b[1]).toBeCloseTo(plan.bResume + 0.25, 9);
  });

  it('covers the whole transition of A when A never fades out, and stops at 0', () => {
    const plan = longPlan({ aStart: 0.1, bStart: 0, aGain: [{ at: 0, value: 1 }] });
    const ranges = excerptRanges(plan)!;
    expect(ranges.a).toEqual([0, 0.1 + 24 + 0.25]);
    expect(ranges.b[0]).toBe(0);
  });

  it('is undefined for a straight cut: there is nothing to decode', () => {
    expect(excerptRanges({ ...longPlan(), style: 'straight', length: 0 })).toBeUndefined();
  });
});

describe('limitLoudness', () => {
  /** Peak over RMS: a limiter that rides the gain keeps it, a clipper flattens the peaks and lowers it. */
  function crest(signal: Float32Array): number {
    let peak = 0;
    let sum = 0;
    for (const v of signal) {
      peak = Math.max(peak, Math.abs(v));
      sum += v * v;
    }
    return peak / Math.sqrt(sum / signal.length);
  }

  it('turns two full-scale songs playing together down to −1 dBFS without clipping their peaks', () => {
    // Two full-scale masters: a 50 Hz bass and a 333 Hz tone, peaking near 2 together.
    const seconds = 2;
    const mono = sine(50, 1, seconds).map((v, i) => v + Math.sin((2 * Math.PI * 333 * i) / rate));
    const sum = stereo(mono);
    const audio = { left: sum.left.slice(), right: sum.right.slice() };
    limitLoudness(audio, rate);

    let peak = 0;
    for (const v of audio.left) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(CEILING + 1e-6);
    expect(peak).toBeGreaterThan(0.85);
    // After the first release (0.5 s in), the waveform keeps its shape: the crest factor holds
    // (measured 2.00 → 1.94; clipping the same sum at the ceiling takes it to 1.32).
    const settled = (signal: Float32Array) => signal.subarray(rate / 2);
    expect(crest(settled(audio.left)) / crest(settled(sum.left))).toBeGreaterThan(0.9);
    // And the gain moves slowly: sample by sample, never by more than a ramp over the 5 ms look-ahead.
    let largestGainStep = 0;
    for (let i = 1; i < mono.length; i++) {
      if (Math.abs(sum.left[i]!) < 0.2 || Math.abs(sum.left[i - 1]!) < 0.2) continue;
      const step = audio.left[i]! / sum.left[i]! - audio.left[i - 1]! / sum.left[i - 1]!;
      largestGainStep = Math.max(largestGainStep, Math.abs(step));
    }
    expect(largestGainStep).toBeLessThan(1 / Math.round(0.005 * rate));
    // Linked: the quieter right channel is turned down by the same gain as the left.
    for (let i = 0; i < mono.length; i += 997) expect(audio.right[i]!).toBeCloseTo(audio.left[i]! * 0.8, 5);
  });

  it('leaves audio under −1 dBFS exactly as it is', () => {
    const quiet = stereo(sine(50, 0.89, 1));
    const audio = { left: quiet.left.slice(), right: quiet.right.slice() };
    limitLoudness(audio, rate);
    expect(maxDifference(audio.left, quiet.left)).toBe(0);
    expect(maxDifference(audio.right, quiet.right)).toBe(0);
  });

  /** The gain applied around time t: the loudest output over the loudest input within ±5 ms. */
  function gainAround(output: Float32Array, input: Float32Array, t: number): number {
    let outPeak = 0;
    let inPeak = 0;
    for (let i = Math.round((t - 0.005) * rate); i < Math.round((t + 0.005) * rate); i++) {
      outPeak = Math.max(outPeak, Math.abs(output[i]!));
      inPeak = Math.max(inPeak, Math.abs(input[i]!));
    }
    return outPeak / inPeak;
  }

  it('holds the gain down for a second after a loud moment, then lets go smoothly', () => {
    const signal = sine(100, 0.5, 4);
    const burstEnd = 0.5 + 2000 / rate;
    for (let i = rate / 2; i < rate / 2 + 2000; i++) signal[i]! *= 3; // a 45 ms burst at 1.5
    const audio = stereo(signal);
    const original = audio.left.slice();
    limitLoudness(audio, rate);
    const needed = CEILING / 1.5;

    // Untouched until the look-ahead before the burst.
    expect(maxDifference(audio.left.subarray(0, rate / 2 - 300), original.subarray(0, rate / 2 - 300))).toBe(0);
    // Held at what the burst needed: 50 ms after it, and half a second after it.
    expect(gainAround(audio.left, original, burstEnd + 0.05)).toBeCloseTo(needed, 2);
    expect(gainAround(audio.left, original, burstEnd + 0.5)).toBeCloseTo(needed, 2);
    // 50 ms after the hold, on its way back (the 150 ms release has made up about a third).
    const letting = gainAround(audio.left, original, burstEnd + 1.05);
    expect(letting).toBeGreaterThan(needed + 0.05);
    expect(letting).toBeLessThan(0.9);
    // And back to unity within a second of the hold ending.
    expect(maxDifference(audio.left.subarray(Math.round((burstEnd + 2) * rate)), original.subarray(Math.round((burstEnd + 2) * rate)))).toBeLessThan(1e-3);
  });

  it('keeps two loud beat-matched songs steady instead of pumping on every kick', () => {
    // Two hot masters at 124 BPM, kicks together: every kick sums to nearly twice full scale.
    const hot = (seed: number, bassHz: number) => {
      const hiss = noise(7, rate, seed);
      const beat = 60 / 124;
      const raw = Float32Array.from({ length: 6 * rate }, (_, i) => {
        const t = i / rate;
        const sinceKick = t % beat;
        const kick = Math.exp(-sinceKick / 0.06) * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-sinceKick / 0.02)) * sinceKick);
        return 0.9 * kick + 0.35 * Math.sin(2 * Math.PI * bassHz * t) + 0.4 * hiss[i]!;
      });
      let peak = 0;
      for (const v of raw) peak = Math.max(peak, Math.abs(v));
      return stereo(raw.map((v) => (0.99 * Math.tanh((1.5 * v) / peak)) / Math.tanh(1.5)));
    };
    const a = hot(1, 55);
    const b = hot(2, 61.7);
    const plan = longPlan({
      aStart: 0,
      bStart: 0,
      length: 6,
      bRate: [{ at: 0, value: 1 }],
      aGain: [{ at: 0, value: 1 }],
      bGain: [{ at: 0, value: 1 }],
      aLowDb: silent,
      bLowDb: silent,
    });
    const out = renderTransition(plan, { ...a, start: 0 }, { ...b, start: 0 }).left;
    const sum = a.left.map((v, i) => v + b.left[i]!);

    const beat = 60 / 124;
    let worstSwing = 0;
    let deepest = 1;
    for (let start = 1.5; start + beat < 5.5; start += beat) {
      let lowest = Infinity;
      let highest = 0;
      for (let i = Math.round(start * rate); i < Math.round((start + beat) * rate); i++) {
        if (Math.abs(sum[i]!) < 0.2) continue;
        const gain = out[i]! / sum[i]!;
        lowest = Math.min(lowest, gain);
        highest = Math.max(highest, gain);
      }
      worstSwing = Math.max(worstSwing, 20 * Math.log10(highest / lowest));
      deepest = Math.min(deepest, lowest);
    }
    expect(20 * Math.log10(deepest)).toBeLessThan(-3); // it is limiting hard
    expect(worstSwing).toBeLessThan(1); // dB within each beat
  });
});

// ——— Real planner output ———
//
// Plans from `planTransition` for songs whose mix maps are the truth of synthetic signals, so
// what the planner decides and what the renderer does with it are checked together.

interface SongOnDisk {
  audio: StereoAudio;
  map: MixMap;
}

/** A `song()` signal at `bpm`, and the mix map an exact analysis would give it. */
function mixSong(
  bpm: number,
  sections: { introBeats: number; bodyBeats: number; outroBeats: number },
  map: Partial<MixMap> = {},
): SongOnDisk {
  const { samples, truth } = song({ bpm, rate, ...sections });
  return {
    audio: stereo(samples),
    map: {
      version: MIX_MAP_VERSION,
      duration: truth.duration,
      bpm,
      firstBeat: 0.5,
      downbeatOffset: 0,
      gridStable: true,
      beatConfidence: 0.9,
      introEnd: truth.introEnd,
      outroStart: truth.outroStart,
      coldStart: false,
      coldEnd: false,
      soundEnd: truth.soundEnd,
      phraseEnergy: [],
      ...map,
    },
  };
}

/** A beat that drifts somewhere in the song: no long blend, a quick mix. */
const drifting = { gridStable: false };

/** Each style with a pair of songs that the planner gives it. */
const PAIRS: Record<string, { style: TransitionStyle; a: SongOnDisk; b: SongOnDisk; mode?: PlanInput['mode'] }> = {
  // 120 into 124 (3.3%), keys unknown, roomy intro and outro: a 32-beat blend and an ease-back.
  long: {
    style: 'long',
    a: mixSong(120, { introBeats: 16, bodyBeats: 32, outroBeats: 48 }),
    b: mixSong(124, { introBeats: 64, bodyBeats: 96, outroBeats: 16 }),
  },
  // 124 into 126 (1.6%), B's beat drifting: a quick mix with B stretched.
  'quick, stretched': {
    style: 'quick',
    a: mixSong(124, { introBeats: 16, bodyBeats: 32, outroBeats: 32 }),
    b: mixSong(126, { introBeats: 32, bodyBeats: 64, outroBeats: 16 }, drifting),
  },
  // 124 into 130 (4.8%), B's beat drifting: a cut, B at its own speed.
  'quick, cut': {
    style: 'quick',
    a: mixSong(124, { introBeats: 16, bodyBeats: 32, outroBeats: 32 }),
    b: mixSong(130, { introBeats: 32, bodyBeats: 64, outroBeats: 16 }, drifting),
  },
  // A's beat unsure: a crossfade.
  fade: {
    style: 'fade',
    a: mixSong(120, { introBeats: 16, bodyBeats: 32, outroBeats: 32 }, { beatConfidence: 0.1, gridStable: false }),
    b: mixSong(124, { introBeats: 32, bodyBeats: 64, outroBeats: 16 }),
  },
  straight: {
    style: 'straight',
    a: mixSong(120, { introBeats: 16, bodyBeats: 32, outroBeats: 32 }),
    b: mixSong(124, { introBeats: 32, bodyBeats: 64, outroBeats: 16 }),
    mode: 'off',
  },
};

function planned(name: string) {
  const pair = PAIRS[name]!;
  const plan = planTransition({ a: pair.a.map, b: pair.b.map, mode: pair.mode ?? 'auto', sameAlbumInOrder: false });
  return { pair, plan };
}

/** The largest sample-to-sample step over `samples` samples from `from`. */
function largestStep(signal: Float32Array, from: number, samples: number): number {
  let largest = 0;
  for (let i = from + 1; i < from + samples; i++) largest = Math.max(largest, Math.abs(signal[i]! - signal[i - 1]!));
  return largest;
}

const flatDb = [{ at: 0, value: 0 }];
const fullGain = [{ at: 0, value: 1 }];
const highPassOff = [{ at: 0, value: 20 }];

describe('renderTransition with the planner’s plans', () => {
  it.each(['long', 'quick, stretched', 'quick, cut', 'fade'])('%s: joins both songs exactly, without a click', (name) => {
    const { pair, plan } = planned(name);
    expect(plan.style).toBe(pair.style);
    if (name === 'quick, stretched') expect(Math.abs(valueAt(plan.bRate, 0) - 1)).toBeLessThanOrEqual(0.02);
    if (name === 'quick, cut') expect(plan.bRate).toEqual([{ at: 0, value: 1 }]);
    const { a, b } = excerptsFor(plan, pair.a.audio, pair.b.audio);
    const out = renderTransition(plan, a, b);
    expect(out.left.length).toBe(Math.round(plan.length * rate));

    // A quick mix's high-pass sweep starts moving straight away (fading in over 11.6 ms), so A is
    // only untouched until the first filter block; elsewhere, for the first 10 ms.
    expectSeamless(plan, a, b, out, plan.style === 'quick' ? FILTER_BLOCK : TEN_MS);

    // No click as the transition starts: no step in the first 50 ms bigger than A's own.
    const aFrom = Math.round((plan.aStart - a.start) * rate);
    const fiftyMs = Math.round(0.05 * rate);
    expect(largestStep(out.left, 0, fiftyMs)).toBeLessThanOrEqual(1.2 * largestStep(a.left, aFrom, fiftyMs));
  });

  it.each(['long', 'quick, stretched', 'quick, cut', 'fade'])('%s: B ends bit for bit on B at bResume, even in dense music', (name) => {
    // Under noise every frame of the time-stretch has to search for its splice, so only the plan
    // getting B back to its own speed in time, and B placed by its end, make the last 50 ms exact.
    const { pair, plan } = planned(name);
    const hiss = noise(pair.b.audio.left.length / rate + 1, rate, 7);
    const dense = (channel: Float32Array) => channel.map((v, i) => 0.85 * (v + 0.15 * hiss[i]!));
    const denseB = { left: dense(pair.b.audio.left), right: dense(pair.b.audio.right) };
    const { a, b } = excerptsFor(plan, pair.a.audio, denseB);
    const out = renderTransition({ ...plan, aGain: silent, bGain: fullGain, bLowDb: flatDb }, a, b);
    const bEnd = Math.round((plan.bResume - b.start) * rate);
    const fiftyMs = Math.round(0.05 * rate);
    const n = out.left.length;
    for (const side of ['left', 'right'] as const) {
      expect(maxDifference(out[side].subarray(n - fiftyMs), b[side].subarray(bEnd - fiftyMs, bEnd))).toBe(0);
    }
  });

  it.each(['long', 'quick, stretched', 'quick, cut', 'fade'])('%s: runs on into B as it plays from bResume, for the tail asked for', (name) => {
    const { pair, plan } = planned(name);
    const { a, b } = excerptsFor(plan, pair.a.audio, pair.b.audio, 3);
    const plain = renderTransition(plan, a, b);
    const out = renderTransition(plan, a, b, rate, 3);
    const n = plain.left.length;
    expect(out.left.length).toBe(n + 3 * rate);
    const bEnd = Math.round((plan.bResume - b.start) * rate);
    for (const side of ['left', 'right'] as const) {
      // The transition itself is unchanged, and B goes on from its sample at bResume, as its own file does.
      expect(maxDifference(out[side].subarray(0, n), plain[side])).toBe(0);
      expect(maxDifference(out[side].subarray(n), b[side].subarray(bEnd, bEnd + 3 * rate))).toBe(0);
    }
  });

  it.each(['long', 'quick, stretched', 'quick, cut', 'fade'])('%s: plays A as it is up to aStart first, for the lead asked for', (name) => {
    const { pair, plan } = planned(name);
    const ranges = excerptRanges(plan, 0, 2)!;
    expect(ranges.a[0]).toBeCloseTo(Math.max(0, plan.aStart - 2.25), 9);
    const a = excerpt(pair.a.audio, ...ranges.a);
    const b = excerpt(pair.b.audio, ...ranges.b);
    const plain = renderTransition(plan, a, b);
    const out = renderTransition(plan, a, b, rate, 0, 2);
    const lead = 2 * rate;
    expect(out.left.length).toBe(lead + plain.left.length);
    const aFrom = Math.round((plan.aStart - a.start) * rate);
    for (const side of ['left', 'right'] as const) {
      // A's own samples up to its sample at aStart, as its own file plays them, then the transition, unchanged.
      expect(maxDifference(out[side].subarray(0, lead), a[side].subarray(aFrom - lead, aFrom))).toBe(0);
      expect(maxDifference(out[side].subarray(lead), plain[side])).toBe(0);
    }
    // An excerpt that doesn't reach back that far is a caller's mistake.
    expect(() => renderTransition(plan, excerpt(pair.a.audio, plan.aStart - 1, ranges.a[1]), b, rate, 0, 2)).toThrow(/excerpt starts/);
  });

  it.each(['long', 'quick, stretched'])('%s: B’s kicks land on A’s through the overlap', (name) => {
    const { pair, plan } = planned(name);
    const { a, b } = excerptsFor(plan, pair.a.audio, pair.b.audio);
    // Each song alone, unfiltered, so its kicks are easy to find; the timing is all the plan's.
    const onlyA = renderTransition({ ...plan, aGain: fullGain, bGain: silent, aLowDb: flatDb, aHighPassHz: highPassOff }, a, b).left;
    const onlyB = renderTransition({ ...plan, aGain: silent, bGain: fullGain, bLowDb: flatDb }, a, b).left;
    // Measured a bar in, clear of the last notes of A's body still ringing at aStart.
    const beat = 60 / pair.a.map.bpm;
    const intoA = kickOnset(pair.a.audio.left, plan.aStart + 4 * beat) - (plan.aStart + 4 * beat);
    const bBeat = 60 / pair.b.map.bpm;
    const intoB = kickOnset(pair.b.audio.left, plan.bStart + 4 * bBeat) - (plan.bStart + 4 * bBeat);

    // A's beats from where B is matched to it until it ends: the overlap of a long blend, the whole
    // of a quick mix but its last moments, getting back to B's own speed.
    const matchedUntil = plan.style === 'long' ? plan.beats * beat : plan.length - OWN_TEMPO_HOLD - OWN_TEMPO_RAMP;
    let worst = 0;
    let checked = 0;
    for (let t = beat; t < matchedUntil - 0.03; t += beat) {
      const kickA = kickOnset(onlyA, t) - intoA;
      const kickB = kickOnset(onlyB, t) - intoB;
      worst = Math.max(worst, Math.abs(kickA - kickB));
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(plan.style === 'long' ? 30 : 6);
    expect(worst).toBeLessThan(0.002);
  });

  it('quick, cut: B is silent until the cut', () => {
    const { pair, plan } = planned('quick, cut');
    const { a, b } = excerptsFor(plan, pair.a.audio, pair.b.audio);
    const out = renderTransition(plan, a, b).left;
    const onlyA = renderTransition({ ...plan, bGain: silent }, a, b).left;
    const cut = Math.floor(plan.switchAt * rate);
    expect(maxDifference(out.subarray(0, cut), onlyA.subarray(0, cut))).toBe(0);
    expect(maxDifference(out.subarray(cut + TEN_MS), onlyA.subarray(cut + TEN_MS))).toBeGreaterThan(0.1);
  });

  it('straight: no transition audio and nothing to decode', () => {
    const { pair, plan } = planned('straight');
    expect(plan.style).toBe('straight');
    expect(excerptRanges(plan)).toBeUndefined();
    const whole = (s: SongOnDisk): Excerpt => ({ ...s.audio, start: 0 });
    const out = renderTransition(plan, whole(pair.a), whole(pair.b));
    expect(out.left.length).toBe(0);
    expect(out.right.length).toBe(0);
  });
});
