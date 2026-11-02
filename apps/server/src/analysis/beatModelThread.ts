import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { BeatActivations } from '@playarr/mix';

/** What the worker is asked: s16le mono PCM at BEAT_THIS_RATE. */
export type BeatModelJob = { id: number; pcm: ArrayBuffer };
/** Its answer: the model's odds, or why there are none (`stopped`: the thread went away, nothing wrong with the model). */
export type BeatModelAnswer = { id: number; error?: string; stopped?: boolean } & Partial<BeatActivations>;

/** The worker goes away after this long without a song: the model holds a gigabyte or so while loaded. */
const IDLE_MS = 2 * 60_000;

type Pending = { resolve: (answer: BeatModelAnswer) => void };

/**
 * The beat model (beatModelWorker.ts) in a thread of its own, started when a song needs it and stopped
 * after two idle minutes, so the NAS only holds its memory while songs are being analysed. Separate
 * from the DSP thread, which renders transitions meanwhile.
 *
 * Every answer is the model's odds or null: null when the model can't run here (missing, or the
 * runtime fails), and then the analysis finds the beats from the onsets as before.
 */
export class BeatModelThread {
  private worker: Worker | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private idle: NodeJS.Timeout | undefined;
  /** Why the model can't run, once it's known: no point starting it again for every song. */
  private broken: string | undefined;

  /** `startWorker` replaces the real worker (tests); `onError` hears why the model can't run, once. */
  constructor(private readonly opts: { startWorker?: () => Worker | null; onError?: (reason: string) => void; idleMs?: number } = {}) {}

  /** The model's odds for `pcm` (s16le mono at BEAT_THIS_RATE), or null when it can't run. The buffer is left alone. */
  async activations(pcm: Buffer): Promise<BeatActivations | null> {
    if (this.broken) return null;
    const worker = this.start();
    if (!worker) return this.fail('The beat model’s thread couldn’t start');
    clearTimeout(this.idle);
    const id = this.nextId++;
    const bytes = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
    const answer = await new Promise<BeatModelAnswer>((resolve) => {
      this.pending.set(id, { resolve });
      worker.postMessage({ id, pcm: bytes } satisfies BeatModelJob, [bytes]);
    });
    if (!this.pending.size) this.idle = setTimeout(() => this.close(), this.opts.idleMs ?? IDLE_MS).unref();
    if (answer.stopped) return null;
    if (answer.error || !answer.beat || !answer.downbeat || !answer.fps) return this.fail(answer.error ?? 'The beat model gave no answer');
    return { fps: answer.fps, beat: answer.beat, downbeat: answer.downbeat };
  }

  /** Stops the worker (it starts again for the next song). */
  close() {
    clearTimeout(this.idle);
    const worker = this.worker;
    this.worker = null;
    this.settle({ stopped: true });
    void worker?.terminate();
  }

  private start(): Worker | null {
    if (this.worker) return this.worker;
    let worker: Worker | null;
    try {
      worker = this.opts.startWorker ? this.opts.startWorker() : startBeatModelWorker();
    } catch {
      worker = null;
    }
    if (!worker) return null;
    worker.unref();
    worker.on('message', (answer: BeatModelAnswer) => {
      const p = this.pending.get(answer.id);
      this.pending.delete(answer.id);
      p?.resolve(answer);
    });
    // Any exit, a clean one included: its songs would wait forever. They get no odds, but the model
    // isn't called broken for it (a crash on one song, or the idle stop).
    worker.on('exit', () => {
      if (this.worker === worker) this.worker = null;
      this.settle({ stopped: true });
    });
    worker.on('error', () => {});
    this.worker = worker;
    return worker;
  }

  /** Answers every song still waiting with `answer`. */
  private settle(answer: Omit<BeatModelAnswer, 'id'>) {
    for (const [id, p] of this.pending) p.resolve({ id, ...answer });
    this.pending.clear();
  }

  /** The model can't run here: no odds for this song, nor for any later one. */
  private fail(reason: string): null {
    if (!this.broken) {
      this.broken = reason;
      this.opts.onError?.(reason);
    }
    return null;
  }
}

/** The worker running beatModelWorker (built, or from source in development); null if neither is there. */
export function startBeatModelWorker(): Worker | null {
  for (const name of ['./beatModelWorker.js', './beatModelWorker.ts']) {
    const url = new URL(name, import.meta.url);
    if (!existsSync(fileURLToPath(url))) continue;
    // From source (development), through tsx like the server itself.
    return new Worker(url, name.endsWith('.ts') ? { execArgv: ['--import', 'tsx'] } : {});
  }
  return null;
}
