import { PCM_COOKIE, WAV_FALLBACKS, type WavFallback } from '@playarr/shared';

/**
 * Tells the server which lossless formats this browser can't play (Chrome and Firefox: Apple Lossless, AIFF), so it
 * streams songs in those to it as WAV. In a cookie: <audio>, and the offline cache's fetches, send it with every
 * request for a song.
 */
export function declareUnplayableFormats(audio: Pick<HTMLAudioElement, 'canPlayType'> = document.createElement('audio')) {
  const unplayable = (Object.keys(WAV_FALLBACKS) as WavFallback[]).filter((format) => !audio.canPlayType(WAV_FALLBACKS[format]));
  document.cookie = unplayable.length
    ? `${PCM_COOKIE}=${unplayable.join('.')}; path=/; max-age=31536000; samesite=lax`
    : `${PCM_COOKIE}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; samesite=lax`;
}
