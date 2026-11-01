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
});
