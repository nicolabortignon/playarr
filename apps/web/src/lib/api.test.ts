import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());

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
    expect(bodies).toEqual([
      { from: 1, to: 2, mode: 'auto', position: 5, fromFileId: 101, toFileId: 102 },
      { from: 1, to: 2, mode: 'party' },
    ]);
  });
});
