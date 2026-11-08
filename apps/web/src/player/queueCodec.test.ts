import type { Track } from '@playarr/shared';
import { describe, expect, it } from 'vitest';
import { compactQueue, expandQueue } from './queueCodec';

const FLAC = { codec: 'FLAC', container: 'flac', bits: 16, sampleRate: 44100, channels: 2, lossless: true };

/** A song as the server sends one (catalog/build.ts), with its album's cover colors. */
function song(album: number, n: number): Track {
  const id = album * 100 + n;
  return {
    id,
    recordingId: `0b1e3c5d-${String(album).padStart(4, '0')}-4a7f-9c2e-${String(id).padStart(12, '0')}`,
    fileId: 50_000 + id,
    albumId: album,
    artistId: 900 + (album % 40),
    title: `A song called number ${n} of ${album}`,
    artistName: `Artist ${album % 40} and the band`,
    albumTitle: `The album number ${album}`,
    trackNumber: n,
    discNumber: 1,
    duration: 180 + ((id * 7) % 240) + 0.373,
    explicit: false,
    format: { ...FLAC, bitrate: 850 + ((id * 13) % 200) },
    size: 20_000_000 + id * 977,
    streamUrl: `/stream/${50_000 + id}`,
    coverUrl: `/art/album/${album}/cover?v=4f3a9c${album % 10}`,
    coverColor: '#3a2f1e',
    coverAccent: '#c9a26b',
  };
}

describe('the saved queue', () => {
  it('comes back exactly as it went, whatever a song holds', () => {
    const plain = song(7, 1);
    const odd = {
      ...song(7, 2),
      // Not its album's: a compilation's own artist, a different cover.
      artistName: 'Someone else',
      coverUrl: undefined,
      // Not streamed from /stream/<fileId>, and a field this version doesn't know.
      streamUrl: '/transitions/1-2.flac',
      favoritedAt: '2026-11-01T10:00:00.000Z',
    } as Track;
    const bare = { id: 3, fileId: 3, streamUrl: '/stream/3', title: 'No more than that', duration: 200 } as Track;
    const mp3 = { ...song(8, 1), format: { codec: 'MP3', container: 'mp3', lossless: false } };
    const queue = [plain, odd, bare, mp3];
    expect(expandQueue(compactQueue(queue))).toEqual(queue);
    // It's what IndexedDB keeps: a structured clone.
    expect(expandQueue(structuredClone(compactQueue(queue)))).toEqual(queue);
  });

  it('holds a song the queue has twice once, and gives it back as one song', () => {
    const a = song(1, 1);
    const b = song(1, 2);
    const saved = compactQueue([a, b, a]);
    expect(saved.rows).toHaveLength(2);
    const queue = expandQueue(saved)!;
    expect(queue.map((t) => t.id)).toEqual([a.id, b.id, a.id]);
    expect(queue[0]).toBe(queue[2]);
  });

  it('takes about a quarter of a queue of whole songs', () => {
    const queue = Array.from({ length: 1000 }, (_, album) => Array.from({ length: 10 }, (_, n) => song(album + 1, n + 1))).flat();
    const whole = JSON.stringify(queue).length;
    const saved = JSON.stringify(compactQueue(queue)).length;
    // Measured: 10,000 songs of 1,000 albums are 544 bytes a song whole (5.4 MB), 134 saved (1.3 MB).
    expect(whole / queue.length).toBeGreaterThan(500);
    expect(saved / whole).toBeLessThan(0.3);
  });

  it('is nothing when what was read isn’t a saved queue', () => {
    expect(expandQueue(undefined)).toBeUndefined();
    expect(expandQueue([song(1, 1)])).toBeUndefined();
    expect(expandQueue({ v: 2, albums: {}, kinds: [], rows: [] })).toBeUndefined();
    expect(expandQueue({ v: 1, albums: {}, kinds: [], rows: ['junk'] })).toBeUndefined();
    expect(expandQueue({ v: 1, albums: {}, kinds: [], rows: [] })).toEqual([]);
  });
});
