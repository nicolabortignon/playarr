import { describe, expect, it } from 'vitest';
import { integrate, valueAt } from './automation.ts';
import { planTransition, tempoRatio, type PlanInput } from './plan.ts';
import type { CuePoints, MixMap, TransitionPlan } from './types.ts';

type Song = MixMap & { cues?: CuePoints };

interface SongOptions extends Partial<MixMap> {
  cues?: CuePoints;
  /** Beats from the first downbeat to the end of the intro (default 40). */
  introBeats?: number;
  /** Beats from the start of the outro to the end of the sound (default 40). */
  outroBeats?: number;
}

/**
 * A mix map with sensible defaults: 124 BPM, 5 minutes, steady beat, 8A, 40-beat intro and outro.
 * Unless given, sound ends on a phrase line, so the outro's room in beats is easy to reason about.
 */
function song({ introBeats = 40, outroBeats = 40, ...overrides }: SongOptions = {}): Song {
  const bpm = overrides.bpm ?? 124;
  const firstBeat = overrides.firstBeat ?? 0.5;
  const downbeatOffset = overrides.downbeatOffset ?? 0;
  const duration = overrides.duration ?? 300;
  // Broken tempos (tested below) still get sensible section times, laid out at 124 BPM.
  const beat = 60 / (Number.isFinite(bpm) && bpm > 0 ? bpm : 124);
  const firstDownbeat = firstBeat + downbeatOffset * beat;
  const phrase = 16 * beat;
  const soundEnd = overrides.soundEnd ?? firstDownbeat + Math.floor((duration - 1 - firstDownbeat) / phrase) * phrase;
  return {
    version: 1,
    duration,
    bpm,
    firstBeat,
    downbeatOffset,
    gridStable: true,
    beatConfidence: 0.9,
    key: { camelot: '8A', confidence: 0.8 },
    introEnd: firstDownbeat + introBeats * beat,
    outroStart: soundEnd - outroBeats * beat,
    coldStart: false,
    coldEnd: false,
    soundEnd,
    phraseEnergy: [],
    ...overrides,
  };
}

function plan(a: Song, b: Song, extra: Partial<PlanInput> = {}): TransitionPlan {
  return planTransition({ a, b, mode: 'auto', sameAlbumInOrder: false, ...extra });
}

const beatOf = (m: MixMap) => 60 / m.bpm;
const barOf = (m: MixMap) => 4 * beatOf(m);
const firstDownbeatOf = (m: MixMap) => m.firstBeat + m.downbeatOffset * beatOf(m);
/** How many bars (or phrases, with 16) from the first downbeat a time is: whole on the grid. */
const linesFromFirstDownbeat = (m: MixMap, t: number, beatsPerLine: number) =>
  (t - firstDownbeatOf(m)) / (beatsPerLine * beatOf(m));
const isWhole = (x: number) => Math.abs(x - Math.round(x)) < 1e-6;
const onBar = (m: MixMap, t: number) => isWhole(linesFromFirstDownbeat(m, t, 4));
const onPhrase = (m: MixMap, t: number) => isWhole(linesFromFirstDownbeat(m, t, 16));

/** Downbeat times of a song within [from, to]. */
function downbeatsBetween(m: MixMap, from: number, to: number): number[] {
  const times: number[] = [];
  for (let t = firstDownbeatOf(m); t <= to + 1e-9; t += barOf(m)) if (t >= from - 1e-9) times.push(t);
  return times;
}

