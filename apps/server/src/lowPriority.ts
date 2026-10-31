import type { ChildProcess } from 'node:child_process';
import { setPriority } from 'node:os';

/**
 * Run a background tool (audio analysis, fingerprinting) at low CPU priority, so it never slows down
 * what someone is waiting for: pages, artwork and streams.
 */
export function lowPriority<T extends ChildProcess>(child: T): T {
  try {
    if (child.pid) setPriority(child.pid, 15);
  } catch {
    // Not allowed here: it just runs at normal priority.
  }
  return child;
}
