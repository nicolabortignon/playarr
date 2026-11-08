// Fakes for the tests of what's saved and of the tabs (player/storage.test.ts, player/tabs.test.ts,
// player/playerRecord.test.ts): IndexedDB as idb-keyval sees it, Web Locks, BroadcastChannel and the audio cache.
// A test imports the player modules once per tab (openTab); each copy sees these same fakes.
import { vi } from 'vitest';

/** IndexedDB as idb-keyval sees it, shared by every copy of the modules a test imports. */
export interface FakeIdb {
  data: Map<string, unknown>;
  /** While set, writes throw it: a full disk (QuotaExceededError), a private window. */
  failWrites: Error | null;
  /** While set, reads wait for it: a slow start. */
  readGate: Promise<void> | null;
  /** The keys of each write, in turn. */
  writes: string[][];
}

const holder = globalThis as { __playarrFakeIdb?: FakeIdb };
export const idb: FakeIdb = (holder.__playarrFakeIdb ??= { data: new Map(), failWrites: null, readGate: null, writes: [] });

export function resetIdb() {
  idb.data.clear();
  idb.failWrites = null;
  idb.readGate = null;
  idb.writes.length = 0;
}

/** A gate for reads: they wait until `open()`. */
export function gateReads() {
  let open = () => {};
  idb.readGate = new Promise<void>((resolve) => (open = resolve));
  return () => {
    idb.readGate = null;
    open();
  };
}

const copy = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

/** idb-keyval on `idb`: vi.mock('idb-keyval', async () => (await import('../testFakes')).fakeIdbKeyval). */
export const fakeIdbKeyval = {
  async get(key: string) {
    await idb.readGate;
    return copy(idb.data.get(key));
  },
  async getMany(keys: string[]) {
    await idb.readGate;
    return keys.map((key) => copy(idb.data.get(key)));
  },
  async set(key: string, value: unknown) {
    if (idb.failWrites) throw idb.failWrites;
    idb.writes.push([key]);
    idb.data.set(key, copy(value));
  },
  async setMany(entries: [string, unknown][]) {
    if (idb.failWrites) throw idb.failWrites;
    idb.writes.push(entries.map(([key]) => key));
    for (const [key, value] of entries) idb.data.set(key, copy(value));
  },
  async del(key: string) {
    idb.data.delete(key);
  },
};

export const quotaError = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');

type Granted = (lock: Lock | null) => unknown;
interface Waiter {
  callback: Granted;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/** Web Locks, shared by the tabs of a test: exclusive locks, a line, ifAvailable, steal and signal. */
export class FakeLocks {
  private held = new Map<string, Waiter>();
  private lines = new Map<string, Waiter[]>();

