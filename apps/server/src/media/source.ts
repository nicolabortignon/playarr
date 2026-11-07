import type { AudioFormat, ByteRange } from '@playarr/shared';
import { spawn } from 'node:child_process';
import { posix } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { lowPriority } from '../lowPriority.ts';

export interface FileStat {
  size: number;
  mtimeMs: number;
}

export type { ByteRange };

/** Where audio bytes come from: local disk in production, SSH/SFTP from a dev machine. */
export interface MediaSource {
  readonly kind: 'none' | 'local' | 'sftp' | 'ssh' | 'smb';
  stat(path: string): Promise<FileStat>;
  open(path: string, range?: ByteRange): Promise<Readable>;
  /** Throws with a human-readable message if the source is unusable. */
  check(probePath?: string): Promise<void>;
  /** Decode a file to s16le PCM (mono unless asked for stereo) with ffmpeg, where the files live. Absent if this source can't. */
  pcm?(path: string, opts: PcmOptions): Promise<Buffer>;
  /** Decode as pcm does, handing the audio on as it comes: for whole songs, and for what someone listens to. */
  pcmStream?(path: string, opts: PcmStreamOptions): Readable;
  /**
   * Decode and encode with ffmpeg where the files are, handing on the encoded audio as it comes: ADTS for AAC,
   * Ogg for Opus (media/encoded.ts makes the stream from it). Absent if this source can't.
   */
  encodedStream?(path: string, opts: EncodeOptions): Readable;
  close(): Promise<void>;
}

/** What encodedStream encodes (see encodeInput in media/encoded.ts, which works it out). */
export interface EncodeOptions {
  codec: 'aac' | 'opus';
  kbps: number;
  /** Start decoding this many seconds in, before decoding (a time the format seeks to exactly). */
  seekSeconds?: number;
  /** Samples (44.1 kHz) decoded and dropped before the first one encoded. */
  skipSamples: number;
  /** Samples of silence encoded before the decoded audio. */
  leadSamples: number;
  /** Samples (44.1 kHz) encoded in all: silence made up where the song comes up short, the rest cut off. */
  samples: number;
  /** Turn the audio up or down by this many dB (even volume). */
  gainDb?: number;
  /** 'low' (the default) for work nobody is waiting on; 'normal' for what someone listens to. */
  priority?: 'low' | 'normal';
  signal?: AbortSignal;
}

/** The bitrates (kbps) an encode may ask for. */
const ENCODE_KBPS = new Set([128, 256]);

/** Refuse anything but sane numbers, as checkPcmOptions does: they end up on a command line (over SSH too). */
function checkEncodeOptions({ codec, kbps, seekSeconds, skipSamples, leadSamples, samples, gainDb }: EncodeOptions): void {
  if (codec !== 'aac' && codec !== 'opus') throw new RangeError(`Invalid codec: ${String(codec)}`);
  if (!ENCODE_KBPS.has(kbps)) throw new RangeError(`Invalid bitrate: ${kbps}`);
  if (seekSeconds !== undefined && !(Number.isFinite(seekSeconds) && seekSeconds >= 0)) throw new RangeError(`Invalid seek: ${seekSeconds}`);
  for (const [name, n] of [['skipSamples', skipSamples], ['leadSamples', leadSamples]] as const) {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`Invalid ${name}: ${n}`);
  }
  if (!Number.isInteger(samples) || samples <= 0) throw new RangeError(`Invalid samples: ${samples}`);
  if (gainDb !== undefined && !(Number.isFinite(gainDb) && Math.abs(gainDb) <= MAX_GAIN_DB)) throw new RangeError(`Invalid gain: ${gainDb}`);
}

/**
 * ffmpeg arguments that decode `path` and encode it, the encoded audio on stdout. Everything happens at
 * 44.1 kHz in the filters, sample by sample: resampled first, then the samples before the stream's first
 * dropped (`atrim`), the silence before the song's start put in (`adelay`), the gain applied, and the length made
 * exact (`apad` then `atrim`), so the encoder is fed exactly `samples` samples whatever the decode gives. A seek
 * (`-ss` before `-i`) only ever goes to a time the format seeks to exactly; `atrim` does the rest.
 *
 * AAC is ffmpeg's own encoder (always there), as ADTS; Opus is libopus at a constant bitrate, as Ogg. The output
 * is bitexact (no version strings), so the same file and arguments always encode to the same bytes.
 */
