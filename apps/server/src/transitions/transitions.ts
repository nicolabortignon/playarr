import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  excerptRanges,
  MIX_MAP_VERSION,
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
import { PCM_MAX_BUFFER } from '../media/source.ts';

// Transition files: while A plays, the player asks for A→B. The plan is made at once (it's cheap
// and pure); the audio is rendered in the background, one transition at a time, and kept on disk
// so the same pair in the same mode is only ever rendered once. The player polls until it's ready,
// and falls back to its own mixing (or a plain crossfade) whenever the answer isn't "ready" in time.

/** Bump when the rendered audio changes for the same plan, so cached files are made again. */
export const RENDERER_VERSION = 1;

/** Renders waiting at most: by the time more pile up, the older ones are songs already skipped. */
const MAX_QUEUED = 3;
/** How long a pair that failed to render is answered "unavailable" before it's tried again. */
const FAILURE_MEMORY_MS = 10 * 60_000;
const DEFAULT_MAX_BYTES = 1024 ** 3;
/** Bytes per stereo frame of the s16le PCM media.pcm decodes. */
const PCM_FRAME_BYTES = 4;
/** Decoders may run a little past a song's listed length: room for that when decoding "to the end". */
const END_SLACK_SECONDS = 1;
/** The shortest decode ever asked for: ffmpeg refuses a zero length. */
const SHORTEST_DECODE_SECONDS = 0.1;
const CACHE_FILE = /^[0-9a-f]{40}(\.rest)?\.(flac|wav)$/;

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
 * Writes stereo audio at RENDER_RATE to `file` as FLAC. Rejects with an error whose `code` is
 * 'ENOENT' when there's no encoder here at all (the service then writes WAV instead).
 */
export type Encoder = (audio: StereoAudio, file: string) => Promise<void>;

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

/** What's kept next to each transition file (`<key>.json`), and in memory as the cache's index. */
interface Sidecar {
  aRecording: string;
  bRecording: string;
  plan: TransitionPlan;
  audio: AudioExtension;
  /** B's remainder, for songs that can't be joined sample-exactly by seeking (MP3). */
  continuation?: AudioExtension;
  createdAt: number;
}

interface Job {
  key: string;
  /** Recordings and mode: what a failure is remembered by. */
  pair: string;
  fromTrackId: number;
  a: Track;
  b: Track;
  plan: TransitionPlan;
  /** One of its songs was forgotten while it rendered: its result is thrown away. */
  forgotten?: boolean;
}

