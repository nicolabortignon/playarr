import { BEAT_THIS_RATE } from '@playarr/mix';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BeatModelThread, startBeatModelWorker } from './beatModelThread.ts';

/** `seconds` of a 120 BPM click (a short burst every half second) as s16le PCM at the model's rate. */
function clicks(seconds: number): Buffer {
  const n = Math.round(seconds * BEAT_THIS_RATE);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = i % (BEAT_THIS_RATE / 2) < 300 ? 0.8 * Math.sin((2 * Math.PI * 80 * i) / BEAT_THIS_RATE) : 0;
    buf.writeInt16LE(Math.round(v * 32000), i * 2);
  }
  return buf;
}

let thread: BeatModelThread | undefined;
afterEach(() => thread?.close());

describe('BeatModelThread', () => {
  it('answers in a worker, one value per 1/50 s, leaving the caller’s buffer alone', async () => {
    thread = new BeatModelThread();
    const pcm = clicks(12);
    const [a, b] = await Promise.all([thread.activations(pcm), thread.activations(pcm)]);
    expect(a?.fps).toBe(50);
    expect(a?.beat.length).toBe(Math.floor((12 * BEAT_THIS_RATE) / 441) + 1);
    expect(b?.downbeat.length).toBe(a?.beat.length);
    expect(pcm.length).toBe(12 * BEAT_THIS_RATE * 2);
  }, 60_000);

  it('stops its worker once idle, and starts it again for the next song', async () => {
    let started = 0;
    thread = new BeatModelThread({
      idleMs: 50,
      startWorker: () => {
        started++;
        return startBeatModelWorker();
      },
    });
    expect(await thread.activations(clicks(5))).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await thread.activations(clicks(5))).not.toBeNull();
    expect(started).toBe(2);
  }, 60_000);

  it('gives no answer when its worker can’t start, and says why once', async () => {
    const onError = vi.fn();
    thread = new BeatModelThread({ startWorker: () => null, onError });
    expect(await thread.activations(clicks(1))).toBeNull();
    expect(await thread.activations(clicks(1))).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
