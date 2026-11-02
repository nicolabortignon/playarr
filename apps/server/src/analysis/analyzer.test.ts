import type { DatabaseSync } from 'node:sqlite';
import { MIX_MAP_VERSION } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogStore } from '../catalog/store.ts';
import { FLAC, freshDb, mezzanine } from '../catalog/testFixtures.ts';
import type { FileResolver } from '../catalog/files.ts';
import type { Library } from '../library/library.ts';
import type { PcmOptions } from '../media/source.ts';
import { Analyzer } from './analyzer.ts';
import { ANALYSIS_VERSION, SAMPLE_RATE } from './dsp.ts';

/** Songs are decoded at the beat model's rate, twice the analysis rate. */
const DECODE_RATE = 2 * SAMPLE_RATE;
import { DspWorkerLost, type SongBeats } from './dspThread.ts';

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
function audio(kind: Kind, from: number, to: number, rate = SAMPLE_RATE): Buffer {
  const first = Math.round(from * rate);
  const samples = new Int16Array(Math.max(0, Math.round(to * rate) - first));
  if (kind === 'silent') return Buffer.from(samples.buffer);
  for (let k = 0; k < samples.length; k++) {
    const i = first + k;
    if (kind === 'timed') samples[k] = Math.floor((i * 10) / rate) % 32768;
    else {
      const beat = i % (rate / 2) < Math.round(0.018 * rate) ? 0.8 : 0;
      const v = beat + 0.2 * Math.sin((2 * Math.PI * 80 * i) / rate);
      samples[k] = Math.round(Math.max(-1, Math.min(1, v)) * 32000);
    }
  }
  return Buffer.from(samples.buffer);
}

/** The song time (seconds) a `timed` sample was taken at. */
const timeAt = (pcm: Buffer, sample: number) => pcm.readInt16LE(sample * 2) / 10;

type Dsp = NonNullable<ConstructorParameters<typeof Analyzer>[3]['dsp']>;
type Beats = NonNullable<ConstructorParameters<typeof Analyzer>[3]['beats']>;

/** A DSP thread that measures nothing, and keeps what it was handed. */
function fakeDsp() {
  return {
    analyze: vi.fn(async (_pcm: Buffer, _rate?: number) => ({ fake: true }) as never),
    mixMap: vi.fn(async (_head: Buffer, _tail: Buffer | null, duration: number, _rate?: number, _beats?: SongBeats) => ({ duration }) as never),
  } satisfies Dsp;
}

/**
 * An analyzer over songs whose files hold `seconds` of audio while the library says they last
 * `listed` (MusicBrainz's rounded length, maybe another release's). Decodes honour startSeconds and
 * maxSeconds, and stop at the file's end.
 */
