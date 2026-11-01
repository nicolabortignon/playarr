import type { DatabaseSync } from 'node:sqlite';
import { MIX_MAP_VERSION } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshDb } from '../catalog/testFixtures.ts';
import type { FileResolver } from '../catalog/files.ts';
import type { Library } from '../library/library.ts';
import type { PcmOptions } from '../media/source.ts';
import { Analyzer } from './analyzer.ts';
import { ANALYSIS_VERSION, SAMPLE_RATE } from './dsp.ts';

const MBID = '11111111-1111-1111-1111-111111111111';

afterEach(() => vi.restoreAllMocks());

describe('Analyzer tags', () => {
  it('waits when ListenBrainz says to slow down, then asks again for the same songs', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'X-RateLimit-Reset-In': '0' } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ [MBID]: { tag: { recording: [{ tag: 'trip hop', count: 5 }] } } }), {
          headers: { 'X-RateLimit-Remaining': '10', 'X-RateLimit-Reset-In': '5' },
        }),
      );
    const analyzer = new Analyzer(freshDb(), {} as Library, {} as FileResolver, { enabled: false, log: { warn: () => {} } });
    analyzer.ensure([MBID, 'local:abc']);
    await vi.waitFor(() => expect(analyzer.meta([MBID]).get(MBID)?.tags).toEqual([['trip hop', 1]]), { timeout: 3000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Songs without a MusicBrainz id are never sent (one unknown id fails a whole batch).
    expect(String(fetchMock.mock.calls[1]![0])).not.toContain('local:');
  });
});

/** `seconds` of a 120 BPM click over a low tone, as 16-bit PCM (what ffmpeg hands the analyzer). */
function clickTrack(seconds: number): Buffer {
  const n = SAMPLE_RATE * seconds;
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const beat = i % (SAMPLE_RATE / 2) < 200 ? 0.8 : 0;
    const v = beat + 0.2 * Math.sin((2 * Math.PI * 80 * i) / SAMPLE_RATE);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32000), i * 2);
  }
  return buf;
}

/** An analyzer over one song of `duration` seconds whose decodes are 20 s click tracks. */
function withSong(duration: number, db: DatabaseSync = freshDb(), dsp?: ConstructorParameters<typeof Analyzer>[3]['dsp']) {
  const pcm = vi.fn(async (_path: string, _opts: PcmOptions) => clickTrack(20));
  const library = {
    trackByRecording: async () => ({ fileId: 1, duration }) as Track,
    file: async () => ({ id: 1, sourceId: 1, path: '/music/song.flac' }),
  } as unknown as Library;
  const files = { resolve: () => ({ media: { pcm }, path: '/music/song.flac' }) } as unknown as FileResolver;
  const analyzer = new Analyzer(db, library, files, { enabled: true, log: { warn: () => {} }, dsp });
  return { analyzer, pcm, db };
}

/** Not a MusicBrainz id, so no tags are fetched for it: these tests only wait for its audio analysis. */
const SONG = 'local:song';

const mixMapRow = (db: DatabaseSync, id: string) =>
  db.prepare('SELECT version, data, error FROM mix_maps WHERE recording_id = ?').get(id) as
    | { version: number; data: string | null; error: string | null }
    | undefined;

