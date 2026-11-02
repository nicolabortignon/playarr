/**
 * The beat model's own thread (see beatModelThread.ts): loads the model on its first song and answers
 * one song at a time, since each run uses several cores and a gigabyte of memory.
 */
import { parentPort } from 'node:worker_threads';
import { lowestPriorityThread } from '../lowPriority.ts';
import { BeatModel } from './beatModel.ts';
import type { BeatModelAnswer, BeatModelJob } from './beatModelThread.ts';
import { pcmToFloat } from './dsp.ts';

// Before the model starts its own threads, so they run at this priority too: a song's beats can wait,
// a transition being rendered or a stream can't.
lowestPriorityThread();

let model: Promise<BeatModel> | undefined;
let queue: Promise<void> = Promise.resolve();

parentPort?.on('message', (job: BeatModelJob) => {
  queue = queue.then(() => answer(job));
});

async function answer(job: BeatModelJob) {
  try {
    model ??= BeatModel.load();
    const { beat, downbeat, fps } = await (await model).activations(pcmToFloat(Buffer.from(job.pcm)));
    const reply: BeatModelAnswer = { id: job.id, fps, beat, downbeat };
    parentPort!.postMessage(reply, [beat.buffer as ArrayBuffer, downbeat.buffer as ArrayBuffer]);
  } catch (err) {
    // A model that didn't load won't load next time either: the thread says so, and each song
    // falls back to the onset analysis.
    parentPort!.postMessage({ id: job.id, error: (err as Error).message } satisfies BeatModelAnswer);
  }
}
