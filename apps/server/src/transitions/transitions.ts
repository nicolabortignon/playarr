import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import {
  excerptRanges,
  planTransition,
  PLANNER_VERSION,
  RENDER_RATE,
  type CuePoints,
  type Excerpt,
  type MixMap,
  type MixMode,
  type StereoAudio,
  type TransitionPlan,
} from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { trimCacheDir } from '../cacheDir.ts';
import type { FileResolver } from '../catalog/files.ts';
import type { Library, LibraryView } from '../library/library.ts';
import { lowPriority } from '../lowPriority.ts';
import { seeksInexactly, type MediaSource } from '../media/source.ts';

// Transition files: while A plays, the player asks for A→B. The plan is made at once (it's cheap
// and pure); the audio is rendered in the background, one transition at a time, and kept on disk
// so the same plan between the same files is only ever rendered once. The player polls until it's
// ready, and falls back to its own mixing (or a plain crossfade) whenever the answer isn't "ready" in time.

/** Bump when the rendered audio changes for the same plan, so cached files are made again. */
export const RENDERER_VERSION = 4;
/**
 * Seconds of B on its own after each transition, in the same file: a phone that can't start one file
 * exactly as another ends (an iPhone) starts B's own file during them, silently, and changes over
 * once the two are in step.
 */
export const TRANSITION_TAIL_SECONDS = 3;
/**
 * Seconds of A on its own before each transition, in the same file: the player starts the file this
 * early, silenced, and changes over from A's own file once the two are in step, all before the
 * transition begins, so the changeover is between two copies of the same sound (not A alone for one
 * moment, A with B coming in the next). Less for a transition starting sooner into A.
 */
export const TRANSITION_LEAD_SECONDS = 3;

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
/**
 * B's remainder is decoded this much at a time and passed straight on to the encoder, so a long
 * song (a DJ set) never sits whole in memory: about 16 MB per chunk, however long the song. A whole
 * number of samples, and of the seek grid, so the chunks meet exactly.
 */
const REMAINDER_CHUNK_SECONDS = 30;
/**
 * The longest remainder made. Sources that stream decode it in one pass (an MP3 from its start once);
 * the others decode each chunk of an MP3 from the start of the file (that's what makes its start
 * exact), so their work grows with the square of the length: 20 minutes is a few minutes of background
 * work on a NAS; a 60-minute set would hold up every other transition for half an hour. Beyond it B
 * is joined from its own file, as well as the player's seek allows.
 */
const LONGEST_REMAINDER_SECONDS = 20 * 60;
/** How long a forgotten transition's files stay servable: a player may be streaming them right now. */
const DEFAULT_FORGET_GRACE_MS = 10 * 60_000;
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
  /** `tail`: seconds of B after the transition; `lead`: of A before it; `progress`: told how far it's got (see renderTransition). */
  render(plan: TransitionPlan, a: Excerpt, b: Excerpt, tail?: number, lead?: number, progress?: (done: number) => void): Promise<StereoAudio>;
}

/** Stereo audio at RENDER_RATE, a piece at a time (each piece is only valid until the next is asked for). */
export type AudioChunks = AsyncIterable<StereoAudio>;

/**
 * Writes the audio to `file` as FLAC, giving up when `signal` aborts or the audio fails to arrive.
 * Rejects with an error whose `code` is 'ENOENT' when there's no encoder here at all (WAV is written instead).
 */
export type Encoder = (audio: AudioChunks, file: string, signal: AbortSignal) => Promise<void>;

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
  /** How long `forget` leaves the files in place for players still streaming them (default 10 minutes). */
  forgetGraceMs?: number;
  now?: () => number;
}

