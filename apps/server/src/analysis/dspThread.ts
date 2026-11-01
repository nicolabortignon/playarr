import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { analyzePcm, pcmToFloat, type AudioFeatures } from './dsp.ts';

type Pending = { resolve: (f: AudioFeatures) => void; reject: (e: Error) => void };

/**
 * analyzePcm in a worker thread, one song at a time. Built, the worker is dist/dspWorker.js next to
 * the server; in development it runs from its source. If no worker can start, songs are measured on
 * the main thread as before (slower to respond, but still working).
 */
export class DspThread {
  private worker: Worker | null = null;
  private failed = false;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  analyze(pcm: Buffer): Promise<AudioFeatures> {
    const worker = this.start();
    if (!worker) return Promise.resolve(analyzePcm(pcmToFloat(pcm)));
    const id = this.nextId++;
    // A copy of just these bytes, handed over to the worker rather than copied again.
    const bytes = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, pcm: bytes }, [bytes]);
    });
  }

  close() {
    void this.worker?.terminate();
    this.worker = null;
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
      worker.on('message', (m: { id: number; features?: AudioFeatures; error?: string }) => {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.features) p?.resolve(m.features);
        else p?.reject(new Error(m.error ?? 'Analysis failed'));
      });
      const lost = (err: Error) => {
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.worker = null;
      };
      worker.on('error', lost);
      worker.on('exit', (code) => code !== 0 && lost(new Error(`Analysis worker stopped (${code})`)));
      this.worker = worker;
      return worker;
    } catch {
      this.failed = true;
      return null;
    }
  }
}

function workerFile(): URL | null {
  for (const name of ['./dspWorker.js', './dspWorker.ts']) {
    const url = new URL(name, import.meta.url);
    if (existsSync(fileURLToPath(url))) return url;
  }
  return null;
}
