import type { DatabaseSync } from 'node:sqlite';
import { MIX_MAP_VERSION } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLAC, freshDb } from '../catalog/testFixtures.ts';
import type { FileResolver } from '../catalog/files.ts';
import type { Library } from '../library/library.ts';
import type { PcmOptions } from '../media/source.ts';
import { Analyzer } from './analyzer.ts';
import { ANALYSIS_VERSION, SAMPLE_RATE } from './dsp.ts';
import { DspWorkerLost } from './dspThread.ts';

const MBID = '11111111-1111-1111-1111-111111111111';

const analyzers: Analyzer[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const analyzer of analyzers.splice(0)) analyzer.close();
});

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
    analyzers.push(analyzer);
    analyzer.ensure([MBID, 'local:abc']);
    await vi.waitFor(() => expect(analyzer.meta([MBID]).get(MBID)?.tags).toEqual([['trip hop', 1]]), { timeout: 3000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Songs without a MusicBrainz id are never sent (one unknown id fails a whole batch).
    expect(String(fetchMock.mock.calls[1]![0])).not.toContain('local:');
  });
});

type Kind = 'click' | 'timed' | 'silent';

/**
 * Samples [from, to) seconds of a song, as 16-bit PCM (what ffmpeg hands the analyzer). `click` is a
 * 120 BPM click over a low tone; `timed` holds in each sample the song time it was taken at, in
 * tenths of a second, so a test can tell which part of the song it was handed.
 */
function audio(kind: Kind, from: number, to: number): Buffer {
  const first = Math.round(from * SAMPLE_RATE);
  const samples = new Int16Array(Math.max(0, Math.round(to * SAMPLE_RATE) - first));
  if (kind === 'silent') return Buffer.from(samples.buffer);
  for (let k = 0; k < samples.length; k++) {
    const i = first + k;
    if (kind === 'timed') samples[k] = Math.floor((i * 10) / SAMPLE_RATE) % 32768;
    else {
      const beat = i % (SAMPLE_RATE / 2) < 200 ? 0.8 : 0;
      const v = beat + 0.2 * Math.sin((2 * Math.PI * 80 * i) / SAMPLE_RATE);
      samples[k] = Math.round(Math.max(-1, Math.min(1, v)) * 32000);
    }
  }
  return Buffer.from(samples.buffer);
}

/** The song time (seconds) a `timed` sample was taken at. */
const timeAt = (pcm: Buffer, sample: number) => pcm.readInt16LE(sample * 2) / 10;

type Dsp = NonNullable<ConstructorParameters<typeof Analyzer>[3]['dsp']>;

/** A DSP thread that measures nothing, and keeps what it was handed. */
function fakeDsp() {
  return {
    analyze: vi.fn(async (_pcm: Buffer) => ({ fake: true }) as never),
    mixMap: vi.fn(async (_head: Buffer, _tail: Buffer | null, duration: number) => ({ duration }) as never),
  } satisfies Dsp;
}

/**
 * An analyzer over songs whose files hold `seconds` of audio while the library says they last
 * `listed` (MusicBrainz's rounded length, maybe another release's). Decodes honour startSeconds and
 * maxSeconds, and stop at the file's end.
 */
function withSong(
  opts: { seconds: number; listed?: number; kind?: Kind; format?: Track['format']; db?: DatabaseSync; dsp?: Dsp },
) {
  const { seconds, listed = seconds, kind = 'timed', format = FLAC, db = freshDb(), dsp } = opts;
  const pcm = vi.fn(async (_path: string, decode: PcmOptions) => {
    if (decode.fromEnd) throw new Error('The end of a file is found by decoding at known positions');
    const from = decode.startSeconds ?? 0;
    return audio(kind, Math.min(from, seconds), Math.min(seconds, from + decode.maxSeconds));
  });
  const asked: string[] = [];
  const library = {
    trackByRecording: async (id: string) => {
      asked.push(id);
      return { fileId: 1, duration: listed, format } as Track;
    },
    file: async () => ({ id: 1, sourceId: 1, path: '/music/song.flac' }),
  } as unknown as Library;
  const files = { resolve: () => ({ media: { pcm }, path: '/music/song.flac' }) } as unknown as FileResolver;
  const analyzer = new Analyzer(db, library, files, { enabled: true, log: { warn: () => {} }, dsp });
  analyzers.push(analyzer);
  /** What each decode was asked for, without its timeout signal. */
  const decodes = () => pcm.mock.calls.map(([, { signal, ...rest }]) => rest);
  return { analyzer, pcm, db, asked, decodes };
}

