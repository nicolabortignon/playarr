import { describe, expect, it } from 'vitest';
import { chord, clickTrack, noise, song } from '../testSignals.ts';
import { beatGrid } from './beatGrid.ts';
import { downbeats } from './downbeats.ts';
import { analyzeOnsets } from './onset.ts';
import { sections } from './sections.ts';

const RATE = 11025;

/** The whole analysis chain on one signal, the way the mix analysis runs it. */
function analyse(samples: Float32Array) {
  const frames = analyzeOnsets(samples, RATE);
  const grid = beatGrid(frames);
  const duration = samples.length / RATE;
  const found = downbeats(frames, grid, duration);
  return { grid, found, ...sections(frames, grid, found, duration) };
}

/**
 * A song built from sections of whole beats at 128 BPM, first beat at 0.5 s: `kick` (kick and
 * ticks only), `body` (adds a chord and a snare on beats 2 and 4), `light` (a body with its kick 9 dB
 * lighter, as a filtered intro's) and `pad` (a chord, no beat). The kick is accented on the "one"
 * unless `equalKicks`. Returns the samples and each section's start.
 */
function build(spec: [kind: 'kick' | 'body' | 'light' | 'pad', beats: number][], { equalKicks = false, padLevel = 1 } = {}) {
  const bpm = 128;
  const beat = 60 / bpm;
  const total = spec.reduce((sum, [, n]) => sum + n, 0);
  const samples = clickTrack({ bpm, seconds: 0.5 + total * beat + 1.5, rate: RATE, accentEvery: equalKicks ? 1 : 4 }).samples;
  samples.fill(0, Math.round((0.5 + total * beat) * RATE));
  const starts: number[] = [];
  let at = 0;
  for (const [kind, n] of spec) {
    starts.push(0.5 + at * beat);
    const from = Math.round((0.5 + at * beat) * RATE);
    if (kind === 'pad') samples.fill(0, from, Math.round((0.5 + (at + n) * beat) * RATE));
    if (kind === 'light') for (let i = from; i < Math.round((0.5 + (at + n) * beat) * RATE); i++) samples[i]! *= 0.35;
    if (kind !== 'kick') {
      const level = kind === 'pad' ? padLevel : 1;
      chord({ root: 'A', minor: true, seconds: n * beat, rate: RATE }).forEach((v, i) => (samples[from + i]! += level * v));
    }
    if (kind === 'body' || kind === 'light') {
      for (let b = at + 1; b < at + n; b += 2) {
        const snare = noise(0.1, RATE, b);
        const start = Math.round((0.5 + b * beat) * RATE);
        snare.forEach((v, i) => (samples[start + i]! += 0.7 * v * Math.exp(-i / RATE / 0.02)));
      }
    }
    at += n;
  }
  return { samples, starts, beat };
}

/** `seconds` of silence before `samples`. */
function afterSilence(seconds: number, samples: Float32Array): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE) + samples.length);
  out.set(samples, Math.round(seconds * RATE));
  return out;
}

