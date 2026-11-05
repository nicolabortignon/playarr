import { WAV_FALLBACKS, wavFallbackOf, type Track, type WavFallback } from '@playarr/shared';

let unplayable: Set<WavFallback> | undefined;

/** The lossless formats this browser can't play (Chrome and Firefox: Apple Lossless, AIFF). */
export function unplayableFormats(audio: Pick<HTMLAudioElement, 'canPlayType'> = document.createElement('audio')): Set<WavFallback> {
  unplayable ??= new Set((Object.keys(WAV_FALLBACKS) as WavFallback[]).filter((format) => !audio.canPlayType(WAV_FALLBACKS[format])));
  return unplayable;
}

/**
 * Where to fetch a song this browser can play: the file itself, or for a format it can't, the server's WAV of it
 * (lossless, seekable). Its own address, so a copy of the file kept on the device never stands in for it.
 */
export function playableUrl(track: Pick<Track, 'streamUrl'> & { format?: Track['format'] }): string {
  const fallback = track.format && wavFallbackOf(track.format);
  return fallback && unplayableFormats().has(fallback) ? `${track.streamUrl}/lossless.wav` : track.streamUrl;
}
