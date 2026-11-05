import type { AudioFormat } from './index.ts';

/**
 * Lossless formats some browsers can't play (Chrome and Firefox: Apple Lossless and AIFF), with the type a browser
 * is asked about. The server streams songs in these as WAV, decoded as they're asked for, to a browser that lists
 * them in PCM_COOKIE: still lossless, and seekable.
 */
export const WAV_FALLBACKS = { ALAC: 'audio/mp4; codecs="alac"', AIFF: 'audio/aiff' } as const;
export type WavFallback = keyof typeof WAV_FALLBACKS;

/** The cookie in which a browser lists, joined by dots, the WAV_FALLBACKS it can't play. */
export const PCM_COOKIE = 'playarr_pcm';

/** Which of WAV_FALLBACKS a file is in, if any (AIFF is told by its container: its codec reads as plain PCM). */
export function wavFallbackOf(format: Pick<AudioFormat, 'codec' | 'container'>): WavFallback | undefined {
  if (['aif', 'aiff'].includes(format.container.toLowerCase())) return 'AIFF';
  return format.codec.toUpperCase() === 'ALAC' ? 'ALAC' : undefined;
}
