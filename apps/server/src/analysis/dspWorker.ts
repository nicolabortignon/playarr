/**
 * Measures songs off the main thread: analyzePcm is seconds of number crunching per song on a NAS,
 * and on the main thread it would hold up every page, image and stream meanwhile.
 */
import { parentPort } from 'node:worker_threads';
import { analyzePcm, pcmToFloat } from './dsp.ts';

parentPort?.on('message', ({ id, pcm }: { id: number; pcm: ArrayBuffer }) => {
  try {
    parentPort!.postMessage({ id, features: analyzePcm(pcmToFloat(Buffer.from(pcm))) });
  } catch (err) {
    parentPort!.postMessage({ id, error: (err as Error).message });
  }
});
