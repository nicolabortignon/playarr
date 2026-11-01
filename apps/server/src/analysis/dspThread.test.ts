import { renderTransition, type TransitionPlan } from '@playarr/mix';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzePcm, pcmToFloat, SAMPLE_RATE } from './dsp.ts';
import { DspThread } from './dspThread.ts';

/** 20 s of a 120 BPM click over a low tone, as 16-bit PCM. */
function clickTrack(): Buffer {
  const n = SAMPLE_RATE * 20;
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const beat = i % (SAMPLE_RATE / 2) < 200 ? 0.8 : 0;
    const v = beat + 0.2 * Math.sin((2 * Math.PI * 80 * i) / SAMPLE_RATE);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32000), i * 2);
  }
  return buf;
}

let thread: DspThread | undefined;
afterEach(() => thread?.close());

describe('DspThread', () => {
  it('measures a song in a worker, with the same result as on the main thread', async () => {
    thread = new DspThread();
    const pcm = clickTrack();
    const inline = analyzePcm(pcmToFloat(pcm));
    const [a, b] = await Promise.all([thread.analyze(pcm), thread.analyze(pcm)]);
    expect(a).toEqual(inline);
    expect(b).toEqual(inline);
    expect(pcm.length).toBe(SAMPLE_RATE * 40); // the caller's buffer is left alone
  });

  it('renders a transition in a worker, with the same result as on the main thread', async () => {
    thread = new DspThread();
    const rate = 44100;
    const plan: TransitionPlan = {
      style: 'fade',
      aStart: 1,
      bStart: 0,
      length: 2,
      bResume: 2,
      switchAt: 1,
      bRate: [{ at: 0, value: 1 }],
      aGain: [{ at: 0, value: 1 }, { at: 2, value: 0 }],
      bGain: [{ at: 0, value: 0 }, { at: 2, value: 1 }],
      aLowDb: [{ at: 0, value: 0 }],
      bLowDb: [{ at: 0, value: 0 }],
      aHighPassHz: [{ at: 0, value: 20 }],
      reason: 'test',
      beats: 0,
    };
    const tone = (hz: number, seconds: number) =>
      Float32Array.from({ length: seconds * rate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));
    const excerpts = () => ({
      a: { left: tone(220, 4), right: tone(330, 4), start: 0 },
      b: { left: tone(440, 3), right: tone(550, 3), start: 0 },
    });
    const inline = excerpts();
    const expected = renderTransition(plan, inline.a, inline.b);
    const sent = excerpts();
    const audio = await thread.render(plan, sent.a, sent.b);
    expect(audio.left).toEqual(expected.left);
    expect(audio.right).toEqual(expected.right);
    expect(audio.left.length).toBe(2 * rate);
  });
});