describe('sections', () => {
  it('finds the intro and outro of a dance-shaped song to within a beat', () => {
    for (const bpm of [128, 124, 97.3]) {
      const { samples, truth } = song({ bpm, rate: RATE, introBeats: 32, bodyBeats: 64, outroBeats: 32 });
      const result = analyse(samples);
      const beat = 60 / bpm;
      expect(Math.abs(result.introEnd - truth.introEnd), `${bpm} BPM intro`).toBeLessThan(beat);
      expect(Math.abs(result.outroStart - truth.outroStart), `${bpm} BPM outro`).toBeLessThan(beat);
      // The body is where the energy jumps: the first drop is the end of the intro.
      expect(Math.abs(result.firstDrop! - truth.introEnd), `${bpm} BPM drop`).toBeLessThan(beat);
      expect(Math.abs(result.soundEnd - truth.soundEnd), `${bpm} BPM sound end`).toBeLessThan(0.05);
      // A kick-only intro and outro are not full sound: neither start nor end is cold.
      expect(result.coldStart).toBe(false);
      expect(result.coldEnd).toBe(false);
    }
  });

  it('calls an intro and outro with full chords but a lighter kick intro and outro, out of the main groove', () => {
    const { samples, starts, beat } = build([
      ['light', 32],
      ['body', 64],
      ['light', 32],
    ]);
    const result = analyse(samples);
    expect(Math.abs(result.introEnd - starts[1]!)).toBeLessThan(beat);
    expect(Math.abs(result.outroStart - starts[2]!)).toBeLessThan(beat);
  });

  it('puts the intro end at the start when the song starts full, and calls the start cold', () => {
    const track = song({ bpm: 128, rate: RATE, introBeats: 32, bodyBeats: 64, outroBeats: 32, startDense: true });
    const result = analyse(track.samples);
    expect(Math.abs(result.introEnd - track.truth.introEnd)).toBeLessThan(60 / 128);
    expect(Math.abs(result.outroStart - track.truth.outroStart)).toBeLessThan(60 / 128);
    expect(result.coldStart).toBe(true);
    expect(result.firstDrop).toBeUndefined();
  });

  it('calls an abrupt full ending cold, and a fade-out not', () => {
    const options = { bpm: 128, rate: RATE, introBeats: 32, bodyBeats: 64, outroBeats: 0 };
    const abrupt = analyse(song(options).samples);
    expect(abrupt.coldEnd).toBe(true);
    // The body's chord rings to where the outro would have started; the song ends dense there.
    const bodyEnd = song(options).truth.outroStart;
    expect(Math.abs(abrupt.soundEnd - bodyEnd)).toBeLessThan(0.05);
    expect(abrupt.outroStart).toBeLessThanOrEqual(abrupt.soundEnd);
    expect(abrupt.outroStart).toBeGreaterThan(bodyEnd - 60 / 128);

    const faded = analyse(song({ ...options, fadeOutSeconds: 10 }).samples);
    expect(faded.coldEnd).toBe(false);
  });

  it('skips leading silence', () => {
    const plain = song({ bpm: 128, rate: RATE, introBeats: 32, bodyBeats: 64, outroBeats: 32 });
    const result = analyse(afterSilence(3, plain.samples));
    expect(Math.abs(result.introEnd - (plain.truth.introEnd + 3))).toBeLessThan(60 / 128);
    expect(Math.abs(result.soundEnd - (plain.truth.soundEnd + 3))).toBeLessThan(0.05);
    expect(result.coldStart).toBe(false);
    // Phrases count from the music's first downbeat: the song's first beat, 3 s later.
    expect(Math.abs(result.firstPhrase - 3.5)).toBeLessThan(0.02);

    const dense = song({ bpm: 128, rate: RATE, introBeats: 0, bodyBeats: 64, outroBeats: 32, startDense: true });
    expect(analyse(afterSilence(3, dense.samples)).coldStart).toBe(true);
  });

  it('tells a cold start and end without a beat grid', () => {
    const noGrid = { bpm: 0, firstBeat: 0 };
    const nothing = { downbeatOffset: 0, phraseEnergy: [] };
    const held = new Float32Array(32 * RATE);
    held.set(chord({ root: 'A', minor: true, seconds: 30, rate: RATE }), RATE);
    const cold = sections(analyzeOnsets(held, RATE), noGrid, nothing, 32);
    expect(cold).toMatchObject({ coldStart: true, coldEnd: true, introEnd: 0, downbeatConfidence: 0 });
    expect(Math.abs(cold.soundEnd - 31)).toBeLessThan(0.05);

    // The same chord faded in and out over 8 s each.
    for (let i = 0; i < held.length; i++) held[i]! *= Math.min(1, Math.max(0, (i / RATE - 1) / 8), (31 - i / RATE) / 8);
    const faded = sections(analyzeOnsets(held, RATE), noGrid, nothing, 32);
    expect(faded).toMatchObject({ coldStart: false, coldEnd: false });
  });

  it('gives nothing for silence', () => {
    const result = analyse(new Float32Array(RATE * 20));
    expect(result).toMatchObject({ introEnd: 0, outroStart: 0, soundEnd: 0, coldStart: false, coldEnd: false, downbeatConfidence: 0 });
    expect(result.firstDrop).toBeUndefined();
  });

  it('is sure of the bar on accented clicks and unsure on equal ones', () => {
    const accented = analyse(clickTrack({ bpm: 124, seconds: 60, rate: RATE }).samples);
    expect(accented.downbeatConfidence).toBeGreaterThan(0.8);
    const equal = analyse(clickTrack({ bpm: 124, seconds: 60, rate: RATE, accentEvery: 1 }).samples);
    expect(equal.downbeatConfidence).toBeLessThan(0.2);
  });

  it('is sure of the bar of the synthetic song, and keeps it', () => {
    const result = analyse(song({ bpm: 128, rate: RATE, introBeats: 32, bodyBeats: 64, outroBeats: 32 }).samples);
    expect(result.downbeatConfidence).toBeGreaterThan(0.8);
    expect(result.downbeatOffset).toBe(result.found.downbeatOffset);
    // The music starts on the grid's first downbeat, so phrases count from the same place.
    expect(result.phraseEnergy).toEqual(result.found.phraseEnergy);
  });
});

