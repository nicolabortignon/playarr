import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import {
  excerptRanges,
  planTransition,
  RENDER_RATE,
  type CuePoints,
  type Excerpt,
  type MixMap,
  type MixMode,
  type StereoAudio,
  type TransitionPlan,
} from '@playarr/mix';
import type { AudioFormat, Track } from '@playarr/shared';
import { trimCacheDir } from '../cacheDir.ts';
import type { FileResolver } from '../catalog/files.ts';
import type { Library } from '../library/library.ts';
import { lowPriority } from '../lowPriority.ts';
import type { MediaSource } from '../media/source.ts';

// Transition files: while A plays, the player asks for A→B. The plan is made at once (it's cheap
// and pure); the audio is rendered in the background, one transition at a time, and kept on disk
// so the same plan between the same files is only ever rendered once. The player polls until it's
// ready, and falls back to its own mixing (or a plain crossfade) whenever the answer isn't "ready" in time.

/** Bump when the rendered audio changes for the same plan, so cached files are made again. */
export const RENDERER_VERSION = 1;

/** Renders waiting at most: by the time more pile up, the older ones are songs already skipped. */
const MAX_QUEUED = 3;
/** How long a pair that failed to render is answered "unavailable" before it's tried again. */
const FAILURE_MEMORY_MS = 10 * 60_000;
const DEFAULT_MAX_BYTES = 1024 ** 3;
/** Longest a decode may take (a whole MP3 decoded to seek exactly, on a slow NAS, is seconds). */
const DEFAULT_DECODE_TIMEOUT_MS = 2 * 60_000;
/** Longest a render or an encode may take (a long blend on a NAS takes tens of seconds). */
const DEFAULT_RENDER_TIMEOUT_MS = 5 * 60_000;
/**
 * The planner starts a plan at least this far ahead of A's position (its PLANNING_LEAD): a plan
 * is reused while it still starts this far ahead, and only replanned once it can't be reached.
 */
const PLANNING_LEAD = 5;
/** Pairs whose plan is remembered: far more than a queue's worth of upcoming transitions. */
const REMEMBERED_PLANS = 500;
/** Bytes per stereo frame of the s16le PCM media.pcm decodes. */
const PCM_FRAME_BYTES = 4;
/** Decoders may run a little past a song's listed length: room for that when decoding "to the end". */
const END_SLACK_SECONDS = 1;
/** A decode this much shorter than asked means the file or the source broke off, not that the song ended. */
const SHORT_DECODE_SLACK_SECONDS = 1;
/** The shortest decode ever asked for: ffmpeg refuses a zero length. */
const SHORTEST_DECODE_SECONDS = 0.1;
/**
 * Decodes start on a 10 ms grid: ffmpeg rounds `-ss` to the millisecond, which would shift the
 * audio against the start we report by up to 22 samples; 10 ms is a whole number of samples at
 * 44.1 and 48 kHz alike, so the start asked for is the start decoded.
 */
const SEEK_GRID_PER_SECOND = 100;
/** Frames written to the encoder or a WAV file at a time: a second, so a long blend is never doubled in memory. */
const CHUNK_FRAMES = RENDER_RATE;
const CACHE_FILE = /^[0-9a-f]{40}(\.rest)?\.(flac|wav)$/;
/** Every file a transition can have: audio in either format, B's remainder, the sidecar, and their temporaries. */
const FILE_SUFFIXES = ['.flac', '.wav', '.rest.flac', '.rest.wav', '.json'].flatMap((s) => [s, `${s}.tmp`]);

/** Mix maps and hand-set cue points, by recording (the analyzer). */
export interface MixMapSource {
  mixMaps(recordingIds: string[]): Map<string, MixMap>;
  cues(recordingIds: string[]): Map<string, CuePoints>;
}

/** Turns a plan and the two excerpts into the transition's audio (the DSP worker thread). */
export interface TransitionRenderer {
  render(plan: TransitionPlan, a: Excerpt, b: Excerpt): Promise<StereoAudio>;
}

