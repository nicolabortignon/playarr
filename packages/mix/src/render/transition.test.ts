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

function excerptsFor(plan: TransitionPlan, a: StereoAudio = songA, b: StereoAudio = songB): { a: Excerpt; b: Excerpt } {
  const ranges = excerptRanges(plan)!;
  return { a: excerpt(a, ...ranges.a), b: excerpt(b, ...ranges.b) };
}

const TEN_MS = Math.round(0.01 * rate);

/**
 * The seams with the songs playing on their own: the first `head` samples of the transition are A
 * from aStart, and its last 10 ms are B up to bResume, rounded to a sample. B is allowed a sample's
 * slack either way: the time-stretch rounds where it reads to whole samples.
 */
function expectSeamless(plan: TransitionPlan, a: Excerpt, b: Excerpt, out: StereoAudio, head = TEN_MS): void {
  const aFrom = Math.round((plan.aStart - a.start) * rate);
  const bEnd = Math.round((plan.bResume - b.start) * rate);
  const n = out.left.length;
  for (const side of ['left', 'right'] as const) {
    expect(maxDifference(out[side].subarray(0, head), a[side].subarray(aFrom, aFrom + head)), `${side}: start`).toBeLessThan(1e-3);
    const tail = out[side].subarray(n - TEN_MS);
    const misses = [-1, 0, 1].map((lag) => maxDifference(tail, b[side].subarray(bEnd + lag - TEN_MS, bEnd + lag)));
    expect(Math.min(...misses), `${side}: end`).toBeLessThan(1e-3);
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

  it.each(['aStart', 'bStart', 'length'] as const)('refuses a plan whose %s is not a number', (field) => {
    const plan = longPlan();
    const { a, b } = excerptsFor(plan);
    for (const broken of [NaN, Infinity]) {
      expect(() => renderTransition({ ...plan, [field]: broken }, a, b)).toThrow(new RegExp(`plan's ${field} is`));
      expect(() => excerptRanges({ ...plan, [field]: broken })).toThrow(RangeError);
    }
  });

  it('refuses a plan that resumes B somewhere its rate doesn’t take it', () => {
    const plan = longPlan();
    const { a, b } = excerptsFor(plan);
    expect(() => renderTransition({ ...plan, bResume: plan.bResume + 0.5 }, a, b)).toThrow(/resumes B at/);
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

  it('comes back to unity gain after a loud moment', () => {
    const signal = sine(100, 0.5, 2);
    for (let i = rate / 2; i < rate / 2 + 2000; i++) signal[i]! *= 3; // a 45 ms burst at 1.5
    const audio = stereo(signal);
    const original = audio.left.slice();
    limitLoudness(audio, rate);
    expect(maxDifference(audio.left.subarray(0, rate / 2 - 300), original.subarray(0, rate / 2 - 300))).toBe(0);
    // A second later (ten release time constants) the gain is back within 0.01%.
    expect(maxDifference(audio.left.subarray(1.6 * rate), original.subarray(1.6 * rate))).toBeLessThan(1e-4);
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

const clash = (camelot: '8A' | '3B') => ({ key: { camelot, confidence: 0.9 } });

/** Each style with a pair of songs that the planner gives it. */
const PAIRS: Record<string, { style: TransitionStyle; a: SongOnDisk; b: SongOnDisk; mode?: PlanInput['mode'] }> = {
  // 120 into 124 (3.3%), keys unknown, roomy intro and outro: a 32-beat blend and an ease-back.
  long: {
    style: 'long',
    a: mixSong(120, { introBeats: 16, bodyBeats: 32, outroBeats: 48 }),
    b: mixSong(124, { introBeats: 64, bodyBeats: 96, outroBeats: 16 }),
  },
  // 124 into 126 (1.6%), keys clash: a quick mix with B stretched.
  'quick, stretched': {
    style: 'quick',
    a: mixSong(124, { introBeats: 16, bodyBeats: 32, outroBeats: 32 }, clash('8A')),
    b: mixSong(126, { introBeats: 32, bodyBeats: 64, outroBeats: 16 }, clash('3B')),
  },
  // 124 into 130 (4.8%), keys clash: a cut, B at its own speed.
  'quick, cut': {
    style: 'quick',
    a: mixSong(124, { introBeats: 16, bodyBeats: 32, outroBeats: 32 }, clash('8A')),
    b: mixSong(130, { introBeats: 32, bodyBeats: 64, outroBeats: 16 }, clash('3B')),
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
