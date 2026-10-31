/**
 * Images load a few at a time, those on screen first, then those about to scroll in. Letting a long grid
 * ask for every cover at once fills the browser's few connections to the server, so pages and the songs
 * themselves wait behind artwork, and the server resizes dozens of images at the same time.
 */
export const MAX_LOADING = 4;
/** A load that never reports back (a dropped connection) gives its turn up after this. */
const STUCK_MS = 20_000;

/** Lower goes first. */
export const ON_SCREEN = 0;
export const NEAR_SCREEN = 1;

interface Waiter {
  priority: number;
  order: number;
  start: (done: () => void) => void;
}

const waiting = new Set<Waiter>();
let loading = 0;
let order = 0;
let pumpScheduled = false;
/** Images already loaded in this visit: shown again at once (the browser has them), without queueing. */
const loaded = new Set<string>();

export const wasLoaded = (url: string) => loaded.has(url);
export const markLoaded = (url: string) => void loaded.add(url);

/**
 * Wait for a turn to load an image. `start` gets a `done` to call once the image loaded or failed.
 * Returns a cancel for when the image is no longer wanted before its turn (it scrolled away).
 */
export function queueImage(priority: number, start: (done: () => void) => void): () => void {
  const waiter = { priority, order: order++, start };
  waiting.add(waiter);
  // Hand out turns once everything a scroll brought into view has asked, so on-screen images go first.
  if (!pumpScheduled) {
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pump();
    });
  }
  return () => void waiting.delete(waiter);
}

function pump() {
  while (loading < MAX_LOADING && waiting.size) {
    let next: Waiter | undefined;
    for (const w of waiting) if (!next || w.priority < next.priority || (w.priority === next.priority && w.order < next.order)) next = w;
    waiting.delete(next!);
    loading++;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      loading--;
      pump();
    };
    const timer = setTimeout(done, STUCK_MS);
    next!.start(done);
  }
}

/** For tests: forget everything. */
export function resetImageQueue() {
  waiting.clear();
  loaded.clear();
  loading = 0;
}