/**
 * Writes stereo audio at RENDER_RATE to `file` as FLAC, giving up when `signal` aborts. Rejects
 * with an error whose `code` is 'ENOENT' when there's no encoder here at all (WAV is written instead).
 */
export type Encoder = (audio: StereoAudio, file: string, signal: AbortSignal) => Promise<void>;

export interface TransitionsOptions {
  library: Pick<Library, 'track' | 'file'>;
  files: Pick<FileResolver, 'resolve'>;
  maps: MixMapSource;
  dsp: TransitionRenderer;
  /** The server's cache folder: transitions go in its `transitions` folder. */
  cacheDir: string;
  /** ffmpeg on this machine (not where the music is): it encodes the rendered audio. */
  ffmpegPath: string;
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
  /** Size cap of the transitions folder (default 1 GiB): least recently used go first. */
  maxBytes?: number;
  /** Replaces the ffmpeg FLAC encoder (tests). */
  encode?: Encoder;
  decodeTimeoutMs?: number;
  renderTimeoutMs?: number;
  now?: () => number;
}

export interface TransitionRequest {
  fromTrackId: number;
  toTrackId: number;
  mode: MixMode;
  /** Where A's playback is now, in seconds: the plan never starts in the past. */
  aPosition?: number;
}

export type TransitionAnswer =
  | { status: 'ready'; plan: TransitionPlan; url: string; continuationUrl?: string }
  | { status: 'pending'; plan: TransitionPlan }
  | { status: 'straight'; plan: TransitionPlan }
  | { status: 'unavailable'; reason: string };

type AudioExtension = 'flac' | 'wav';

/** A plan made for a pair of files in a mode, kept so polls that come later get the same one. */
interface RememberedPlan {
  plan: TransitionPlan;
  /** Fingerprint of what the plan was made from (maps, cues, album order): a change means a new plan. */
  inputs: string;
  recordings: [string, string];
}

/** What's kept next to each transition file (`<key>.json`), and in memory as the cache's index. */
interface Sidecar {
  aRecording: string;
  bRecording: string;
  plan: TransitionPlan;
  audio: AudioExtension;
  /** B's remainder, for songs that can't be joined sample-exactly by seeking (MP3). */
  continuation?: AudioExtension;
  createdAt: number;
  /** The pair (files and mode) and plan inputs, so a restarted server keeps answering with this plan. */
  pair?: string;
  inputs?: string;
}

interface Job {
  key: string;
  pair: string;
  inputs: string;
  fromTrackId: number;
  a: Track;
  b: Track;
  /** Song lengths to decode against: the mix map's (measured) where known, else the library's. */
  aDuration: number;
  bDuration: number;
  plan: TransitionPlan;
  /** One of its songs was forgotten while it rendered: its result is thrown away. */
  forgotten?: boolean;
}

export class Transitions {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly encode: Encoder;
  private readonly decodeTimeoutMs: number;
  private readonly renderTimeoutMs: number;
  private readonly now: () => number;
  private readonly index = new Map<string, Sidecar>();
  private readonly plans = new Map<string, RememberedPlan>();
  private readonly failures = new Map<string, { until: number; reason: string; recordings: [string, string] }>();
  /** Renders waiting, newest first. */
  private queue: Job[] = [];
  private running: Job | null = null;
  private idleWaiters: (() => void)[] = [];
  /** ffmpeg turned out not to exist here: transitions are written as WAV from then on. */
  private noEncoder = false;