describe('Analyzer mix maps', () => {
  it('measures a mix map along with the features, from the start of a short song only', async () => {
    const { analyzer, pcm, db } = withSong(200);
    analyzer.ensure([SONG]);
    await vi.waitFor(() => expect(analyzer.pending([SONG])).toBe(0), { timeout: 10_000 });
    expect(analyzer.features([SONG]).has(SONG)).toBe(true);
    expect(mixMapRow(db, SONG)).toMatchObject({ version: MIX_MAP_VERSION, error: null });
    const map = analyzer.mixMaps([SONG]).get(SONG)!;
    expect(map.bpm).toBeCloseTo(120, 0);
    expect(map.duration).toBe(200);
    expect(pcm).toHaveBeenCalledTimes(1);
    expect(pcm.mock.calls[0]![1]).toEqual({ sampleRate: SAMPLE_RATE, maxSeconds: 420 });
  }, 20_000);

  it('also decodes the end of a song longer than 7 minutes, and measures its outro there', async () => {
    const { analyzer, pcm } = withSong(600);
    analyzer.ensure([SONG]);
    await vi.waitFor(() => expect(analyzer.mixMaps([SONG]).has(SONG)).toBe(true), { timeout: 10_000 });
    expect(pcm.mock.calls.map((call) => call[1])).toEqual([
      { sampleRate: SAMPLE_RATE, maxSeconds: 420 },
      { sampleRate: SAMPLE_RATE, maxSeconds: 180, fromEnd: true },
    ]);
    // The tail is the song's last 20 s here, so its sound ends at the song's end, not the head's.
    expect(analyzer.mixMaps([SONG]).get(SONG)!.soundEnd).toBeGreaterThan(590);
  }, 20_000);

  it('measures songs that have features but no mix map yet, without measuring the features again', async () => {
    const db = freshDb();
    db.prepare('INSERT INTO track_features (recording_id, version, features, error, analyzed_at) VALUES (?, ?, ?, NULL, ?)').run(
      SONG,
      ANALYSIS_VERSION,
      JSON.stringify({ stored: true }),
      new Date().toISOString(),
    );
    const { analyzer } = withSong(200, db);
    analyzer.ensure([SONG]);
    expect(analyzer.pending([SONG])).toBe(1);
    await vi.waitFor(() => expect(analyzer.pending([SONG])).toBe(0), { timeout: 10_000 });
    expect(analyzer.mixMaps([SONG]).has(SONG)).toBe(true);
    expect(analyzer.features([SONG]).get(SONG)).toEqual({ stored: true });
    // Both measured: nothing left to do.
    analyzer.ensure([SONG]);
    expect(analyzer.pending([SONG])).toBe(0);
  }, 20_000);

  it('stores why a mix map failed, and doesn’t try again straight away', async () => {
    const { analyzer, pcm, db } = withSong(600);
    pcm.mockImplementation(async (_path, opts) => {
      if (opts.fromEnd) throw new Error('No seeking here');
      return clickTrack(20);
    });
    analyzer.ensure([SONG]);
    await vi.waitFor(() => expect(mixMapRow(db, SONG)?.error).toBe('No seeking here'), { timeout: 10_000 });
    expect(mixMapRow(db, SONG)?.data).toBeNull();
    expect(analyzer.mixMaps([SONG]).has(SONG)).toBe(false);
    await vi.waitFor(() => expect(analyzer.pending([SONG])).toBe(0));
    analyzer.ensure([SONG]);
    expect(analyzer.pending([SONG])).toBe(0);
  }, 20_000);

  it('does its number crunching on the DSP thread it’s given (the one transitions render on)', async () => {
    const dsp = { analyze: vi.fn(async () => ({ given: true }) as never), mixMap: vi.fn(async () => ({ bpm: 99 }) as never) };
    const { analyzer } = withSong(200, freshDb(), dsp);
    analyzer.ensure([SONG]);
    await vi.waitFor(() => expect(analyzer.pending([SONG])).toBe(0), { timeout: 10_000 });
    expect(analyzer.features([SONG]).get(SONG)).toEqual({ given: true });
    expect(analyzer.mixMaps([SONG]).get(SONG)).toEqual({ bpm: 99 });
  }, 20_000);

  it('only hands out mix maps measured by the current version', () => {
    const { analyzer, db } = withSong(200);
    const save = db.prepare('INSERT INTO mix_maps (recording_id, version, data, error, analyzed_at) VALUES (?, ?, ?, ?, ?)');
    const now = new Date().toISOString();
    save.run('current', MIX_MAP_VERSION, JSON.stringify({ bpm: 128 }), null, now);
    save.run('old', MIX_MAP_VERSION - 1, JSON.stringify({ bpm: 100 }), null, now);
    save.run('failed', MIX_MAP_VERSION, null, 'boom', now);
    const maps = analyzer.mixMaps(['current', 'old', 'failed', 'unknown']);
    expect([...maps.keys()]).toEqual(['current']);
    expect(maps.get('current')).toEqual({ bpm: 128 });
  });
});

describe('Analyzer cue points', () => {
  it('stores, replaces and clears a song’s cue points', () => {
    const { analyzer, db } = withSong(200);
    analyzer.setCues('rec', { mixIn: 12.5, mixOut: 190 });
    expect(analyzer.cues(['rec', 'other'])).toEqual(new Map([['rec', { mixIn: 12.5, mixOut: 190 }]]));
    // A cue left out (or null) is cleared.
    analyzer.setCues('rec', { mixOut: 180, mixIn: null });
    expect(analyzer.cues(['rec']).get('rec')).toEqual({ mixOut: 180 });
    analyzer.setCues('rec', {});
    expect(analyzer.cues(['rec']).size).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cue_points').get()).toEqual({ n: 0 });
  });
});
