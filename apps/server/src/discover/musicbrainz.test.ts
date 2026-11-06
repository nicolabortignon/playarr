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

  it('waits out a busy MusicBrainz for background work, but retries a search someone waits on only once', async () => {
    vi.useFakeTimers();
    try {
      const busy = () => new Response('{}', { status: 503 });
      const fetch = vi.spyOn(globalThis, 'fetch');
      fetch.mockImplementation(async () => busy());
      const mb = new MusicBrainz('Playarr-test');
      const asked = mb.searchReleases('A', 'One').catch((err: Error) => err);
      await vi.runAllTimersAsync();
      expect(await asked).toBeInstanceOf(Error);
      expect(fetch).toHaveBeenCalledTimes(2);

      fetch.mockClear();
      let calls = 0;
      fetch.mockImplementation(async () => (++calls < 4 ? busy() : new Response(JSON.stringify({ releases: [] }))));
      const background = mb.searchReleases('B', 'Two', undefined, { background: true });
      await vi.runAllTimersAsync();
      expect(await background).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MusicBrainz's discography of an artist", () => {
  it('asks for credits, and only for groups with an official release', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ 'release-groups': [] })));
    await new MusicBrainz('Playarr-test').artistReleaseGroups('a74b1b7f-71a5-4011-9441-d0b5e4122711');
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.searchParams.get('inc')).toBe('artist-credits');
    expect(url.searchParams.get('release-group-status')).toBe('website-default');
    expect(url.searchParams.get('type')).toBe('album|ep');
  });
});