  constructor(private readonly opts: TransitionsOptions) {
    this.dir = join(opts.cacheDir, 'transitions');
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.encode = opts.encode ?? ffmpegFlacEncoder(opts.ffmpegPath);
    this.decodeTimeoutMs = opts.decodeTimeoutMs ?? DEFAULT_DECODE_TIMEOUT_MS;
    this.renderTimeoutMs = opts.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Reads the cache's index from the sidecars on disk, and clears away what a crash left behind:
   * half-written files, and audio whose sidecar was never written.
   */
  async load(): Promise<void> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const sidecars = new Set(names.filter((name) => name.endsWith('.json')).map((name) => name.split('.')[0]));
    for (const name of names) {
      if (name.endsWith('.tmp') || !sidecars.has(name.split('.')[0])) await rm(join(this.dir, name), { force: true });
    }
    for (const name of names) {
      if (!name.endsWith('.json') || !sidecars.has(name.split('.')[0])) continue;
      try {
        const sidecar = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as Sidecar;
        if (typeof sidecar.aRecording !== 'string' || typeof sidecar.bRecording !== 'string' || !sidecar.plan) continue;
        this.index.set(name.slice(0, -'.json'.length), sidecar);
        if (sidecar.pair && sidecar.inputs) {
          this.remember(sidecar.pair, { plan: sidecar.plan, inputs: sidecar.inputs, recordings: [sidecar.aRecording, sidecar.bRecording] });
        }
      } catch {
        // A broken sidecar: its transition is made again when it's asked for.
      }
    }
  }

  async request({ fromTrackId, toTrackId, mode, aPosition }: TransitionRequest): Promise<TransitionAnswer> {
    const [a, b] = await Promise.all([this.opts.library.track(fromTrackId), this.opts.library.track(toTrackId)]);
    if (!a || !b) return { status: 'unavailable', reason: 'Unknown song' };
    const recordings: [string, string] = [a.recordingId, b.recordingId];
    const maps = this.opts.maps.mixMaps(recordings);
    const aMap = maps.get(a.recordingId);
    const bMap = maps.get(b.recordingId);
    if (!aMap) return { status: 'unavailable', reason: `No mix map yet for the song playing (“${a.title}”)` };
    if (!bMap) return { status: 'unavailable', reason: `No mix map yet for the next song (“${b.title}”)` };
    const cues = this.opts.maps.cues(recordings);
    const aCues = cues.get(a.recordingId);
    const bCues = cues.get(b.recordingId);
    const sameAlbumInOrder = continuesAlbum(a, b);

    // The plan made for this pair before, while it can still be reached: a later poll (A has
    // played on) would otherwise get a plan that starts later, a new file to render, and never be ready.
    const pair = JSON.stringify([a.fileId, b.fileId, mode]);
    const inputs = hash([aMap, aCues ?? null, bMap, bCues ?? null, sameAlbumInOrder]);
    const remembered = this.plans.get(pair);
    const reachable = (plan: TransitionPlan) => plan.aStart >= (aPosition ?? 0) + PLANNING_LEAD;
    let plan: TransitionPlan;
    if (remembered && remembered.inputs === inputs && reachable(remembered.plan)) {
      plan = remembered.plan;
    } else {
      plan = planTransition({ a: { ...aMap, cues: aCues }, b: { ...bMap, cues: bCues }, mode, sameAlbumInOrder, aPosition });
      this.remember(pair, { plan, inputs, recordings });
    }
    if (plan.style === 'straight' || plan.length === 0) return { status: 'straight', plan };

    // The plan holds everything the audio depends on (maps, cues and mode went into it); the files'
    // sizes stand in for their contents, so a replaced file is rendered again.
    const key = hash([RENDERER_VERSION, a.fileId, a.size, b.fileId, b.size, plan]);
    const cached = await this.cached(key);
    if (cached) return cached;
    this.forgetExpiredFailures();
    const failure = this.failures.get(pair);
    if (failure) return { status: 'unavailable', reason: failure.reason };
    const songLength = (map: MixMap, track: Track) => (Number.isFinite(map.duration) && map.duration > 0 ? map.duration : track.duration);
    this.enqueue({ key, pair, inputs, fromTrackId, a, b, aDuration: songLength(aMap, a), bDuration: songLength(bMap, b), plan });
    return { status: 'pending', plan };
  }

