import type { Track } from '@playarr/shared';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { freshDb } from '../catalog/testFixtures.ts';
import { LyricsService, parseLrc } from './lyrics.ts';

const track = { id: 1, fileId: 1, recordingId: 'rec-1', artistName: 'Coldplay', title: 'Yellow', albumTitle: 'Parachutes', duration: 269 } as Track;

function setup(opts: { lrc?: string; responses?: (Response | null)[] } = {}) {
  const files: Record<string, string> = opts.lrc ? { '/music/Yellow.lrc': opts.lrc } : {};
  const media = {
    stat: async (path: string) => {
      if (path === '/music/Yellow.flac') return { size: 10, mtimeMs: 0 };
      if (files[path] !== undefined) return { size: files[path]!.length, mtimeMs: 0 };
      throw new Error('ENOENT');
    },
    open: async (path: string) => Readable.from([Buffer.from(files[path]!)]),
  };
  const queue = [...(opts.responses ?? [])];
  const fetch = vi.fn(async () => queue.shift() ?? new Response('', { status: 404 })) as unknown as typeof globalThis.fetch;
  const service = new LyricsService(
    freshDb(),
    { track: async (id) => (id === 1 ? track : undefined), file: async () => ({ fileId: 1 }) as never },
    { resolve: () => ({ media: media as never, path: '/music/Yellow.flac' }) as never },
    { log: { warn: () => {} }, fetch },
  );
  return { service, fetch };
}

describe('lyrics', () => {
  it('reads LRC: several times per line, fractions, and an offset', () => {
    expect(parseLrc('[ar:Coldplay]\n[offset:+500]\n[00:10.50][01:00.00]Look at the stars\n[00:20.25] Look how they shine\n')).toEqual([
      { at: 10, text: 'Look at the stars' },
      { at: 19.75, text: 'Look how they shine' },
      { at: 59.5, text: 'Look at the stars' },
    ]);
    expect(parseLrc('Just words\nno times')).toBeNull();
  });

  it('prefers an .lrc file beside the song', async () => {
    const { service, fetch } = setup({ lrc: '﻿[00:01.00]Hello' });
    expect(await service.forTrack(1)).toEqual({ synced: [{ at: 1, text: 'Hello' }], source: 'file' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks LRCLIB, then searches by name for the closest length, and remembers', async () => {
    const search = Response.json([
      { duration: 200, syncedLyrics: '[00:01.00]Wrong song' },
      { duration: 268, plainLyrics: 'Plain words' },
      { duration: 270, syncedLyrics: '[00:02.00]Synced words' },
    ]);
    const { service, fetch } = setup({ responses: [new Response('', { status: 404 }), search] });
    const found = await service.forTrack(1);
    expect(found).toEqual({ synced: [{ at: 2, text: 'Synced words' }], source: 'lrclib' });
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toContain('duration=269');
    expect(await service.forTrack(1)).toEqual(found);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('remembers that a song has none, and knows unknown songs', async () => {
    const { service, fetch } = setup({ responses: [new Response('', { status: 404 }), Response.json([])] });
    expect(await service.forTrack(1)).toBeNull();
    expect(await service.forTrack(1)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await service.forTrack(2)).toBeUndefined();
  });
});