export class Transitions {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly encode: Encoder;
  private readonly now: () => number;
  private readonly index = new Map<string, Sidecar>();
  private readonly failures = new Map<string, { until: number; reason: string }>();
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
    this.now = opts.now ?? Date.now;
  }

  /** Reads the cache's index from the sidecars on disk, and clears away half-written files. */
  async load(): Promise<void> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    for (const name of names) {
      if (name.endsWith('.tmp')) {
        await rm(join(this.dir, name), { force: true });
        continue;
      }
      if (!name.endsWith('.json')) continue;
      try {
        const sidecar = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as Sidecar;
        if (typeof sidecar.aRecording !== 'string' || typeof sidecar.bRecording !== 'string' || !sidecar.plan) continue;
        this.index.set(name.slice(0, -'.json'.length), sidecar);
      } catch {
        // A broken sidecar: its transition is made again when it's asked for.
      }
    }
  }

  async request({ fromTrackId, toTrackId, mode, aPosition }: TransitionRequest): Promise<TransitionAnswer> {
    const [a, b] = await Promise.all([this.opts.library.track(fromTrackId), this.opts.library.track(toTrackId)]);
    if (!a || !b) return { status: 'unavailable', reason: 'Unknown song' };
    const recordings = [a.recordingId, b.recordingId];
    const maps = this.opts.maps.mixMaps(recordings);
    const aMap = maps.get(a.recordingId);
    const bMap = maps.get(b.recordingId);
    if (!aMap) return { status: 'unavailable', reason: `No mix map yet for the song playing (“${a.title}”)` };
    if (!bMap) return { status: 'unavailable', reason: `No mix map yet for the next song (“${b.title}”)` };
    const cues = this.opts.maps.cues(recordings);
    const aCues = cues.get(a.recordingId);
    const bCues = cues.get(b.recordingId);
    const plan = planTransition({
      a: { ...aMap, cues: aCues },
      b: { ...bMap, cues: bCues },
      mode,
      sameAlbumInOrder: continuesAlbum(a, b),
      aPosition,
    });
    if (plan.style === 'straight') return { status: 'straight', plan };

    const key = cacheKey([a.recordingId, b.recordingId, mode, MIX_MAP_VERSION, RENDERER_VERSION, aCues ?? null, bCues ?? null, plan.aStart, plan.bStart]);
    const cached = await this.cached(key);
    if (cached) return cached;
    const pair = JSON.stringify([a.recordingId, b.recordingId, mode]);
    const failure = this.failures.get(pair);
    if (failure && failure.until > this.now()) return { status: 'unavailable', reason: failure.reason };
    this.failures.delete(pair);
    this.enqueue({ key, pair, fromTrackId, a, b, plan });
    return { status: 'pending', plan };
  }

  /**
   * Deletes every cached transition into or out of a song: its mix map or cue points changed, or it
   * left the library. Renders of it still waiting are dropped too.
   */
  async forget(recordingId: string): Promise<void> {
    const involves = (a: string, b: string) => a === recordingId || b === recordingId;
    this.queue = this.queue.filter((job) => !involves(job.a.recordingId, job.b.recordingId));
    if (this.running && involves(this.running.a.recordingId, this.running.b.recordingId)) this.running.forgotten = true;
    for (const pair of this.failures.keys()) {
      const [a, b] = JSON.parse(pair) as [string, string];
      if (involves(a, b)) this.failures.delete(pair);
    }
    for (const [key, sidecar] of [...this.index]) {
      if (!involves(sidecar.aRecording, sidecar.bRecording)) continue;
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
      await this.trim();
    } catch (err) {
      await this.removeFiles(job.key);
      const reason = `The transition couldn’t be made: ${(err as Error).message}`;
      this.failures.set(job.pair, { until: this.now() + FAILURE_MEMORY_MS, reason });
      this.opts.log.warn({ err, from: job.a.recordingId, to: job.b.recordingId }, 'transition render failed');
    }
  }

  private async render({ key, a, b, plan }: Job): Promise<Sidecar> {
    const [aFile, bFile] = await Promise.all([this.opts.library.file(a.fileId), this.opts.library.file(b.fileId)]);
    if (!aFile || !bFile) throw new Error('The song’s file is gone');
    const aSource = this.opts.files.resolve(aFile);
    const bSource = this.opts.files.resolve(bFile);
    const ranges = excerptRanges(plan);
    const decode = async ({ media, path }: typeof aSource, from: number, seconds: number): Promise<Excerpt> => {
      if (!media.pcm) throw new Error('This source can’t decode audio');
      const pcm = await media.pcm(path, { sampleRate: RENDER_RATE, channels: 2, startSeconds: from, maxSeconds: Math.max(SHORTEST_DECODE_SECONDS, seconds) });
      return { ...deinterleave(pcm), start: from };
    };
    const decodeRange = (source: typeof aSource, [from, to]: [number, number], duration: number) =>
      decode(source, from, Math.min(to, duration) - from);

    const aExcerpt = await decodeRange(aSource, ranges.a, a.duration);
    let bExcerpt: Excerpt;
    let rest: StereoAudio | undefined;
    if (!seeksInexactly(b.format)) {
      bExcerpt = await decodeRange(bSource, ranges.b, b.duration);
    } else {
      // Seeking into an MP3 lands only roughly where asked, and differently each time; so the
      // player plays B's remainder from a file made from the same decode as the transition,
      // where the two meet sample-exactly. One decode from the transition to B's end when that
      // fits in memory; otherwise two, which join as well as the seeks allow.
      const toEnd = b.duration - ranges.b[0] + END_SLACK_SECONDS;
      if (toEnd * RENDER_RATE * PCM_FRAME_BYTES < PCM_MAX_BUFFER * 0.9) {
        const whole = await decode(bSource, ranges.b[0], toEnd);
        const excerptEnd = Math.round((ranges.b[1] - ranges.b[0]) * RENDER_RATE);
        const restFrom = Math.round((plan.bResume - ranges.b[0]) * RENDER_RATE);
        bExcerpt = { left: whole.left.slice(0, excerptEnd), right: whole.right.slice(0, excerptEnd), start: whole.start };
        rest = { left: whole.left.slice(restFrom), right: whole.right.slice(restFrom) };
      } else {
        bExcerpt = await decodeRange(bSource, ranges.b, b.duration);
        rest = await decode(bSource, plan.bResume, b.duration - plan.bResume + END_SLACK_SECONDS);
      }
    }

    const audio = await this.opts.dsp.render(plan, aExcerpt, bExcerpt);
    await mkdir(this.dir, { recursive: true });
    const sidecar: Sidecar = {
      aRecording: a.recordingId,
      bRecording: b.recordingId,
      plan,
      audio: await this.writeAudio(audio, key),
      ...(rest ? { continuation: await this.writeAudio(rest, `${key}.rest`) } : {}),
      createdAt: this.now(),
    };
    // Written last: a sidecar means the audio beside it is complete.
    await writeFile(join(this.dir, `${key}.json`), JSON.stringify(sidecar));
    return sidecar;
  }

  /** Writes `<name>.flac`, or `<name>.wav` where there's no ffmpeg; answers which. */
  private async writeAudio(audio: StereoAudio, name: string): Promise<AudioExtension> {
    if (!this.noEncoder) {
      const tmp = join(this.dir, `${name}.flac.tmp`);
      let encoded = false;
      try {
        await this.encode(audio, tmp);
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
    await writeFile(tmp, wavFile(audio));
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

  /** Every file of a transition: the audio in either format, B's remainder and the sidecar. */
  private async removeFiles(key: string) {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    for (const name of names) if (name.split('.')[0] === key) await rm(join(this.dir, name), { force: true });
  }
}

/** B follows A on the same album, in order (as the player's `continues()` decides it). */
export function continuesAlbum(a: Track, b: Track): boolean {
  if (a.albumId !== b.albumId) return false;
  return (b.discNumber === a.discNumber && b.trackNumber === a.trackNumber + 1) || (b.discNumber === a.discNumber + 1 && b.trackNumber === 1);
}

/**
 * Formats a player can't start sample-exactly in the middle of: MP3 (VBR files above all) seeks by
 * estimate, so a join into it could land off the beat.
 */
function seeksInexactly(format: AudioFormat): boolean {
  return format.codec.toUpperCase() === 'MP3' || format.container.toLowerCase() === 'mp3';
}

function cacheKey(parts: unknown[]): string {
  return createHash('sha1').update(stableJson(parts)).digest('hex');
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

/** s16le stereo PCM (what media.pcm decodes) as the renderer's float channels. */
export function deinterleave(pcm: Buffer): StereoAudio {
  const frames = Math.floor(pcm.length / PCM_FRAME_BYTES);
  // Read in place where the bytes are aligned for it (little-endian, like every machine Playarr runs on).
  const samples =
    pcm.byteOffset % 2 === 0
      ? new Int16Array(pcm.buffer, pcm.byteOffset, frames * 2)
      : new Int16Array(new Uint8Array(pcm.subarray(0, frames * PCM_FRAME_BYTES)).buffer);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = samples[2 * i]! / 32768;
    right[i] = samples[2 * i + 1]! / 32768;
  }
  return { left, right };
}

/** Interleaved float32 frames, little-endian like every machine Playarr runs on (ffmpeg's f32le). */
function interleave({ left, right }: StereoAudio): Buffer {
  const out = new Float32Array(left.length * 2);
  for (let i = 0; i < left.length; i++) {
    out[2 * i] = left[i]!;
    out[2 * i + 1] = right[i]!;
  }
  return Buffer.from(out.buffer);
}

/** A 16-bit stereo WAV file at RENDER_RATE: what's stored when this server has no ffmpeg to make FLAC. */
export function wavFile({ left, right }: StereoAudio): Buffer {
  const channels = 2;
  const bytesPerSample = 2;
  const dataBytes = left.length * channels * bytesPerSample;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16); // size of this chunk
  wav.writeUInt16LE(1, 20); // plain PCM
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(RENDER_RATE, 24);
  wav.writeUInt32LE(RENDER_RATE * channels * bytesPerSample, 28);
  wav.writeUInt16LE(channels * bytesPerSample, 32);
  wav.writeUInt16LE(bytesPerSample * 8, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  const toInt16 = (x: number) => Math.round(Math.max(-1, Math.min(1, x)) * 32767);
  for (let i = 0; i < left.length; i++) {
    wav.writeInt16LE(toInt16(left[i]!), 44 + i * 4);
    wav.writeInt16LE(toInt16(right[i]!), 46 + i * 4);
  }
  return wav;
}

/** Encodes with ffmpeg on this machine, at low priority: rendering is never what anyone is waiting on. */
export function ffmpegFlacEncoder(ffmpegPath: string): Encoder {
  return (audio, file) =>
    new Promise((resolve, reject) => {
      const args = [
        ...['-hide_banner', '-loglevel', 'error'],
        ...['-f', 'f32le', '-ar', String(RENDER_RATE), '-ac', '2', '-i', '-'],
        // The file name ends in .tmp until it's complete, so the format is named rather than guessed.
        ...['-c:a', 'flac', '-compression_level', '5', '-f', 'flac', '-y', file],
      ];
      const child = lowPriority(spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] }));
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
      // Missing ffmpeg (ENOENT) arrives here, with its code kept for the WAV fallback.
      child.on('error', reject);
      // ffmpeg stopping early closes the pipe; 'close' below says why.
      child.stdin.on('error', () => {});
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg couldn’t encode the transition (${code}): ${stderr.trim()}`));
      });
      child.stdin.end(interleave(audio));
    });
}