  /**
   * Deletes every cached transition into or out of a song: its mix map or cue points changed, or it
   * left the library. Renders of it still waiting are dropped too, and one rendering is thrown away.
   */
  async forget(recordingId: string): Promise<void> {
    const involves = ([a, b]: [string, string]) => a === recordingId || b === recordingId;
    this.queue = this.queue.filter((job) => !involves([job.a.recordingId, job.b.recordingId]));
    if (this.running && involves([this.running.a.recordingId, this.running.b.recordingId])) this.running.forgotten = true;
    for (const [pair, failure] of [...this.failures]) if (involves(failure.recordings)) this.failures.delete(pair);
    for (const [pair, remembered] of [...this.plans]) if (involves(remembered.recordings)) this.plans.delete(pair);
    for (const [key, sidecar] of [...this.index]) {
      if (!involves([sidecar.aRecording, sidecar.bRecording])) continue;
      this.index.delete(key);
      await this.removeFiles(key);
    }
  }

  /** The file behind a transition URL's name, or undefined for any name this service doesn't make. */
  filePath(name: string): string | undefined {
    return CACHE_FILE.test(name) ? join(this.dir, name) : undefined;
  }

  /** Resolves once nothing is rendering or waiting (tests, shutdown). */
  idle(): Promise<void> {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private remember(pair: string, remembered: RememberedPlan) {
    this.plans.delete(pair); // re-inserted as the newest
    this.plans.set(pair, remembered);
    if (this.plans.size > REMEMBERED_PLANS) this.plans.delete(this.plans.keys().next().value!);
  }

  private forgetExpiredFailures() {
    const now = this.now();
    for (const [pair, failure] of [...this.failures]) if (failure.until <= now) this.failures.delete(pair);
  }

  private async cached(key: string): Promise<TransitionAnswer | undefined> {
    const sidecar = this.index.get(key);
    if (!sidecar) return undefined;
    const files = [`${key}.${sidecar.audio}`, ...(sidecar.continuation ? [`${key}.rest.${sidecar.continuation}`] : [])];
    const present = await Promise.all(files.map((name) => access(join(this.dir, name)).then(() => true, () => false)));
    if (present.includes(false)) {
      // Trimmed away (or deleted by hand) since: made again.
      this.index.delete(key);
      return undefined;
    }
    return {
      status: 'ready',
      plan: sidecar.plan,
      url: `/transitions/${files[0]}`,
      ...(files[1] ? { continuationUrl: `/transitions/${files[1]}` } : {}),
    };
  }

  /**
   * Newest first. A newer request from the same song replaces what was waiting for it: the
   * listener changed the next song, so the old pair won't be needed.
   */
  private enqueue(job: Job) {
    if (this.running?.key === job.key) return;
    this.queue = [job, ...this.queue.filter((queued) => queued.key !== job.key && queued.fromTrackId !== job.fromTrackId)].slice(0, MAX_QUEUED);
    this.pump();
  }

  private pump() {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) {
      for (const resolve of this.idleWaiters.splice(0)) resolve();
      return;
    }
    this.running = job;
    void this.run(job).finally(() => {
      this.running = null;
      this.pump();
    });
  }

  private async run(job: Job): Promise<void> {
    const started = this.now();
    try {
      const sidecar = await this.render(job);
      if (job.forgotten) {
        await this.removeFiles(job.key);
        return;
      }
      this.index.set(job.key, sidecar);
      this.opts.log.info(
        { from: job.a.recordingId, to: job.b.recordingId, style: job.plan.style, seconds: (this.now() - started) / 1000 },
        'transition rendered',
      );
    } catch (err) {
      await this.removeFiles(job.key);
      if (!job.forgotten) {
        const reason = `The transition couldn’t be made: ${(err as Error).message}`;
        this.failures.set(job.pair, { until: this.now() + FAILURE_MEMORY_MS, reason, recordings: [job.a.recordingId, job.b.recordingId] });
      }
      this.opts.log.warn({ err, from: job.a.recordingId, to: job.b.recordingId }, 'transition render failed');
      return;
    }
    // Apart from the render: a trim that fails leaves the cache a little big, not this transition lost.
    await this.trim().catch((err: unknown) => this.opts.log.warn({ err }, 'transition cache trim failed'));
  }

