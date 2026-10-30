import { afterEach, describe, expect, it, vi } from 'vitest';
import { MusicBrainz } from './musicbrainz.ts';

afterEach(() => vi.restoreAllMocks());

describe('MusicBrainz queue status', () => {
  it('counts waiting lookups, and background ones separately', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ releases: [] })));
    const mb = new MusicBrainz('Playarr-test');
    expect(mb.status()).toEqual({ queued: 0, background: 0, etaSeconds: 0 });
    const a = mb.searchReleases('A', 'One');
    const b = mb.searchReleases('B', 'Two', undefined, { background: true });
    expect(mb.status()).toEqual({ queued: 2, background: 1, etaSeconds: 3 });
    await Promise.all([a, b]);
    expect(mb.status()).toEqual({ queued: 0, background: 0, etaSeconds: 0 });
  });

  it('frees its place in line when a lookup fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 404 }));
    const mb = new MusicBrainz('Playarr-test');
    await expect(mb.release('nope')).rejects.toThrow(/404/);
    expect(mb.status().queued).toBe(0);
  });

  it('answers cached lookups without queueing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ releases: [] })));
    const mb = new MusicBrainz('Playarr-test');
    await mb.searchReleases('A', 'One');
    const again = mb.searchReleases('A', 'One');
    expect(mb.status().queued).toBe(0);
    await again;
  });
});
