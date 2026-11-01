import { describe, expect, it } from 'vitest';
import { toCamelot } from '../camelot.ts';
import { chord, clickTrack, noise, PITCH_NAMES, song } from '../testSignals.ts';
import { detectKey } from './key.ts';

const RATE = 11025;

/** Overtone recipes: a sawtooth's 16 harmonics at 1/n, a square's odd ones, and a soft synth's three. */
const SAW = Array.from({ length: 16 }, (_, h) => 1 / (h + 1));
const SQUARE = SAW.map((gain, h) => (h % 2 === 0 ? gain : 0));
const SYNTH = [1, 0.5, 0.25];

interface ToneOptions {
  seconds: number;
  harmonics: number[];
  /** Tuning reference: the pitch of A4 in Hz. */
  a4?: number;
  /** Each note is five voices spread evenly across ±this many cents, like a chorus or a supersaw. */
  chorusCents?: number;
}

/**
 * Notes given as MIDI numbers (60 = C4): each entry of `notes` is what sounds together for 2 s, then
 * the next entry, looping.
 */
function tones(notes: number[][], { seconds, harmonics, a4 = 440, chorusCents = 0 }: ToneOptions): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  const voices = chorusCents ? [-1, -0.5, 0, 0.5, 1].map((d) => (d * chorusCents) / 100) : [0];
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    let v = 0;
    for (const midi of notes[Math.floor(t / 2) % notes.length]!) {
      for (const detune of voices) {
        const hz = a4 * 2 ** ((midi + detune - 69) / 12);
        // Each voice starts at its own phase (its detune, as radians), as a real chorus's would.
        harmonics.forEach((gain, h) => {
          if (hz * (h + 1) < RATE / 2) v += (gain * Math.sin(2 * Math.PI * hz * (h + 1) * t + detune)) / voices.length;
        });
      }
    }
    out[i] = 0.05 * v;
  }
  return out;
}

/** Noise whose power falls with frequency, roughly like pink noise: white noise through four low-pass filters, summed. */
function pinkNoise(seconds: number): Float32Array {
  const white = noise(seconds, RATE, 3);
  const poles = [0.99, 0.95, 0.8, 0.3];
  const state = poles.map(() => 0);
  return white.map((w) => {
    let sum = 0;
    poles.forEach((pole, j) => {
      state[j] = pole * state[j]! + (1 - pole) * 4 * w;
      sum += state[j]!;
    });
    return sum;
  });
}

/** A kick drum that rings longer than clickTrack's, a sine at `hz` dying away over `decay` seconds, at 124 bpm. */
function boomyKick(hz: number, decay: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  const length = Math.round(5 * decay * RATE);
  for (let beat = 0.5; beat < seconds; beat += 60 / 124) {
    const start = Math.round(beat * RATE);
    for (let i = 0; i < length && start + i < out.length; i++) {
      out[start + i]! += 0.5 * Math.exp(-i / RATE / decay) * Math.sin((2 * Math.PI * hz * i) / RATE);
    }
  }
  return out;
}

const mix = (a: Float32Array, b: Float32Array, gain = 1) => a.map((v, i) => v + gain * b[i]!);

