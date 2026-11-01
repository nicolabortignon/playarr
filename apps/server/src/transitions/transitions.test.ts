import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
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
import { ffmpegFlacEncoder, Transitions, type Encoder, type TransitionAnswer } from './transitions.ts';

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

/** Synthetic s16le stereo for `path` from `startSeconds`, stopping at the song's end like ffmpeg would. */
function synthPcm(path: string, { sampleRate, maxSeconds, startSeconds = 0 }: PcmOptions): Buffer {
  const frames = Math.max(0, Math.round(Math.min(maxSeconds, SONG_SECONDS - startSeconds) * sampleRate));
  const samples = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const value = Math.round(sampleAt(path, startSeconds + i / sampleRate) * 32767);
    samples[2 * i] = value;
    samples[2 * i + 1] = -value;
  }
  return Buffer.from(samples.buffer);
}

/** Writes the floats as they are, interleaved: enough to check what would have been encoded. */
const rawEncoder: Encoder = async ({ left, right }: StereoAudio, file: string) => {
  const out = new Float32Array(left.length * 2);
  for (let i = 0; i < left.length; i++) {
    out[2 * i] = left[i]!;
    out[2 * i + 1] = right[i]!;
  }
  await writeFile(file, Buffer.from(out.buffer));
};

function readRaw(file: string): Float32Array {
  const bytes = readFileSync(file);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

let cleanup = () => {};
afterEach(() => cleanup());

interface SetupOptions {
  tracks?: Track[];
  maps?: Map<string, MixMap>;
  cues?: Map<string, CuePoints>;
  encode?: Encoder;
  render?: (plan: TransitionPlan, a: Excerpt, b: Excerpt) => Promise<StereoAudio>;
  now?: () => number;
  dir?: string;
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
  const media = { kind: 'local', pcm } as unknown as MediaSource;
  const render = vi.fn(options.render ?? (async (plan: TransitionPlan, a: Excerpt, b: Excerpt) => renderTransition(plan, a, b)));
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
  });
  return { dir, transitions, pcm, render, encode, log, maps, cues };
}

/** A temporary cache folder, removed after the test. */
function cacheFolder(): string {
  const t = tempDir();
  const previous = cleanup;
  cleanup = () => {
    previous();
    t.cleanup();
  };
  return t.dir;
}

const transitionFiles = (dir: string) => (existsSync(join(dir, 'transitions')) ? readdirSync(join(dir, 'transitions')).sort() : []);
const fileOf = (dir: string, url: string) => join(dir, 'transitions', url.replace('/transitions/', ''));

function expectReady(answer: TransitionAnswer): Extract<TransitionAnswer, { status: 'ready' }> {
  expect(answer.status).toBe('ready');
  return answer as Extract<TransitionAnswer, { status: 'ready' }>;
}

describe('Transitions', () => {
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
    const samples = readRaw(fileOf(t.dir, ready.url));
    expect(samples.length).toBe(2 * Math.round(expectedPlan.length * RENDER_RATE));

    // A's excerpt is decoded in stereo from just before the transition, clamped to the song's length.
    expect(t.pcm).toHaveBeenCalledTimes(2);
    const [aPath, aOpts] = t.pcm.mock.calls[0]!;
    expect(aPath).toBe('/music/1.flac');
    expect(aOpts).toMatchObject({ sampleRate: RENDER_RATE, channels: 2, startSeconds: expectedPlan.aStart - 0.25 });
    expect(aOpts.startSeconds! + aOpts.maxSeconds).toBeLessThanOrEqual(SONG_SECONDS);
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

  it('keys the cache by the songs, mode and cue points', async () => {
    const t = setup();
    await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' });
    await t.transitions.idle();
    const auto = expectReady(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' }));
    expect((await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'party' })).status).toBe('pending');
    t.cues.set('rec-1', { mixOut: 35 });
    expect((await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' })).status).toBe('pending');
    await t.transitions.idle();
    const withCue = expectReady(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' }));
    expect(withCue.url).not.toBe(auto.url);
    expect(withCue.plan.aStart).toBe(35);
  });

  it('forget removes every cached transition involving a song', async () => {
    const t = setup();
    await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' });
    await t.transitions.request({ fromTrackId: 3, toTrackId: 4, mode: 'auto' });
    await t.transitions.idle();
    expect(transitionFiles(t.dir)).toHaveLength(4);

    await t.transitions.forget('rec-2');
    expect(transitionFiles(t.dir)).toHaveLength(2);
    expect((await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' })).status).toBe('pending');
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

  it('also stores the rest of an MP3 B from where playback resumes, decoded with the transition', async () => {
    const t = setup({ tracks: [track(1), track(2, MP3)] });
    await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' });
    await t.transitions.idle();
    const ready = expectReady(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' }));
    expect(ready.continuationUrl).toBe(ready.url.replace(/\.flac$/, '.rest.flac'));

    const rest = readRaw(fileOf(t.dir, ready.continuationUrl!));
    const bResume = ready.plan.bResume;
    expect(rest.length / 2).toBe(Math.round((SONG_SECONDS - bResume) * RENDER_RATE));
    for (const i of [0, 1000, 44100]) {
      expect(rest[2 * i]).toBeCloseTo(sampleAt('/music/2.flac', bResume + i / RENDER_RATE), 3);
    }
    // One decode of B covers both the transition and the rest, so they join without a gap.
    expect(t.pcm).toHaveBeenCalledTimes(2);

    t.pcm.mockClear();
    expect(await t.transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' })).toEqual(ready);
    expect(t.pcm).not.toHaveBeenCalled();
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
    expect(wav.readUInt32LE(40)).toBe(Math.round(ready.plan.length * RENDER_RATE) * 4);
    expect(t.encode).toHaveBeenCalledTimes(1);

    await t.transitions.request({ fromTrackId: 2, toTrackId: 3, mode: 'auto' });
    await t.transitions.idle();
    expect(expectReady(await t.transitions.request({ fromTrackId: 2, toTrackId: 3, mode: 'auto' })).url).toMatch(/\.wav$/);
    expect(t.encode).toHaveBeenCalledTimes(1);
  });

  it('the ffmpeg encoder reports a missing ffmpeg as ENOENT, which is what switches to WAV', async () => {
    const encode = ffmpegFlacEncoder('playarr-test-no-such-ffmpeg');
    const audio = { left: new Float32Array(10), right: new Float32Array(10) };
    await expect(encode(audio, join(cacheFolder(), 'out.flac.tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
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