export interface TransitionRequest {
  fromTrackId: number;
  toTrackId: number;
  mode: MixMode;
  /** Where A's playback is now, in seconds: the plan never starts in the past. */
  aPosition?: number;
  /**
   * The files the player has for the two songs. The library may have picked another file for a song
   * since the queue was saved: a transition from that one wouldn't line up with what's playing.
   */
  fromFileId?: number;
  toFileId?: number;
  /** How long a plain fade lasts (the listener's fade length, in seconds); the planner's own when not given. */
  fadeSeconds?: number;
  /**
   * The queue plays the songs' album: then songs of one album in order follow each other straight on, as
   * recorded. False when they only happen to be in order (a playlist, a mix): they're mixed like any two.
   * Older players don't say: as true.
   */
  albumQueue?: boolean;
  /**
   * Even volume: the gains (dB) the player plays the two songs at (their levelled streams), so the
   * transition between them is at the same levels. Left out (or 0): each at its own volume.
   */
  levels?: { a: number; b: number };
  /** Where to look the two songs up: the asking account's view of the library; the whole library otherwise. */
  library?: Pick<LibraryView, 'track'>;
}

export type TransitionAnswer =
  | {
      status: 'ready';
      plan: TransitionPlan;
      url: string;
      continuationUrl?: string;
      /** Seconds of B after the transition in its file (see TRANSITION_TAIL_SECONDS); none in older files. */
      tail?: number;
      /** Seconds of A before the transition in its file (see TRANSITION_LEAD_SECONDS): the file starts at aStart − lead. None in older files. */
      lead?: number;
      /** The songs' gains (dB) made into the audio (and B's remainder), when they were asked for. */
      levels?: { a: number; b: number };
    }
  | { status: 'pending'; plan: TransitionPlan; render?: RenderProgress }
  | { status: 'straight'; plan: TransitionPlan }
  | { status: 'unavailable'; reason: string };

/**
 * How far a transition being made has got: waiting its turn (behind `ahead` others), decoding the two
 * songs around the mix, mixing them, saving the file, then (for an MP3 next song) saving the rest of it.
 * `done` is the whole job's share done, 0–1, the steps weighted by about how long each takes.
 */
export interface RenderProgress {
  step: 'waiting' | 'decoding' | 'mixing' | 'saving' | 'saving the rest of the next song';
  done: number;
  ahead?: number;
}

/** Each step's share of a render, roughly as long as each takes on a NAS: the mix is most of it. */
const DECODING_SHARE = 0.1;
const MIXING_SHARE = 0.6;
/** Saving the transition: its share when the rest of B is saved too, then that. */
const SAVING_SHARE = 0.1;

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
  /** Seconds of B after the transition in its file; none in files made before tails. */
  tail?: number;
  /** Seconds of A before the transition in its file; none in files made before leads. */
  lead?: number;
  /** The songs' gains (dB) made into the audio; none for songs at their own volume. */
  levels?: { a: number; b: number };
  createdAt: number;
  /** The pair (files and mode) and plan inputs, so a restarted server keeps answering with this plan. */
  pair?: string;
  inputs?: string;
}

interface Job {
  key: string;
  pair: string;
  inputs: string;
  levels?: { a: number; b: number };
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
  private readonly forgetGraceMs: number;
  private readonly now: () => number;
  /** Forgotten transitions whose files are deleted once players are done with them. */
  private readonly forgottenFiles = new Map<string, NodeJS.Timeout>();
  private readonly index = new Map<string, Sidecar>();
  private readonly plans = new Map<string, RememberedPlan>();
  private readonly failures = new Map<string, { until: number; reason: string; recordings: [string, string] }>();
  /** Renders waiting, newest first. */
  private queue: Job[] = [];
  private running: Job | null = null;
  /** How far the job running has got (see RenderProgress). */
  private runningProgress: RenderProgress = { step: 'decoding', done: 0 };
  private idleWaiters: (() => void)[] = [];
  /** ffmpeg turned out not to exist here: transitions are written as WAV from then on. */
  private noEncoder = false;