  private async render({ key, pair, inputs, a, b, aDuration, bDuration, plan }: Job): Promise<Sidecar> {
    const ranges = excerptRanges(plan);
    if (!ranges) throw new Error('A straight cut has no transition audio');
    const [aFile, bFile] = await Promise.all([this.opts.library.file(a.fileId), this.opts.library.file(b.fileId)]);
    if (!aFile || !bFile) throw new Error('The song’s file is gone');
    const aSource = { ...this.opts.files.resolve(aFile), track: a, duration: aDuration };
    const bSource = { ...this.opts.files.resolve(bFile), track: b, duration: bDuration };

    const aExcerpt = await this.decode(aSource, ranges.a[0], ranges.a[1]);
    const bExcerpt = await this.decode(bSource, ranges.b[0], ranges.b[1]);
    // An MP3 can't be started sample-exactly in the middle by a player (see seeksInexactly), so
    // the player plays B's remainder from here, decoded exactly like the transition's B: the
    // two meet at bResume to the sample. A leftover risk on A's side (and B's start, if a player
    // ever plays it): ffmpeg skips the LAME encoder delay and padding the file declares, and a
    // browser that doesn't would hear A shifted by those ~25 ms against the transition.
    const rest = seeksInexactly(b.format)
      ? startingAt(await this.decode(bSource, plan.bResume, bDuration + END_SLACK_SECONDS), plan.bResume)
      : undefined;

    const audio = await withTimeout(this.opts.dsp.render(plan, aExcerpt, bExcerpt), this.renderTimeoutMs, 'The render took too long');
    await mkdir(this.dir, { recursive: true });
    const sidecar: Sidecar = {
      aRecording: a.recordingId,
      bRecording: b.recordingId,
      plan,
      audio: await this.writeAudio(audio, key),
      ...(rest ? { continuation: await this.writeAudio(rest, `${key}.rest`) } : {}),
      createdAt: this.now(),
      pair,
      inputs,
    };
    // Written last: a sidecar means the audio beside it is complete.
    await writeFile(join(this.dir, `${key}.json`), JSON.stringify(sidecar));
    return sidecar;
  }

  /**
   * Song time `from` to `to` (clamped to the song's length), stereo at RENDER_RATE. The decode starts
   * on the seek grid at or just before `from`, and the excerpt says so in its `start`. Throws if the
   * source stops much short of what was asked: missing audio would otherwise play as silence.
   */
  private async decode(
    source: { media: MediaSource; path: string; track: Track; duration: number },
    from: number,
    to: number,
  ): Promise<Excerpt> {
    const { media, path, track, duration } = source;
    if (!media.pcm) throw new Error('This source can’t decode audio');
    const gridFrom = Math.floor(from * SEEK_GRID_PER_SECOND) / SEEK_GRID_PER_SECOND;
    const end = Math.min(to, duration + END_SLACK_SECONDS);
    const pcm = await media.pcm(path, {
      sampleRate: RENDER_RATE,
      channels: 2,
      startSeconds: gridFrom,
      maxSeconds: Math.max(SHORTEST_DECODE_SECONDS, end - gridFrom),
      exactSeek: seeksInexactly(track.format),
      signal: AbortSignal.timeout(this.decodeTimeoutMs),
    });
    const { left, right } = deinterleave(pcm);
    const expected = Math.min(to, duration) - gridFrom;
    if (left.length / RENDER_RATE < expected - SHORT_DECODE_SLACK_SECONDS) {
      throw new Error(`Decoding “${track.title}” stopped ${(expected - left.length / RENDER_RATE).toFixed(1)} s short`);
    }
    return { left, right, start: gridFrom };
  }

