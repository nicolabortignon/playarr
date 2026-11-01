import { describe, expect, it } from 'vitest';
import { toCamelot } from '../camelot.ts';
import { chord, clickTrack, noise, PITCH_NAMES, song } from '../testSignals.ts';
import { detectKey } from './key.ts';

const RATE = 11025;

describe('detectKey', () => {
  it.each([
    ['C', false, '8B'],
    ['A', true, '8A'],
    ['F#', true, '11A'],
  ] as const)('hears a sustained %s (minor: %s) chord as %s', (root, minor, camelot) => {
    const key = detectKey(chord({ root, minor, seconds: 8, rate: RATE }), RATE);
    expect(key?.camelot).toBe(camelot);
    expect(key!.confidence).toBeGreaterThan(0);
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
    expect(detectKey(samples, RATE)?.camelot).toBe('9A');
  }, 30_000);

  it('gets the key of chords in all 24 keys right, or at worst their relative major/minor', () => {
    let exact = 0;
    const misses: string[] = [];
    PITCH_NAMES.forEach((root, pitchClass) => {
      for (const minor of [false, true]) {
        const truth = toCamelot(pitchClass, minor);
        const relative = toCamelot(minor ? (pitchClass + 3) % 12 : (pitchClass + 9) % 12, !minor);
        const found = detectKey(chord({ root, minor, seconds: 6, rate: RATE }), RATE)?.camelot;
        if (found === truth) exact++;
        else misses.push(`${root}${minor ? 'm' : ''} (${truth}) heard as ${found}`);
        expect([truth, relative]).toContain(found);
      }
    });
    console.log(`key detection on 24 chords: ${exact}/24 exact${misses.length ? `; relative: ${misses.join(', ')}` : ''}`);
    expect(exact).toBeGreaterThanOrEqual(20);
  }, 60_000); // synthesizing 24 chords is slow when the whole suite runs in parallel

  it.each([50, 65.4, 73.4])('is not thrown by a loud kick pitched at %s Hz', (kickHz) => {
    // A kick is a short pitched thud; tuned to C or D it would pull an E minor chord off key if it
    // counted as a note.
    const kick = clickTrack({ bpm: 124, seconds: 20, rate: RATE, kickHz }).samples;
    const body = chord({ root: 'E', minor: true, seconds: 20, rate: RATE });
    expect(detectKey(kick.map((v, i) => v + body[i]!), RATE)?.camelot).toBe('9A');
  }, 30_000);

  it('hears a chord through noise', () => {
    const body = chord({ root: 'D', minor: false, seconds: 10, rate: RATE });
    const hiss = noise(10, RATE);
    expect(detectKey(body.map((v, i) => v + 0.2 * hiss[i]!), RATE)?.camelot).toBe('10B');
  });

  it('gives no key for drums alone', () => {
    expect(detectKey(clickTrack({ bpm: 124, seconds: 30, rate: RATE }).samples, RATE)).toBeUndefined();
  });

  it('is unsure about noise', () => {
    const key = detectKey(noise(10, RATE), RATE);
    if (key) expect(key.confidence).toBeLessThan(0.2);
  });

  it('gives nothing for silence or a too-short signal', () => {
    expect(detectKey(new Float32Array(RATE * 5), RATE)).toBeUndefined();
    expect(detectKey(new Float32Array(100), RATE)).toBeUndefined();
  });
});
