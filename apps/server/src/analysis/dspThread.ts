import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { renderTransition, type Excerpt, type StereoAudio, type TransitionPlan } from '@playarr/mix';
import { analyzePcm, pcmToFloat, type AudioFeatures } from './dsp.ts';

type Pending = { resolve: (answer: WorkerAnswer) => void; reject: (e: Error) => void };

/** What the worker sends back: one of these per job, matched up by id. */
export type WorkerAnswer = { id: number; features?: AudioFeatures; audio?: StereoAudio; error?: string };

/** What the worker is asked to do. */
export type WorkerJob =
  | { id: number; kind: 'analyze'; pcm: ArrayBuffer }
  | { id: number; kind: 'render'; plan: TransitionPlan; a: Excerpt; b: Excerpt };

/**
 * The number crunching (analyzePcm, renderTransition) in a worker thread, one job at a time. Built,
 * the worker is dist/dspWorker.js next to the server; in development it runs from its source. If no
 * worker can start, the work is done on the main thread as before (slower to respond, but still working).
 */
export class DspThread {
  private worker: Worker | null = null;
  private failed = false;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  async analyze(pcm: Buffer): Promise<AudioFeatures> {
    const worker = this.start();
    if (!worker) return analyzePcm(pcmToFloat(pcm));
    // A copy of just these bytes, handed over to the worker rather than copied again.
    const bytes = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
    const answer = await this.send(worker, { id: this.nextId++, kind: 'analyze', pcm: bytes }, [bytes]);
    if (!answer.features) throw new Error(answer.error ?? 'Analysis failed');
    return answer.features;
  }

  /**
   * Renders a transition (see renderTransition). The excerpts' samples are handed over to the worker,
   * not copied: the caller must not use them afterwards.
   */
  async render(plan: TransitionPlan, a: Excerpt, b: Excerpt): Promise<StereoAudio> {
    const worker = this.start();
    if (!worker) return renderTransition(plan, a, b);
    const owned = [ownBuffer(a.left), ownBuffer(a.right), ownBuffer(b.left), ownBuffer(b.right)];
    const [aLeft, aRight, bLeft, bRight] = owned as [Float32Array, Float32Array, Float32Array, Float32Array];
    const job: WorkerJob = {
      id: this.nextId++,
      kind: 'render',
      plan,
      a: { left: aLeft, right: aRight, start: a.start },
      b: { left: bLeft, right: bRight, start: b.start },
    };
    const transfer = [...new Set(owned.map((channel) => channel.buffer as ArrayBuffer))];
    const answer = await this.send(worker, job, transfer);
    if (!answer.audio) throw new Error(answer.error ?? 'Rendering failed');
    return answer.audio;
  }

  close() {
    void this.worker?.terminate();
    this.worker = null;
  }

  private send(worker: Worker, job: WorkerJob, transfer: ArrayBuffer[]): Promise<WorkerAnswer> {
    return new Promise((resolve, reject) => {
      this.pending.set(job.id, { resolve, reject });
      worker.postMessage(job, transfer);
    });
  }

  private start(): Worker | null {
    if (this.worker || this.failed) return this.worker;
    const file = workerFile();
    if (!file) {
      this.failed = true;
      return null;
    }
    try {
      // From source (development), through tsx like the server itself.
      const worker = new Worker(file, file.pathname.endsWith('.ts') ? { execArgv: ['--import', 'tsx'] } : {});
      worker.unref();
      worker.on('message', (answer: WorkerAnswer) => {
        const p = this.pending.get(answer.id);
        this.pending.delete(answer.id);
        p?.resolve(answer);
      });
      const lost = (err: Error) => {
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.worker = null;
      };
      worker.on('error', lost);
      worker.on('exit', (code) => code !== 0 && lost(new Error(`DSP worker stopped (${code})`)));
      this.worker = worker;
      return worker;
    } catch {
      this.failed = true;
      return null;
    }
  }
}

/**
 * The samples in a buffer of their own, so it can be handed to the worker whole: handing over a
 * shared buffer would take the rest of it (and anything else viewing it) away from the caller.
 */
function ownBuffer(channel: Float32Array): Float32Array {
  const whole = channel.byteOffset === 0 && channel.byteLength === channel.buffer.byteLength;
  return whole && channel.buffer instanceof ArrayBuffer ? channel : channel.slice();
}

function workerFile(): URL | null {
  for (const name of ['./dspWorker.js', './dspWorker.ts']) {
    const url = new URL(name, import.meta.url);
    if (existsSync(fileURLToPath(url))) return url;
  }
  return null;
}