  request(name: string, options: LockOptions | Granted, maybe?: Granted): Promise<unknown> {
    const opts: LockOptions = typeof options === 'function' ? {} : options;
    const callback = (typeof options === 'function' ? options : maybe)!;
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { callback, resolve, reject };
      if (opts.signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      if (opts.steal) {
        const holding = this.held.get(name);
        this.held.delete(name);
        holding?.reject(new DOMException('Lock broken by another request with the steal option', 'AbortError'));
        return this.grant(name, waiter);
      }
      if (!this.held.has(name)) return this.grant(name, waiter);
      if (opts.ifAvailable) {
        void Promise.resolve()
          .then(() => callback(null))
          .then(resolve, reject);
        return;
      }
      const line = this.lines.get(name) ?? [];
      this.lines.set(name, line);
      line.push(waiter);
      opts.signal?.addEventListener('abort', () => {
        const at = line.indexOf(waiter);
        if (at < 0) return;
        line.splice(at, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  }

  /** The tab holding `name` closed: the next in line gets it. */
  close(name: string) {
    this.held.delete(name);
    this.next(name);
  }

  isHeld(name: string) {
    return this.held.has(name);
  }

  private grant(name: string, waiter: Waiter) {
    this.held.set(name, waiter);
    void Promise.resolve()
      .then(() => waiter.callback({ name, mode: 'exclusive' } as Lock))
      .then(
        (value) => {
          this.release(name, waiter);
          waiter.resolve(value);
        },
        (err: unknown) => {
          this.release(name, waiter);
          waiter.reject(err);
        },
      );
  }

  private release(name: string, waiter: Waiter) {
    // Taken by a steal meanwhile: not this request's to give back.
    if (this.held.get(name) !== waiter) return;
    this.held.delete(name);
    this.next(name);
  }

  private next(name: string) {
    const waiter = this.lines.get(name)?.shift();
    if (waiter) this.grant(name, waiter);
  }
}

/** BroadcastChannel between the tabs of a test: each message reaches the other channels of its name a task later, in order. */
export class FakeChannel {
  static open = new Set<FakeChannel>();
  onmessage: ((event: MessageEvent) => void) | null = null;
  private inbox: unknown[] = [];

  constructor(readonly name: string) {
    FakeChannel.open.add(this);
  }

  postMessage(data: unknown) {
    for (const channel of FakeChannel.open) if (channel !== this && channel.name === this.name) channel.receive(structuredClone(data));
  }

  close() {
    FakeChannel.open.delete(this);
  }

  // Fake timers may run a timer set during another one after a later one: the inbox keeps the order messages were sent in.
  private receive(message: unknown) {
    this.inbox.push(message);
    setTimeout(() => {
      while (this.inbox.length) this.onmessage?.({ data: this.inbox.shift() } as MessageEvent);
    }, 0);
  }
}

/** The audio cache, by path and query, with each file's headers: what Cache Storage keeps. */
export function fakeAudioCache() {
  const files = new Map<string, { body: Uint8Array; headers: Headers }>();
  const deleted: string[] = [];
  const address = (url: string | Request) => {
    const { pathname, search } = new URL(typeof url === 'string' ? url : url.url, 'http://localhost:4000');
    return pathname + search;
  };
  const cache = {
    async put(url: string, res: Response) {
      files.set(address(url), { body: new Uint8Array(await res.arrayBuffer()), headers: new Headers(res.headers) });
    },
    async delete(url: string) {
      deleted.push(address(url));
      return files.delete(address(url));
    },
    async keys() {
      return [...files.keys()].map((path) => new Request(new URL(path, 'http://localhost:4000')));
    },
    async match(url: string | Request) {
      const file = files.get(address(url));
      return file ? new Response(file.body.slice(), { headers: file.headers }) : undefined;
    },
  };
  /** Put a file there as if kept: `bytes` long, sent by the server at `date`. */
  const keep = (path: string, bytes: number, date = 'Mon, 02 Nov 2026 10:00:00 GMT') =>
    files.set(path, { body: new Uint8Array(bytes), headers: new Headers({ 'Content-Length': String(bytes), Date: date }) });
  const caches = {
    open: async () => cache,
    delete: async () => {
      deleted.push('*');
      files.clear();
      return true;
    },
    match: async (url: string) => cache.match(url),
  };
  return { files, deleted, keep, caches };
}

/**
 * A tab: its own copy of the player's modules, on the IndexedDB, locks, channel and cache all tabs share (the test
 * stubs them: indexedDB, BroadcastChannel = FakeChannel, navigator.locks, caches). Its play reports are recorded.
 */
export async function openTab(locks: FakeLocks | null) {
  vi.resetModules();
  const tabs = await import('./player/tabs');
  const offline = await import('./player/offline');
  const store = await import('./player/store');
  const playerRecord = await import('./player/playerRecord');
  const tracker = await import('./player/playTracker');
  const { api } = await import('./lib/api');
  const reported = vi.spyOn(api, 'reportPlays').mockResolvedValue(undefined as never);
  tabs.startTabs();
  const channel = [...FakeChannel.open].at(-1);
  await vi.advanceTimersByTimeAsync(0);
  /** The tab closes: its lock goes to the next tab in line, and it hears nothing more. */
  const close = () => {
    channel?.close();
    if (tabs.isLeader()) locks?.close('playarr.leader');
  };
  return { tabs, offline, store, playerRecord, tracker, reported, close };
}
export type Tab = Awaited<ReturnType<typeof openTab>>;
