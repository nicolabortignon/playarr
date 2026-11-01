import { describe, expect, it } from 'vitest';
import { clickTrack, song } from '../testSignals.ts';
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

/** `seconds` of silence before `samples`. */
function afterSilence(seconds: number, samples: Float32Array): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE) + samples.length);
  out.set(samples, Math.round(seconds * RATE));
  return out;
}

describe('sections', () => {
  it('finds the intro and outro of a dance-shaped song to within a beat', () => {
    for (const bpm of [128, 124, 97.3]) {
      const { truth } = song({ bpm, rate: RATE, introBeats: 32, bodyBeats: 64, outroBeats: 32 });
      const result = analyse(song({ bpm, rate: RATE, introBeats: 32, bodyBeats: 64, outroBeats: 32 }).samples);
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
    expect(result.phraseEnergy).toBe(result.found.phraseEnergy);
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
    return { fps, lowEnergy, rms, energy, onset };
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
