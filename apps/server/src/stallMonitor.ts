import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Logs when the server stopped answering for a while (its event loop was blocked), so freezes show up
 * in the logs with how long they lasted.
 */
export function watchStalls(log: { warn: (msg: string) => void }, { everyMs = 60_000, thresholdMs = 500 } = {}) {
  const delay = monitorEventLoopDelay({ resolution: 50 });
  delay.enable();
  const timer = setInterval(() => {
    const worst = delay.max / 1e6;
    if (worst >= thresholdMs) {
      log.warn(`Server was unresponsive for up to ${Math.round(worst)} ms in the last ${everyMs / 1000} s`);
    }
    delay.reset();
  }, everyMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    delay.disable();
  };
}
