// A song's loudness phrase by phrase, over all of it. The mix analysis decodes a long song's beginning
// and end in full (where it's mixed in and out); its middle only needs measuring for how loud it is,
// which the server streams through `LoudnessFrames` without holding the audio.

import { ONSET_FRAME, ONSET_HOP } from './onset.ts';
import { BEATS_PER_PHRASE, FRAME_CENTRE, MIN_BEAT_SOUND, MIN_LAST_PHRASE_BEATS } from './shared.ts';

/**
 * Each frame's loudness (the RMS of ONSET_FRAME samples, every ONSET_HOP), exactly as analyzeOnsets
 * measures `rms`, from audio fed in pieces of any length.
 */
export class LoudnessFrames {
  private carry = new Float32Array(0);
  private readonly rms: number[] = [];

  push(samples: Float32Array) {
    const audio = new Float32Array(this.carry.length + samples.length);
    audio.set(this.carry);
    audio.set(samples, this.carry.length);
    let f = 0;
    for (; f * ONSET_HOP + ONSET_FRAME <= audio.length; f++) {
      let sumSq = 0;
      for (let i = f * ONSET_HOP; i < f * ONSET_HOP + ONSET_FRAME; i++) sumSq += audio[i]! * audio[i]!;
      this.rms.push(Math.sqrt(sumSq / ONSET_FRAME));
    }
    this.carry = audio.slice(f * ONSET_HOP);
  }

  frames(): Float64Array {
    return Float64Array.from(this.rms);
  }
}

/** Frame loudness for a stretch of a song: frame f is centred FRAME_CENTRE frames after `start` + f/fps; counted from `from` to `to`. */
export interface LoudnessStretch {
  start: number;
  rms: ArrayLike<number>;
  from: number;
  to: number;
}

/**
 * Energy 0–1 of each 16-beat phrase of the song from `firstPhrase`, relative to the loudest, from the
 * stretches measured (each frame counted where its stretch says). A phrase none of them reached is
 * null. Phrases run to `soundEnd`; a last, partial phrase counts when at least 8 of its beats have sound.
 */
export function songPhraseEnergy(stretches: LoudnessStretch[], fps: number, firstPhrase: number, period: number, soundEnd: number): (number | null)[] {
  if (!(period > 0) || !(soundEnd > firstPhrase)) return [];
  const phraseSeconds = BEATS_PER_PHRASE * period;
  const whole = Math.floor((soundEnd - firstPhrase) / phraseSeconds);
  const lastBeats = Math.ceil((soundEnd - MIN_BEAT_SOUND - firstPhrase - whole * phraseSeconds) / period);
  const count = whole + (lastBeats >= MIN_LAST_PHRASE_BEATS ? 1 : 0);
  const sums = new Float64Array(count);
  const counts = new Float64Array(count);
  for (const { start, rms, from, to } of stretches) {
    for (let f = 0; f < rms.length; f++) {
      const t = start + (f + FRAME_CENTRE) / fps;
      if (t < from || t >= to || t >= soundEnd) continue;
      const k = Math.floor((t - firstPhrase) / phraseSeconds);
      if (k < 0 || k >= count) continue;
      sums[k]! += rms[f]!;
      counts[k]!++;
    }
  }
  const energy = Array.from(sums, (s, k) => (counts[k] ? s / counts[k]! : null));
  const loudest = Math.max(0, ...energy.map((e) => e ?? 0));
  if (!loudest) return [];
  return energy.map((e) => (e === null ? null : Math.round((e / loudest) * 1000) / 1000));
}
