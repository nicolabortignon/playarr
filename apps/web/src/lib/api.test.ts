import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
