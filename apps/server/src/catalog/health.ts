/**
 * Which sources don't answer just now: a folder whose disk or host is away, or Lidarr's music folders. A source is
 * asked (`probe`) when one of its files can't be read or its sync fails, and found offline only when the source
 * itself doesn't answer: a file that's gone is the file's problem, not the source's. Offline sources are asked again
 * every minute, and are back as soon as they answer or one of their files is read.
 *
 * The library plays a copy elsewhere for songs that have one while their source is offline (catalog/build.ts), and
 * the stream routes try the next copy when one can't be read (routes/stream.ts).
 */
export interface SourceHealthDeps {
  /**
   * Resolves when the source answers, rejects when it doesn't; undefined when there's nothing to ask (it then counts
   * as answering).
   */
  probe: (sourceId: number) => Promise<unknown> | undefined;
  /** The set of offline sources changed. */
  onChange: (offline: ReadonlySet<number>) => void;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  /** How long an answer is waited for (ms). */
  timeoutMs?: number;
  /** How often offline sources are asked again (ms). */
  recheckMs?: number;
}

export class SourceHealth {
  private readonly down = new Map<number, string>();
  private readonly asking = new Map<number, Promise<boolean>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SourceHealthDeps) {}

  /** The sources that don't answer just now. */
  offline(): ReadonlySet<number> {
    return new Set(this.down.keys());
  }

  isOffline(sourceId: number): boolean {
    return this.down.has(sourceId);
  }

  /**
   * One of the source's files couldn't be read, or its sync failed: asks the source, once at a time, and says
   * whether it's offline.
   */
  check(sourceId: number): Promise<boolean> {
    let asked = this.asking.get(sourceId);
    if (!asked) {
      asked = this.ask(sourceId).finally(() => this.asking.delete(sourceId));
      this.asking.set(sourceId, asked);
    }
    return asked;
  }

  /** One of the source's files was read, or its sync worked: it answers. */
  reached(sourceId: number) {
    if (this.down.delete(sourceId)) this.changed(sourceId, null);
  }

  /** Asks the offline sources again every so often until stop(). */
  start() {
    this.timer ??= setInterval(() => {
      for (const id of [...this.down.keys()]) void this.check(id);
    }, this.deps.recheckMs ?? 60_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async ask(sourceId: number): Promise<boolean> {
    const probe = this.deps.probe(sourceId);
    if (!probe) {
      this.reached(sourceId);
      return false;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('no answer')), this.deps.timeoutMs ?? 10_000);
      timer.unref?.();
    });
    try {
      await Promise.race([probe, timeout]);
      this.reached(sourceId);
      return false;
    } catch (err) {
      const reason = (err as Error).message || 'no answer';
      if (!this.down.has(sourceId)) {
        this.down.set(sourceId, reason);
        this.changed(sourceId, reason);
      }
      return true;
    } finally {
      clearTimeout(timer);
      // A probe that answers after the timeout mustn't be an unhandled rejection.
      probe.then(
        () => {},
        () => {},
      );
    }
  }

  private changed(sourceId: number, reason: string | null) {
    if (reason) this.deps.log.warn(`Source ${sourceId} doesn’t answer (${reason}): its songs play from other sources where they can`);
    else this.deps.log.info(`Source ${sourceId} answers again`);
    this.deps.onChange(this.offline());
  }
}
