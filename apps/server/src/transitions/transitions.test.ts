import { Readable } from 'node:stream';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  planTransition,
  RENDER_RATE,
  renderTransition,
  type CuePoints,
  type Excerpt,
  type MixMap,
  type StereoAudio,
  type TransitionPlan,
} from '@playarr/mix';
import type { AudioFormat, Track } from '@playarr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileRecord } from '../catalog/build.ts';
import { tempDir } from '../catalog/testFixtures.ts';
import type { MediaSource, PcmOptions } from '../media/source.ts';
import { ffmpegFlacEncoder, TRANSITION_TAIL_SECONDS, Transitions, type Encoder, type TransitionAnswer } from './transitions.ts';

// planTransition as itself, but watchable: one test makes it depend on A's position the way some plans do.
vi.mock('@playarr/mix', async (importOriginal) => {
  const mix = await importOriginal<typeof import('@playarr/mix')>();
  return { ...mix, planTransition: vi.fn(mix.planTransition) };
});

const SONG_SECONDS = 60;
const FLAC: AudioFormat = { codec: 'FLAC', container: 'flac', lossless: true };
const MP3: AudioFormat = { codec: 'MP3', container: 'mp3', lossless: false };

/**
 * A mix map with an unsure beat, so the planner picks a short crossfade: quick to render, and
 * the service doesn't care which style it renders.
 */
function mixMap(overrides: Partial<MixMap> = {}): MixMap {
  return {
    version: 1,
    duration: SONG_SECONDS,
    bpm: 120,
    firstBeat: 0.5,
    downbeatOffset: 0,
    gridStable: true,
    beatConfidence: 0.2,
    introEnd: 10,
    outroStart: 40,
    coldStart: false,
    coldEnd: false,
    soundEnd: 50,
    phraseEnergy: [],
    ...overrides,
  };
}

function track(id: number, format: AudioFormat = FLAC): Track {
  return {
    id,
    recordingId: `rec-${id}`,
    fileId: 100 + id,
    // Each song on its own album: never "same album, in order".
    albumId: 1000 + id,
    artistId: 1,
    title: `Song ${id}`,
    artistName: 'Artist',
    albumTitle: `Album ${id}`,
    trackNumber: 1,
    discNumber: 1,
    duration: SONG_SECONDS,
    explicit: false,
    format,
    size: 1,
    streamUrl: `/stream/${id}`,
  };
}

/** The tone each song plays: a different pitch per file, so a sample tells which song and when it's from. */
const pitchOf = (path: string) => 200 + 10 * Number(path.replace(/\D/g, ''));
const sampleAt = (path: string, seconds: number) => 0.5 * Math.sin(2 * Math.PI * pitchOf(path) * seconds);

/**
 * Synthetic s16le stereo for `path` from `startSeconds`, stopping at the song's end like ffmpeg would.
 * Like ffmpeg, it starts at `startSeconds` rounded to the millisecond.
 */
function synthPcm(path: string, { sampleRate, maxSeconds, startSeconds: asked = 0 }: PcmOptions): Buffer {
  const startSeconds = Number(asked.toFixed(3));
  const frames = Math.max(0, Math.round(Math.min(maxSeconds, SONG_SECONDS - startSeconds) * sampleRate));
  const samples = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const value = Math.round(sampleAt(path, startSeconds + i / sampleRate) * 32767);
    samples[2 * i] = value;
    samples[2 * i + 1] = -value;
  }
  return Buffer.from(samples.buffer);
}

/** The most frames the fake encoder was ever handed at once. */
let largestPiece = 0;

/** Writes the floats as they are, interleaved, as they arrive: enough to check what would have been encoded. */
const rawEncoder: Encoder = async (audio, file) => {
  await writeFile(file, Buffer.alloc(0));
  for await (const { left, right } of audio) {
    largestPiece = Math.max(largestPiece, left.length);
    const out = new Float32Array(left.length * 2);
    for (let i = 0; i < left.length; i++) {
      out[2 * i] = left[i]!;
      out[2 * i + 1] = right[i]!;
    }
    await appendFile(file, Buffer.from(out.buffer));
  }
};