function withSong(
  opts: { seconds: number; listed?: number; kind?: Kind; format?: Track['format']; db?: DatabaseSync; dsp?: Dsp; songs?: string[]; beats?: Beats },
) {
  const { seconds, listed = seconds, kind = 'timed', format = FLAC, db = freshDb(), dsp, songs = [], beats } = opts;
  const pcm = vi.fn(async (_path: string, decode: PcmOptions) => {
    if (decode.fromEnd) throw new Error('The end of a file is found by decoding at known positions');
    const from = decode.startSeconds ?? 0;
    return audio(kind, Math.min(from, seconds), Math.min(seconds, from + decode.maxSeconds), decode.sampleRate);
  });
  const asked: string[] = [];
  const library = {
    trackByRecording: async (id: string) => {
      asked.push(id);
      return { fileId: 1, duration: listed, format } as Track;
    },
    file: async () => ({ id: 1, sourceId: 1, path: '/music/song.flac' }),
    allTracks: async () => songs.map((recordingId) => ({ recordingId }) as Track),
  } as unknown as Library;
  const files = { resolve: () => ({ media: { pcm }, path: '/music/song.flac' }) } as unknown as FileResolver;
  const analyzer = new Analyzer(db, library, files, { enabled: true, log: { warn: () => {} }, dsp, ...(beats ? { beats } : {}) });
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

const HEAD = { sampleRate: DECODE_RATE, maxSeconds: 420 };

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

  it('decodes at the beat model’s rate and hands its answer for the head and the tail to the mix map', async () => {
    const odds = (pcm: Buffer) => {
      const frames = Math.round((pcm.length / 2 / DECODE_RATE) * 50);
      return { fps: 50, beat: new Float32Array(frames), downbeat: new Float32Array(frames) };
    };
    const beats = { activations: vi.fn(async (pcm: Buffer) => odds(pcm)) };
    const { dsp, head, tail } = await measured({ seconds: 600, beats });
    const [, , , rate, answer] = dsp.mixMap.mock.calls[0]!;
    expect(rate).toBe(DECODE_RATE);
    expect(beats.activations).toHaveBeenCalledTimes(2);
    expect(beats.activations.mock.calls[0]![0] === head && beats.activations.mock.calls[1]![0] === tail).toBe(true);
    expect(answer?.head.beat.length).toBe(420 * 50);
    expect(answer?.tail?.beat.length).toBe(180 * 50);
    expect(dsp.analyze.mock.calls[0]![0] === head && dsp.analyze.mock.calls[0]![1] === DECODE_RATE).toBe(true);
  });

  it('leaves the beats to the onset analysis when the beat model can’t run', async () => {
    const beats = { activations: vi.fn(async () => null) };
    const { dsp } = await measured({ seconds: 600, beats });
    expect(dsp.mixMap.mock.calls[0]![4]).toBeUndefined();
    expect(beats.activations).toHaveBeenCalledTimes(1); // not asked again for the tail
  });

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
    expect(decodes()).toEqual([HEAD, { sampleRate: DECODE_RATE, startSeconds: 420, maxSeconds: 240 }]);
    expect(duration).toBeCloseTo(600.4, 3);
    expect(tail!.length / 2 / DECODE_RATE).toBeCloseTo(180, 3);
    expect(timeAt(tail!, 0)).toBeCloseTo(420.4, 1);
    expect(timeAt(tail!, tail!.length / 2 - 1)).toBeCloseTo(600.3, 1);
  });

  it('starts the end’s decode where the library’s length says it is', async () => {
    const { tail, duration, decodes } = await measured({ seconds: 1000.2, listed: 1000 });
    expect(decodes()[1]).toEqual({ sampleRate: DECODE_RATE, startSeconds: 790, maxSeconds: 240 });
    expect(duration).toBeCloseTo(1000.2, 3);
    expect(timeAt(tail!, 0)).toBeCloseTo(820.2, 1);
  });

  it('finds the end of a song that runs past the 7 minutes the library says it lasts', async () => {
    const { tail, duration } = await measured({ seconds: 425, listed: 419 });
    expect(duration).toBeCloseTo(425, 3);
    // The last 3 minutes, partly from the start's decode: none of the last 6 s are lost.
    expect(tail!.length / 2 / DECODE_RATE).toBeCloseTo(180, 3);
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
      expect(tail!.length / 2 / DECODE_RATE).toBeCloseTo(180, 3);
      expect(timeAt(tail!, 0)).toBeCloseTo(420, 1);
    }
  });

  it('decodes an MP3’s end exactly (its seeking is an estimate)', async () => {
    const mp3 = { codec: 'MP3', container: 'mp3', bits: 16, sampleRate: 44100, lossless: false };
    const { decodes } = await measured({ seconds: 600, format: mp3 });
    expect(decodes()[1]).toEqual({ sampleRate: DECODE_RATE, startSeconds: 420, maxSeconds: 240, exactSeek: true });
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
      return audio('timed', 0, 420, opts.sampleRate);
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

  it('hands out current mix maps, and older ones of today’s shape until their song is redone', () => {
    const { analyzer, db } = withSong({ seconds: 200 });
    const save = db.prepare('INSERT INTO mix_maps (recording_id, version, data, error, analyzed_at) VALUES (?, ?, ?, ?, ?)');
    const now = new Date().toISOString();
    save.run('current', MIX_MAP_VERSION, JSON.stringify({ bpm: 128 }), null, now);
    save.run('previous', 2, JSON.stringify({ bpm: 100 }), null, now);
    save.run('ancient', 1, JSON.stringify({ bpm: 90 }), null, now);
    save.run('failed', MIX_MAP_VERSION, null, 'boom', now);
    const maps = analyzer.mixMaps(['current', 'previous', 'ancient', 'failed', 'unknown']);
    expect(Object.fromEntries(maps)).toEqual({ current: { bpm: 128 }, previous: { bpm: 100 } });
  });

  it('hands out only what blending needs from mix maps in use, without the rest of the map', () => {
    const { analyzer, db } = withSong({ seconds: 200 });
    const save = db.prepare('INSERT INTO mix_maps (recording_id, version, data, error, analyzed_at) VALUES (?, ?, ?, ?, ?)');
    const now = new Date().toISOString();
    const map = { bpm: 128, beatConfidence: 0.9, gridStable: true, key: { camelot: '8A', confidence: 0.7 }, phraseEnergy: [0.2, 0.9], introEnd: 30 };
    save.run('current', MIX_MAP_VERSION, JSON.stringify(map), null, now);
    save.run('keyless', MIX_MAP_VERSION, JSON.stringify({ bpm: 0, beatConfidence: 0.1, gridStable: false }), null, now);
    save.run('ancient', 1, JSON.stringify(map), null, now);
    save.run('failed', MIX_MAP_VERSION, null, 'boom', now);
    const summaries = analyzer.mixSummaries(['current', 'keyless', 'ancient', 'failed', 'unknown']);
    expect(Object.fromEntries(summaries)).toEqual({
      current: { bpm: 128, beatConfidence: 0.9, gridStable: true, key: { camelot: '8A', confidence: 0.7 } },
      keyless: { bpm: 0, beatConfidence: 0.1, gridStable: false },
    });
  });

  it('counts only features and mix maps measured by the current version, so a new version is noticed', () => {
    const { analyzer, db } = withSong({ seconds: 200 });
    const now = new Date().toISOString();
    const feature = db.prepare('INSERT INTO track_features (recording_id, version, features, error, analyzed_at) VALUES (?, ?, ?, ?, ?)');
    feature.run('current', ANALYSIS_VERSION, '{}', null, now);
    feature.run('old', ANALYSIS_VERSION - 1, '{}', null, now);
    feature.run('failed', ANALYSIS_VERSION, null, 'boom', now);
    const map = db.prepare('INSERT INTO mix_maps (recording_id, version, data, error, analyzed_at) VALUES (?, ?, ?, ?, ?)');
    map.run('current', MIX_MAP_VERSION, '{}', null, now);
    map.run('old', MIX_MAP_VERSION - 1, '{}', null, now);
    map.run('failed', MIX_MAP_VERSION, null, 'boom', now);
    expect(analyzer.progress()).toMatchObject({ features: 1, mixMaps: 1 });
  });
});

