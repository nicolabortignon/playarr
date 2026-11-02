/**
 * The number crunching off the main thread: analyzePcm and analyzeMix are seconds of work per song on a
 * NAS, and a transition render more; on the main thread they would hold up every page, image and stream
 * meanwhile.
 */
import { parentPort } from 'node:worker_threads';
import { renderTransition } from '@playarr/mix';
import { analyzePcm, atSampleRate, pcmToFloat } from './dsp.ts';
import { mixMapOf, type WorkerAnswer, type WorkerJob, type WorkerProgress } from './dspThread.ts';

/** A render says how far it has got at most this often (in its 0–1), so the messages stay few. */
const PROGRESS_STEP = 0.02;

parentPort?.on('message', (job: WorkerJob) => {
  try {
    if (job.kind === 'render') {
      let told = -1;
      const progress = (done: number) => {
        if (done - told < PROGRESS_STEP && done < 1) return;
        told = done;
        parentPort!.postMessage({ id: job.id, progress: done } satisfies WorkerProgress);
      };
      const audio = renderTransition(job.plan, job.a, job.b, undefined, job.tail, job.lead, progress);
      // Handed back, not copied: a long blend is tens of megabytes.
      const answer: WorkerAnswer = { id: job.id, audio };
      parentPort!.postMessage(answer, [audio.left.buffer as ArrayBuffer, audio.right.buffer as ArrayBuffer]);
    } else if (job.kind === 'mixmap') {
      const mixMap = mixMapOf(Buffer.from(job.pcm), job.tail ? Buffer.from(job.tail) : null, job.duration, job.rate, job.beats);
      parentPort!.postMessage({ id: job.id, mixMap } satisfies WorkerAnswer);
    } else {
      const answer: WorkerAnswer = { id: job.id, features: analyzePcm(atSampleRate(pcmToFloat(Buffer.from(job.pcm)), job.rate)) };
      parentPort!.postMessage(answer);
    }
  } catch (err) {
    parentPort!.postMessage({ id: job.id, error: (err as Error).message } satisfies WorkerAnswer);
  }
});
