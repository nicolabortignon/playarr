import { describe, expect, it } from 'vitest';
import { beatModelAnswer, clickTrack, noise, song } from '../testSignals.ts';
import { MIX_MAP_VERSION, type MixMap } from '../types.ts';
import { analyzeMix, MIX_HEAD_SECONDS, MIX_TAIL_SECONDS } from './mixMap.ts';

const RATE = 11025;

/** Phrase line `k` the way the planner draws it (plan.ts `gridLine` with 16 beats per line). */
const phraseLine = (map: MixMap, k: number) => map.firstBeat + (map.downbeatOffset + 16 * k) * (60 / map.bpm);

/** How far `t` is from the nearest of the planner's phrase lines. */
function offPhraseGrid(map: MixMap, t: number): number {
  const k = Math.max(0, Math.round((t - phraseLine(map, 0)) / (16 * (60 / map.bpm))));
  return Math.abs(t - phraseLine(map, k));
}

/** How far `t` is from the nearest of the map's bar lines. */
function offBarGrid(map: MixMap, t: number): number {
  const bar = 4 * (60 / map.bpm);
  const off = (((t - (map.firstBeat + map.downbeatOffset * (60 / map.bpm))) % bar) + bar) % bar;
  return Math.min(off, bar - off);
}

/** The first `seconds` and the last `seconds` of a signal, as the server decodes a long song. */
const head = (samples: Float32Array) => samples.subarray(0, MIX_HEAD_SECONDS * RATE);
const tail = (samples: Float32Array) => samples.subarray(samples.length - MIX_TAIL_SECONDS * RATE);

function expectInvariants(map: MixMap) {
  const times = [map.firstBeat, map.introEnd, map.outroStart, map.soundEnd, map.firstDrop ?? 0];
  for (const t of times) {
    expect(Number.isFinite(t)).toBe(true);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThanOrEqual(map.duration);
  }
  expect(map.introEnd).toBeLessThanOrEqual(map.outroStart);
  expect(map.outroStart).toBeLessThanOrEqual(map.soundEnd);
  expect([0, 1, 2, 3]).toContain(map.downbeatOffset);
  expect(map.version).toBe(MIX_MAP_VERSION);
}

// A ten-minute song (126 BPM, 1280 beats: 32 intro, 1184 body, 64 outro), rendered once.
const BPM = 126;
const long = song({ bpm: BPM, rate: RATE, introBeats: 32, bodyBeats: 1184, outroBeats: 64, key: { root: 'D', minor: true } });

