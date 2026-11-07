import type { Track } from '@playarr/shared';
import { playableUrl } from '../lib/playable';
import { encodedOffset, encodedUrl, encodes, playQuality, QUALITY_KBPS } from '../lib/quality';
import type { QueueState } from './decks';
import { graphGain, levelledUrl, streamGain } from './levels';
import { keptCopy } from './offline';

/** Songs whose encoded stream wouldn't play this session (a server that doesn't encode, an encode that failed): their own file. */
const unencoded = new Set<number>();

/** The encoded stream of this song failed: its own file from now on. */
export function encodedStreamFailed(t: Track) {
  unencoded.add(t.fileId);
}

/** Where a deck plays a song from, and how its level is set (see AudioEngine's load). */
export interface StreamChoice {
  url: string;
  /** Seconds into the song where the file starts: a stream asked for from a time on. */
  offset: number;
  /** The gain (dB) made into the audio: a levelled stream's (phones and tablets). */
  baked?: number;
  /** The gain (dB) Web Audio plays it at on a desktop. */
  graph?: number;
  /** The bitrate of an encoded stream from the server (not a kept copy): a seek past what it has loaded asks for it from there. */
  encoded?: number;
}

/**
 * Where to play a song from, `at` seconds into it: a copy kept on this device if one will do (offline any;
 * online one as good as wanted), else the server's stream at the quality songs play at here: the song's
 * own file, or its encoded stream from `at` on (not when `encode` is false: its encoded stream wouldn't play
 * just now). Even volume: on a desktop Web Audio's gain, elsewhere the levelled stream (encoded at High and
 * Normal, uncompressed at Original).
 */
export function chooseStream(t: Track, s: QueueState, at = 0, encode = true): StreamChoice {
  const graph = graphGain(t, s);
  const withGraph = graph !== undefined ? { graph } : {};
  const quality = playQuality();
  const kept = keptCopy(t, quality);
  if (kept) return { url: kept, offset: 0, ...withGraph };
  const baked = streamGain(t, s);
  if (encode && encodes(t, quality) && !unencoded.has(t.fileId)) {
    const kbps = QUALITY_KBPS[quality];
    const url = encodedUrl(t, kbps, { start: at, ...(baked !== undefined ? { gainDb: baked } : {}) });
    return { url, offset: encodedOffset(at), encoded: kbps, ...(baked !== undefined ? { baked } : {}), ...withGraph };
  }
  if (baked !== undefined) return { url: levelledUrl(t, baked), offset: 0, baked };
  return { url: playableUrl(t), offset: 0, ...withGraph };
}

/** The song streams encoded here now: a stream from any time on, which a remainder file needn't stand in for. */
export const streamsEncoded = (t: Track, s: QueueState) => chooseStream(t, s).encoded !== undefined;
