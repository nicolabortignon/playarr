import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { analyzeMix, renderTransition, type BeatActivations, type Excerpt, type MixMap, type StereoAudio, type TransitionPlan } from '@playarr/mix';
import { analyzePcm, atSampleRate, pcmToFloat, SAMPLE_RATE, type AudioFeatures } from './dsp.ts';

/**
 * The job failed because the worker went away (crashed, stopped or was closed), not because of what
 * it was given: the same job may well succeed on the next worker.
 */
export class DspWorkerLost extends Error {}

type Pending = { resolve: (answer: WorkerAnswer) => void; reject: (e: Error) => void };

/** What the worker sends back: one of these per job, matched up by id. */
export type WorkerAnswer = { id: number; features?: AudioFeatures; mixMap?: MixMap; audio?: StereoAudio; error?: string };

/** The beat model's answer for a song's head, and its tail when it's long (see analyzeMix). */
export type SongBeats = { head: BeatActivations; tail?: BeatActivations | null };

/** What the worker is asked to do. PCM is s16le mono at `rate` (SAMPLE_RATE or twice it). */
export type WorkerJob =
  | { id: number; kind: 'analyze'; pcm: ArrayBuffer; rate: number }
  /** The song's head, and its tail when it's long (see analyzeMix). */
  | { id: number; kind: 'mixmap'; pcm: ArrayBuffer; tail?: ArrayBuffer; duration: number; rate: number; beats?: SongBeats }
  | { id: number; kind: 'render'; plan: TransitionPlan; a: Excerpt; b: Excerpt; tail?: number };

/**
 * The number crunching (analyzePcm, analyzeMix, renderTransition) in a worker thread, one job at a
 * time. Built, the worker is dist/dspWorker.js next to the server; in development it runs from its
 * source. If no worker can start, the work is done on the main thread as before (slower to respond,
 * but still working).
 */
export class DspThread {
  private worker: Worker | null = null;
  private failed = false;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  /** `startWorker` replaces the real worker (tests). */
  constructor(private readonly opts: { startWorker?: () => Worker } = {}) {}

  /** A song's features (see analyzePcm) from s16le PCM at `rate` (SAMPLE_RATE or twice it). */
  async analyze(pcm: Buffer, rate = SAMPLE_RATE): Promise<AudioFeatures> {
    const worker = this.start();
    if (!worker) return analyzePcm(atSampleRate(pcmToFloat(pcm), rate));
    const bytes = copyOf(pcm);
    const answer = await this.send(worker, { id: this.nextId++, kind: 'analyze', pcm: bytes, rate }, [bytes]);
    if (!answer.features) throw new Error(answer.error ?? 'Analysis failed');
    return answer.features;
  }

  /**
   * A song's mix map (see analyzeMix) from s16le PCM at `rate` (SAMPLE_RATE or twice it): its head,
   * and its tail (null for a song short enough for the head to hold all of it), with the beat model's
   * answer for them if there is one. The caller's buffers are left alone.
   */
  async mixMap(pcm: Buffer, tail: Buffer | null, duration: number, rate = SAMPLE_RATE, beats?: SongBeats): Promise<MixMap> {
    const worker = this.start();
    if (!worker) return mixMapOf(pcm, tail, duration, rate, beats);
    const head = copyOf(pcm);
    const end = tail && copyOf(tail);
    const job: WorkerJob = { id: this.nextId++, kind: 'mixmap', pcm: head, ...(end ? { tail: end } : {}), duration, rate, ...(beats ? { beats } : {}) };
    const answer = await this.send(worker, job, end ? [head, end] : [head]);
    if (!answer.mixMap) throw new Error(answer.error ?? 'Mix analysis failed');
    return answer.mixMap;
  }

  /**
   * Renders a transition (see renderTransition). The excerpts' samples are handed over to the worker,
   * not copied: the caller must not use them afterwards.
   */
  async render(plan: TransitionPlan, a: Excerpt, b: Excerpt, tail = 0): Promise<StereoAudio> {
    const worker = this.start();
    if (!worker) return renderTransition(plan, a, b, undefined, tail);
    const owned = [ownBuffer(a.left), ownBuffer(a.right), ownBuffer(b.left), ownBuffer(b.right)];
    const [aLeft, aRight, bLeft, bRight] = owned as [Float32Array, Float32Array, Float32Array, Float32Array];
    const job: WorkerJob = {
      id: this.nextId++,
      kind: 'render',
      plan,
      a: { left: aLeft, right: aRight, start: a.start },
      b: { left: bLeft, right: bRight, start: b.start },
      tail,
    };
    const transfer = [...new Set(owned.map((channel) => channel.buffer as ArrayBuffer))];
    const answer = await this.send(worker, job, transfer);
    if (!answer.audio) throw new Error(answer.error ?? 'Rendering failed');
    return answer.audio;
  }

  close() {
    const worker = this.worker;
    if (!worker) return;
    this.lost(worker, new DspWorkerLost('DSP worker closed'));
    void worker.terminate();
  }

  private send(worker: Worker, job: WorkerJob, transfer: ArrayBuffer[]): Promise<WorkerAnswer> {
    return new Promise((resolve, reject) => {
      this.pending.set(job.id, { resolve, reject });
      try {
        worker.postMessage(job, transfer);
      } catch (err) {
        // Never sent (something in it can't be copied to another thread), so no answer will come.
        this.pending.delete(job.id);
        reject(err as Error);
      }
    });
  }

  private start(): Worker | null {
    if (this.worker || this.failed) return this.worker;
    try {
      const worker = this.opts.startWorker ? this.opts.startWorker() : startWorker();
      if (!worker) {
        this.failed = true;
        return null;
      }
      worker.unref();
      worker.on('message', (answer: WorkerAnswer) => {
        const p = this.pending.get(answer.id);
        this.pending.delete(answer.id);
        p?.resolve(answer);
      });
      worker.on('error', (err: Error) => this.lost(worker, new DspWorkerLost(`DSP worker failed: ${err.message}`, { cause: err })));
      // Any exit, a clean one included: a worker that's gone never answers, and its jobs would wait forever.
      worker.on('exit', (code) => this.lost(worker, new DspWorkerLost(`DSP worker stopped (${code})`)));
      this.worker = worker;
      return worker;
    } catch {
      this.failed = true;
      return null;
    }
  }

  /**
   * The worker is gone (or going): its waiting jobs fail, and the next job starts a fresh one. An
   * error is followed by an exit, and a closed worker's exit can arrive after a new one started:
   * only the current worker's first loss counts.
   */
  private lost(worker: Worker, err: Error) {
    if (this.worker !== worker) return;
    this.worker = null;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

/** analyzeMix on s16le PCM at `rate`: what the worker does for a 'mixmap' job. */
export function mixMapOf(pcm: Buffer, tail: Buffer | null, duration: number, rate: number, beats?: SongBeats): MixMap {
  const at = (buf: Buffer) => atSampleRate(pcmToFloat(buf), rate);
  return analyzeMix(at(pcm), tail && at(tail), duration, SAMPLE_RATE, beats);
}

/** A copy of just these bytes, to hand over to the worker rather than copy again. */
function copyOf(pcm: Buffer): ArrayBuffer {
  return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
}

function startWorker(): Worker | null {
  const file = workerFile();
  if (!file) return null;
  // From source (development), through tsx like the server itself.
  return new Worker(file, file.pathname.endsWith('.ts') ? { execArgv: ['--import', 'tsx'] } : {});
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