  /** Writes `<name>.flac`, or `<name>.wav` where there's no ffmpeg; answers which. */
  private async writeAudio(audio: StereoAudio, name: string): Promise<AudioExtension> {
    if (!this.noEncoder) {
      const tmp = join(this.dir, `${name}.flac.tmp`);
      let encoded = false;
      try {
        await this.encode(audio, tmp, AbortSignal.timeout(this.renderTimeoutMs));
        encoded = true;
      } catch (err) {
        await rm(tmp, { force: true });
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        this.noEncoder = true;
        this.opts.log.warn({ ffmpeg: this.opts.ffmpegPath }, 'no ffmpeg on this server: transitions are stored as WAV');
      }
      if (encoded) {
        await rename(tmp, join(this.dir, `${name}.flac`));
        return 'flac';
      }
    }
    const tmp = join(this.dir, `${name}.wav.tmp`);
    await writeWavFile(audio, tmp);
    await rename(tmp, join(this.dir, `${name}.wav`));
    return 'wav';
  }

  private async trim() {
    const { removed } = await trimCacheDir(this.dir, this.maxBytes);
    if (!removed) return;
    for (const key of [...this.index.keys()]) {
      if (!(await this.cached(key))) this.index.delete(key);
    }
  }

  /** Every file a transition can have, whichever of them it has. */
  private async removeFiles(key: string) {
    await Promise.all(FILE_SUFFIXES.map((suffix) => rm(join(this.dir, `${key}${suffix}`), { force: true })));
  }
}

/** B follows A on the same album, in order (as the player's `continues()` decides it). */
export function continuesAlbum(a: Track, b: Track): boolean {
  if (a.albumId !== b.albumId) return false;
  return (b.discNumber === a.discNumber && b.trackNumber === a.trackNumber + 1) || (b.discNumber === a.discNumber + 1 && b.trackNumber === 1);
}

/**
 * Formats that can't be started sample-exactly in the middle. MP3 has no index: a seek is an
 * estimate from the bitrate (or a 100-entry table in VBR files), so a player or ffmpeg jumping into
 * one lands only near the time asked. The others Playarr plays seek exactly: FLAC by its frames
 * and seek table, AAC/ALAC in MP4 by the sample tables, Ogg Vorbis/Opus by granule positions.
 */
function seeksInexactly(format: AudioFormat): boolean {
  return format.codec.toUpperCase() === 'MP3' || format.container.toLowerCase() === 'mp3';
}

/** The excerpt from song time `at` on (it must start at or before it), without copying the samples. */
function startingAt({ left, right, start }: Excerpt, at: number): StereoAudio {
  const skip = Math.min(left.length, Math.round((at - start) * RENDER_RATE));
  return { left: left.subarray(skip), right: right.subarray(skip) };
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function hash(value: unknown): string {
  return createHash('sha1').update(stableJson(value)).digest('hex');
}

/** JSON with object keys sorted, so the same values always make the same text (and the same key). */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : stableJson(v))).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Byte order: PCM in and out (s16le from ffmpeg, f32le to it, WAV) is little-endian whatever the
// machine, so it's read and written through DataView with the order spelled out.

/** s16le stereo PCM (what media.pcm decodes) as the renderer's float channels. */
export function deinterleave(pcm: Buffer): StereoAudio {
  const frames = Math.floor(pcm.length / PCM_FRAME_BYTES);
  const view = new DataView(pcm.buffer, pcm.byteOffset, frames * PCM_FRAME_BYTES);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = view.getInt16(i * PCM_FRAME_BYTES, true) / 32768;
    right[i] = view.getInt16(i * PCM_FRAME_BYTES + 2, true) / 32768;
  }
  return { left, right };
}