function readRaw(file: string): Float32Array {
  const bytes = readFileSync(file);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** Every service and cache folder a test made: the services are stopped (their work finished) before the folders go. */
const services: Transitions[] = [];
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

interface SetupOptions {
  tracks?: Track[];
  maps?: Map<string, MixMap>;
  cues?: Map<string, CuePoints>;
  encode?: Encoder;
  render?: (plan: TransitionPlan, a: Excerpt, b: Excerpt) => Promise<StereoAudio>;
  now?: () => number;
  dir?: string;
  maxBytes?: number;
  renderTimeoutMs?: number;
  forgetGraceMs?: number;
  /** The source streams decodes too (as local files and rclone do), in odd-sized reads. */
  stream?: boolean;
}

function setup(options: SetupOptions = {}) {
  const dir = options.dir ?? cacheFolder();
  const tracks = new Map((options.tracks ?? [1, 2, 3, 4, 5, 6].map((id) => track(id))).map((t) => [t.id, t]));
  const files = new Map<number, FileRecord>(
    [...tracks.values()].map((t) => [t.fileId, { id: t.fileId, sourceId: 1, path: `/music/${t.id}.flac`, size: 1, format: t.format }]),
  );
  const maps = options.maps ?? new Map([...tracks.values()].map((t) => [t.recordingId, mixMap()]));
  const cues = options.cues ?? new Map<string, CuePoints>();
  const pcm = vi.fn(async (path: string, opts: PcmOptions) => synthPcm(path, opts));
  // 1001 bytes a read: frames (4 bytes) split across reads.
  const pcmStream = vi.fn((path: string, opts: PcmOptions) => {
    const bytes = synthPcm(path, opts);
    return Readable.from((function* () {
      for (let i = 0; i < bytes.length; i += 1001) yield bytes.subarray(i, i + 1001);
    })());
  });
  const media = { kind: 'local', pcm, ...(options.stream ? { pcmStream } : {}) } as unknown as MediaSource;
  const render = vi.fn(
    options.render ?? (async (plan: TransitionPlan, a: Excerpt, b: Excerpt, tail?: number) => renderTransition(plan, a, b, undefined, tail)),
  );
  const encode = vi.fn(options.encode ?? rawEncoder);
  const log = { info: vi.fn(), warn: vi.fn() };
  const transitions = new Transitions({
    library: { track: async (id: number) => tracks.get(id), file: async (id: number) => files.get(id) },
    files: { resolve: (file: FileRecord) => ({ media, path: file.path }) },
    maps: {
      mixMaps: (ids: string[]) => new Map(ids.flatMap((id) => (maps.has(id) ? [[id, maps.get(id)!] as const] : []))),
      cues: (ids: string[]) => new Map(ids.flatMap((id) => (cues.has(id) ? [[id, cues.get(id)!] as const] : []))),
    },
    dsp: { render },
    cacheDir: dir,
    ffmpegPath: 'ffmpeg',
    log,
    encode,
    now: options.now,
    maxBytes: options.maxBytes,
    renderTimeoutMs: options.renderTimeoutMs,
    forgetGraceMs: options.forgetGraceMs,
  });
  services.push(transitions);
  return { dir, transitions, pcm, pcmStream, render, encode, log, maps, cues, tracks };
}

/** A temporary cache folder, removed after the test. */
function cacheFolder(): string {
  const { dir } = tempDir();
  folders.push(dir);
  return dir;
}

const transitionFiles = (dir: string) => (existsSync(join(dir, 'transitions')) ? readdirSync(join(dir, 'transitions')).sort() : []);
const fileOf = (dir: string, url: string) => join(dir, 'transitions', url.replace('/transitions/', ''));

function expectReady(answer: TransitionAnswer): Extract<TransitionAnswer, { status: 'ready' }> {
  expect(answer.status).toBe('ready');
  return answer as Extract<TransitionAnswer, { status: 'ready' }>;
}

// Renders go through the real renderer: seconds each when the whole suite runs files side by side.
describe('Transitions', { timeout: 30_000 }, () => {
  it('answers pending, renders in the background, then serves the cached file', async () => {
    const t = setup();
    const first = await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' });
    const expectedPlan = planTransition({ a: mixMap(), b: mixMap(), mode: 'auto', sameAlbumInOrder: false });
    expect(first).toEqual({ status: 'pending', plan: expectedPlan });
    expect(expectedPlan.style).toBe('fade');

    await t.transitions.idle();
    const ready = expectReady(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' }));
    expect(ready.plan).toEqual(expectedPlan);
    expect(ready.url).toMatch(/^\/transitions\/[0-9a-f]{40}\.flac$/);
    expect(ready.continuationUrl).toBeUndefined();
    // The transition, then B on its own for a few seconds, as its own file goes on (for phones to change over in).
    expect(ready.tail).toBe(TRANSITION_TAIL_SECONDS);
    const samples = readRaw(fileOf(t.dir, ready.url));
    expect(samples.length).toBe(2 * (Math.round(expectedPlan.length * RENDER_RATE) + TRANSITION_TAIL_SECONDS * RENDER_RATE));

    // A's excerpt is decoded in stereo from just before the transition, clamped to the song's length.
    expect(t.pcm).toHaveBeenCalledTimes(2);
    const [aPath, aOpts] = t.pcm.mock.calls[0]!;
    expect(aPath).toBe('/music/1.flac');
    // From the 10 ms step at or before the excerpt's start: a time ffmpeg seeks to exactly.
    const excerptStart = Math.floor((expectedPlan.aStart - 0.25) * 100) / 100;
    expect(aOpts).toMatchObject({ sampleRate: RENDER_RATE, channels: 2, startSeconds: excerptStart, exactSeek: false });
    expect(aOpts.signal).toBeInstanceOf(AbortSignal);
    expect(aOpts.startSeconds! + aOpts.maxSeconds).toBeLessThanOrEqual(SONG_SECONDS + 1);
    // What the renderer got: A's audio as it is in the song, from the excerpt's start.
    const [, aExcerpt] = t.render.mock.calls[0]!;
    expect(aExcerpt.start).toBe(aOpts.startSeconds);
    expect(aExcerpt.left[100]).toBeCloseTo(sampleAt('/music/1.flac', aExcerpt.start + 100 / RENDER_RATE), 3);
    expect(aExcerpt.right[100]).toBeCloseTo(-sampleAt('/music/1.flac', aExcerpt.start + 100 / RENDER_RATE), 3);

    const key = ready.url.slice('/transitions/'.length, -'.flac'.length);
    expect(transitionFiles(t.dir)).toEqual([`${key}.flac`, `${key}.json`]);
    const sidecar = JSON.parse(readFileSync(join(t.dir, 'transitions', `${key}.json`), 'utf8'));
    expect(sidecar).toMatchObject({ aRecording: 'rec-1', bRecording: 'rec-2', plan: expectedPlan });
    expect(typeof sidecar.createdAt).toBe('number');

    // The same request again: straight from the cache.
    t.pcm.mockClear();
    t.render.mockClear();
    expect(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' })).toEqual(ready);
    await t.transitions.idle();
    expect(t.pcm).not.toHaveBeenCalled();
    expect(t.render).not.toHaveBeenCalled();

    // A restarted server finds it again from the sidecars.
    const restarted = setup({ dir: t.dir });
    await restarted.transitions.load();
    expect(await restarted.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' })).toEqual(ready);
    expect(restarted.render).not.toHaveBeenCalled();
  });

  it('fades for as long as the listener asks, and plans again for another length', async () => {
    const t = setup();
    const six = await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', fadeSeconds: 6 });
    expect(six).toMatchObject({ status: 'pending', plan: { style: 'fade', length: 6 } });
    const three = await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', fadeSeconds: 3 });
    expect(three).toMatchObject({ status: 'pending', plan: { style: 'fade', length: 3 } });
  });

  it('plays songs of one album in order straight on only when the queue plays that album', async () => {
    const onAlbum = (id: number, trackNumber: number) => ({ ...track(id), albumId: 7, trackNumber });
    const t = setup({ tracks: [onAlbum(1, 1), onAlbum(2, 2)] });
    const straight = { status: 'straight', plan: { reason: 'Same album, in order: straight on' } };
    // Older players don't say: as before.
    expect(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' })).toMatchObject(straight);
    expect(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', albumQueue: true })).toMatchObject(straight);
    // In order by chance (a playlist): mixed like any two songs.
    const mixed = await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', albumQueue: false });
    expect(mixed).toMatchObject({ status: 'pending', plan: { style: 'fade' } });
  });

  it('keys the cache by the plan and the files', async () => {
    const t = setup();
    await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' });
    await t.transitions.idle();
    const auto = expectReady(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' }));

    // Party plans the very same crossfade for these songs: the same audio, so the same file.
    const partyPlan = planTransition({ a: mixMap(), b: mixMap(), mode: 'party', sameAlbumInOrder: false });
    expect(partyPlan).toEqual(auto.plan);
    expect(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'party' })).toEqual(auto);

    // A cue point that moves the plan: new audio, a new file.
    t.cues.set('rec-1', { mixOut: 35 });
    const moved = await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' });
    expect(moved).toMatchObject({ status: 'pending', plan: { aStart: 35 } });
    await t.transitions.idle();
    const withCue = expectReady(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' }));
    expect(withCue.url).not.toBe(auto.url);

    // The same plan from a replaced file (another size): rendered again.
    t.tracks.set(2, { ...t.tracks.get(2)!, size: 2 });
    expect((await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' })).status).toBe('pending');
  });

  it('keeps answering with the same plan as A plays on, until that plan can no longer be reached', async () => {
    const mix = await vi.importActual<typeof import('@playarr/mix')>('@playarr/mix');
    // A planner whose start drifts with A's position (as next-downbeat quick mixes do): without
    // remembering, every poll would be a new plan and a new file that's never ready in time.
    vi.mocked(planTransition).mockImplementation((input) => {
      const plan = mix.planTransition(input);
      return { ...plan, aStart: plan.aStart + (input.aPosition ?? 0) / 100 };
    });
    try {
      const t = setup();
      // Song 1 is left at 40 s, or as soon after as A's position allows.
      t.cues.set('rec-1', { mixOut: 40 });
      const first = await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', aPosition: 0 });
      expect(first).toMatchObject({ status: 'pending', plan: { aStart: 40 } });
      expect(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', aPosition: 30 })).toEqual(first);
      await t.transitions.idle();
      expect(t.render).toHaveBeenCalledTimes(1);
      const ready = expectReady(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', aPosition: 35 }));
      expect(ready.plan).toEqual((first as { plan: TransitionPlan }).plan);

      // A restarted server picks the plan up from the cache too.
      const restarted = setup({ dir: t.dir });
      restarted.cues.set('rec-1', { mixOut: 40 });
      await restarted.transitions.load();
      expect(await restarted.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', aPosition: 33 })).toEqual(ready);

      // Past the point where it could still start 5 s ahead: planned again.
      const late = await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', aPosition: 36 });
      expect(late).toMatchObject({ status: 'pending', plan: { aStart: 41.36 } });
    } finally {
      vi.mocked(planTransition).mockImplementation(mix.planTransition);
    }
  });

  it('forget plans afresh at once, and deletes the old files only once players are done with them', async () => {
    const t = setup({ forgetGraceMs: 300 });
    await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' });
    await t.transitions.request({ fromTrackId: 3, toTrackId: 4, mode: 'auto' });
    await t.transitions.idle();
    const old = expectReady(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' }));
    expect(transitionFiles(t.dir)).toHaveLength(4);

    // Song 1's mix map is measured again (its sound ends sooner: the fade starts 8 s before), and the analyzer forgets it.
    t.maps.set('rec-1', mixMap({ soundEnd: 43 }));
    await t.transitions.forget('rec-1');
    const replanned = await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' });
    expect(replanned).toMatchObject({ status: 'pending', plan: { aStart: 35 } });
    // A player streaming the old transition can still finish it.
    const oldName = old.url.replace('/transitions/', '');
    expect(existsSync(t.transitions.filePath(oldName)!)).toBe(true);
    expect((await t.transitions.request({ fromTrackId: 3, toTrackId: 4, mode: 'auto' })).status).toBe('ready');

    await t.transitions.idle();
    await vi.waitFor(() => expect(existsSync(t.transitions.filePath(oldName)!)).toBe(false));
    expect(transitionFiles(t.dir)).toHaveLength(4); // 3→4, and 1→2 made afresh
    expect(transitionFiles(t.dir)).not.toContain(oldName.replace('.flac', '.json'));
  });

  it('turns away a request for a file the song no longer has, so the player falls back', async () => {
    const t = setup();
    expect(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', fromFileId: 101, toFileId: 999 })).toEqual({
      status: 'unavailable',
      reason: expect.stringContaining('file changed'),
    });
    expect((await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', fromFileId: 101, toFileId: 102 })).status).toBe('pending');
    await t.transitions.idle();
  });

  it('forget during a render throws its result away', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const t = setup({
      render: async (plan, a, b) => {
        await gate;
        return renderTransition(plan, a, b);
      },
    });
    await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' });
    await vi.waitFor(() => expect(t.render).toHaveBeenCalledTimes(1));
    await t.transitions.forget('rec-2');
    release();
    await t.transitions.idle();
    expect(transitionFiles(t.dir)).toEqual([]);
    expect((await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' })).status).toBe('pending');
  });

  it('keeps to its size cap, least recently made first, and forgets what it trimmed', async () => {
    const first = setup();
    await first.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' });
    await first.transitions.idle();
    const oneTransition = transitionFiles(first.dir).reduce((sum, name) => sum + readFileSync(join(first.dir, 'transitions', name)).length, 0);

    const t = setup({ dir: first.dir, maxBytes: Math.round(oneTransition * 1.5) });
    await t.transitions.load();
    await t.transitions.request({ fromTrackId: 3, toTrackId: 4, mode: 'auto' });
    await t.transitions.idle();
    const kept = expectReady(await t.transitions.request({ fromTrackId: 3, toTrackId: 4, mode: 'auto' }));
    const key = kept.url.slice('/transitions/'.length, -'.flac'.length);
    expect(transitionFiles(t.dir)).toEqual([`${key}.flac`, `${key}.json`]);
    expect((t.transitions as unknown as { index: Map<string, unknown> }).index.size).toBe(1);
    expect((await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' })).status).toBe('pending');
  });

  it('a render that hangs is given up on, and the queue moves on', async () => {
    const t = setup({
      renderTimeoutMs: 50,
      render: async (plan, a, b) => (pitchOfExcerpt(a) === 1 ? new Promise<never>(() => {}) : renderTransition(plan, a, b)),
    });
    await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' });
    await t.transitions.request({ fromTrackId: 3, toTrackId: 4, mode: 'auto' });
    await t.transitions.idle();
    expect(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' })).toEqual({
      status: 'unavailable',
      reason: expect.stringContaining('took too long'),
    });
    expect((await t.transitions.request({ fromTrackId: 3, toTrackId: 4, mode: 'auto' })).status).toBe('ready');
  });

  it('a newer request from the same song replaces its queued render; at most 3 wait, newest first', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const rendered: string[] = [];
    const t = setup({
      tracks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((id) => track(id)),
      render: async (plan, a, b) => {
        rendered.push(`${pitchOfExcerpt(a)}→${pitchOfExcerpt(b)}`);
        if (rendered.length === 1) await gate;
        return renderTransition(plan, a, b);
      },
    });
    await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' });
    await vi.waitFor(() => expect(rendered).toHaveLength(1));

    await t.transitions.request({ fromTrackId: 3, toTrackId: 4, mode: 'auto' });
    await t.transitions.request({ fromTrackId: 3, toTrackId: 5, mode: 'auto' }); // 3→4 was skipped
    await t.transitions.request({ fromTrackId: 6, toTrackId: 7, mode: 'auto' });
    await t.transitions.request({ fromTrackId: 7, toTrackId: 8, mode: 'auto' });
    await t.transitions.request({ fromTrackId: 8, toTrackId: 9, mode: 'auto' }); // pushes out 3→5, the oldest
    release();
    await t.transitions.idle();

    expect(rendered).toEqual(['1→2', '8→9', '7→8', '6→7']);
    expect((await t.transitions.request({ fromTrackId: 3, toTrackId: 4, mode: 'auto' })).status).toBe('pending');
  });

  it('is unavailable for unknown songs or songs without a mix map, saying which', async () => {
    const t = setup({ maps: new Map([['rec-1', mixMap()]]) });
    expect(await t.transitions.request({ fromTrackId: 1, toTrackId: 99, mode: 'auto' })).toEqual({
      status: 'unavailable',
      reason: expect.stringMatching(/unknown/i),
    });
    const missingB = await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' });
    expect(missingB).toEqual({ status: 'unavailable', reason: expect.stringContaining('Song 2') });
    const missingA = await t.transitions.request({ fromTrackId: 2, toTrackId: 1, mode: 'auto' });
    expect(missingA).toEqual({ status: 'unavailable', reason: expect.stringContaining('Song 2') });
    expect(t.render).not.toHaveBeenCalled();
  });

  it('straight on needs no file', async () => {
    const t = setup();
    const answer = await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'off' });
    expect(answer).toMatchObject({ status: 'straight', plan: { style: 'straight' } });
    await t.transitions.idle();
    expect(t.render).not.toHaveBeenCalled();
    expect(t.pcm).not.toHaveBeenCalled();
  });

  it('plans same-album songs in order as straight on', async () => {
    const a = { ...track(1), albumId: 7, trackNumber: 3 };
    const b = { ...track(2), albumId: 7, trackNumber: 4 };
    const t = setup({ tracks: [a, b] });
    expect((await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' })).status).toBe('straight');
  });

  it('also stores the rest of an MP3 B from where playback resumes, decoded exactly, joining the transition', async () => {
    // A leaves at a time off the 10 ms grid, so B resumes at one too (on a whole sample, for a clean check):
    // a decode started where ffmpeg rounds to the millisecond would be a sample or two off.
    const bResumeFrames = 293_837; // 6.66297… s
    // A fade that long, from B's start.
    const fadeSeconds = bResumeFrames / RENDER_RATE;
    const t = setup({ tracks: [track(1), track(2, MP3)] });
    largestPiece = 0;
    await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', fadeSeconds });
    await t.transitions.idle();
    const ready = expectReady(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', fadeSeconds }));
    expect(ready.continuationUrl).toBe(ready.url.replace(/\.flac$/, '.rest.flac'));

    // B's excerpt and its remainder are each decoded with an exact seek; A (FLAC) needs none.
    expect(t.pcm.mock.calls.map(([path, opts]) => [path, opts.exactSeek])).toEqual([
      ['/music/1.flac', false],
      ['/music/2.flac', true],
      ['/music/2.flac', true],
      ['/music/2.flac', true],
    ]);
    // The remainder comes in 30 s decodes, one after the other on the 10 ms grid, and reaches the
    // encoder no bigger than that: a long song is never held whole.
    const remainderCalls = t.pcm.mock.calls.slice(2).map(([, opts]) => opts);
    expect(remainderCalls.map((opts) => opts.startSeconds)).toEqual([6.66, 36.66]);
    expect(remainderCalls.every((opts) => opts.maxSeconds <= 30)).toBe(true);
    expect(largestPiece).toBeLessThanOrEqual(30 * RENDER_RATE);

    const rest = readRaw(fileOf(t.dir, ready.continuationUrl!));
    const bResume = ready.plan.bResume;
    expect(bResume * RENDER_RATE).toBeCloseTo(bResumeFrames, 6);
    expect(Math.abs(rest.length / 2 - (SONG_SECONDS - bResume) * RENDER_RATE)).toBeLessThanOrEqual(1);
    for (const i of [0, 1000, 44100]) {
      expect(rest[2 * i]).toBeCloseTo(sampleAt('/music/2.flac', bResume + i / RENDER_RATE), 3);
    }

    // The join: the transition ends on B's tone alone, and the rest's first sample is the very next
    // one of it (a pure tone's next sample follows from its last two). One sample off would miss by ~0.03.
    const transition = readRaw(fileOf(t.dir, ready.url));
    const frames = transition.length / 2;
    const [beforeLast, last] = [transition[2 * (frames - 2)]!, transition[2 * (frames - 1)]!];
    const step = (2 * Math.PI * pitchOf('/music/2.flac')) / RENDER_RATE;
    expect(Math.abs(rest[0]! - (2 * Math.cos(step) * last - beforeLast))).toBeLessThan(2e-3);

    t.pcm.mockClear();
    expect(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', fadeSeconds })).toEqual(ready);
    expect(t.pcm).not.toHaveBeenCalled();
  });

  it('streams the rest of an MP3 B in one decode where the source can, joining the transition just the same', async () => {
    const bResumeFrames = 293_837;
    const fadeSeconds = bResumeFrames / RENDER_RATE;
    const t = setup({ tracks: [track(1), track(2, MP3)], stream: true });
    await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', fadeSeconds });
    await t.transitions.idle();
    const ready = expectReady(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', fadeSeconds }));

    // The excerpts as before; the remainder from one exact decode on the 10 ms grid, to the song's end.
    expect(t.pcm.mock.calls.map(([path]) => path)).toEqual(['/music/1.flac', '/music/2.flac']);
    expect(t.pcmStream.mock.calls.map(([path, opts]) => [path, opts.startSeconds, opts.exactSeek])).toEqual([['/music/2.flac', 6.66, true]]);
    expect(t.pcmStream.mock.calls[0]![1].maxSeconds).toBeGreaterThan(SONG_SECONDS - 6.66);

    const rest = readRaw(fileOf(t.dir, ready.continuationUrl!));
    const bResume = ready.plan.bResume;
    expect(Math.abs(rest.length / 2 - (SONG_SECONDS - bResume) * RENDER_RATE)).toBeLessThanOrEqual(1);
    for (const i of [0, 1000, 44100]) {
      expect(rest[2 * i]).toBeCloseTo(sampleAt('/music/2.flac', bResume + i / RENDER_RATE), 3);
    }
    const transition = readRaw(fileOf(t.dir, ready.url));
    const frames = transition.length / 2;
    const [beforeLast, last] = [transition[2 * (frames - 2)]!, transition[2 * (frames - 1)]!];
    const step = (2 * Math.PI * pitchOf('/music/2.flac')) / RENDER_RATE;
    expect(Math.abs(rest[0]! - (2 * Math.cos(step) * last - beforeLast))).toBeLessThan(2e-3);
  });

  it('mixes at the levels the player plays the songs at, B’s remainder too, and keeps each level’s file apart', async () => {
    const t = setup({ tracks: [track(1), track(2, MP3)] });
    const levels = { a: -6, b: 3 };
    await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', levels });
    await t.transitions.idle();
    const ready = expectReady(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', levels }));
    expect(ready.levels).toEqual(levels);
    // What the renderer got: each song turned by its gain.
    const [, aExcerpt, bExcerpt] = t.render.mock.calls[0]!;
    expect(aExcerpt.left[100]).toBeCloseTo(sampleAt('/music/1.flac', aExcerpt.start + 100 / RENDER_RATE) * 10 ** (-6 / 20), 3);
    expect(bExcerpt.left[100]).toBeCloseTo(sampleAt('/music/2.flac', bExcerpt.start + 100 / RENDER_RATE) * 10 ** (3 / 20), 3);
    const rest = readRaw(fileOf(t.dir, ready.continuationUrl!));
    expect(rest[2000]).toBeCloseTo(sampleAt('/music/2.flac', ready.plan.bResume + 1000 / RENDER_RATE) * 10 ** (3 / 20), 3);

    // Other levels (or none) are another file; songs at 0 dB are the same as none.
    const none = await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' });
    expect(none.status).toBe('pending');
    await t.transitions.idle();
    const plain = expectReady(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', levels: { a: 0, b: 0 } }));
    expect(plain.url).not.toBe(ready.url);
    expect(plain.levels).toBeUndefined();
  });

  it('after a failed render answers unavailable for 10 minutes, then tries again', async () => {
    let clock = 1_000_000;
    const t = setup({
      now: () => clock,
      render: async () => {
        throw new Error('out of memory');
      },
    });
    expect((await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' })).status).toBe('pending');
    await t.transitions.idle();
    expect(t.log.warn).toHaveBeenCalled();
    expect(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' })).toEqual({
      status: 'unavailable',
      reason: expect.stringContaining('out of memory'),
    });
    expect(transitionFiles(t.dir).filter((name) => !name.endsWith('.tmp'))).toEqual([]);
    clock += 10 * 60_000 + 1;
    expect((await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' })).status).toBe('pending');
  });

  it('writes WAV files when there is no ffmpeg here, and stops trying it', async () => {
    const t = setup({
      tracks: [track(1), track(2, MP3), track(3)],
      encode: async () => {
        throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
      },
    });
    await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' });
    await t.transitions.idle();
    const ready = expectReady(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' }));
    expect(ready.url).toMatch(/\.wav$/);
    expect(ready.continuationUrl).toMatch(/\.rest\.wav$/);

    const wav = readFileSync(fileOf(t.dir, ready.url));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(2); // stereo
    expect(wav.readUInt32LE(24)).toBe(RENDER_RATE);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe((Math.round(ready.plan.length * RENDER_RATE) + TRANSITION_TAIL_SECONDS * RENDER_RATE) * 4);
    expect(t.encode).toHaveBeenCalledTimes(1);

    await t.transitions.request({ fromTrackId: 2, toTrackId: 3, mode: 'auto' });
    await t.transitions.idle();
    expect(expectReady(await t.transitions.request({ fromTrackId: 2, toTrackId: 3, mode: 'auto' })).url).toMatch(/\.wav$/);
    expect(t.encode).toHaveBeenCalledTimes(1);
  });

  it('the ffmpeg encoder reports a missing ffmpeg as ENOENT, which is what switches to WAV', async () => {
    const encode = ffmpegFlacEncoder('playarr-test-no-such-ffmpeg');
    const audio = { left: new Float32Array(10), right: new Float32Array(10) };
    const pieces = (async function* () {
      yield audio;
    })();
    await expect(encode(pieces, join(cacheFolder(), 'out.flac.tmp'), AbortSignal.timeout(10_000))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serves only its own file names', () => {
    const t = setup();
    const key = 'a'.repeat(40);
    expect(t.transitions.filePath(`${key}.flac`)).toBe(join(t.dir, 'transitions', `${key}.flac`));
    expect(t.transitions.filePath(`${key}.rest.wav`)).toBe(join(t.dir, 'transitions', `${key}.rest.wav`));
    expect(t.transitions.filePath(`${key}.json`)).toBeUndefined();
    expect(t.transitions.filePath('../secret.flac')).toBeUndefined();
  });
});

/** Which song an excerpt is from, by the tone's pitch (see pitchOf): its zero crossings per second. */
function pitchOfExcerpt(excerpt: Excerpt): number {
  let crossings = 0;
  const n = RENDER_RATE; // one second
  for (let i = 1; i < n; i++) if (excerpt.left[i - 1]! < 0 !== excerpt.left[i]! < 0) crossings++;
  return Math.round((crossings / 2 - 200) / 10);
}