export function ffmpegEncodeArgs(path: string, opts: EncodeOptions): string[] {
  checkEncodeOptions(opts);
  const { codec, kbps, seekSeconds, skipSamples, leadSamples, samples, gainDb } = opts;
  const filters = [
    'aresample=44100',
    ...(skipSamples ? [`atrim=start_sample=${skipSamples}`] : []),
    ...(leadSamples ? [`adelay=${leadSamples}S:all=1`] : []),
    ...(gainDb ? [`volume=${Number(gainDb.toFixed(2))}dB`] : []),
    `apad=whole_len=${samples}`,
    `atrim=end_sample=${samples}`,
  ];
  const encoder =
    codec === 'aac'
      ? ['-c:a', 'aac', '-b:a', `${kbps}k`, '-f', 'adts']
      : ['-c:a', 'libopus', '-b:a', `${kbps}k`, '-vbr', 'off', '-application', 'audio', '-frame_duration', '20', '-ar', '48000', '-f', 'ogg'];
  return [
    ...['-hide_banner', '-loglevel', 'error', '-nostdin'],
    ...(seekSeconds ? ['-ss', seconds(seekSeconds)] : []),
    ...['-i', path],
    ...['-map', '0:a:0', '-vn', '-sn', '-dn'],
    ...['-af', filters.join(',')],
    ...['-ac', '2'],
    ...encoder,
    ...['-fflags', '+bitexact', '-flags:a', '+bitexact', '-'],
  ];
}

export interface PcmOptions {
  sampleRate: number;
  /** Decode at most this many seconds (from the start, from `startSeconds`, or the last ones with `fromEnd`). */
  maxSeconds: number;
  /**
   * Start decoding this many seconds into the file. The transition renderer uses it to pull
   * an exact section out of the middle of a song without decoding everything before it.
   */
  startSeconds?: number;
  /**
   * Decode the last `maxSeconds` of the file instead of the first. The analyzer needs a song's
   * ending to plan the mix out of it, and long songs would otherwise never get there.
   * Can't be combined with `startSeconds`.
   */
  fromEnd?: boolean;
  /**
   * Seek by decoding from the start and throwing away everything before `startSeconds`, rather than
   * jumping in the container. Slower, but exact for formats whose seeking is an estimate (MP3 has no
   * index, so a jump lands only roughly where asked): the transition renderer needs the sample asked for.
   */
  exactSeek?: boolean;
  /** 1 for analysis (the default, smallest), 2 when rendering audio people will hear. */
  channels?: 1 | 2;
  /** 16-bit samples (the default), or 24 to keep a hi-res file's own depth. */
  bits?: 16 | 24;
  /** Turn the audio up or down by this many dB as it's decoded (even volume). */
  gainDb?: number;
  signal?: AbortSignal;
}

/** The loudest and quietest a decode is turned: more is a mistake, not a song's level. */
const MAX_GAIN_DB = 24;

export interface PcmStreamOptions extends PcmOptions {
  /** 'low' (the default) for background work; 'normal' for audio someone is listening to. */
  priority?: 'low' | 'normal';
}

/**
 * Formats that can't be started sample-exactly in the middle. MP3 has no index: a seek is an
 * estimate from the bitrate (or a 100-entry table in VBR files), so a player or ffmpeg jumping into
 * one lands only near the time asked. The others Playarr plays seek exactly: FLAC by its frames
 * and seek table, AAC/ALAC in MP4 by the sample tables, Ogg Vorbis/Opus by granule positions.
 * Decode those with `exactSeek` when the position must be exact.
 */
export function seeksInexactly(format: AudioFormat): boolean {
  return format.codec.toUpperCase() === 'MP3' || format.container.toLowerCase() === 'mp3';
}

/**
 * Seconds as a plain decimal ffmpeg understands. Rounded to the microsecond (a sample is 23 µs at
 * 44.1 kHz) so tiny values never turn into exponent notation like "1e-7", which ffmpeg would reject.
 */
function seconds(value: number): string {
  return String(Number(value.toFixed(6)));
}

/**
 * Refuse anything but sane numbers. These end up on an ffmpeg command line (over SSH too, where
 * they're shell-quoted along with everything else), so a NaN or a negative must never get through.
 */
function checkPcmOptions({ sampleRate, maxSeconds, startSeconds, fromEnd, exactSeek, channels, bits, gainDb }: PcmOptions): void {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError(`Invalid sample rate: ${sampleRate}`);
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) throw new RangeError(`Invalid maxSeconds: ${maxSeconds}`);
  if (startSeconds !== undefined && (!Number.isFinite(startSeconds) || startSeconds < 0)) {
    throw new RangeError(`Invalid startSeconds: ${startSeconds}`);
  }
  if (startSeconds !== undefined && fromEnd) throw new RangeError('startSeconds and fromEnd cannot be combined');
  if (exactSeek && fromEnd) throw new RangeError('exactSeek and fromEnd cannot be combined');
  if (channels !== undefined && channels !== 1 && channels !== 2) throw new RangeError(`Invalid channels: ${channels}`);
  if (bits !== undefined && bits !== 16 && bits !== 24) throw new RangeError(`Invalid bits: ${bits}`);
  if (gainDb !== undefined && !(Number.isFinite(gainDb) && Math.abs(gainDb) <= MAX_GAIN_DB)) throw new RangeError(`Invalid gain: ${gainDb}`);
}