describe('Analyzer library analysis', () => {
  /** An analyzer over a library of `ids` whose decodes never finish, so queued songs stay queued. */
  function withLibrary(songs: string[]) {
    const { analyzer, pcm, db } = withSong({ seconds: 200, songs });
    pcm.mockImplementation(() => new Promise(() => {}));
    return { analyzer, db };
  }

  it('queues the library’s songs still needing a mix map, in the backlog, and says how many', async () => {
    const { analyzer, db } = withLibrary(['local:ready', 'local:new', 'local:old', 'local:failed', 'local:retry', 'track:9']);
    const now = new Date().toISOString();
    const longAgo = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    const feature = db.prepare('INSERT INTO track_features (recording_id, version, features, error, analyzed_at) VALUES (?, ?, ?, NULL, ?)');
    const map = db.prepare('INSERT INTO mix_maps (recording_id, version, data, error, analyzed_at) VALUES (?, ?, ?, ?, ?)');
    for (const id of ['local:ready', 'local:old', 'local:failed', 'local:retry']) feature.run(id, ANALYSIS_VERSION, '{}', now);
    map.run('local:ready', MIX_MAP_VERSION, '{}', null, now);
    map.run('local:old', MIX_MAP_VERSION - 1, '{}', null, now);
    map.run('local:failed', MIX_MAP_VERSION, null, 'boom', now); // failed lately: not yet
    map.run('local:retry', MIX_MAP_VERSION, null, 'boom', longAgo); // due for another try
    expect(await analyzer.analyzeLibrary()).toBe(3); // new, old and retry; never track: ids
    expect(analyzer.analysisProgress()).toMatchObject({ waiting: 2, working: 1 });
    // Pressed again: the same songs are already waiting or being measured.
    expect(await analyzer.analyzeLibrary()).toBe(0);
    expect(analyzer.analysisProgress()).toMatchObject({ waiting: 2, working: 1 });
  });

  it('analyses every song again when asked, keeping their maps in use until each is redone', async () => {
    const { analyzer, db } = withLibrary(['local:a', 'local:b']);
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const feature = db.prepare('INSERT INTO track_features (recording_id, version, features, error, analyzed_at) VALUES (?, ?, ?, NULL, ?)');
    const map = db.prepare('INSERT INTO mix_maps (recording_id, version, data, error, analyzed_at) VALUES (?, ?, ?, NULL, ?)');
    for (const id of ['local:a', 'local:b']) {
      feature.run(id, ANALYSIS_VERSION, '{}', earlier);
      map.run(id, MIX_MAP_VERSION, '{"bpm":120}', earlier);
    }
    expect(await analyzer.analyzeLibrary()).toBe(0); // all done
    expect(await analyzer.reanalyzeLibrary()).toBe(2);
    expect(analyzer.analysisProgress()).toMatchObject({ waiting: 1, working: 1 });
    expect([...analyzer.mixMaps(['local:a', 'local:b']).keys()]).toEqual(['local:a', 'local:b']);
  });

  it('measures only the sound for sound analysis, leaving mix maps to beat analysis', async () => {
    const dsp = fakeDsp();
    const { analyzer, db } = withSong({ seconds: 200, dsp, songs: [SONG] });
    expect(await analyzer.analyzeLibrary('sound')).toBe(1);
    await vi.waitFor(() => expect(analyzer.analysisProgress()).toMatchObject({ waiting: 0, working: 0 }), { timeout: 10_000 });
    expect(dsp.analyze).toHaveBeenCalledTimes(1);
    expect(dsp.mixMap).not.toHaveBeenCalled();
    expect(mixMapRow(db, SONG)).toBeUndefined();
    expect(await analyzer.analyzeLibrary('sound')).toBe(0); // its sound is measured
    expect(await analyzer.analyzeLibrary('beats')).toBe(1); // its beats aren't
  });

  it('makes the mix map of a song being measured for its sound alone once it’s wanted for a play', async () => {
    const dsp = fakeDsp();
    const { analyzer, pcm } = withSong({ seconds: 200, dsp, songs: [SONG] });
    const decode = pcm.getMockImplementation()!;
    let finish!: () => void;
    pcm.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => (finish = resolve));
      return decode(...args);
    });
    await analyzer.analyzeLibrary('sound');
    await vi.waitFor(() => expect(pcm).toHaveBeenCalled());
    expect(analyzer.ensure([SONG], { urgent: true })).toBe(1);
    finish();
    await vi.waitFor(() => expect(analyzer.mixMaps([SONG]).has(SONG)).toBe(true), { timeout: 10_000 });
    expect(dsp.analyze).toHaveBeenCalledTimes(1); // its sound, measured once
  });

  it('leaves songs someone is waiting for ahead of the backlog', async () => {
    const { analyzer } = withLibrary(['local:a', 'local:b', 'local:c']);
    analyzer.ensure(['local:a'], { urgent: true }); // starts at once
    analyzer.ensure(['local:b'], { urgent: true }); // waits, ahead of the backlog
    expect(await analyzer.analyzeLibrary()).toBe(1);
    expect(analyzer.pending(['local:b', 'local:c'])).toBe(2);
  });
});