/** Frames `from` to `to` as interleaved little-endian float32 (ffmpeg's f32le). */
function f32leChunk({ left, right }: StereoAudio, from: number, to: number): Buffer {
  const chunk = Buffer.alloc((to - from) * 8);
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  for (let i = from; i < to; i++) {
    view.setFloat32((i - from) * 8, left[i]!, true);
    view.setFloat32((i - from) * 8 + 4, right[i]!, true);
  }
  return chunk;
}

/** Frames `from` to `to` as interleaved 16-bit little-endian PCM (a WAV file's data). */
function s16leChunk({ left, right }: StereoAudio, from: number, to: number): Buffer {
  const chunk = Buffer.alloc((to - from) * 4);
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const toInt16 = (x: number) => Math.round(Math.max(-1, Math.min(1, x)) * 32767);
  for (let i = from; i < to; i++) {
    view.setInt16((i - from) * 4, toInt16(left[i]!), true);
    view.setInt16((i - from) * 4 + 2, toInt16(right[i]!), true);
  }
  return chunk;
}

/** The 44-byte header of a 16-bit stereo WAV file at RENDER_RATE holding `frames` frames. */
export function wavHeader(frames: number): Buffer {
  const channels = 2;
  const bytesPerSample = 2;
  const dataBytes = frames * channels * bytesPerSample;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // size of this chunk
  header.writeUInt16LE(1, 20); // plain PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(RENDER_RATE, 24);
  header.writeUInt32LE(RENDER_RATE * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** A 16-bit stereo WAV file: what's stored when this server has no ffmpeg to make FLAC. Written a second at a time. */
async function writeWavFile(audio: StereoAudio, file: string): Promise<void> {
  const handle = await open(file, 'w');
  try {
    await handle.write(wavHeader(audio.left.length));
    for (let from = 0; from < audio.left.length; from += CHUNK_FRAMES) {
      await handle.write(s16leChunk(audio, from, Math.min(audio.left.length, from + CHUNK_FRAMES)));
    }
  } finally {
    await handle.close();
  }
}

/** Feeds the audio to ffmpeg a second at a time, waiting whenever its pipe is full. */
async function feed(stdin: Writable, audio: StereoAudio, signal: AbortSignal): Promise<void> {
  for (let from = 0; from < audio.left.length; from += CHUNK_FRAMES) {
    const chunk = f32leChunk(audio, from, Math.min(audio.left.length, from + CHUNK_FRAMES));
    if (!stdin.write(chunk)) await once(stdin, 'drain', { signal });
  }
  stdin.end();
}

/** Encodes with ffmpeg on this machine, at low priority: rendering is never what anyone is waiting on. */
export function ffmpegFlacEncoder(ffmpegPath: string): Encoder {
  return (audio, file, signal) =>
    new Promise((resolve, reject) => {
      const args = [
        ...['-hide_banner', '-loglevel', 'error'],
        ...['-f', 'f32le', '-ar', String(RENDER_RATE), '-ac', '2', '-i', '-'],
        // The file name ends in .tmp until it's complete, so the format is named rather than guessed.
        ...['-c:a', 'flac', '-compression_level', '5', '-f', 'flac', '-y', file],
      ];
      // Aborting (the timeout) kills ffmpeg; that, or ffmpeg exiting, also stops the feeding.
      const done = new AbortController();
      const child = lowPriority(spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'], signal }));
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
      // Missing ffmpeg (ENOENT) arrives here, with its code kept for the WAV fallback.
      child.on('error', (err) => {
        done.abort();
        reject(err);
      });
      // ffmpeg stopping early closes the pipe; 'close' below says why.
      child.stdin.on('error', () => {});
      child.on('close', (code) => {
        done.abort();
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg couldn’t encode the transition (${code}): ${stderr.trim()}`));
      });
      feed(child.stdin, audio, done.signal).catch(() => {});
    });
}