/** Transition time at which B reaches `bSeconds` of its own timeline (B's rate is always positive). */
function transitionTimeOfB(p: TransitionPlan, bSeconds: number): number {
  let low = 0;
  let high = p.length;
  for (let i = 0; i < 100; i++) {
    const middle = (low + high) / 2;
    if (p.bStart + integrate(p.bRate, 0, middle) < bSeconds) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

const overlapOf = (p: TransitionPlan, a: MixMap) => p.beats * beatOf(a);

describe('tempoRatio', () => {
  it.each([
    [124, 124, 1],
    [124, 126, 124 / 126],
    [87, 174, 1],
    [174, 87, 1],
    [174, 88, 87 / 88],
    [90, 128, 90 / 128], // 0.70 is closer to 1 than 1.41
  ])('%d over %d is %f', (aBpm, bBpm, expected) => {
    expect(tempoRatio(aBpm, bBpm)).toBeCloseTo(expected, 12);
  });
});

describe('planTransition: choosing the style', () => {
  interface Row {
    name: string;
    a?: SongOptions;
    b?: SongOptions;
    input?: Partial<PlanInput>;
    style: TransitionPlan['style'];
    reason?: RegExp;
  }
  const rows: Row[] = [
    { name: 'No mixing on the queue', input: { mode: 'off' }, style: 'straight', reason: /^No mixing: straight on$/ },
    { name: 'same album, in order', input: { sameAlbumInOrder: true }, style: 'straight', reason: /^Same album, in order: straight on$/ },
    { name: 'A has no steady beat', a: { beatConfidence: 0.2 }, style: 'fade', reason: /^No steady beat: crossfade$/ },
    { name: 'B has no steady beat', b: { beatConfidence: 0.34 }, style: 'fade' },
    { name: 'a beat confidence of exactly 0.35 is steady', a: { beatConfidence: 0.35 }, style: 'long' },
    { name: 'a tempo of 0 is no steady beat', a: { bpm: 0 }, style: 'fade', reason: /^No steady beat: crossfade$/ },
    { name: 'a tempo that isn’t a number is no steady beat', b: { bpm: Number.NaN }, style: 'fade' },
    { name: 'an endless tempo, B starts abruptly', b: { bpm: Number.POSITIVE_INFINITY, coldStart: true }, style: 'straight' },
    { name: 'no steady beat, A ends abruptly', a: { beatConfidence: 0.2, coldEnd: true }, style: 'straight' },
    { name: 'no steady beat, B starts abruptly', b: { beatConfidence: 0.2, coldStart: true }, style: 'straight' },
    { name: 'no steady beat, cold only away from the join', a: { beatConfidence: 0.2, coldStart: true }, b: { coldEnd: true }, style: 'fade' },
    { name: 'abrupt end into abrupt start, tempos far apart', a: { coldEnd: true }, b: { coldStart: true, bpm: 140 }, style: 'straight' },
    { name: 'abrupt end into abrupt start, tempos close', a: { coldEnd: true }, b: { coldStart: true, bpm: 126 }, style: 'long' },
    { name: 'tempos 11% apart', b: { bpm: 140 }, style: 'quick', reason: /^Tempos 11% apart: quick mix$/ },
    { name: 'tempos 11% apart, beat confidence exactly 0.5', a: { beatConfidence: 0.5 }, b: { bpm: 140 }, style: 'quick' },
    { name: 'tempos 11% apart and an unsure beat', a: { beatConfidence: 0.45 }, b: { bpm: 140 }, style: 'fade', reason: /crossfade$/ },
    {
      name: 'tempos 11% apart, an unsure beat and an abrupt end',
      a: { beatConfidence: 0.45, coldEnd: true },
      b: { bpm: 140 },
      style: 'straight',
      reason: /^Tempos 11% apart, an unsure beat and an abrupt edge: straight on$/,
    },
    { name: 'tempos exactly 8% apart still blend', a: { bpm: 108 }, b: { bpm: 100 }, style: 'long', reason: /^Tempos 8% apart/ },
    { name: 'the beat grid drifts', b: { gridStable: false }, style: 'quick', reason: /quick mix$/ },
    { name: 'keys clash', b: { key: { camelot: '3B', confidence: 0.9 } }, style: 'quick', reason: /^Keys clash \(8A, 3B\): quick mix$/ },
    { name: 'neighbouring keys', b: { key: { camelot: '9A', confidence: 0.9 } }, style: 'long' },
    { name: 'keys clash but one is unsure', b: { key: { camelot: '3B', confidence: 0.2 } }, style: 'long' },
    { name: 'keys clash, key confidence exactly 0.3', b: { key: { camelot: '3B', confidence: 0.3 } }, style: 'quick' },
    { name: 'a key is unknown', b: { key: undefined }, style: 'long', reason: /key unknown/ },
    { name: 'A’s outro too short', a: { outroBeats: 12 }, style: 'quick', reason: /room/ },
    { name: 'B’s intro too short', b: { introBeats: 12 }, style: 'quick', reason: /room/ },
    { name: 'half-time tempos count as close', a: { bpm: 87 }, b: { bpm: 174 }, style: 'long' },
    { name: 'close tempos, same key', b: { bpm: 126 }, style: 'long', reason: /^Tempos 2% apart, keys compatible: 32-beat blend$/ },
  ];

  it.each(rows)('$name → $style', ({ a, b, input, style, reason }) => {
    const result = plan(song(a), song(b), input);
    expect(result.style).toBe(style);
    if (reason) expect(result.reason).toMatch(reason);
  });

  it('A’s cue point overrides its detected outro', () => {
    const a = song({ outroBeats: 12 });
    expect(plan(a, song()).style).toBe('quick');
    const withCue = { ...a, cues: { mixOut: a.soundEnd - 40 * beatOf(a) } };
    expect(plan(withCue, song()).style).toBe('long');
  });

  it('B’s cue point overrides its detected intro, either way', () => {
    const shortIntro = song({ introBeats: 12 });
    const roomyCue = { ...shortIntro, cues: { mixIn: firstDownbeatOf(shortIntro) + 40 * beatOf(shortIntro) } };
    expect(plan(song(), roomyCue).style).toBe('long');
    const longIntro = song({ introBeats: 40 });
    const tightCue = { ...longIntro, cues: { mixIn: firstDownbeatOf(longIntro) + 12 * beatOf(longIntro) } };
    expect(plan(song(), tightCue).style).toBe('quick');
  });

  describe('blend length', () => {
    it.each([
      // [A outro beats, B intro beats, auto, party]
      [20, 20, 16, 16],
      [40, 40, 32, 32],
      [80, 80, 32, 64],
      [80, 40, 32, 32],
      [140, 140, 64, 64],
      [140, 40, 32, 32],
    ])('outro %i, intro %i: auto %i beats, party %i', (outroBeats, introBeats, auto, party) => {
      const a = song({ outroBeats });
      const b = song({ introBeats, bpm: 125 });
      expect(plan(a, b, { mode: 'auto' })).toMatchObject({ style: 'long', beats: auto });
      expect(plan(a, b, { mode: 'party' })).toMatchObject({ style: 'long', beats: party });
    });

    it('party is longer than auto when the room allows', () => {
      const a = song({ outroBeats: 96 });
      const b = song({ introBeats: 96 });
      expect(plan(a, b, { mode: 'party' }).length).toBeGreaterThan(plan(a, b, { mode: 'auto' }).length);
    });

    it('party takes 32 beats inside a 70-beat outro rather than 64 starting before it', () => {
      // The first phrase line in the outro leaves 57 beats: 64 would have to start before the outro.
      const a = song({ outroBeats: 70, soundEnd: 299 });
      const p = plan(a, song({ introBeats: 70 }), { mode: 'party' });
      expect(p).toMatchObject({ style: 'long', beats: 32 });
      expect(p.aStart).toBeGreaterThanOrEqual(a.outroStart);
    });
  });
});

describe('planTransition: a long blend', () => {
  const pairs: [string, SongOptions, SongOptions][] = [
    ['124 into 127.3', { bpm: 124, firstBeat: 0.37, downbeatOffset: 1 }, { bpm: 127.3, firstBeat: 0.81, downbeatOffset: 3 }],
    ['128 into 122', { bpm: 128, firstBeat: 0.05, downbeatOffset: 2, duration: 412.3 }, { bpm: 122, firstBeat: 1.4, downbeatOffset: 0 }],
    ['party, 120 into 121', { bpm: 120, firstBeat: 0.2, outroBeats: 100 }, { bpm: 121, firstBeat: 0.6, introBeats: 100 }],
    ['124 into 125, mix-out cue at 250 s', { cues: { mixOut: 250 } }, { bpm: 125 }],
  ];

  describe.each(pairs)('%s', (_name, aOptions, bOptions) => {
    const a = song(aOptions);
    const b = song(bOptions);
    const p = plan(a, b, { mode: 'party' });
    const overlap = overlapOf(p, a);
    const r = a.bpm / b.bpm;

    it('is a long blend', () => {
      expect(p.style).toBe('long');
      expect([16, 32, 64]).toContain(p.beats);
    });

    it('starts on a phrase line inside A’s outro (or after its cue), and B on one of its own phrase lines', () => {
      expect(onPhrase(a, p.aStart)).toBe(true);
      expect(p.aStart).toBeGreaterThanOrEqual(a.cues?.mixOut ?? a.outroStart);
      expect(p.aStart + overlap).toBeLessThanOrEqual(a.soundEnd + 1e-9);
      expect(onPhrase(b, p.bStart)).toBe(true);
    });

    it('lines B’s downbeats up with A’s to within a millisecond through the overlap', () => {
      const bDownbeats = downbeatsBetween(b, p.bStart, p.bStart + overlap * r);
      expect(bDownbeats.length).toBeGreaterThanOrEqual(p.beats / 4);
      const aDownbeatsInTransition = downbeatsBetween(a, p.aStart, p.aStart + overlap).map((t) => t - p.aStart);
      for (const downbeat of bDownbeats) {
        const t = transitionTimeOfB(p, downbeat);
        const nearest = Math.min(...aDownbeatsInTransition.map((aT) => Math.abs(aT - t)));
        expect(nearest).toBeLessThan(0.001);
      }
    });

    it('stretches B to A’s tempo, then eases back to its own over 16 of its own bars', () => {
      const easeBack = (2 * 64 * beatOf(b)) / (r + 1);
      expect(valueAt(p.bRate, 0)).toBeCloseTo(r, 12);
      expect(valueAt(p.bRate, overlap)).toBeCloseTo(r, 12);
      expect(valueAt(p.bRate, overlap + easeBack / 2)).toBeCloseTo((r + 1) / 2, 12);
      expect(valueAt(p.bRate, overlap + easeBack)).toBe(1);
      expect(p.length).toBeCloseTo(overlap + easeBack, 9);
      // As heard: the ease-back plays exactly 64 of B's beats.
      expect(integrate(p.bRate, overlap, p.length)).toBeCloseTo(64 * beatOf(b), 9);
    });

    it('resumes B where the stretched transition leaves it: on one of B’s bar lines, before its outro', () => {
      expect(p.bResume).toBeCloseTo(p.bStart + integrate(p.bRate, 0, p.length), 9);
      expect(onBar(b, p.bResume)).toBe(true);
      expect(p.bResume).toBeLessThanOrEqual(b.outroStart);
    });

    it('swaps the bass on an A bar line at the middle of the overlap, and switches there', () => {
      expect(onBar(a, p.aStart + p.switchAt)).toBe(true);
      expect(Math.abs(p.switchAt - overlap / 2)).toBeLessThanOrEqual(barOf(a) / 2 + 1e-9);
      expect(valueAt(p.aLowDb, p.switchAt - beatOf(a))).toBe(0);
      expect(valueAt(p.aLowDb, p.switchAt)).toBe(-24);
      expect(valueAt(p.bLowDb, p.switchAt - beatOf(a))).toBe(-24);
      expect(valueAt(p.bLowDb, p.switchAt)).toBe(0);
      expect(p.aHighPassHz).toEqual([{ at: 0, value: 20 }]);
    });

    it('brings B in over the first quarter and takes A out over the last quarter', () => {
      expect(valueAt(p.bGain, 0)).toBe(0);
      expect(valueAt(p.bGain, overlap * 0.125)).toBeGreaterThan(0.6); // equal power: ≈ 0.71 halfway
      expect(valueAt(p.bGain, overlap * 0.25)).toBeCloseTo(1, 12);
      expect(valueAt(p.bGain, p.length)).toBeCloseTo(1, 12);
      expect(valueAt(p.aGain, overlap * 0.75)).toBeCloseTo(1, 12);
      expect(valueAt(p.aGain, overlap * 0.875)).toBeGreaterThan(0.6);
      expect(valueAt(p.aGain, overlap)).toBeCloseTo(0, 12);
      expect(p.aGain.length).toBeGreaterThanOrEqual(9);
      expect(p.bGain.length).toBeGreaterThanOrEqual(8);
    });
  });

  it('half-time tempos: B plays at its own speed and every A downbeat meets a B downbeat', () => {
    const a = song({ bpm: 87, firstBeat: 0.3 });
    const b = song({ bpm: 174, firstBeat: 0.2, introBeats: 80 });
    const p = plan(a, b);
    expect(p.style).toBe('long');
    expect(p.bRate).toEqual([{ at: 0, value: 1 }]);
    expect(p.length).toBeCloseTo(overlapOf(p, a), 9); // nothing to ease back from
    const overlap = overlapOf(p, a);
    for (const downbeat of downbeatsBetween(a, p.aStart, p.aStart + overlap)) {
      expect(onBar(b, p.bStart + (downbeat - p.aStart))).toBe(true);
    }
  });

  it('A’s mix-out cue moves where A leaves, B’s mix-in cue where B lands', () => {
    const a = song({ outroBeats: 40 });
    const b = song({ introBeats: 40 });
    const detected = plan(a, b);
    const mixOut = a.soundEnd - 120 * beatOf(a);
    const mixIn = firstDownbeatOf(b) + 96 * beatOf(b);
    const cued = plan({ ...a, cues: { mixOut } }, { ...b, cues: { mixIn } });
    expect(cued.style).toBe('long');
    expect(cued.aStart).toBeLessThan(detected.aStart);
    expect(cued.aStart).toBeGreaterThanOrEqual(mixOut);
    expect(cued.aStart - mixOut).toBeLessThan(16 * beatOf(a));
    expect(cued.bStart).toBeGreaterThan(detected.bStart);
    // B's phrase line nearest to where the overlap would end at the mix-in point.
    const overlapInB = overlapOf(cued, a) * (a.bpm / b.bpm);
    expect(Math.abs(cued.bStart - (mixIn - overlapInB))).toBeLessThanOrEqual(8 * beatOf(b) + 1e-9);
  });

  it.each([undefined, 30, 200, 245, 255, 262])('never starts before A’s position + 5 s (position %s)', (aPosition) => {
    const a = song({ outroBeats: 100 });
    const p = plan(a, song({ introBeats: 64 }), { aPosition });
    expect(p.style).toBe('long');
    if (aPosition !== undefined) expect(p.aStart).toBeGreaterThanOrEqual(aPosition + 5);
    expect(onPhrase(a, p.aStart)).toBe(true);
    expect(p.aStart + overlapOf(p, a)).toBeLessThanOrEqual(a.soundEnd + 1e-9);
  });

  describe('a short B', () => {
    // B at 126: intro ends 17.6 s in; a 32-beat blend hands over at 15.7 s, the ease-back would run to 46 s.
    const a = song();
    const shortB = (outroStart: number) => song({ bpm: 126, duration: 60, soundEnd: 59, introBeats: 36, outroStart });

    it('drops the whole ease-back rather than resume inside its outro', () => {
      const b = shortB(39.95);
      const p = plan(a, b);
      expect(p.style).toBe('long');
      expect(p.bRate).toEqual([{ at: 0, value: tempoRatio(a.bpm, b.bpm) }]);
      expect(p.length).toBeCloseTo(overlapOf(p, a), 9);
      expect(p.bResume).toBeCloseTo(p.bStart + integrate(p.bRate, 0, p.length), 9);
      expect(p.bResume).toBeLessThanOrEqual(b.outroStart);
    });

    it('a quick mix when even a plain blend would resume inside its outro', () => {
      const p = plan(a, shortB(15));
      expect(p.style).toBe('quick');
      expect(p.reason).toBe('B’s outro comes too soon for a blend: quick mix');
    });
  });

  it('a hand-set mix-out cue close to the end: a quick mix from the cue, never before it', () => {
    const a = song({ soundEnd: 299 });
    const mixOut = 299 - 10 * beatOf(a);
    const p = plan({ ...a, cues: { mixOut } }, song());
    expect(p.style).toBe('quick');
    expect(p.aStart).toBeGreaterThanOrEqual(mixOut);
    expect(p.aStart + p.length).toBeLessThanOrEqual(299 + 1e-9);
  });

  it('a hand-set mix-out cue with no room after it at all: straight on rather than leave early', () => {
    const a = song({ soundEnd: 299 });
    expect(plan({ ...a, cues: { mixOut: 298 } }, song()).style).toBe('straight');
  });

  it('a detected outro with no room: a quick mix from the phrase line before it, at most a phrase early', () => {
    const a = song({ soundEnd: 299, outroStart: 298 });
    const p = plan(a, song());
    expect(p.style).toBe('quick');
    expect(p.aStart).toBeLessThan(a.outroStart);
    expect(p.aStart).toBeGreaterThanOrEqual(a.outroStart - 16 * beatOf(a));
  });

  it('too late for any phrase line: a quick mix at the next downbeat after A’s position + 5 s', () => {
    // Phrase lines at 0.5 + 7.742k: the last one before the end (294.7) is too close to 290 + 5.
    const a = song({ soundEnd: 299 });
    const aPosition = 290;
    const p = plan(a, song(), { aPosition });
    expect(p.style).toBe('quick');
    expect(p.aStart).toBeGreaterThanOrEqual(aPosition + 5);
    expect(p.aStart - (aPosition + 5)).toBeLessThan(barOf(a));
    expect(onBar(a, p.aStart)).toBe(true);
    expect(p.aStart + p.length).toBeLessThanOrEqual(a.soundEnd);
  });

  it('past the end of A: straight on', () => {
    const a = song();
    expect(plan(a, song(), { aPosition: a.duration - 1 }).style).toBe('straight');
  });
});

describe('planTransition: a quick mix', () => {
  it.each([
    ['keys clash, tempos close', { bpm: 124 }, { bpm: 125, key: { camelot: '3B' as const, confidence: 0.9 } }],
    ['keys clash, half-time tempos close', { bpm: 87 }, { bpm: 175, key: { camelot: '3B' as const, confidence: 0.9 } }],
  ])('%s: B stretched to A, crossfading over the last two beats', (_name, aOptions, bOptions) => {
    const a = song(aOptions);
    const b = song(bOptions);
    const p = plan(a, b);
    expect(p.style).toBe('quick');
    expect([4, 8]).toContain(p.beats);
    const overlap = overlapOf(p, a);
    expect(p.length).toBeCloseTo(overlap, 9);
    expect(p.bRate).toEqual([{ at: 0, value: tempoRatio(a.bpm, b.bpm) }]);
    expect(p.bResume).toBeCloseTo(p.bStart + integrate(p.bRate, 0, p.length), 9);

    // A leaves on a phrase line: the crossfade finishes there, inside A's outro, as B lands on a downbeat.
    expect(onPhrase(a, p.aStart + overlap)).toBe(true);
    expect(p.aStart).toBeGreaterThanOrEqual(a.outroStart);
    expect(onBar(b, p.bResume)).toBe(true);

    const crossfade = overlap - 2 * beatOf(a);
    expect(p.switchAt).toBeCloseTo(crossfade, 9);
    expect(valueAt(p.aGain, crossfade)).toBe(1);
    expect(valueAt(p.aGain, overlap)).toBeCloseTo(0, 12);
    expect(valueAt(p.bGain, crossfade)).toBe(0);
    expect(valueAt(p.bGain, overlap)).toBeCloseTo(1, 12);
    expect(valueAt(p.aHighPassHz, 0)).toBe(20);
    // Exponential: halfway through the sweep is near √(20 × 800) ≈ 126 Hz, not the linear 410 Hz.
    expect(valueAt(p.aHighPassHz, overlap / 2)).toBeGreaterThan(110);
    expect(valueAt(p.aHighPassHz, overlap / 2)).toBeLessThan(150);
    expect(valueAt(p.aHighPassHz, overlap)).toBeCloseTo(800, 9);
    expect(p.aLowDb).toEqual([{ at: 0, value: 0 }]);
    expect(p.bLowDb).toEqual([{ at: 0, value: 0 }]);
  });

  it.each([
    ['keys clash, tempos 5% apart', { bpm: 124 }, { bpm: 130, key: { camelot: '3B' as const, confidence: 0.9 } }],
    ['tempos 11% apart', { bpm: 124 }, { bpm: 140 }],
  ])('%s: B unstretched, so a cut on the downbeat with no overlapping beat', (_name, aOptions, bOptions) => {
    const a = song(aOptions);
    const b = song(bOptions);
    const p = plan(a, b);
    const beat = beatOf(a);
    expect(p.style).toBe('quick');
    expect(p.bRate).toEqual([{ at: 0, value: 1 }]);
    expect(p.length).toBeCloseTo(p.switchAt + beat, 9);
    expect(p.bResume).toBeCloseTo(p.bStart + p.length, 9);

    // The cut is on a phrase line of A inside its outro, and B is on one of its bar lines right there.
    expect(onPhrase(a, p.aStart + p.switchAt)).toBe(true);
    expect(p.aStart).toBeGreaterThanOrEqual(a.outroStart);
    expect(onBar(b, p.bStart + p.switchAt)).toBe(true);

    // B is silent until the cut, then fully in within 20 ms.
    for (const point of p.bGain) if (point.at < p.switchAt) expect(point.value).toBe(0);
    expect(valueAt(p.bGain, p.switchAt)).toBe(0);
    expect(valueAt(p.bGain, p.switchAt + 0.02)).toBe(1);

    // A rings on for one beat, its kick filtered away, fading out.
    expect(valueAt(p.aGain, p.switchAt)).toBe(1);
    expect(valueAt(p.aGain, p.switchAt + beat)).toBeCloseTo(0, 12);
    expect(valueAt(p.aHighPassHz, 0)).toBe(20);
    expect(valueAt(p.aHighPassHz, p.switchAt)).toBeGreaterThanOrEqual(800);
    expect(valueAt(p.aHighPassHz, p.switchAt + beat / 2)).toBeGreaterThanOrEqual(800);
  });
});

describe('planTransition: a crossfade', () => {
  it('fades over up to 8 seconds from A’s outro, both at their own speed', () => {
    const a = song({ beatConfidence: 0.1 });
    const p = plan(a, song());
    expect(p).toMatchObject({ style: 'fade', length: 8, bStart: 0, bResume: 8, switchAt: 4, beats: 0 });
    expect(p.aStart).toBeCloseTo(a.outroStart, 9);
    expect(p.bRate).toEqual([{ at: 0, value: 1 }]);
    expect(valueAt(p.aGain, 0)).toBe(1);
    expect(valueAt(p.aGain, 8)).toBeCloseTo(0, 12);
    expect(valueAt(p.bGain, 0)).toBe(0);
    expect(valueAt(p.bGain, 8)).toBeCloseTo(1, 12);
    expect(p.aHighPassHz).toEqual([{ at: 0, value: 20 }]);
  });

  it('a short outro makes a shorter fade', () => {
    const a = song({ beatConfidence: 0.1, soundEnd: 299, outroStart: 296 });
    const p = plan(a, song());
    expect(p.style).toBe('fade');
    expect(p.length).toBeCloseTo(3, 9);
    expect(p.switchAt).toBeCloseTo(1.5, 9);
  });

  it('never starts before A’s position + 5 s', () => {
    const a = song({ beatConfidence: 0.1, soundEnd: 299 });
    const p = plan(a, song(), { aPosition: 288 });
    expect(p.style).toBe('fade');
    expect(p.aStart).toBeGreaterThanOrEqual(293);
    expect(p.aStart + p.length).toBeLessThanOrEqual(a.soundEnd + 1e-9);
  });

  it('too close to the end to fade: straight on', () => {
    const a = song({ beatConfidence: 0.1, soundEnd: 299 });
    const p = plan(a, song(), { aPosition: 293.5 });
    expect(p.style).toBe('straight');
    expect(p.reason).toBe('Too close to the end to fade: straight on');
  });
});

describe('planTransition: straight on', () => {
  it('is A to its end, then B from its start', () => {
    const a = song();
    const p = plan(a, song(), { mode: 'off' });
    expect(p).toMatchObject({ style: 'straight', aStart: a.duration, bStart: 0, length: 0, bResume: 0, switchAt: 0, beats: 0 });
  });
});

describe('planTransition: broken mix maps never make a broken plan', () => {
  const broken: [string, SongOptions][] = [
    ['zero duration', { duration: 0, soundEnd: 0, outroStart: 0, introEnd: 0 }],
    ['first beat past the end', { firstBeat: 1000 }],
    ['negative first beat', { firstBeat: -3 }],
    ['tempo 0', { bpm: 0 }],
    ['tempo not a number', { bpm: Number.NaN }],
    ['endless tempo', { bpm: Number.POSITIVE_INFINITY }],
    ['negative tempo', { bpm: -120 }],
    ['1 BPM', { bpm: 1 }],
    ['1000 BPM', { bpm: 1000 }],
    ['sound past the end', { soundEnd: 400 }],
    ['outro after the sound', { outroStart: 350 }],
    ['outro before the start', { outroStart: -20 }],
    ['outro not a number', { outroStart: Number.NaN }],
    ['intro past the end', { introEnd: 500 }],
    ['very short song', { duration: 3, soundEnd: 2.5, outroStart: 1, introEnd: 1 }],
  ];
  const fine = song();
  const cases: [string, Song, Song, number | undefined][] = [];
  for (const [name, options] of broken) {
    cases.push([`A: ${name}`, song(options), fine, undefined]);
    cases.push([`B: ${name}`, fine, song(options), undefined]);
    cases.push([`both: ${name}`, song(options), song(options), 100]);
  }
  cases.push(['A’s position past its end', fine, fine, 1e6]);
  cases.push(['A’s position before its start', fine, fine, -50]);

  it.each(cases)('%s', (_name, a, b, aPosition) => {
    for (const mode of ['auto', 'party'] as const) {
      const p = plan(a, b, { mode, aPosition });
      const numbers = [p.aStart, p.bStart, p.length, p.bResume, p.switchAt, p.beats];
      for (const curve of [p.bRate, p.aGain, p.bGain, p.aLowDb, p.bLowDb, p.aHighPassHz]) {
        expect(curve.length).toBeGreaterThan(0);
        for (const point of curve) numbers.push(point.at, point.value);
      }
      for (const value of numbers) expect(Number.isFinite(value)).toBe(true);
      expect(p.aStart).toBeGreaterThanOrEqual(0);
      expect(p.aStart).toBeLessThanOrEqual(Math.max(0, a.duration));
      expect(p.bStart).toBeGreaterThanOrEqual(0);
      expect(p.length).toBeGreaterThanOrEqual(0);
    }
  });
});
