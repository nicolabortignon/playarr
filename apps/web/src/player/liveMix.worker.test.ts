import { RENDER_RATE, type CuePoints, type MixMap } from '@playarr/mix';
import { describe, expect, it } from 'vitest';
import { answerLiveMix, planLiveMix, type LiveMixRequest, type SongAudio } from './liveMix.worker';

type Song = MixMap & { cues?: CuePoints };

/** 124 BPM, 5 minutes, a steady beat in 8A, 40-beat intro and outro: a pair of these blends long at the outro. */
function song(overrides: Partial<Song> = {}): Song {
  const beat = 60 / 124;
  return {
    version: 1,
    duration: 300,
    bpm: 124,
    firstBeat: 0.5,
    downbeatOffset: 0,
    gridStable: true,
    beatConfidence: 0.9,
    key: { camelot: '8A', confidence: 0.8 },
    introEnd: 0.5 + 40 * beat,
    outroStart: 290 - 40 * beat,
    coldStart: false,
    coldEnd: false,
    soundEnd: 290,
    phraseEnergy: [],
    ...overrides,
  };
}

const beat = 60 / 124;
const onBar = (t: number) => {
  const bars = (t - 0.5) / (4 * beat);
  return Math.abs(bars - Math.round(bars)) < 1e-6;
};

/** A stretch of quiet noise standing in for a song's decoded audio, from `from` to `to` seconds. */
function audio(from: number, to: number, toEnd = false): SongAudio {
  const samples = Math.round((to - from) * RENDER_RATE);
  const noise = () => Float32Array.from({ length: samples }, (_, i) => 0.1 * Math.sin(i * 0.37) * Math.cos(i * 0.011));
  return { left: noise(), right: noise(), start: from, toEnd };
}

function request(overrides: Partial<LiveMixRequest> = {}): LiveMixRequest {
  return {
    a: song(),
    b: song(),
    mode: 'auto',
    sameAlbumInOrder: false,
    at: 60.5,
    aAudio: audio(60, 80),
    bAudio: audio(0, 40),
    ...overrides,
  };
}

describe('planLiveMix', () => {
  it('leaves A mid-song on a bar line a few beats after the earliest it may, not at its outro', () => {
    const plan = planLiveMix(request());
    expect(plan.aStart).toBeGreaterThanOrEqual(60.5);
    // The cut lands on a bar line, its lead-in included, under 6 beats after the earliest start.
    const landing = plan.aStart + plan.beats * beat;
    expect(landing).toBeLessThan(60.5 + 6 * beat);
    expect(onBar(landing)).toBe(true);
  });

  it('a pair that would blend long gets a quick mix: a skip has no time for a blend', () => {
    const plan = planLiveMix(request());
    expect(plan.style).toBe('quick');
    expect(plan.reason).toBe('Skipped: quick mix');
  });

  it('a beat that isn’t sure enough to cut on: a short crossfade from the earliest start', () => {
    const plan = planLiveMix(request({ a: song({ beatConfidence: 0.2 }) }));
    expect(plan).toMatchObject({ style: 'fade', aStart: 60.5, bStart: 0, length: 2.5 });
  });

  it('ignores A’s own mix-out cue: the skip says where A leaves', () => {
    const plan = planLiveMix(request({ a: song({ cues: { mixOut: 250 } }) }));
    expect(plan.aStart).toBeLessThan(80);
  });
});

describe('answerLiveMix', () => {
  it('renders the quick mix and hands its buffers over', () => {
    const { reply, transfer } = answerLiveMix(request());
    expect(reply.status).toBe('ready');
    if (reply.status !== 'ready') return;
    expect(reply.plan.style).toBe('quick');
    expect(reply.left.length).toBe(Math.round(reply.plan.length * RENDER_RATE));
    expect(reply.right.length).toBe(reply.left.length);
    expect(reply.left.some((x) => x !== 0)).toBe(true);
    expect(transfer).toEqual([reply.left.buffer, reply.right.buffer]);
  });

  it('renders the crossfade where a beat isn’t sure', () => {
    const { reply } = answerLiveMix(request({ b: song({ beatConfidence: 0.2 }) }));
    expect(reply.status).toBe('ready');
    if (reply.status !== 'ready') return;
    expect(reply.plan.style).toBe('fade');
    expect(reply.left.length).toBe(Math.round(2.5 * RENDER_RATE));
  });

  it.each([
    ['no mixing on the queue', { mode: 'off' as const }, /no mixing: straight on$/],
    ['no sure beat, and B starts abruptly', { a: song({ beatConfidence: 0.2 }), b: song({ coldStart: true }) }, /straight on$/],
    ['too close to A’s end', { at: 289 }, /straight on$/],
  ])('%s: straight on, so not possible', (_, overrides, reason) => {
    const { reply, transfer } = answerLiveMix(request(overrides));
    expect(reply).toEqual({ status: 'not possible', reason: expect.stringMatching(reason) });
    expect(transfer).toEqual([]);
  });

  it('A’s audio starts after the mix does: not possible, rather than off the beat', () => {
    const { reply } = answerLiveMix(request({ aAudio: audio(70, 90) }));
    expect(reply).toEqual({ status: 'not possible', reason: 'A’s audio doesn’t cover the mix' });
  });

  it('B’s audio stops short of the mix: not possible', () => {
    const { reply } = answerLiveMix(request({ bAudio: audio(0, 10) }));
    expect(reply).toEqual({ status: 'not possible', reason: 'B’s audio doesn’t cover the mix' });
  });

  it('audio that runs to the song’s end covers everything after it', () => {
    const { reply } = answerLiveMix(request({ bAudio: audio(0, 22, true) }));
    expect(reply.status).toBe('ready');
  });

  it('audio with no usable start: not possible', () => {
    const broken = audio(60, 80);
    broken.start = Number.NaN;
    const { reply } = answerLiveMix(request({ aAudio: broken }));
    expect(reply.status).toBe('not possible');
  });

  it('anything thrown is not possible, never a crash of the worker', () => {
    const detached = Object.defineProperty(audio(60, 80), 'left', {
      get() {
        throw new Error('Buffer detached');
      },
    });
    expect(answerLiveMix(request({ aAudio: detached })).reply).toEqual({ status: 'not possible', reason: 'Buffer detached' });
  });
});
