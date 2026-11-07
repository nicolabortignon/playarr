import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { api, signInRedirect } from './api';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('api.transition', () => {
  it('sends the songs, the mode, the position and the files the player has for the songs', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ status: 'unavailable', reason: 'test' }), { status: 200 });
    });
    await api.transition(1, 2, 'auto', 5, { fromFileId: 101, toFileId: 102 });
    // Older callers leave the files out, and the server then takes the library's files.
    await api.transition(1, 2, 'party');
    await api.transition(1, 2, 'auto', undefined, undefined, { fade: 9, albumQueue: false });
    expect(bodies).toEqual([
      { from: 1, to: 2, mode: 'auto', position: 5, fromFileId: 101, toFileId: 102 },
      { from: 1, to: 2, mode: 'party' },
      { from: 1, to: 2, mode: 'auto', fade: 9, albumQueue: false },
    ]);
  });
});

describe('request', () => {
  it('sends the page to sign in when the server wants a session, but not for the sign-in calls themselves', async () => {
    const go = vi.spyOn(signInRedirect, 'go').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Sign in to Playarr', setup: false }), { status: 401 })));
    await expect(api.favorites()).rejects.toMatchObject({ status: 401, message: 'Sign in to Playarr' });
    expect(go).toHaveBeenCalledTimes(1);
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    expect(go).toHaveBeenCalledTimes(1);
  });

  /** A server that never answers: each request waits until it's stopped. */
  function hangs() {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            signals.push(init.signal!);
            // As fetch does: stopped already, or once stopped.
            if (init.signal!.aborted) reject(init.signal!.reason);
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
          }),
      ),
    );
    return signals;
  }

  it('gives up on a request not answered within 15 s, and on one the server takes its time over after 2 minutes', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const signals = hangs();
    const favorites = expect(api.favorites()).rejects.toMatchObject({ status: 0, message: 'The Playarr server took too long to answer' });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(signals[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await favorites;
    const organizing = expect(api.organize(1, ['a'])).rejects.toMatchObject({ status: 0 });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(signals[1]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await organizing;
  });

  it('leaves nothing waiting once answered', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
    await api.favorites();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops when its caller stops it, as the caller’s own abort', async () => {
    hangs();
    const caller = new AbortController();
    const searching = api.search('massive', caller.signal);
    caller.abort();
    await expect(searching).rejects.toMatchObject({ name: 'AbortError' });
    const already = new AbortController();
    already.abort();
    await expect(api.search('attack', already.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
