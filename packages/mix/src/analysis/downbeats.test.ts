import { describe, expect, it } from 'vitest';
import { clickTrack, song } from '../testSignals.ts';
import { beatGrid } from './beatGrid.ts';
import { downbeats } from './downbeats.ts';
import { analyzeOnsets, ONSET_LATENCY_FRAMES } from './onset.ts';

const RATE = 11025;

/** One onset pass and its grid, the way the mix analysis runs them. */
function analyse(samples: Float32Array) {
  const frames = analyzeOnsets(samples, RATE);
  const grid = beatGrid(frames.beatOnset, frames.fps);
  return { frames, grid, duration: samples.length / RATE };
}

/** The grid's index of a true beat time: the grid's first beat may fall before the music starts. */
function gridIndex(time: number, grid: { bpm: number; firstBeat: number }): number {
  return Math.round((time - grid.firstBeat) / (60 / grid.bpm));
}

describe('downbeats', () => {
  it('finds the bar on a click track whatever beat it starts on', () => {
    for (const [bpm, firstBeat] of [
      [124, 0.5],
      [128, 0.21],
      [97.3, 0.37],
    ] as const) {
      for (let accentOffset = 0; accentOffset < 4; accentOffset++) {
        const track = clickTrack({ bpm, seconds: 60, rate: RATE, firstBeat, accentOffset });
        const { frames, grid, duration } = analyse(track.samples);
        const expected = gridIndex(track.downbeats[0]!, grid) % 4;
        expect(downbeats(frames, grid, duration).downbeatOffset, `${bpm} BPM, accent on ${accentOffset}`).toBe(expected);
      }
    }
  });

  it('falls back to the strongest onsets when every beat has the same bass', () => {
    // A four-to-the-floor kick, equally heavy on every beat, with a crash on the "one" of each bar.
    const fps = 43;
    const grid = { bpm: 120, firstBeat: 0.25 };
    const n = 30 * fps;
    const lowEnergy = new Float64Array(n).fill(1);
    const rms = new Float64Array(n).fill(0.1);
    const onset = new Float64Array(n);
    for (let beat = 0; ; beat++) {
      const frame = Math.round((grid.firstBeat + beat * 0.5) * fps - ONSET_LATENCY_FRAMES);
      if (frame >= n) break;
      if (frame >= 0) onset[frame] = beat % 4 === 3 ? 3 : 1;
    }
    expect(downbeats({ fps, lowEnergy, onset, rms }, grid, 30).downbeatOffset).toBe(3);
  });

  it('gives quiet intro and outro phrases and loud body phrases', () => {
    const track = song({ bpm: 128, rate: RATE, introBeats: 32, bodyBeats: 64, outroBeats: 32 });
    const { frames, grid, duration } = analyse(track.samples);
    const { downbeatOffset, phraseEnergy } = downbeats(frames, grid, duration);

    expect(downbeatOffset).toBe(gridIndex(track.downbeats[0]!, grid) % 4);
    expect(phraseEnergy).toHaveLength(8);
    const [intro, body, outro] = [phraseEnergy.slice(0, 2), phraseEnergy.slice(2, 6), phraseEnergy.slice(6)];
    for (const e of [...intro, ...outro]) expect(e).toBeLessThan(0.6);
    for (const e of body) expect(e).toBeGreaterThan(0.8);
    expect(Math.max(...phraseEnergy)).toBe(1);
  });

  it('counts a last phrase of at least 8 beats and drops a shorter one', () => {
    // 128 + 8 beats: a ninth, half-length phrase of outro.
    const long = song({ bpm: 128, rate: RATE, introBeats: 32, bodyBeats: 64, outroBeats: 40 });
    const a = analyse(long.samples);
    expect(downbeats(a.frames, a.grid, a.duration).phraseEnergy).toHaveLength(9);

    // 128 + 4 beats (plus the tail and second of silence): not enough for another phrase.
    const short = song({ bpm: 128, rate: RATE, introBeats: 32, bodyBeats: 64, outroBeats: 36 });
    const b = analyse(short.samples);
    expect(downbeats(b.frames, b.grid, b.duration).phraseEnergy).toHaveLength(8);
  });

  it('gives nothing for silence or a missing grid', () => {
    const silence = new Float32Array(RATE * 20);
    const { frames, grid, duration } = analyse(silence);
    expect(downbeats(frames, grid, duration)).toEqual({ downbeatOffset: 0, phraseEnergy: [] });
    expect(downbeats(frames, { bpm: 120, firstBeat: 0.1 }, duration)).toEqual({ downbeatOffset: 0, phraseEnergy: [] });

    const track = clickTrack({ bpm: 124, seconds: 30, rate: RATE });
    const clicks = analyzeOnsets(track.samples, RATE);
    expect(downbeats(clicks, { bpm: 0, firstBeat: 0 }, 30)).toEqual({ downbeatOffset: 0, phraseEnergy: [] });
  });
});