  constructor(private readonly opts: TransitionsOptions) {
    this.dir = join(opts.cacheDir, 'transitions');
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.encode = opts.encode ?? ffmpegFlacEncoder(opts.ffmpegPath);
    this.decodeTimeoutMs = opts.decodeTimeoutMs ?? DEFAULT_DECODE_TIMEOUT_MS;
    this.renderTimeoutMs = opts.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
    this.forgetGraceMs = opts.forgetGraceMs ?? DEFAULT_FORGET_GRACE_MS;
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

  async request({ fromTrackId, toTrackId, mode, aPosition, fromFileId, toFileId, fadeSeconds, albumQueue, levels: asked, library }: TransitionRequest): Promise<TransitionAnswer> {
    const songs = library ?? this.opts.library;
    const [a, b] = await Promise.all([songs.track(fromTrackId), songs.track(toTrackId)]);
    if (!a || !b) return { status: 'unavailable', reason: 'Unknown song' };
    if ((fromFileId !== undefined && fromFileId !== a.fileId) || (toFileId !== undefined && toFileId !== b.fileId)) {
      return { status: 'unavailable', reason: 'The song’s file changed since it was queued' };
    }
    const recordings: [string, string] = [a.recordingId, b.recordingId];
    const maps = this.opts.maps.mixMaps(recordings);
    const aMap = maps.get(a.recordingId);
    const bMap = maps.get(b.recordingId);
    if (!aMap) return { status: 'unavailable', reason: `No mix map yet for the song playing (“${a.title}”)` };
    if (!bMap) return { status: 'unavailable', reason: `No mix map yet for the next song (“${b.title}”)` };
    const cues = this.opts.maps.cues(recordings);
    const aCues = cues.get(a.recordingId);
    const bCues = cues.get(b.recordingId);
    const sameAlbumInOrder = albumQueue !== false && continuesAlbum(a, b);

    // The plan made for this pair before, while it can still be reached: a later poll (A has
    // played on) would otherwise get a plan that starts later, a new file to render, and never be ready.
    const pair = JSON.stringify([a.fileId, b.fileId, mode]);
    const inputs = hash([PLANNER_VERSION, aMap, aCues ?? null, bMap, bCues ?? null, sameAlbumInOrder, fadeSeconds ?? null]);
    const remembered = this.plans.get(pair);
    const reachable = (plan: TransitionPlan) => plan.aStart >= (aPosition ?? 0) + PLANNING_LEAD;
    let plan: TransitionPlan;
    if (remembered && remembered.inputs === inputs && reachable(remembered.plan)) {
      plan = remembered.plan;
    } else {
      plan = planTransition({ a: { ...aMap, cues: aCues }, b: { ...bMap, cues: bCues }, mode, sameAlbumInOrder, aPosition, fadeSeconds });
      this.remember(pair, { plan, inputs, recordings });
    }
    if (plan.style === 'straight' || plan.length === 0) return { status: 'straight', plan };

    // The plan holds everything the audio depends on (maps, cues and mode went into it) but the levels;
    // the files' sizes stand in for their contents, so a replaced file is rendered again.
    const levels = asked && (asked.a || asked.b) ? { a: asked.a, b: asked.b } : undefined;
    const key = hash([RENDERER_VERSION, a.fileId, a.size, b.fileId, b.size, plan, ...(levels ? [levels] : [])]);
    const cached = await this.cached(key);
    if (cached) return cached;
    this.forgetExpiredFailures();
    const failure = this.failures.get(pair);
    if (failure) return { status: 'unavailable', reason: failure.reason };
    const songLength = (map: MixMap, track: Track) => (Number.isFinite(map.duration) && map.duration > 0 ? map.duration : track.duration);
    this.enqueue({ key, pair, inputs, ...(levels ? { levels } : {}), fromTrackId, a, b, aDuration: songLength(aMap, a), bDuration: songLength(bMap, b), plan });
    const render = this.progressOf(key);
    return { status: 'pending', plan, ...(render ? { render } : {}) };
  }

  /** How far the transition with this key has got: the one being made, or one waiting its turn. */
  private progressOf(key: string): RenderProgress | undefined {
    if (this.running?.key === key) return { ...this.runningProgress };
    const waiting = this.queue.findIndex((job) => job.key === key);
    return waiting < 0 ? undefined : { step: 'waiting', done: 0, ahead: waiting + (this.running ? 1 : 0) };
  }

  /**
   * Forgets every cached transition into or out of a song: its mix map or cue points changed, or it
   * left the library. Renders of it still waiting are dropped too, and one rendering is thrown away.
   * The next request plans afresh at once; the old files stay a while for a player that may be
   * streaming them (a cue edit on the song playing), then go (trim counts them meanwhile).
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
      this.removeLater(key);
    }
  }

  /** The file behind a transition URL's name, or undefined for any name this service doesn't make. */
  filePath(name: string): string | undefined {
    return CACHE_FILE.test(name) ? join(this.dir, name) : undefined;
  }

  /** The two songs (recordings) a transition file joins, for checking who may hear it. */
  recordingsOf(name: string): [string, string] | undefined {
    const sidecar = CACHE_FILE.test(name) ? this.index.get(name.slice(0, 40)) : undefined;
    return sidecar && [sidecar.aRecording, sidecar.bRecording];
  }

  /**
   * Stops: renders still waiting are dropped, forgotten files are left for trim (or the next start),
   * and it resolves once the render under way (if any) has finished writing.
   */
  async close(): Promise<void> {
    for (const timer of this.forgottenFiles.values()) clearTimeout(timer);
    this.forgottenFiles.clear();
    this.queue = [];
    await this.idle();
  }

  /** Resolves once nothing is rendering or waiting (tests, shutdown). */
  idle(): Promise<void> {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Deletes a forgotten transition's files after the grace period, unless it's been made (or is being made) again. */
  private removeLater(key: string) {
    clearTimeout(this.forgottenFiles.get(key));
    const timer = setTimeout(() => {
      this.forgottenFiles.delete(key);
      if (this.index.has(key) || this.running?.key === key) return;
      void this.removeFiles(key).catch((err: unknown) => this.opts.log.warn({ err }, 'forgotten transition not deleted'));
    }, this.forgetGraceMs);
    timer.unref();
    this.forgottenFiles.set(key, timer);
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
      ...(sidecar.tail ? { tail: sidecar.tail } : {}),
      ...(sidecar.lead ? { lead: sidecar.lead } : {}),
      ...(sidecar.levels ? { levels: sidecar.levels } : {}),
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
    this.runningProgress = { step: 'decoding', done: 0 };
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

  private async render({ key, pair, inputs, levels, a, b, aDuration, bDuration, plan }: Job): Promise<Sidecar> {
    // A whole number of samples, so the player's file time and the transition's meet exactly.
    const lead = Math.floor(Math.min(TRANSITION_LEAD_SECONDS, Math.max(0, plan.aStart)) * RENDER_RATE) / RENDER_RATE;
    const ranges = excerptRanges(plan, TRANSITION_TAIL_SECONDS, lead);
    if (!ranges) throw new Error('A straight cut has no transition audio');
    const [aFile, bFile] = await Promise.all([this.opts.library.file(a.fileId), this.opts.library.file(b.fileId)]);
    if (!aFile || !bFile) throw new Error('The song’s file is gone');
    const aSource = { ...this.opts.files.resolve(aFile), track: a, duration: aDuration };
    const bSource = { ...this.opts.files.resolve(bFile), track: b, duration: bDuration };

    // At the levels the player plays the songs at, so the transition sounds as loud as they do.
    const remainderSeconds = bDuration - plan.bResume;
    const withRest = seeksInexactly(b.format) && remainderSeconds <= LONGEST_REMAINDER_SECONDS;
    const saving = withRest ? SAVING_SHARE : 1 - DECODING_SHARE - MIXING_SHARE;
    const step = (name: RenderProgress['step'], from: number, share: number) => (done: number) => {
      this.runningProgress = { step: name, done: from + share * Math.min(1, Math.max(0, done)) };
    };
    const decoding = step('decoding', 0, DECODING_SHARE);
    const aExcerpt = withGain(await this.decode(aSource, ranges.a[0], ranges.a[1]), levels?.a);
    decoding(0.5);
    const bExcerpt = withGain(await this.decode(bSource, ranges.b[0], ranges.b[1]), levels?.b);
    const mixing = step('mixing', DECODING_SHARE, MIXING_SHARE);
    mixing(0);
    const audio = await withTimeout(
      this.opts.dsp.render(plan, aExcerpt, bExcerpt, TRANSITION_TAIL_SECONDS, lead, mixing),
      this.renderTimeoutMs,
      'The render took too long',
    );
    await mkdir(this.dir, { recursive: true });
    const saved = step('saving', DECODING_SHARE + MIXING_SHARE, saving);
    const transitionAudio = await this.writeAudio(() => counted(inPieces(audio), audio.left.length / RENDER_RATE, saved), key, this.renderTimeoutMs);

    // An MP3 can't be started sample-exactly in the middle by a player (see seeksInexactly), so
    // the player plays B's remainder from here, decoded exactly like the transition's B: the
    // two meet at bResume to the sample. A leftover risk on A's side (and B's start, if a player
    // ever plays it): ffmpeg skips the LAME encoder delay and padding the file declares, and a
    // browser that doesn't would hear A shifted by those ~25 ms against the transition.
    let continuation: AudioExtension | undefined;
    if (seeksInexactly(b.format) && remainderSeconds > LONGEST_REMAINDER_SECONDS) {
      this.opts.log.info({ recordingId: b.recordingId, remainderSeconds }, 'remainder too long to make: B joins from its own file');
    } else if (seeksInexactly(b.format)) {
      const chunks = Math.ceil((remainderSeconds + END_SLACK_SECONDS) / REMAINDER_CHUNK_SECONDS);
      const timeoutMs = this.renderTimeoutMs + chunks * this.decodeTimeoutMs;
      const rest = step('saving the rest of the next song', DECODING_SHARE + MIXING_SHARE + SAVING_SHARE, 1 - DECODING_SHARE - MIXING_SHARE - SAVING_SHARE);
      continuation = await this.writeAudio(() => counted(gained(this.remainder(bSource, plan.bResume), levels?.b), remainderSeconds, rest), `${key}.rest`, timeoutMs);
    }
    const sidecar: Sidecar = {
      aRecording: a.recordingId,
      bRecording: b.recordingId,
      plan,
      audio: transitionAudio,
      ...(continuation ? { continuation } : {}),
      tail: TRANSITION_TAIL_SECONDS,
      ...(lead ? { lead } : {}),
      ...(levels ? { levels } : {}),
      createdAt: this.now(),
      pair,
      inputs,
    };
    // Written last: a sidecar means the audio beside it is complete.
    await writeFile(join(this.dir, `${key}.json`), JSON.stringify(sidecar));
    return sidecar;
  }

  /**
   * B from song time `from` to its end, starting exactly at `from`: decoded from the seek grid (the
   * first step at or just before `from`, the samples before it dropped), as one stream where the
   * source can (an MP3 decoded from its start once), else REMAINDER_CHUNK_SECONDS at a time, each
   * chunk starting where the last ended. Either way only a little is held at a time. Throws, once the
   * audio runs out, if it ran out much sooner than the song should have.
   */
  private async *remainder(source: { media: MediaSource; path: string; track: Track; duration: number }, from: number): AudioChunks {
    const { media, path, track, duration } = source;
    if (!media.pcm && !media.pcmStream) throw new Error('This source can’t decode audio');
    // Counted in grid steps (whole numbers), so the chunk starts never drift by a rounding error.
    const firstStep = Math.floor(from * SEEK_GRID_PER_SECOND);
    const stepsPerChunk = REMAINDER_CHUNK_SECONDS * SEEK_GRID_PER_SECOND;
    const end = duration + END_SLACK_SECONDS;
    let skip = Math.round((from - firstStep / SEEK_GRID_PER_SECOND) * RENDER_RATE);
    let decodedSeconds = 0;
    if (media.pcmStream) {
      const start = firstStep / SEEK_GRID_PER_SECOND;
      const stream = media.pcmStream(path, {
        sampleRate: RENDER_RATE,
        channels: 2,
        startSeconds: start,
        maxSeconds: Math.max(SHORTEST_DECODE_SECONDS, end - start),
        exactSeek: seeksInexactly(track.format),
      });
      try {
        // Frames can arrive split across reads: a partial one waits for the rest.
        let pending: Buffer = Buffer.alloc(0);
        for await (const read of stream as AsyncIterable<Buffer>) {
          pending = pending.length ? Buffer.concat([pending, read]) : read;
          const whole = pending.length - (pending.length % PCM_FRAME_BYTES);
          if (!whole) continue;
          const { left, right } = deinterleave(pending.subarray(0, whole));
          pending = pending.subarray(whole);
          decodedSeconds += left.length / RENDER_RATE;
          if (left.length > skip) yield { left: left.subarray(skip), right: right.subarray(skip) };
          skip = Math.max(0, skip - left.length);
        }
      } finally {
        stream.destroy();
      }
    } else {
      yield* this.remainderInChunks(source, firstStep, stepsPerChunk, end, skip, (seconds) => (decodedSeconds += seconds));
    }
    const expected = duration - firstStep / SEEK_GRID_PER_SECOND;
    if (decodedSeconds < expected - SHORT_DECODE_SLACK_SECONDS) {
      throw new Error(`Decoding “${track.title}” stopped ${(expected - decodedSeconds).toFixed(1)} s short`);
    }
  }

  /** The remainder chunk by chunk, for sources that can't stream (see remainder). */
  private async *remainderInChunks(
    source: { media: MediaSource; path: string; track: Track },
    firstStep: number,
    stepsPerChunk: number,
    end: number,
    skip: number,
    decoded: (seconds: number) => void,
  ): AudioChunks {
    const { media, path, track } = source;
    if (!media.pcm) throw new Error('This source can’t decode audio');
    for (let step = firstStep; step / SEEK_GRID_PER_SECOND < end; step += stepsPerChunk) {
      const start = step / SEEK_GRID_PER_SECOND;
      const seconds = Math.min(REMAINDER_CHUNK_SECONDS, end - start);
      const pcm = await media.pcm(path, {
        sampleRate: RENDER_RATE,
        channels: 2,
        startSeconds: start,
        maxSeconds: Math.max(SHORTEST_DECODE_SECONDS, seconds),
        exactSeek: seeksInexactly(track.format),
        signal: AbortSignal.timeout(this.decodeTimeoutMs),
      });
      const { left, right } = deinterleave(pcm);
      // Never more than the chunk's length: anything past it is the next chunk's first samples.
      const wanted = Math.round(seconds * RENDER_RATE);
      const frames = Math.min(left.length, wanted);
      decoded(frames / RENDER_RATE);
      if (frames > skip) yield { left: left.subarray(skip, frames), right: right.subarray(skip, frames) };
      skip = Math.max(0, skip - frames);
      if (frames < wanted) break; // the song ended
    }
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

  /**
   * Writes `<name>.flac`, or `<name>.wav` where there's no ffmpeg; answers which. `audio` makes the
   * audio afresh for each try (a failed encoder may have used some of it up).
   */
  private async writeAudio(audio: () => AudioChunks, name: string, timeoutMs: number): Promise<AudioExtension> {
    if (!this.noEncoder) {
      const tmp = join(this.dir, `${name}.flac.tmp`);
      let encoded = false;
      try {
        await this.encode(audio(), tmp, AbortSignal.timeout(timeoutMs));
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
    await writeWavFile(audio(), tmp);
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

/** Pieces of at most a second, without copying the samples: no buffer made from one is ever large. */
function* bySecond({ left, right }: StereoAudio): Generator<StereoAudio> {
  for (let from = 0; from < left.length; from += CHUNK_FRAMES) {
    yield { left: left.subarray(from, from + CHUNK_FRAMES), right: right.subarray(from, from + CHUNK_FRAMES) };
  }
}

/** `audio` as it is, telling `done` the share of `seconds` that has gone by as each piece is taken. */
async function* counted(audio: AudioChunks, seconds: number, done: (share: number) => void): AudioChunks {
  let taken = 0;
  for await (const piece of audio) {
    yield piece;
    taken += piece.left.length / RENDER_RATE;
    if (seconds > 0) done(taken / seconds);
  }
}

/** Rendered audio, handed to a writer a second at a time. */
async function* inPieces(audio: StereoAudio): AudioChunks {
  yield* bySecond(audio);
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

/** Turns audio by `db` in place (nothing for none); answers the audio. */
function withGain<T extends StereoAudio>(audio: T, db: number | undefined): T {
  if (!db) return audio;
  const g = 10 ** (db / 20);
  for (const channel of [audio.left, audio.right]) for (let i = 0; i < channel.length; i++) channel[i]! *= g;
  return audio;
}

/** Chunks of audio, each turned by `db`. */
async function* gained(chunks: AudioChunks, db: number | undefined): AudioChunks {
  for await (const chunk of chunks) yield withGain(chunk, db);
}

/** Interleaved little-endian float32 (ffmpeg's f32le). */
function f32le({ left, right }: StereoAudio): Buffer {
  const chunk = Buffer.alloc(left.length * 8);
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  for (let i = 0; i < left.length; i++) {
    view.setFloat32(i * 8, left[i]!, true);
    view.setFloat32(i * 8 + 4, right[i]!, true);
  }
  return chunk;
}

/** Interleaved 16-bit little-endian PCM (a WAV file's data). */
function s16le({ left, right }: StereoAudio): Buffer {
  const chunk = Buffer.alloc(left.length * 4);
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const toInt16 = (x: number) => Math.round(Math.max(-1, Math.min(1, x)) * 32767);
  for (let i = 0; i < left.length; i++) {
    view.setInt16(i * 4, toInt16(left[i]!), true);
    view.setInt16(i * 4 + 2, toInt16(right[i]!), true);
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

/**
 * A 16-bit stereo WAV file: what's stored when this server has no ffmpeg to make FLAC. Written as the
 * audio arrives; the header's sizes are filled in at the end, once the length is known.
 */
async function writeWavFile(audio: AudioChunks, file: string): Promise<void> {
  const handle = await open(file, 'w');
  try {
    await handle.write(wavHeader(0));
    let frames = 0;
    for await (const chunk of audio) {
      for (const piece of bySecond(chunk)) {
        await handle.write(s16le(piece));
        frames += piece.left.length;
      }
    }
    await handle.write(wavHeader(frames), 0, 44, 0);
  } finally {
    await handle.close();
  }
}

/** Feeds the audio to ffmpeg a second at a time, waiting whenever its pipe is full. */
async function feed(stdin: Writable, audio: AudioChunks, signal: AbortSignal): Promise<void> {
  for await (const chunk of audio) {
    for (const piece of bySecond(chunk)) {
      if (!stdin.write(f32le(piece))) await once(stdin, 'drain', { signal });
    }
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
      // The audio failing to arrive (a decode of B's remainder broke off) fails the encode too.
      let feedError: unknown;
      child.on('close', (code) => {
        done.abort();
        if (feedError) reject(feedError);
        else if (code === 0) resolve();
        else reject(new Error(`ffmpeg couldn’t encode the transition (${code}): ${stderr.trim()}`));
      });
      feed(child.stdin, audio, done.signal).catch((err: unknown) => {
        if (done.signal.aborted) return; // ffmpeg is already gone, and 'close' or 'error' says why
        feedError = err;
        child.kill();
      });
    });
}
