/**
 * The number crunching off the main thread: analyzePcm and analyzeMix are seconds of work per song on a
 * NAS, and a transition render more; on the main thread they would hold up every page, image and stream
 * meanwhile.
 */
import { parentPort } from 'node:worker_threads';
import { analyzeMix, renderTransition } from '@playarr/mix';
import { analyzePcm, pcmToFloat, SAMPLE_RATE } from './dsp.ts';
import type { WorkerAnswer, WorkerJob } from './dspThread.ts';

parentPort?.on('message', (job: WorkerJob) => {
  try {
    if (job.kind === 'render') {
      const audio = renderTransition(job.plan, job.a, job.b);
      // Handed back, not copied: a long blend is tens of megabytes.
      const answer: WorkerAnswer = { id: job.id, audio };
      parentPort!.postMessage(answer, [audio.left.buffer as ArrayBuffer, audio.right.buffer as ArrayBuffer]);
    } else if (job.kind === 'mixmap') {
      const tail = job.tail ? pcmToFloat(Buffer.from(job.tail)) : null;
      const mixMap = analyzeMix(pcmToFloat(Buffer.from(job.pcm)), tail, job.duration, SAMPLE_RATE);
      parentPort!.postMessage({ id: job.id, mixMap } satisfies WorkerAnswer);
    } else {
      const answer: WorkerAnswer = { id: job.id, features: analyzePcm(pcmToFloat(Buffer.from(job.pcm))) };
      parentPort!.postMessage(answer);
    }
  } catch (err) {
    parentPort!.postMessage({ id: job.id, error: (err as Error).message } satisfies WorkerAnswer);
  }
});
