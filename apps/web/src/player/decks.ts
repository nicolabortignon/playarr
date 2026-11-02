import type { Track, TrackLevel } from '@playarr/shared';
import type { PlaySource, RepeatMode } from './store';

export type QueueState = { queue: Track[]; order: number[]; pos: number; repeat: RepeatMode };

/** The song that plays when this one ends on its own; none with repeat-one (the song restarts). */
export function upNext(s: QueueState): Track | undefined {
  if (s.pos < 0 || s.repeat === 'one') return undefined;
  if (s.pos + 1 < s.order.length) return s.queue[s.order[s.pos + 1]!];
  return s.repeat === 'all' && s.order.length > 1 ? s.queue[s.order[0]!] : undefined;
}

/** `b` is the song after `a` on the same album: the two are heard as one, never faded into each other. */
export function continues(a: Track | undefined, b: Track | undefined): boolean {
  if (!a || !b || a.albumId !== b.albumId) return false;
  return (b.discNumber === a.discNumber && b.trackNumber === a.trackNumber + 1) || (b.discNumber === a.discNumber + 1 && b.trackNumber === 1);
}

/**
 * The queue plays `a`'s album (or its artist's albums, which come whole and in order): there, songs of
 * the album in order are heard as one. Elsewhere (a playlist, a mix) they only happen to be in order,
 * and DJ mix mixes them like any two. A queue saved before its source was kept counts as the album.
 */
export function playsAlbum(source: PlaySource | undefined, a: Track): boolean {
  return !source || source.href === `/albums/${a.albumId}` || source.href === `/artists/${a.artistId}`;
}

/** How long `a`'s end and `b`'s start overlap: none within an album, never more than a third of either song. */
export function fadeSeconds(a: Track | undefined, b: Track | undefined, crossfade: number): number {
  if (!a || !b || !crossfade || continues(a, b)) return 0;
  return Math.min(crossfade, a.duration / 3, b.duration / 3);
}

/**
 * How much to turn a song (dB) so it's as loud as the others. Within an album played in order the
 * album's level applies, so its quiet songs stay quiet next to its loud ones.
 */
export function levelDb(track: Track, level: TrackLevel, s: QueueState): number {
  const at = s.order.findIndex((i, p) => Math.abs(p - s.pos) <= 2 && s.queue[i]?.fileId === track.fileId);
  const before = at > 0 ? s.queue[s.order[at - 1]!] : undefined;
  const after = at >= 0 ? s.queue[s.order[at + 1]!] : undefined;
  const inAlbum = continues(before, track) || continues(track, after);
  return inAlbum && level.album !== undefined ? level.album : level.track;
}

/**
 * How much to play a song at by its element's volume (0–1), for a song playing its own file: only
 * down, as an element can't go above full volume (its levelled stream turns quiet songs up).
 */
export function levelGain(track: Track, level: TrackLevel | undefined, s: QueueState): number {
  return level ? Math.min(1, 10 ** (levelDb(track, level, s) / 20)) : 1;
}

/** Equal-power fade: `x` from 0 (silent) to 1 (full). */
export const fadeCurve = (x: number) => Math.sin((Math.max(0, Math.min(1, x)) * Math.PI) / 2);

let volumeWorks: boolean | undefined;
/** iPhones and iPads fix the volume of audio at the hardware buttons: no fades or levelling there. */
export function canSetVolume(): boolean {
  if (volumeWorks === undefined) {
    const probe = new Audio();
    probe.volume = 0.5;
    volumeWorks = probe.volume === 0.5;
  }
  return volumeWorks;
}

/**
 * A desktop browser (mouse or trackpad, not a phone or tablet). Only there does Web Audio play on with the
 * page in the background: iPhones, iPads and Android phones suspend it when the screen locks, so there the
 * sound must stay in the <audio> elements, which the system keeps playing. iPads ask for desktop pages
 * (as a Mac), but have a touch screen.
 */
export function isDesktop(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) return false;
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return false;
  return typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
}

let silence: string | undefined;
/** A tenth of a second of silence, to let a player make sound later without a tap (see AudioEngine). */
export function silentClip(): string {
  if (silence) return silence;
  const rate = 8000;
  const samples = rate / 10;
  const buf = new DataView(new ArrayBuffer(44 + samples));
  const text = (at: number, s: string) => [...s].forEach((c, i) => buf.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  buf.setUint32(4, 36 + samples, true);
  text(8, 'WAVEfmt ');
  buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true); // PCM
  buf.setUint16(22, 1, true); // mono
  buf.setUint32(24, rate, true);
  buf.setUint32(28, rate, true);
  buf.setUint16(32, 1, true);
  buf.setUint16(34, 8, true);
  text(36, 'data');
  buf.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) buf.setUint8(44 + i, 128);
  silence = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  return silence;
}