describe('sections: edges, fades and breakdowns', () => {
  const beat = 60 / 128;

  it('ends the outro at the last kick phrase, not at a chord ringing out after it', () => {
    const track = song({ bpm: 128, rate: RATE, introBeats: 32, bodyBeats: 64, outroBeats: 32 });
    const samples = new Float32Array(track.samples.length + 3 * RATE);
    samples.set(track.samples);
    const ring = chord({ root: 'C', minor: false, seconds: 3.5, rate: RATE });
    const from = Math.round((track.beats.at(-1)! + beat) * RATE);
    ring.forEach((v, i) => {
      if (from + i < samples.length) samples[from + i]! += v * Math.exp(-i / RATE);
    });
    const result = analyse(samples);
    expect(Math.abs(result.outroStart - track.truth.outroStart)).toBeLessThan(beat);
    expect(result.soundEnd).toBeGreaterThan(track.truth.soundEnd + 1);
  });

  it('finds the outro before a quiet beatless ending, and runs it on through the ending', () => {
    for (const padLevel of [0.2, 0.4]) {
      const { samples, starts } = build(
        [
          ['light', 32],
          ['body', 96],
          ['light', 32],
          ['pad', 32],
        ],
        { padLevel },
      );
      const result = analyse(samples);
      expect(Math.abs(result.outroStart - starts[2]!), `pad at ${padLevel}`).toBeLessThan(beat);
      expect(result.soundEnd).toBeGreaterThan(starts[3]! + 32 * beat - 1);
    }
  });

  it('can leave a song that fades out from the phrase where the fade gets going', () => {
    const track = song({ bpm: 128, rate: RATE, introBeats: 32, bodyBeats: 128, outroBeats: 0, fadeOutSeconds: 20 });
    const result = analyse(track.samples);
    const fadeFrom = track.truth.soundEnd - 20;
    // Phrases are 15 s at 128 BPM: the outro starts within one of the fade's start, not in its last seconds.
    expect(result.outroStart).toBeGreaterThanOrEqual(fadeFrom - 32 * beat);
    expect(result.outroStart).toBeLessThanOrEqual(fadeFrom + 32 * beat);
    expect(result.soundEnd - result.outroStart).toBeGreaterThan(14);
  });

  it('counts a beatless pad before the kicks as intro, however loud', () => {
    for (const padLevel of [0.4, 1]) {
      const { samples, starts } = build(
        [
          ['pad', 16],
          ['kick', 32],
          ['body', 64],
          ['kick', 32],
        ],
        { padLevel },
      );
      const result = analyse(samples);
      expect(Math.abs(result.introEnd - starts[2]!), `pad at ${padLevel}`).toBeLessThan(beat);
      expect(Math.abs(result.outroStart - starts[3]!), `pad at ${padLevel}`).toBeLessThan(beat);
    }
  });

  it('keeps a loud opening without a kick but with notes starting in it (a piano intro) as music', () => {
    // Chord stabs on every beat, no kick, then the body: nothing to skip before the body.
    const { samples } = build([
      ['pad', 16],
      ['body', 64],
    ]);
    const stab = chord({ root: 'A', minor: true, seconds: beat, rate: RATE });
    for (let b = 0; b < 16; b++) {
      const from = Math.round((0.5 + b * beat) * RATE);
      samples.fill(0, from, from + stab.length);
      stab.forEach((v, i) => (samples[from + i]! += 1.5 * v * Math.exp(-i / RATE / 0.5)));
    }
    expect(analyse(samples).introEnd).toBeLessThan(0.5 + beat);
  });

  it('keeps the phrase lines through a fade-in', () => {
    for (const fadeBeats of [8, 16]) {
      const track = song({ bpm: 128, rate: RATE, introBeats: 32, bodyBeats: 64, outroBeats: 32 });
      const fadeEnd = Math.round((0.5 + fadeBeats * beat) * RATE);
      for (let i = 0; i < fadeEnd; i++) track.samples[i]! *= i / fadeEnd;
      const result = analyse(track.samples);
      expect(Math.abs(result.introEnd - track.truth.introEnd), `${fadeBeats}-beat fade intro`).toBeLessThan(beat);
      expect(Math.abs(result.outroStart - track.truth.outroStart), `${fadeBeats}-beat fade outro`).toBeLessThan(beat);
      // The first phrase is the song's first beat, even though the first beats are barely audible.
      expect(Math.abs(result.firstPhrase - 0.5), `${fadeBeats}-beat fade first phrase`).toBeLessThan(0.02);
      expect(result.coldStart).toBe(false);
    }
  });

  it('trusts a fade-in’s first audible beat less when nothing else says where the phrase starts', () => {
    const clicks = clickTrack({ bpm: 128, seconds: 60, rate: RATE });
    const clean = analyse(clicks.samples).downbeatConfidence;
    const fadeEnd = Math.round(8 * RATE);
    for (let i = 0; i < fadeEnd; i++) clicks.samples[i]! *= i / fadeEnd;
    const faded = analyse(clicks.samples).downbeatConfidence;
    expect(clean).toBeGreaterThan(0.8);
    expect(faded).toBeLessThan(0.6);
  });

  it('calls a short final hit cut dead a cold end', () => {
    const track = song({ bpm: 128, rate: RATE, introBeats: 32, bodyBeats: 64, outroBeats: 0 });
    track.samples.fill(0, Math.round((track.beats.at(-1)! + 0.15) * RATE));
    const result = analyse(track.samples);
    expect(result.coldEnd).toBe(true);
    expect(Math.abs(result.soundEnd - (track.beats.at(-1)! + 0.15))).toBeLessThan(0.05);
  });

  it('calls a partial fade then a cut not cold, but the same cut without the fade cold', () => {
    const options = { bpm: 128, rate: RATE, introBeats: 32, bodyBeats: 64, outroBeats: 0 };
    const cut = song(options);
    const end = cut.truth.outroStart;
    cut.samples.fill(0, Math.round(end * RATE));
    expect(analyse(cut.samples).coldEnd).toBe(true);

    // The last four bars fall from full to 0.62 (still "full sound" at the end) before the cut.
    const faded = song(options);
    const start = end - 16 * beat;
    for (let i = Math.round(start * RATE); i < faded.samples.length; i++) {
      const t = i / RATE;
      faded.samples[i]! *= t >= end ? 0 : 1 - (0.38 * (t - start)) / (end - start);
    }
    expect(analyse(faded.samples).coldEnd).toBe(false);
  });

  it('leaves the intro and outro alone around a breakdown in the middle', () => {
    for (const breakdown of ['kick', 'pad'] as const) {
      const { samples, starts } = build([
        ['kick', 32],
        ['body', 64],
        [breakdown, 32],
        ['body', 64],
        ['kick', 32],
      ]);
      const result = analyse(samples);
      expect(Math.abs(result.introEnd - starts[1]!), `${breakdown} breakdown intro`).toBeLessThan(beat);
      expect(Math.abs(result.outroStart - starts[4]!), `${breakdown} breakdown outro`).toBeLessThan(beat);
    }
  });

  it('keeps intro ≤ outro ≤ sound end for songs all sparse, all full, or very short', () => {
    const cases: [string, ['kick' | 'body' | 'pad', number][]][] = [
      ['all sparse', [['kick', 128]]],
      ['all full', [['body', 128]]],
      ['ten beats', [['body', 10]]],
      ['six beats', [['kick', 6]]],
      ['two beats', [['body', 2]]],
    ];
    for (const [label, spec] of cases) {
      const result = analyse(build(spec).samples);
      expect(result.introEnd, label).toBeLessThanOrEqual(result.outroStart);
      expect(result.outroStart, label).toBeLessThanOrEqual(result.soundEnd);
      expect(result.soundEnd, label).toBeGreaterThan(0);
    }
  });

  it('finds the drop and the bar when the beat before the drop is silent', () => {
    // Equal kicks, so only the section changes tell where the bar starts; beat 31 (the last of the
    // intro) is muted, a common build-up trick.
    const { samples, starts } = build(
      [
        ['kick', 32],
        ['body', 64],
        ['kick', 32],
      ],
      { equalKicks: true },
    );
    samples.fill(0, Math.round((0.5 + 31 * beat) * RATE), Math.round((0.5 + 32 * beat) * RATE));
    const result = analyse(samples);
    expect(Math.abs(result.introEnd - starts[1]!)).toBeLessThan(beat);
    expect(Math.abs(result.firstDrop! - starts[1]!)).toBeLessThan(beat);
    expect(result.downbeatOffset).toBe(Math.round((0.5 - result.grid.firstBeat) / (60 / result.grid.bpm)) % 4);
    expect(result.downbeatConfidence).toBeGreaterThan(0.5);
  });
});

