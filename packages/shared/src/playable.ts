import type { AudioFormat } from './index.ts';

/**
 * Lossless formats some browsers can't play (Chrome and Firefox: Apple Lossless and AIFF), with the type a browser
 * is asked about. For a browser that can't, the server streams songs in these as WAV at `<streamUrl>/lossless.wav`,
 * decoded as they're asked for: still lossless, and seekable.
 */
export const WAV_FALLBACKS = { ALAC: 'audio/mp4; codecs="alac"', AIFF: 'audio/aiff' } as const;
export type WavFallback = keyof typeof WAV_FALLBACKS;

/** Which of WAV_FALLBACKS a file is in, if any (AIFF is told by its container: its codec reads as plain PCM). */
export function wavFallbackOf(format: Pick<AudioFormat, 'codec' | 'container'>): WavFallback | undefined {
  if (['aif', 'aiff'].includes(format.container.toLowerCase())) return 'AIFF';
  return format.codec.toUpperCase() === 'ALAC' ? 'ALAC' : undefined;
}
