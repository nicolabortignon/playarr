import type { ChildProcess } from 'node:child_process';
import { setPriority } from 'node:os';

/** The priority of background work: what anyone is waiting for (pages, artwork, streams) comes first. */
const LOW = 15;
/** The lowest: the beat model, which keeps several cores busy for most of a minute per song. */
const LOWEST = 19;

/**
 * Run a background tool (audio analysis, fingerprinting) at low CPU priority, so it never slows down
 * what someone is waiting for: pages, artwork and streams.
 */
export function lowPriority<T extends ChildProcess>(child: T): T {
  try {
    if (child.pid) setPriority(child.pid, LOW);
  } catch {
    // Not allowed here: it just runs at normal priority.
  }
  return child;
}

/**
 * Run the calling worker thread, and the threads it starts from now on, at the lowest CPU priority. Only
 * on Linux, where each thread has its own priority; elsewhere this would slow the whole server.
 */
export function lowestPriorityThread() {
  if (process.platform !== 'linux') return;
  try {
    setPriority(LOWEST);
  } catch {
    // Not allowed here: it just runs at normal priority.
  }
}