describe('analyzeMix', () => {
  it('maps a three-minute song: tempo, intro, outro, sound end and key', () => {
    const bpm = 124;
    const track = song({ bpm, rate: RATE, introBeats: 32, bodyBeats: 256, outroBeats: 64, key: { root: 'A', minor: true } });
    const map = analyzeMix(track.samples, null, track.truth.duration);
    const beat = 60 / bpm;
    expect(map.version).toBe(MIX_MAP_VERSION);
    expect(map.duration).toBe(track.truth.duration);
    expect(Math.abs(map.bpm - bpm)).toBeLessThan(0.05);
    expect(Math.abs(map.introEnd - track.truth.introEnd)).toBeLessThan(beat);
    expect(Math.abs(map.outroStart - track.truth.outroStart)).toBeLessThan(beat);
    expect(Math.abs(map.soundEnd - track.truth.soundEnd)).toBeLessThan(beat);
    expect(Math.abs(map.firstDrop! - track.truth.introEnd)).toBeLessThan(beat);
    expect(map.key?.camelot).toBe('8A');
    expect(map.gridStable).toBe(true);
    expect(map.beatConfidence).toBeGreaterThan(0.5);
    expect(map.downbeatConfidence).toBeGreaterThan(0.5);
    // 352 beats from the first downbeat: 22 phrases.
    expect(map.phraseEnergy.length).toBe(22);
    expect(map.coldStart).toBe(false);
    expect(map.coldEnd).toBe(false);
    expectInvariants(map);
  });

  it('takes the outro and sound end of a long song from its tail', () => {
    const { samples, truth } = long;
    const map = analyzeMix(head(samples), tail(samples), truth.duration);
    const beat = 60 / BPM;
    expect(truth.outroStart).toBeGreaterThan(MIX_HEAD_SECONDS);
    expect(Math.abs(map.bpm - BPM)).toBeLessThan(0.01);
    expect(map.gridStable).toBe(true);
    expect(Math.abs(map.introEnd - truth.introEnd)).toBeLessThan(beat);
    expect(Math.abs(map.outroStart - truth.outroStart)).toBeLessThan(beat);
    expect(Math.abs(map.soundEnd - truth.soundEnd)).toBeLessThan(beat);
    expect(map.coldEnd).toBe(false);
    // Nine and a half minutes in, the planner's phrase grid still lands on the outro.
    expect(offPhraseGrid(map, truth.outroStart)).toBeLessThan(0.01);
    expect(map.key?.camelot).toBe('7A');
    expectInvariants(map);
  });

  it('calls the grid unstable when the tail has drifted off the tempo', () => {
    const { samples, truth } = long;
    // The tail's beats carry on from the head's grid, then speed up by 0.5% over three minutes.
    const tailStart = truth.duration - MIX_TAIL_SECONDS;
    const period = 60 / BPM;
    const nextBeat = 0.5 + Math.ceil((tailStart - 0.5) / period) * period - tailStart;
    const drifted = clickTrack({
      bpm: BPM,
      seconds: MIX_TAIL_SECONDS,
      rate: RATE,
      firstBeat: nextBeat,
      tempoAt: (t) => BPM * (1 + (0.005 * t) / MIX_TAIL_SECONDS),
    }).samples;
    const map = analyzeMix(head(samples), drifted, truth.duration);
    expect(map.gridStable).toBe(false);
    expectInvariants(map);
  });

  it('lines the planner’s phrase grid up with the music after leading silence', () => {
    const bpm = 124;
    const beat = 60 / bpm;
    const track = song({ bpm, rate: RATE, introBeats: 32, bodyBeats: 128, outroBeats: 32 });
    const silence = 3.3;
    const samples = new Float32Array(Math.round(silence * RATE) + track.samples.length);
    samples.set(track.samples, Math.round(silence * RATE));
    const map = analyzeMix(samples, null, samples.length / RATE);

    expect(map.firstBeat).toBeGreaterThanOrEqual(0);
    // The music's phrases start on its first beat (a downbeat), every 16 beats.
    const musicStart = silence + track.beats[0]!;
    for (let k = 0; k < 12; k++) {
      expect(Math.abs(phraseLine(map, k) - (musicStart + 16 * k * beat)), `phrase ${k}`).toBeLessThan(0.01);
    }
    expect(offPhraseGrid(map, map.introEnd)).toBeLessThan(0.01);
    expect(Math.abs(map.introEnd - (silence + track.truth.introEnd))).toBeLessThan(beat);
    expect(Math.abs(map.outroStart - (silence + track.truth.outroStart))).toBeLessThan(beat);
    // Phrase energy counts from the same first downbeat: the kick-only intro is two quiet phrases.
    expect(map.phraseEnergy.length).toBe(12);
    expect(map.phraseEnergy[0]).toBeLessThan(0.7);
    expect(map.phraseEnergy[2]).toBeGreaterThan(0.95);
    expectInvariants(map);
  });

  it('puts intro, outro and drop on the planner’s phrase lines whatever the leading silence', () => {
    const bpm = 128;
    for (const silence of [2, 3, 5, 10]) {
      const track = song({ bpm, rate: RATE, introBeats: 32, bodyBeats: 64, outroBeats: 32 });
      const samples = new Float32Array(Math.round(silence * RATE) + track.samples.length);
      samples.set(track.samples, Math.round(silence * RATE));
      const map = analyzeMix(samples, null, samples.length / RATE);
      const period = 60 / map.bpm;
      const line0 = map.firstBeat + map.downbeatOffset * period;
      for (const [name, t] of [
        ['intro end', map.introEnd],
        ['outro start', map.outroStart],
        ['first drop', map.firstDrop!],
      ] as const) {
        const beats = (t - line0) / period;
        const offPhrase = Math.abs(beats - 16 * Math.round(beats / 16));
        expect(offPhrase, `${silence} s of silence: ${name}`).toBeLessThan(0.05);
      }
      expect(Math.abs(map.introEnd - (silence + track.truth.introEnd)), `${silence} s`).toBeLessThan(period);
      expect(Math.abs(map.firstDrop! - (silence + track.truth.introEnd)), `${silence} s`).toBeLessThan(period);
      // phraseEnergy[k] is the phrase from phrase line k: the drop's phrase is loud, the one before quiet.
      const dropPhrase = Math.round((map.firstDrop! - line0) / (16 * period));
      expect(map.phraseEnergy[dropPhrase], `${silence} s`).toBeGreaterThan(0.9);
      expect(map.phraseEnergy[dropPhrase - 1], `${silence} s`).toBeLessThan(0.5);
    }
  });

  it('takes the grid and the bars from the beat model when it has its answer', () => {
    const bpm = 124;
    const track = song({ bpm, rate: RATE, introBeats: 32, bodyBeats: 256, outroBeats: 64 });
    const seconds = track.truth.duration;
    const map = analyzeMix(track.samples, null, seconds, RATE, { head: beatModelAnswer(track.beats, track.downbeats, seconds) });
    expect(map.beatsFrom).toBe('model');
    expect(Math.abs(map.bpm - bpm)).toBeLessThan(0.01);
    expect(map.gridStable).toBe(true);
    // Bar lines on the song's downbeats, and the intro still found.
    expect(offBarGrid(map, track.downbeats[8]!)).toBeLessThan(0.01);
    expect(Math.abs(map.introEnd - track.truth.introEnd)).toBeLessThan(60 / bpm);
    expectInvariants(map);
  });

  it('keeps the beat model’s bars even where the kicks would put them elsewhere', () => {
    const bpm = 124;
    const track = song({ bpm, rate: RATE, introBeats: 32, bodyBeats: 256, outroBeats: 64 });
    const seconds = track.truth.duration;
    // The model hears the bar start one beat after the accented kick.
    const later = track.downbeats.map((t) => t + 60 / bpm);
    const map = analyzeMix(track.samples, null, seconds, RATE, { head: beatModelAnswer(track.beats, later, seconds) });
    expect(offBarGrid(map, later[0]!)).toBeLessThan(0.01);
  });

  it('checks a long song’s tail on the beat model’s beats there', () => {
    const { samples, truth, beats, downbeats } = long;
    const tailStart = truth.duration - MIX_TAIL_SECONDS;
    const inTail = (times: number[]) => times.filter((t) => t >= tailStart).map((t) => t - tailStart);
    const map = analyzeMix(head(samples), tail(samples), truth.duration, RATE, {
      head: beatModelAnswer(beats.filter((t) => t < MIX_HEAD_SECONDS), downbeats.filter((t) => t < MIX_HEAD_SECONDS), MIX_HEAD_SECONDS),
      tail: beatModelAnswer(inTail(beats), inTail(downbeats), MIX_TAIL_SECONDS),
    });
    expect(Math.abs(map.bpm - BPM)).toBeLessThan(0.01);
    expect(map.gridStable).toBe(true);
    expect(offPhraseGrid(map, truth.outroStart)).toBeLessThan(0.01);
    expectInvariants(map);
  });

  it('gives an empty map for silence and for too little audio', () => {
    const empty = (duration: number, soundEnd: number): MixMap => ({
      version: MIX_MAP_VERSION,
      duration,
      bpm: 0,
      firstBeat: 0,
      downbeatOffset: 0,
      downbeatConfidence: 0,
      gridStable: false,
      beatConfidence: 0,
      beatsFrom: 'onsets',
      introEnd: 0,
      outroStart: soundEnd,
      coldStart: false,
      coldEnd: false,
      soundEnd,
      phraseEnergy: [],
    });
    expect(analyzeMix(new Float32Array(20 * RATE), null, 20)).toEqual(empty(20, 0));
    expect(analyzeMix(new Float32Array(100), null, 0.01)).toEqual(empty(0.01, 0));
    expect(analyzeMix(new Float32Array(0), null, 0)).toEqual(empty(0, 0));
  });

  it('keeps its promises on noise, and inside a duration shorter than the audio', () => {
    const hiss = noise(60, RATE);
    const map = analyzeMix(hiss, null, 60);
    expect(map.gridStable).toBe(false);
    expect(map.key).toBeUndefined();
    expectInvariants(map);

    const track = song({ bpm: 128, rate: RATE, introBeats: 32, bodyBeats: 64, outroBeats: 32 });
    expectInvariants(analyzeMix(track.samples, null, 30));
  });
});
