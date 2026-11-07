import type { Track } from '@playarr/shared';
import { playableUrl } from './playable';
import { usePrefs, type Quality } from './prefs';

/**
 * Stream quality (Settings → Playback → Streaming quality): a song's own file, or the server's encoded stream of
 * it, AAC in fragmented MP4 at High (256 kbps) or Normal (128 kbps), made as it's asked for, from any sample on
 * (docs/server/streaming-and-art.md, Encoded streams).
 */

/** The encoded qualities' bitrates (kbps). */
export const QUALITY_KBPS = { high: 256, normal: 128 } as const satisfies Record<Exclude<Quality, 'original'>, number>;
/** The rate encoded streams are made at, and count `start` in. */
const STREAM_RATE = 44_100;
/**
 * The bytes an encoded stream declares for its length, per byte of its bitrate: the server allows the encoder 20%
 * over its bitrate, and 16 KiB more, padding what it doesn't use (media/encoded.ts on the server).
 */
const DECLARED_MARGIN = 1.2;
const DECLARED_SLACK = 16 * 1024;

/** Better first: a copy kept at a quality at least as good as the one wanted will do. */
const RANK: Record<Quality, number> = { original: 2, high: 1, normal: 0 };
export const atLeast = (have: Quality, want: Quality) => RANK[have] >= RANK[want];

interface NetworkInfo extends EventTarget {
  type?: string;
  saveData?: boolean;
}
const connection = (): NetworkInfo | undefined =>
  typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { connection?: NetworkInfo }).connection;

/**
 * The browser says the connection is metered: mobile data (Chrome on Android), or Data Saver on. Other browsers
 * (Safari, Firefox, Chrome on a computer) don't say: their connection counts as Wi-Fi.
 */
export function metered(): boolean {
  const c = connection();
  return !!c && (c.saveData === true || c.type === 'cellular');
}

/** This browser says what kind of connection it's on, so mobile data's quality can apply (Chrome on Android). */
export function tellsMobileData(): boolean {
  return typeof connection()?.type === 'string';
}

/** The quality songs stream at on this connection. */
export function streamQuality(prefs: { wifiQuality: Quality; cellularQuality: Quality } = usePrefs.getState()): Quality {
  return metered() ? prefs.cellularQuality : prefs.wifiQuality;
}

type Encodable = Pick<Track, 'streamUrl' | 'size' | 'duration' | 'format'>;

/** The song's own file's bitrate (kbps), as its format says or its size gives. */
function fileKbps(t: Encodable): number {
  if (t.format?.bitrate) return t.format.bitrate;
  return t.duration > 0 && t.size > 0 ? (t.size * 8) / t.duration / 1000 : Infinity;
}

/**
 * The song comes encoded at `quality`: not at Original, not where the server can't encode it (a song not
 * streamed from /stream/), and not a file already about that small: an MP3 at 128 kbps plays as it is at
 * Normal, as encoding it again would only lose quality.
 */
export function encodes(t: Encodable, quality: Quality): quality is Exclude<Quality, 'original'> {
  if (quality === 'original' || !t.streamUrl?.startsWith('/stream/')) return false;
  return QUALITY_KBPS[quality] * 1.25 < fileKbps(t);
}

/**
 * The song's encoded stream at `kbps`: from `start` seconds into the song on (to the sample), and leveled at
 * `gainDb` when asked.
 */
export function encodedUrl(t: Pick<Track, 'streamUrl'>, kbps: number, { start = 0, gainDb }: { start?: number; gainDb?: number } = {}): string {
  const sample = Math.round(start * STREAM_RATE);
  const query = [...(gainDb !== undefined ? [`gain=${gainDb}`] : []), `kbps=${kbps}`, ...(sample > 0 ? [`start=${sample}`] : [])];
  return `${t.streamUrl}/${gainDb !== undefined ? 'levelled.aac' : 'aac'}?${query.join('&')}`;
}

/** Where a stream from `start` seconds on begins: the sample it's asked from. */
export const encodedOffset = (start: number) => Math.round(start * STREAM_RATE) / STREAM_RATE;

/** Where a song is kept on this device at `quality`: its own file (as this browser plays it), or its encoded stream. */
export function keptUrl(t: Encodable & Pick<Track, 'format'>, quality: Quality): string {
  return encodes(t, quality) ? encodedUrl(t, QUALITY_KBPS[quality]) : playableUrl(t);
}

/** The quality of a song's copy, by its address. */
export function qualityOfUrl(url: string): Quality {
  const kbps = /\/aac\?(?:[^#]*&)?kbps=(\d+)/.exec(url)?.[1];
  return kbps === String(QUALITY_KBPS.high) ? 'high' : kbps === String(QUALITY_KBPS.normal) ? 'normal' : 'original';
}

/** How many bytes a song takes at `quality`: its own file's size, or at most what its encoded stream declares. */
export function sizeAt(t: Encodable, quality: Quality): number {
  if (!encodes(t, quality)) return t.size;
  return Math.ceil(t.duration * QUALITY_KBPS[quality] * 125 * DECLARED_MARGIN) + DECLARED_SLACK;
}

/**
 * Safari, and every browser on an iPhone or iPad: WebKit, which plays through AVFoundation. It places an encoded
 * stream's samples exactly where the song's own file has them (measured: docs/server/streaming-and-art.md).
 */
export function isAppleWebKit(): boolean {
  return typeof navigator !== 'undefined' && /^Apple/.test(navigator.vendor ?? '');
}

/**
 * An encoded stream lines up with a DJ transition to the sample in this browser: WebKit (Safari, every iPhone
 * browser) places its samples exactly where the song's own file has them (measured, docs/server/streaming-and-art.md).
 * Elsewhere it isn't measured, so DJ mix plays songs' own files there (see playQuality).
 */
export const encodedJoinsExact = () => isAppleWebKit();

/**
 * The quality songs play (and are kept) at here: `base` (this connection's streaming quality, or the
 * downloads'), unless DJ mix needs songs' own files to join on the beat (see encodedJoinsExact).
 */
export function playQuality(base: Quality = streamQuality()): Quality {
  return base !== 'original' && usePrefs.getState().transitions === 'dj' && !encodedJoinsExact() ? 'original' : base;
}
