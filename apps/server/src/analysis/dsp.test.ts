import { describe, expect, it } from 'vitest';
import { analyzePcm, ENVELOPE_POINTS, SAMPLE_RATE } from './dsp.ts';

const SR = SAMPLE_RATE;

/** Deterministic white noise (mulberry32), so tests never flake. A naive LCG repeats within a second, which is a beat. */
function noise(seed = 1) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** Kick-like clicks (decaying 60 Hz thump + noise burst) at `bpm`. */
function clickTrack(bpm: number, seconds = 30, gain = 0.8): Float32Array {
  const out = new Float32Array(seconds * SR);
  const rand = noise(bpm);
  const every = (60 / bpm) * SR;
  for (let beat = 0; beat * every < out.length; beat++) {
    const start = Math.round(beat * every);
    for (let i = 0; i < 0.12 * SR && start + i < out.length; i++) {
      const decay = Math.exp(-i / (0.03 * SR));
      out[start + i] = gain * decay * (0.7 * Math.sin((2 * Math.PI * 60 * i) / SR) + 0.3 * rand());
    }
  }
  return out;
}

function tone(hz: number, seconds = 10, gain = 0.5): Float32Array {
  return Float32Array.from({ length: seconds * SR }, (_, i) => gain * Math.sin((2 * Math.PI * hz * i) / SR));
}

describe('analyzePcm', () => {
  it.each([90, 120, 128, 140, 174])('finds the tempo of a %d BPM click track', (bpm) => {
    const f = analyzePcm(clickTrack(bpm));
    // 174 has no octave inside 70–180 other than itself; others must come back as written.
    expect(f.bpm).toBeGreaterThan(bpm - 1.5);
    expect(f.bpm).toBeLessThan(bpm + 1.5);
    expect(f.pulse).toBeGreaterThan(0.7);
  });

  it('reports no steady beat for noise', () => {
    const rand = noise(7);
    const f = analyzePcm(Float32Array.from({ length: 20 * SR }, () => 0.3 * rand()));
    expect(f.pulse).toBeLessThan(0.3);
  });

  it('hears a high tone as brighter than a low one, and a loud one as louder', () => {
    const low = analyzePcm(tone(220));
    const high = analyzePcm(tone(3000));
    expect(high.brightness).toBeGreaterThan(low.brightness + 0.5);
    expect(analyzePcm(tone(220, 10, 0.5)).loudness).toBeGreaterThan(analyzePcm(tone(220, 10, 0.05)).loudness + 0.4);
    expect(low.bass).toBeLessThan(0.1);
    expect(analyzePcm(tone(60)).bass).toBeGreaterThan(0.9);
  });

  it('traces a fade-in in the envelope and calls it dynamic', () => {
    const n = 30 * SR;
    const fade = Float32Array.from({ length: n }, (_, i) => (i / n) ** 2 * 0.8 * Math.sin((2 * Math.PI * 440 * i) / SR));
    const f = analyzePcm(fade);
    expect(f.envelope).toHaveLength(ENVELOPE_POINTS);
    expect(f.envelope.at(-1)!).toBeGreaterThan(f.envelope[4]! + 0.4);
    expect(f.dynamics).toBeGreaterThan(0.6);
    expect(analyzePcm(tone(440, 30)).dynamics).toBeLessThan(0.1);
  });

  it('returns silence for empty or near-empty input', () => {
    expect(analyzePcm(new Float32Array(SR)).loudness).toBe(0);
    expect(analyzePcm(new Float32Array(10 * SR)).pulse).toBe(0);
  });
});