describe('sections: the bar check', () => {
  // Hand-made frames: 128 beats at 120 BPM, a kick of the same weight on every beat (so the bass
  // can't tell where the bar starts), quiet and sparse except for beats 34–97: section changes on
  // beats 34 and 98, the phrase lines of bar position 2.
  const fps = 43;
  const grid = { bpm: 120, firstBeat: 0.25 };
  const beatAt = (t: number) => (t - grid.firstBeat) / 0.5;
  const n = Math.round(64.5 * fps);

  function frames({ accentOn, changesAt }: { accentOn?: number; changesAt?: [number, number] }) {
    const lowEnergy = new Float64Array(n).fill(1);
    const rms = new Float64Array(n);
    const energy = new Float64Array(n);
    const onset = new Float64Array(n);
    const lowOnset = new Float64Array(n);
    for (let f = 0; f < n; f++) {
      // The frame's centre is two hops after its index.
      const beat = beatAt((f + 2) / fps);
      const loud = !changesAt || (beat >= changesAt[0] && beat < changesAt[1]);
      rms[f] = loud ? 0.1 : 0.02;
      energy[f] = lowEnergy[f]! + (loud ? 10 : 0.1);
    }
    if (accentOn !== undefined) {
      for (let beat = accentOn; beat < 128; beat += 4) {
        const centre = Math.round((grid.firstBeat + beat * 0.5) * fps);
        for (let f = Math.max(0, centre - 5); f <= Math.min(n - 1, centre + 1); f++) {
          lowEnergy[f] = 3;
          energy[f]! += 2;
        }
      }
    }
    return { fps, lowEnergy, rms, energy, onset, lowOnset };
  }

  it('moves an unsure bar to where the section changes fall', () => {
    const result = sections(frames({ changesAt: [34, 98] }), grid, { downbeatOffset: 0, phraseEnergy: [] }, 64.5);
    expect(result.downbeatOffset).toBe(2);
    expect(result.introEnd).toBeCloseTo(grid.firstBeat + 34 * 0.5, 2);
    expect(result.outroStart).toBeCloseTo(grid.firstBeat + 98 * 0.5, 2);
    expect(result.phraseEnergy.length).toBeGreaterThan(6);
    expect(result.firstDrop).toBeCloseTo(result.introEnd, 2);
    expect(result.downbeatConfidence).toBeGreaterThan(0.5);
  });

  it('counts section changes on the phrase lines toward the confidence', () => {
    const flat = sections(frames({}), grid, { downbeatOffset: 2, phraseEnergy: [] }, 64.5);
    const changes = sections(frames({ changesAt: [34, 98] }), grid, { downbeatOffset: 2, phraseEnergy: [] }, 64.5);
    expect(flat.downbeatConfidence).toBeLessThan(0.1);
    expect(changes.downbeatConfidence).toBeGreaterThan(0.5);
  });

  it('keeps a bar the bass is sure of, but trusts it less when the sections disagree', () => {
    const agree = sections(frames({ accentOn: 2, changesAt: [34, 98] }), grid, { downbeatOffset: 2, phraseEnergy: [] }, 64.5);
    const disagree = sections(frames({ accentOn: 0, changesAt: [34, 98] }), grid, { downbeatOffset: 0, phraseEnergy: [] }, 64.5);
    expect(agree.downbeatOffset).toBe(2);
    expect(agree.downbeatConfidence).toBeGreaterThan(0.9);
    expect(disagree.downbeatOffset).toBe(0);
    expect(disagree.downbeatConfidence).toBeLessThan(0.7);
  });

  it('counts phrases from a phrase line it is given, whatever the bass says', () => {
    const found = { downbeatOffset: 0, phraseEnergy: [] };
    const sure = frames({ accentOn: 0, changesAt: [34, 98] });
    expect(sections(sure, grid, found, 64.5).firstPhrase).toBeCloseTo(grid.firstBeat, 2);
    // Beat 50 is on the phrase lines of beat 2 (50 = 2 + 3·16): the same phrases follow.
    for (const line of [2, 50]) {
      const result = sections(sure, grid, found, 64.5, grid.firstBeat + line * 0.5);
      expect(result.downbeatOffset).toBe(2);
      expect(result.firstPhrase).toBeCloseTo(grid.firstBeat + 2 * 0.5, 2);
      expect(result.introEnd).toBeCloseTo(grid.firstBeat + 34 * 0.5, 2);
      expect(result.outroStart).toBeCloseTo(grid.firstBeat + 98 * 0.5, 2);
    }
  });
});