describe('detectKey', () => {
  // A lone major triad is weaker evidence than a minor one: the minor key a third up shares two of its
  // notes and the overtones of the third (C–E–G against E–G–B), so its confidence comes out lower.
  it.each([
    ['C', false, '8B', 0.3],
    ['A', true, '8A', 0.6],
    ['F#', true, '11A', 0.6],
  ] as const)('hears a sustained %s (minor: %s) chord as %s', (root, minor, camelot, atLeast) => {
    const key = detectKey(chord({ root, minor, seconds: 8, rate: RATE }), RATE);
    expect(key?.camelot).toBe(camelot);
    expect(key!.confidence).toBeGreaterThanOrEqual(atLeast);
    expect(key!.confidence).toBeLessThanOrEqual(1);
  });

  it('finds the key of a song under its kick and snare', () => {
    const { samples } = song({
      bpm: 124,
      rate: RATE,
      introBeats: 16,
      bodyBeats: 64,
      outroBeats: 16,
      key: { root: 'E', minor: true },
    });
    const key = detectKey(samples, RATE);
    expect(key?.camelot).toBe('9A');
    expect(key!.confidence).toBeGreaterThanOrEqual(0.6);
  }, 30_000);

  it('gets the key of chords in all 24 keys right, or at worst their relative major/minor', () => {
    let exact = 0;
    PITCH_NAMES.forEach((root, pitchClass) => {
      for (const minor of [false, true]) {
        const truth = toCamelot(pitchClass, minor);
        const relative = toCamelot(minor ? (pitchClass + 3) % 12 : (pitchClass + 9) % 12, !minor);
        const found = detectKey(chord({ root, minor, seconds: 6, rate: RATE }), RATE)?.camelot;
        if (found === truth) exact++;
        expect([truth, relative]).toContain(found);
      }
    });
    expect(exact).toBeGreaterThanOrEqual(23);
  }, 30_000); // about a second on its own, but it shares the CPU with the rest of the suite

  it('gets bright sawtooth triads in octave 4 right in all 24 keys', () => {
    // A sawtooth's overtones are strong enough to tip a major triad over to the minor key a third up
    // (C–E–G reads as E minor) unless the lower notes count for more (BASS_TILT).
    let exact = 0;
    for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
      for (const minor of [false, true]) {
        const truth = toCamelot(pitchClass, minor);
        const relative = toCamelot(minor ? (pitchClass + 3) % 12 : (pitchClass + 9) % 12, !minor);
        const root = 60 + pitchClass;
        const found = detectKey(tones([[root, root + (minor ? 3 : 4), root + 7]], { seconds: 6, harmonics: SAW }), RATE);
        if (found?.camelot === truth) exact++;
        expect([truth, relative]).toContain(found?.camelot);
      }
    }
    expect(exact).toBeGreaterThanOrEqual(23);
  }, 30_000); // a few seconds: 16 harmonics for every note of every sample

  it('reads a progression between a minor key and its relative major as either, at full confidence', () => {
    // The relative major/minor mixes just the same, so being torn between them is no reason for doubt.
    const aMinor = [[57, 60, 64], [57, 60, 65], [55, 60, 64], [55, 59, 62]]; // Am F C G
    const cMajor = [[60, 64, 67], [59, 62, 67], [57, 60, 64], [57, 60, 65]]; // C G Am F, a hair from A minor
    for (const progression of [aMinor, cMajor]) {
      const key = detectKey(tones(progression, { seconds: 16, harmonics: SAW }), RATE);
      expect(['8A', '8B']).toContain(key?.camelot);
      expect(key!.confidence).toBeGreaterThanOrEqual(0.9);
    }
  });

  it.each([428, 432, 450, 452])('allows for a band tuned to A4 = %s Hz', (a4) => {
    // A chorused chord spreads each note ±25 cents; tuned far from 440, part of that spread would
    // land past the half-semitone line and count as the neighbouring note.
    const key = detectKey(tones([[48, 52, 55]], { seconds: 8, harmonics: SYNTH, a4, chorusCents: 25 }), RATE);
    expect(key?.camelot).toBe('8B');
    expect(key!.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it.each([
    ['C2 G2 F2 C2', [36, 43, 41, 36], '8B'],
    ['E1 G1 A1 B1', [28, 31, 33, 35], '9A'],
  ] as const)('hears a sine sub-bass line (%s) below 80 Hz', (_, line, camelot) => {
    const key = detectKey(tones(line.map((note) => [note]), { seconds: 16, harmonics: [1] }), RATE);
    expect(key?.camelot).toBe(camelot);
    expect(key!.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it.each([50, 65.4, 73.4])('gives no key for a boomy kick at %s Hz on its own', (kickHz) => {
    // It rings for ~0.4 s, so it's in nearly every frame and its peak is fairly narrow: without both
    // the sharpness and the sustain checks below LOW_HZ it would pass for a sub-bass note.
    expect(detectKey(boomyKick(kickHz, 0.08, 20), RATE)).toBeUndefined();
  });

  it.each([50, 65.4, 73.4])('is not thrown by a loud boomy kick at %s Hz under an E minor chord', (kickHz) => {
    // Tuned to C or D, the kick would pull the chord off key if it counted as a note.
    const body = chord({ root: 'E', minor: true, seconds: 20, rate: RATE });
    expect(detectKey(mix(body, boomyKick(kickHz, 0.15, 20)), RATE)?.camelot).toBe('9A');
  });

  it.each([0.2, 0.5])('hears a chord through noise at %s times the level', (level) => {
    const body = chord({ root: 'D', minor: false, seconds: 10, rate: RATE });
    expect(detectKey(mix(body, noise(10, RATE), level), RATE)?.camelot).toBe('10B');
  });

  it('gives no key for drums alone', () => {
    expect(detectKey(clickTrack({ bpm: 124, seconds: 30, rate: RATE }).samples, RATE)).toBeUndefined();
  });

  it('gives no key for noise, even two minutes of it', () => {
    // Over minutes, enough of noise's random peaks get past the prominence test to add up to a
    // made-up key; the flatness gate turns those frames away.
    expect(detectKey(noise(10, RATE), RATE)).toBeUndefined();
    expect(detectKey(noise(120, RATE, 3), RATE)).toBeUndefined();
    expect(detectKey(pinkNoise(120), RATE)).toBeUndefined();
  });

  it.each([
    ['a sustained sawtooth note', [[57]], SAW],
    ['a sustained square-wave note', [[57]], SQUARE],
    ['all 12 notes at once', [[60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71]], SAW],
    ['a diminished seventh chord', [[60, 63, 66, 69]], SAW],
  ])('is unsure of the key of %s', (_, notes, harmonics) => {
    const key = detectKey(tones(notes, { seconds: 8, harmonics }), RATE);
    expect(key).toBeDefined();
    expect(key!.confidence).toBeLessThan(0.3);
  }, 30_000);

  it('gives nothing for silence, a too-short signal or under 2 s of notes', () => {
    expect(detectKey(new Float32Array(RATE * 5), RATE)).toBeUndefined();
    expect(detectKey(new Float32Array(100), RATE)).toBeUndefined();
    expect(detectKey(chord({ root: 'C', minor: false, seconds: 1.5, rate: RATE }), RATE)).toBeUndefined();
    expect(detectKey(chord({ root: 'C', minor: false, seconds: 4, rate: RATE }), RATE)?.camelot).toBe('8B');
  });
});
