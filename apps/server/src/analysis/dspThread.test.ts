import { Worker } from 'node:worker_threads';
import { analyzeMix, renderTransition, type TransitionPlan } from '@playarr/mix';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzePcm, pcmToFloat, SAMPLE_RATE } from './dsp.ts';
import { DspThread, DspWorkerLost } from './dspThread.ts';

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
    const told: number[] = [];
    const audio = await thread.render(plan, sent.a, sent.b, 0, 0, (done) => told.push(done));
    expect(audio.left).toEqual(expected.left);
    // It said how far it had got along the way, up to all of it, before answering.
    expect(told.length).toBeGreaterThan(1);
    expect(told).toEqual([...told].sort((x, y) => x - y));
    expect(told.at(-1)).toBe(1);
    expect(audio.right).toEqual(expected.right);
    expect(audio.left.length).toBe(2 * rate);
  });

  it('measures a mix map in a worker, with the same result as on the main thread', async () => {
    thread = new DspThread();
    const head = clickTrack();
    const tail = clickTrack();
    // A 10-minute song: its first and last 20 s stand in for the decoded head and tail.
    const inline = analyzeMix(pcmToFloat(head), pcmToFloat(tail), 600, SAMPLE_RATE);
    const [withTail, headOnly] = await Promise.all([thread.mixMap(head, tail, 600), thread.mixMap(head, null, 20)]);
    expect(withTail).toEqual(inline);
    expect(headOnly).toEqual(analyzeMix(pcmToFloat(head), null, 20, SAMPLE_RATE));
    expect(withTail.soundEnd).toBeGreaterThan(590); // the tail was used: the sound ends at the song's end
    expect(head.length).toBe(SAMPLE_RATE * 40); // the caller's buffers are left alone
    expect(tail.length).toBe(SAMPLE_RATE * 40);
  });

  it('fails the waiting jobs when the worker stops, and starts a fresh one for the next', async () => {
    let started = 0;
    // The first worker quits cleanly (code 0) on its first job; the next one answers.
    const quits = "require('node:worker_threads').parentPort.once('message', () => process.exit(0));";
    const answers =
      "const { parentPort } = require('node:worker_threads');" +
      "parentPort.on('message', (job) => parentPort.postMessage({ id: job.id, error: 'answered' }));";
    thread = new DspThread({ startWorker: () => new Worker(started++ ? answers : quits, { eval: true }) });
    await expect(thread.analyze(clickTrack())).rejects.toThrow(DspWorkerLost);
    await expect(thread.analyze(clickTrack())).rejects.toThrow('answered');
    expect(started).toBe(2);
  });

  it('takes a new job straight after being closed, on a fresh worker', async () => {
    thread = new DspThread();
    const pcm = clickTrack();
    const waiting = thread.analyze(pcm);
    thread.close();
    await expect(waiting).rejects.toThrow(DspWorkerLost);
    expect(await thread.analyze(pcm)).toEqual(analyzePcm(pcmToFloat(pcm)));
  });

  it('fails a job the worker can’t be sent, without leaving it waiting', async () => {
    // A worker that never answers: the job must fail on sending, not wait for an answer.
    const silent = "require('node:worker_threads').parentPort.on('message', () => {});";
    thread = new DspThread({ startWorker: () => new Worker(silent, { eval: true }) });
    const excerpt = () => ({ left: new Float32Array(4), right: new Float32Array(4), start: 0 });
    // A function can't be copied to another thread, so postMessage throws.
    const plan = { reason: () => 'not copyable' } as unknown as TransitionPlan;
    await expect(thread.render(plan, excerpt(), excerpt())).rejects.toThrow();
    expect(thread['pending'].size).toBe(0);
  });
});

