/**
 * Records kept in IndexedDB through idb-keyval, in the same database as the query cache: the player's queue and where
 * it is (player/playerRecord.ts), and what's kept on this device (player/offline.ts). Each is written a moment after
 * it changes, one write at a time. A write that fails (storage full, a private window) is logged and tried again with
 * the next change, the state staying in memory meanwhile: a failed write never clears anything. While the page is
 * hidden or going away, whatever waits is written at once.
 */

/** IndexedDB is there to keep things in (it isn't in tests, nor in some older browsers' private windows). */
export const canSave = () => typeof indexedDB !== 'undefined';

export interface Writer {
  /** Something changed: write it within the writer's delay, or at once while the page is hidden. */
  schedule(): void;
  /** Write what waits now. Resolves once written, or once the write has failed (and been logged). */
  flush(): Promise<void>;
}

const writers = new Set<Writer>();
/** The page is hidden or going away: nothing waits for a timer that may never fire. */
let hidden = false;
let watching = false;

function watchPage() {
  if (watching || typeof window === 'undefined' || typeof document === 'undefined') return;
  watching = true;
  // Opened in the background, where timers may wait a minute.
  hidden = document.visibilityState === 'hidden';
  // Registered before anything else's, so a write scheduled by a later listener (the player saving where the song
  // is, as the page goes) happens at once.
  const hide = () => {
    hidden = true;
    for (const w of writers) void w.flush();
  };
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', () => (hidden = false));
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? hide() : (hidden = false)));
}

/**
 * A record written by `write` at most `delayMs` after its first unwritten change (never a write per change, and
 * never put off for ever by changes that keep coming). `write` writes the record as it is then, all of it that's
 * waiting; when it throws, the error is logged and the record waits for the next change, or for the page to hide.
 */
export function writer(what: string, write: () => Promise<void>, delayMs: number): Writer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting = false;
  let running: Promise<void> | null = null;
  let failing = false;

  async function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    while (running) await running;
    if (!waiting) return;
    waiting = false;
    running = write()
      .then(
        () => {
          failing = false;
        },
        (err: unknown) => {
          waiting = true;
          // Once per run of failures: a full disk would otherwise say so at every change.
          if (!failing) console.warn(`Playarr couldn’t save ${what}: it stays as it is here, and saving is tried again with the next change`, err);
          failing = true;
        },
      )
      .finally(() => (running = null));
    await running;
  }

  const w: Writer = {
    schedule() {
      waiting = true;
      if (hidden) return void flush();
      timer ??= setTimeout(() => void flush(), delayMs);
    },
    flush,
  };
  writers.add(w);
  watchPage();
  return w;
}

/** What zustand's persist kept under `key` in localStorage before the records moved to IndexedDB ({ state, version }). */
export function readLegacy(key: string): Record<string, unknown> | undefined {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    if (!raw) return undefined;
    const { state } = JSON.parse(raw) as { state?: unknown };
    return state && typeof state === 'object' ? (state as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Remove the localStorage copy, once the IndexedDB one is written. */
export function forgetLegacy(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage blocked: the copy stays, and is ignored now that IndexedDB has the record.
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