/**
 * ffmpeg arguments that decode `path` to s16le PCM on stdout (s24le with `bits: 24`).
 *
 * Seeking (`-ss` / `-sseof`) goes before `-i` so ffmpeg jumps in the container instead of
 * decoding and throwing away everything before; for audio it still decodes accurately from
 * the requested point. `-t` stays even with `-sseof`: it is harmless there and still caps the
 * output if the file is shorter than `maxSeconds` (ffmpeg then just starts at the beginning).
 * With `exactSeek`, `-ss` and `-t` go after `-i` instead: ffmpeg decodes from the start and
 * drops what comes before, so the first sample out is exactly the one asked for.
 */
export function ffmpegPcmArgs(path: string, opts: PcmOptions): string[] {
  checkPcmOptions(opts);
  const { sampleRate, maxSeconds, startSeconds, fromEnd, exactSeek, channels = 1, bits = 16, gainDb } = opts;
  const seek = startSeconds !== undefined ? ['-ss', seconds(startSeconds)] : fromEnd ? ['-sseof', `-${seconds(maxSeconds)}`] : [];
  const length = ['-t', seconds(maxSeconds)];
  const input = ['-i', path];
  return [
    ...['-hide_banner', '-loglevel', 'error', '-nostdin'],
    ...(exactSeek ? [...input, ...seek, ...length] : [...seek, ...length, ...input]),
    ...(gainDb ? ['-af', `volume=${Number(gainDb.toFixed(2))}dB`] : []),
    ...['-vn', '-ac', String(channels), '-ar', String(sampleRate), '-f', `s${bits}le`, '-'],
  ];
}

/**
 * Runs ffmpeg on this machine to decode `input` (a path, or a URL ffmpeg can read), the audio handed
 * on as it comes. The stream fails if ffmpeg does, and ffmpeg stops as soon as the stream is closed
 * (the listener went away).
 */
export function ffmpegPcmStream(ffmpeg: string, input: string, opts: PcmStreamOptions): Readable {
  return ffmpegStream(ffmpeg, ffmpegPcmArgs(input, opts), opts);
}

/** Runs ffmpeg on this machine to encode `input` (a path, or a URL ffmpeg can read), as ffmpegPcmStream decodes. */
export function ffmpegEncodedStream(ffmpeg: string, input: string, opts: EncodeOptions): Readable {
  return ffmpegStream(ffmpeg, ffmpegEncodeArgs(input, opts), opts);
}

/** An ffmpeg asked to stop that's still running after this long is killed outright. */
const KILL_AFTER_MS = 1000;

/** ffmpeg's stdout as a stream that fails if ffmpeg does, and stops ffmpeg as soon as it's closed. */
function ffmpegStream(ffmpeg: string, args: string[], opts: { priority?: 'low' | 'normal'; signal?: AbortSignal }): Readable {
  const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal });
  if (opts.priority !== 'normal') lowPriority(child);
  const out = new PassThrough();
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
  child.stdout.pipe(out, { end: false });
  child.on('error', (err) => out.destroy(err));
  child.on('close', (code) => {
    if (code === 0) out.end();
    else out.destroy(new Error(`ffmpeg: ${stderr.trim() || `exit code ${code}`}`));
  });
  out.on('close', () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    // ffmpeg finishes the write it's in before it heeds SIGTERM, and with nobody reading (an encode paused ahead of
    // its listeners) that write never ends: closing the pipe ends it (ffmpeg ignores SIGPIPE, and stops on the error).
    child.stdout.destroy();
    child.kill();
    const kill = setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'), KILL_AFTER_MS);
    kill.unref();
    child.once('exit', () => clearTimeout(kill));
  });
  return out;
}

/**
 * Most PCM bytes we'll collect from one ffmpeg run. A stereo 44.1 kHz s16le section of 150 s
 * is 44100 × 2 × 2 × 150 ≈ 26.5 MB; this leaves plenty of room above that.
 */
export const PCM_MAX_BUFFER = 96 * 1024 * 1024;

export class MediaUnavailableError extends Error {}

export class NoMediaSource implements MediaSource {
  readonly kind = 'none' as const;
  private fail(): never {
    throw new MediaUnavailableError(
      'Audio streaming is not configured. Set MEDIA_SOURCE (local, sftp or ssh) in .env.',
    );
  }
  async stat(): Promise<FileStat> {
    this.fail();
  }
  async open(): Promise<Readable> {
    this.fail();
  }
  async check() {
    this.fail();
  }
  async close() {}
}

/** Translate a Lidarr path to the path Playarr should read, via the first matching prefix. */
export function mapPath(lidarrPath: string, pathMap: [string, string][]): string {
  for (const [from, to] of pathMap) {
    const prefix = from.endsWith('/') ? from : `${from}/`;
    if (lidarrPath === from || lidarrPath.startsWith(prefix)) {
      return posix.normalize(to + lidarrPath.slice(from.length));
    }
  }
  return posix.normalize(lidarrPath);
}