/** Not a MusicBrainz id, so no tags are fetched for it: these tests only wait for its audio analysis. */
const SONG = 'local:song';

const mixMapRow = (db: DatabaseSync, id: string) =>
  db.prepare('SELECT version, data, error FROM mix_maps WHERE recording_id = ?').get(id) as
    | { version: number; data: string | null; error: string | null }
    | undefined;

/** Measures SONG with a fake DSP thread; what its mix map was made from. */
async function measured(opts: Parameters<typeof withSong>[0]) {
  const dsp = fakeDsp();
  const song = withSong({ ...opts, dsp });
  song.analyzer.ensure([SONG]);
  await vi.waitFor(() => expect(song.analyzer.pending([SONG])).toBe(0), { timeout: 10_000 });
  const call = dsp.mixMap.mock.calls[0];
  return { ...song, dsp, head: call?.[0], tail: call?.[1], duration: call?.[2] };
}

const HEAD = { sampleRate: SAMPLE_RATE, maxSeconds: 420 };

describe('Analyzer mix maps', () => {
  it('measures a mix map along with the features, from the start of a short song only', async () => {
    const { analyzer, pcm, db } = withSong({ seconds: 20, listed: 200, kind: 'click' });
    analyzer.ensure([SONG]);
    await vi.waitFor(() => expect(analyzer.pending([SONG])).toBe(0), { timeout: 10_000 });
    expect(analyzer.features([SONG]).has(SONG)).toBe(true);
    expect(mixMapRow(db, SONG)).toMatchObject({ version: MIX_MAP_VERSION, error: null });
    const map = analyzer.mixMaps([SONG]).get(SONG)!;
    expect(map.bpm).toBeCloseTo(120, 0);
    // The decoded audio is the song's exact length; the library's is rounded, maybe another release's.
    expect(map.duration).toBe(20);
    expect(pcm).toHaveBeenCalledTimes(1);
    expect(pcm.mock.calls[0]![1]).toMatchObject(HEAD);
    expect(pcm.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  }, 20_000);

  it('takes a short song’s length from its audio, longer or shorter than the library says', async () => {
    for (const listed of [180, 230, 0]) {
      const { tail, duration, decodes } = await measured({ seconds: 203.7, listed });
      expect(duration).toBeCloseTo(203.7, 3);
      expect(tail).toBeNull();
      expect(decodes()).toEqual([HEAD]);
    }
  });

  it('decodes a long song’s end at a known position, so its last 3 minutes sit exactly where they are', async () => {
    const { tail, duration, decodes } = await measured({ seconds: 600.4, listed: 600 });
    expect(decodes()).toEqual([HEAD, { sampleRate: SAMPLE_RATE, startSeconds: 420, maxSeconds: 240 }]);
    expect(duration).toBeCloseTo(600.4, 3);
    expect(tail!.length / 2 / SAMPLE_RATE).toBeCloseTo(180, 3);
    expect(timeAt(tail!, 0)).toBeCloseTo(420.4, 1);
    expect(timeAt(tail!, tail!.length / 2 - 1)).toBeCloseTo(600.3, 1);
  });

  it('starts the end’s decode where the library’s length says it is', async () => {
    const { tail, duration, decodes } = await measured({ seconds: 1000.2, listed: 1000 });
    expect(decodes()[1]).toEqual({ sampleRate: SAMPLE_RATE, startSeconds: 790, maxSeconds: 240 });
    expect(duration).toBeCloseTo(1000.2, 3);
    expect(timeAt(tail!, 0)).toBeCloseTo(820.2, 1);
  });

  it('finds the end of a song that runs past the 7 minutes the library says it lasts', async () => {
    const { tail, duration } = await measured({ seconds: 425, listed: 419 });
    expect(duration).toBeCloseTo(425, 3);
    // The last 3 minutes, partly from the start's decode: none of the last 6 s are lost.
    expect(tail!.length / 2 / SAMPLE_RATE).toBeCloseTo(180, 3);
    expect(timeAt(tail!, 0)).toBeCloseTo(245, 1);
    expect(timeAt(tail!, tail!.length / 2 - 1)).toBeCloseTo(424.9, 1);
  });

  it('finds the end of a long song the library has no length for', async () => {
    const { tail, duration, decodes } = await measured({ seconds: 1000, listed: 0 });
    expect(duration).toBeCloseTo(1000, 3);
    expect(timeAt(tail!, 0)).toBeCloseTo(820, 1);
    // Each window that doesn't reach the end is followed by a longer one, overlapping its last 3 minutes.
    expect(decodes().map((d) => [d.startSeconds, d.maxSeconds])).toEqual([
      [undefined, 420],
      [420, 240],
      [480, 480],
      [780, 960],
    ]);
  });

  it('finds the end of a song shorter than the library says', async () => {
    for (const listed of [700, 2000]) {
      const { tail, duration } = await measured({ seconds: 600, listed });
      expect(duration).toBeCloseTo(600, 3);
      expect(tail!.length / 2 / SAMPLE_RATE).toBeCloseTo(180, 3);
      expect(timeAt(tail!, 0)).toBeCloseTo(420, 1);
    }
  });

  it('decodes an MP3’s end exactly (its seeking is an estimate)', async () => {
    const mp3 = { codec: 'MP3', container: 'mp3', bits: 16, sampleRate: 44100, lossless: false };
    const { decodes } = await measured({ seconds: 600, format: mp3 });
    expect(decodes()[1]).toEqual({ sampleRate: SAMPLE_RATE, startSeconds: 420, maxSeconds: 240, exactSeek: true });
  });

  it('gives up on finding the end of a song that never ends', async () => {
    const { db, dsp } = await measured({ seconds: Infinity, listed: 0, kind: 'silent' });
    expect(dsp.mixMap).not.toHaveBeenCalled();
    expect(mixMapRow(db, SONG)?.error).toMatch(/^tail: /);
  }, 20_000);

  it('measures songs that have features but no mix map yet, without measuring the features again', async () => {
    const db = freshDb();
    db.prepare('INSERT INTO track_features (recording_id, version, features, error, analyzed_at) VALUES (?, ?, ?, NULL, ?)').run(
      SONG,
      ANALYSIS_VERSION,
      JSON.stringify({ stored: true }),
      new Date().toISOString(),
    );
    const dsp = fakeDsp();
    const { analyzer } = withSong({ seconds: 200, db, dsp });
    analyzer.ensure([SONG]);
    expect(analyzer.pending([SONG])).toBe(1);
    // Waiting for its mix map only: nothing a playlist cover needs.
    expect(analyzer.pending([SONG], { mixMaps: false })).toBe(0);
    await vi.waitFor(() => expect(analyzer.pending([SONG])).toBe(0), { timeout: 10_000 });
    expect(analyzer.mixMaps([SONG]).has(SONG)).toBe(true);
    expect(analyzer.features([SONG]).get(SONG)).toEqual({ stored: true });
    expect(dsp.analyze).not.toHaveBeenCalled();
    // Both measured: nothing left to do.
    analyzer.ensure([SONG]);
    expect(analyzer.pending([SONG])).toBe(0);
  });

  it('doesn’t measure features again that failed recently, while making the mix map', async () => {
    const db = freshDb();
    db.prepare('INSERT INTO track_features (recording_id, version, features, error, analyzed_at) VALUES (?, ?, NULL, ?, ?)').run(
      SONG,
      ANALYSIS_VERSION,
      'boom',
      new Date().toISOString(),
    );
    const { dsp, analyzer } = await measured({ seconds: 200, db });
    expect(dsp.analyze).not.toHaveBeenCalled();
    expect(analyzer.mixMaps([SONG]).has(SONG)).toBe(true);
  });

  it('stores why a mix map failed, and doesn’t try again straight away', async () => {
    const { analyzer, pcm, db } = withSong({ seconds: 600, dsp: fakeDsp() });
    pcm.mockImplementation(async (_path, opts) => {
      if (opts.startSeconds !== undefined) throw new Error('No seeking here');
      return audio('timed', 0, 420);
    });
    analyzer.ensure([SONG]);
    await vi.waitFor(() => expect(mixMapRow(db, SONG)?.error).toBe('tail: No seeking here'), { timeout: 10_000 });
    expect(mixMapRow(db, SONG)?.data).toBeNull();
    expect(analyzer.mixMaps([SONG]).has(SONG)).toBe(false);
    await vi.waitFor(() => expect(analyzer.pending([SONG])).toBe(0));
    analyzer.ensure([SONG]);
    expect(analyzer.pending([SONG])).toBe(0);
  });

  it('measures a song again when the DSP worker was lost, rather than storing a failure', async () => {
    const dsp = fakeDsp();
    dsp.mixMap.mockRejectedValueOnce(new DspWorkerLost('DSP worker stopped (1)'));
    const { analyzer, db } = withSong({ seconds: 200, dsp });
    analyzer.ensure([SONG]);
    await vi.waitFor(() => expect(analyzer.mixMaps([SONG]).has(SONG)).toBe(true), { timeout: 10_000 });
    expect(dsp.mixMap).toHaveBeenCalledTimes(2);
    expect(mixMapRow(db, SONG)?.error).toBeNull();
  });

  it('measures songs needed now before the rest of the library', async () => {
    const { analyzer, asked } = withSong({ seconds: 200, dsp: fakeDsp() });
    analyzer.ensure(['local:a', 'local:b', 'local:c']);
    analyzer.ensure(['local:now'], { urgent: true });
    await vi.waitFor(() => expect(analyzer.pending(['local:a', 'local:b', 'local:c', 'local:now'])).toBe(0), { timeout: 10_000 });
    expect(asked).toEqual(['local:a', 'local:now', 'local:b', 'local:c']);
  });

  it('does its number crunching on the DSP thread it’s given (the one transitions render on)', async () => {
    const dsp = { analyze: vi.fn(async () => ({ given: true }) as never), mixMap: vi.fn(async () => ({ bpm: 99 }) as never) };
    const { analyzer } = withSong({ seconds: 200, dsp });
    analyzer.ensure([SONG]);
    await vi.waitFor(() => expect(analyzer.pending([SONG])).toBe(0), { timeout: 10_000 });
    expect(analyzer.features([SONG]).get(SONG)).toEqual({ given: true });
    expect(analyzer.mixMaps([SONG]).get(SONG)).toEqual({ bpm: 99 });
  });

  it('only hands out mix maps measured by the current version', () => {
    const { analyzer, db } = withSong({ seconds: 200 });
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
    const { analyzer, db } = withSong({ seconds: 200 });
    analyzer.setCues('rec', { mixIn: 12.5, mixOut: 190 });
    expect(analyzer.cues(['rec', 'other'])).toEqual(new Map([['rec', { mixIn: 12.5, mixOut: 190 }]]));
    // A cue left out (or null) is cleared.
    analyzer.setCues('rec', { mixOut: 180, mixIn: null });
    expect(analyzer.cues(['rec']).get('rec')).toEqual({ mixOut: 180 });
    analyzer.setCues('rec', {});
    expect(analyzer.cues(['rec']).size).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cue_points').get()).toEqual({ n: 0 });
  });

  it('refuses cue points that aren’t times in order', () => {
    const { analyzer } = withSong({ seconds: 200 });
    for (const cues of [{ mixIn: Number.NaN }, { mixOut: -1 }, { mixIn: Infinity }, { mixIn: 100, mixOut: 100 }, { mixIn: 120, mixOut: 30 }]) {
      expect(() => analyzer.setCues('rec', cues)).toThrow(RangeError);
    }
    expect(analyzer.cues(['rec']).size).toBe(0);
  });
});
