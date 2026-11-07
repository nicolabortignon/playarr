import { monitorEventLoopDelay } from 'node:perf_hooks';

/** The stalls found since the monitor started (GET /api/diagnostics): how many, the longest (ms), and when the last was. */
export interface StallTally {
  count: number;
  longestMs: number;
  lastAt?: string;
}

/**
 * Logs when the server stopped answering for a while (its event loop was blocked), so freezes show up
 * in the logs with how long they lasted, and keeps a tally of them.
 */
export function watchStalls(log: { warn: (msg: string) => void }, { everyMs = 60_000, thresholdMs = 500 } = {}) {
  const delay = monitorEventLoopDelay({ resolution: 50 });
  delay.enable();
  const tally: StallTally = { count: 0, longestMs: 0 };
  const timer = setInterval(() => {
    const worst = delay.max / 1e6;
    if (worst >= thresholdMs) {
      log.warn(`Server was unresponsive for up to ${Math.round(worst)} ms in the last ${everyMs / 1000} s`);
      tally.count += 1;
      tally.longestMs = Math.max(tally.longestMs, Math.round(worst));
      tally.lastAt = new Date().toISOString();
    }
    delay.reset();
  }, everyMs);
  timer.unref();
  return {
    tally: (): StallTally => ({ ...tally }),
    stop: () => {
      clearInterval(timer);
      delay.disable();
    },
  };
}