describe('Analyzer analysis progress', () => {
  it('counts the library’s songs, those mapped for mixing and those that failed, from the current version', () => {
    const db = freshDb();
    const store = new CatalogStore(db);
    store.applySync(store.ensureSource('lidarr', 'Lidarr'), mezzanine()); // rec-1 and rec-2
    // A song only a turned-off source has isn't in the library.
    const off = store.addSource('folder', 'Old disk');
    const elsewhere = mezzanine();
    elsewhere.tracks = [{ ...elsewhere.tracks[0]!, key: 'mb:rg-1#rec-3', recordingId: 'rec-3' }];
    elsewhere.copies = [{ ...elsewhere.copies[0]!, ref: 'x', trackKey: 'mb:rg-1#rec-3' }];
    store.applySync(off, elsewhere);
    db.prepare('UPDATE sources SET enabled = 0 WHERE id = ?').run(off);

    const { analyzer } = withSong({ seconds: 200, db });
    const now = new Date().toISOString();
    const longAgo = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    const map = db.prepare('INSERT INTO mix_maps (recording_id, version, data, error, analyzed_at) VALUES (?, ?, ?, ?, ?)');
    map.run('rec-1', MIX_MAP_VERSION, '{}', null, now);
    map.run('rec-2', MIX_MAP_VERSION, null, 'boom', now);
    map.run('rec-3', MIX_MAP_VERSION, '{}', null, now);
    map.run('gone', MIX_MAP_VERSION, '{}', null, now);
    expect(analyzer.analysisProgress()).toEqual({
      songs: 2,
      beats: { ready: 1, beatModel: 0, failed: 1 },
      sound: { ready: 0, failed: 0 },
      tags: { ready: 0, songs: 0 }, // no MusicBrainz ids: nothing to look up
      waiting: 0,
      working: 0,
      tagsWaiting: 0,
    });

    // A failure due for another try is neither ready nor failed; an old version's map doesn't count.
    db.prepare('UPDATE mix_maps SET analyzed_at = ? WHERE recording_id = ?').run(longAgo, 'rec-2');
    db.prepare('UPDATE mix_maps SET version = ? WHERE recording_id = ?').run(MIX_MAP_VERSION - 1, 'rec-1');
    expect(analyzer.analysisProgress()).toMatchObject({ songs: 2, beats: { ready: 0, failed: 0 } });
  });

  it('counts the maps whose beats the beat model found, and none from before Analyse all again', async () => {
    const db = freshDb();
    const store = new CatalogStore(db);
    store.applySync(store.ensureSource('lidarr', 'Lidarr'), mezzanine()); // rec-1 and rec-2
    const { analyzer, pcm } = withSong({ seconds: 200, db });
    pcm.mockImplementation(() => new Promise(() => {})); // never finishes
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const map = db.prepare('INSERT INTO mix_maps (recording_id, version, data, error, analyzed_at) VALUES (?, ?, ?, NULL, ?)');
    map.run('rec-1', MIX_MAP_VERSION, '{"beatsFrom":"model"}', earlier);
    map.run('rec-2', MIX_MAP_VERSION, '{"beatsFrom":"onsets"}', earlier);
    expect(analyzer.analysisProgress()).toMatchObject({ songs: 2, beats: { ready: 2, beatModel: 1 } });
    await analyzer.reanalyzeLibrary('beats');
    expect(analyzer.analysisProgress()).toMatchObject({ songs: 2, beats: { ready: 0, beatModel: 0 } });
  });

  it('counts the songs waiting in either queue and the one being measured', () => {
    const { analyzer, pcm } = withSong({ seconds: 200 });
    pcm.mockImplementation(() => new Promise(() => {})); // never finishes
    analyzer.ensure(['local:a', 'local:b']);
    analyzer.ensure(['local:c'], { urgent: true });
    expect(analyzer.analysisProgress()).toMatchObject({ waiting: 2, working: 1 });
  });
  it('counts sound analysis and tag lookups, each from its own Analyse all again', async () => {
    const db = freshDb();
    const store = new CatalogStore(db);
    const sync = mezzanine();
    sync.tracks = sync.tracks.map((t, i) => ({ ...t, recordingId: [MBID, 'local:abc'][i]! }));
    store.applySync(store.ensureSource('lidarr', 'Lidarr'), sync);
    const { analyzer, pcm } = withSong({ seconds: 200, db, songs: [MBID, 'local:abc'] });
    pcm.mockImplementation(() => new Promise(() => {})); // never finishes
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {})); // nor does ListenBrainz
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const feature = db.prepare('INSERT INTO track_features (recording_id, version, features, error, analyzed_at) VALUES (?, ?, ?, ?, ?)');
    feature.run(MBID, ANALYSIS_VERSION, '{}', null, earlier);
    feature.run('local:abc', ANALYSIS_VERSION, null, 'boom', earlier);
    db.prepare('INSERT INTO mix_maps (recording_id, version, data, error, analyzed_at) VALUES (?, ?, ?, NULL, ?)').run(MBID, MIX_MAP_VERSION, '{}', earlier);
    db.prepare('INSERT INTO track_meta (recording_id, tags, year, fetched_at) VALUES (?, ?, NULL, ?)').run(MBID, '[]', earlier);
    expect(analyzer.analysisProgress()).toMatchObject({
      songs: 2,
      beats: { ready: 1 },
      sound: { ready: 1, failed: 1 },
      tags: { ready: 1, songs: 1 }, // only the song with a MusicBrainz id can be looked up
    });

    expect(await analyzer.reanalyzeLibrary('sound')).toBe(2);
    expect(analyzer.analysisProgress()).toMatchObject({ beats: { ready: 1 }, sound: { ready: 0, failed: 0 }, tags: { ready: 1 } });
    expect(await analyzer.reanalyzeLibrary('tags')).toBe(1);
    expect(analyzer.analysisProgress()).toMatchObject({ beats: { ready: 1 }, tags: { ready: 0, songs: 1 }, tagsWaiting: 1 });
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
