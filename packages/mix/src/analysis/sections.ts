// Where a song can be mixed in and out: its intro and outro (a steady beat with little else, which a
// DJ blends over another song), its first drop, whether it starts or ends on full sound, and where
// its sound ends. Also a check on the bar grid from downbeats.ts: section changes in dance music
// land on phrase lines, so where the energy jumps says something about where the phrases start.

import type { BeatGrid } from './beatGrid.ts';
import { barAccents, isBassTie, phraseEnergyFrom, type Downbeats } from './downbeats.ts';
import { ONSET_FRAME, ONSET_HOP, type Onsets } from './onset.ts';

export interface Sections {
  /**
   * Start (s) of the first phrase that isn't mostly sparse beats: where the intro ends. When the
   * first phrase is already full, this is the music's first downbeat (no intro to mix over).
   */
  introEnd: number;
  /**
   * End (s) of the last phrase that isn't mostly sparse beats: where the outro starts. When the
   * song is full to the end, this is where the last full phrase ends, at most `soundEnd`.
   */
  outroStart: number;
  /** Start (s) of the first phrase louder than the one before by at least 0.35 of the loudest phrase. */
  firstDrop?: number;
  /** The first sounding beat is about as loud as the main part of the song: no intro or fade-in. */
  coldStart: boolean;
  /** The last sounding beat is about as loud as the main part of the song, and not faded out. */
  coldEnd: boolean;
  /** Where the sound ends, before any trailing silence (s); 0 for silence. */
  soundEnd: number;
  /** 0–1: how sure the bar starts are; low means the planner shouldn't trust phrase alignment. */
  downbeatConfidence: number;
  /**
   * The bar position to use: the one from `downbeats`, unless its bass accents barely decided and
   * the section changes clearly sit on another one's phrase lines.
   */
  downbeatOffset: number;
  /** Phrase energy for that bar position (the same as `downbeats` gave when it is unchanged). */
  phraseEnergy: number[];
}

type Frames = Pick<Onsets, 'fps' | 'onset' | 'rms' | 'lowEnergy' | 'energy'>;

const BEATS_PER_BAR = 4;
const BEATS_PER_PHRASE = 16;
/** A frame's window covers this many hops; its centre lies half of it after its index. */
const FRAME_HOPS = ONSET_FRAME / ONSET_HOP;
const FRAME_CENTRE = FRAME_HOPS / 2;
/** Frames either side of a beat searched for its kick (as in downbeats.ts). */
const KICK_HALF_WIDTH = 2;

/**
 * A beat with less mid/high "fill" than this share of the song's full fill is sparse (if it has a
 * kick). "Full" is the upper quartile rather than the median: in a dance edit the intro and outro
 * can be half the song, and then the median is intro material itself.
 */
const SPARSE_FILL_SHARE = 0.35;
const FULL_PERCENTILE = 0.75;
/** A beat has a kick when its bass peak is above this share of the song's typical (90th pct) kick. */
const KICK_GATE_SHARE = 0.1;
/** A phrase with at least this share of sparse beats is intro or outro. */
const SPARSE_PHRASE_SHARE = 0.75;
/** A phrase this much louder (as a share of the loudest phrase) than the one before is a drop. */
const DROP_RISE = 0.35;
/** A last, partial phrase this short can't be a drop (as in downbeats.ts). */
const MIN_LAST_PHRASE_BEATS = 8;
/**
 * "Full sound" for cold starts and ends: at least this share of the song's upper-quartile beat
 * loudness (upper quartile for the same reason as the fill).
 */
const COLD_SHARE = 0.6;
/**
 * A beat is audible (part of the music rather than the edge of a frame hearing a neighbour, or the
 * first whisper of a fade-in) at this share of the upper-quartile loudness: −20 dB.
 */
const AUDIBLE_SHARE = 0.1;
/** The last bars falling this much from first to last, bar after bar, is a fade-out. */
const FADE_BARS = 4;
const FADE_DROP = 0.85;
/** Frames quieter than this share of the song's loud (95th pct) frames, or than the floor, are silence. */
const SILENCE_SHARE = 0.01;
const SILENCE_FLOOR = 1e-4;

/** A loudness step of at least this ratio between consecutive bars is a section change. */
const SECTION_JUMP = Math.log(1.5);
/** Bass margin (best over second-best accent, as a share of the best) that counts as fully sure. */
const SURE_BASS_MARGIN = 0.25;
/** Onset accents are weaker evidence than bass: their margin counts this much when the bass ties. */
const ONSET_MARGIN_WEIGHT = 0.5;
/** How far section changes on the phrase lines can lift the confidence toward 1… */
const SECTION_WEIGHT = 0.7;
/** …and how far changes on another bar position's phrase lines can pull it down. */
const CONTRADICTION_WEIGHT = 0.5;
/** Below this bass confidence, section changes may move the bar… */
const WEAK_BASS = 0.5;
/** …when another bar position's section score beats the chosen one's by this much. */
const SECTION_OVERRIDE = 0.5;
/** Section changes needed for full weight: one change could be chance. */
const SECTION_CHANGES_FOR_FULL_WEIGHT = 2;

/** Per grid beat, what the section analysis needs. */
interface Beat {
  /**
   * Mean full-band RMS of the frames whose window starts at the beat (give or take a hop, for the
   * grid's error) and ends by the next: how loud it is, without hearing the next beat's attack.
   */
  loudness: number;
  /** Peak bass power around the beat: the kick. */
  kick: number;
  /**
   * Mean mid/high power (above ~150 Hz) of the frames that lie wholly between this beat and the
   * next, so the kick's and the next kick's attacks don't count: the chords, pads and vocals.
   */
  fill: number;
}

/**
 * Finds the sections of a song from one `analyzeOnsets` pass, its `beatGrid` and its `downbeats`.
 *
 * Each beat is *sparse* when it has a kick but little else (mid/high fill under 35% of the song's
 * full fill); a phrase of mostly sparse beats is intro or outro. Intro, outro and drop snap to
 * phrase edges because that's where a DJ starts and ends a blend. Phrases here count 16 beats from
 * the first downbeat *of the music*: after seconds of leading silence, the grid's first downbeat
 * can be in the silence, and phrases counted from there would cut the music's phrases in half.
 */
export function sections(frames: Frames, grid: Pick<BeatGrid, 'bpm' | 'firstBeat'>, found: Downbeats, duration: number): Sections {
  const silence = silenceGate(frames.rms);
  const soundEnd = lastSound(frames, silence);
  const beats = beatsOf(frames, grid, duration);
  const nothing: Sections = {
    introEnd: 0,
    outroStart: soundEnd,
    coldStart: false,
    coldEnd: false,
    soundEnd,
    downbeatConfidence: 0,
    downbeatOffset: found.downbeatOffset,
    phraseEnergy: found.phraseEnergy,
  };
  const fullLoudness = percentile(
    beats.map((b) => b.loudness),
    FULL_PERCENTILE,
  );
  const audible = Math.max(silence, AUDIBLE_SHARE * fullLoudness);
  const sounding = beats.filter((b) => b.loudness > audible);
  if (sounding.length < BEATS_PER_BAR) return nothing;

  const period = 60 / grid.bpm;
  const musicStart = beats.findIndex((b) => b.loudness > audible);
  // The first beat at or after the music starts that is a downbeat for bar position `offset`.
  const anchorOf = (offset: number) => musicStart + mod(offset - musicStart, BEATS_PER_BAR);
  const check = checkBar(frames, grid, duration, beats, audible, anchorOf, found.downbeatOffset);
  const downbeatOffset = check.offset;
  const phraseEnergy =
    downbeatOffset === found.downbeatOffset ? found.phraseEnergy : phraseEnergyFrom(frames, grid, downbeatOffset, duration);
  const anchor = anchorOf(downbeatOffset);
  const phraseStart = (k: number) => round(grid.firstBeat + (anchor + k * BEATS_PER_PHRASE) * period);

  const phrases = phrasesOf(beats, anchor, audible);
  const dense = phrases.map((p) => p.dense);
  const firstDense = dense.indexOf(true);
  const lastDense = dense.lastIndexOf(true);
  const introEnd = firstDense < 0 ? phraseStart(0) : phraseStart(firstDense);
  const outroStart = lastDense < 0 ? soundEnd : Math.min(soundEnd, phraseStart(lastDense + 1));

  const loudest = Math.max(...phrases.map((p) => p.loudness)) || 1;
  const rise = phrases.findIndex((p, k) => k > 0 && (p.loudness - phrases[k - 1]!.loudness) / loudest >= DROP_RISE);

  const fullSound = COLD_SHARE * fullLoudness;
  const coldStart = sounding[0]!.loudness >= fullSound;
  const coldEnd = sounding.at(-1)!.loudness >= fullSound && !fadesOut(sounding);

  return {
    introEnd,
    outroStart,
    ...(rise > 0 ? { firstDrop: phraseStart(rise) } : {}),
    coldStart,
    coldEnd,
    soundEnd,
    downbeatConfidence: round(check.confidence),
    downbeatOffset,
    phraseEnergy,
  };
}

/** Loudness, kick and fill of every grid beat that starts before the song (or the frames) end. */
function beatsOf(frames: Frames, grid: Pick<BeatGrid, 'bpm' | 'firstBeat'>, duration: number): Beat[] {
  const { fps, rms, lowEnergy, energy } = frames;
  if (!(grid.bpm > 0) || !rms.length) return [];
  const period = 60 / grid.bpm;
  const end = Math.min(duration, (rms.length + FRAME_CENTRE) / fps);
  const beats: Beat[] = [];
  for (let t = grid.firstBeat; t < end; t += period) {
    // Frame f's window covers frames-worth of time [f, f + FRAME_HOPS). Windows from the beat's
    // attack to the next beat for its loudness; windows strictly after the attack for its fill. At
    // a tempo too fast for any such window, the frames centred in the beat.
    const lastInside = Math.min(rms.length, Math.floor((t + period) * fps - FRAME_HOPS) + 1);
    const centredFrom = Math.max(0, Math.ceil(t * fps - FRAME_CENTRE));
    const centredTo = Math.min(rms.length, Math.ceil((t + period) * fps - FRAME_CENTRE));
    let [from, to] = [Math.max(0, Math.ceil(t * fps - 1)), lastInside];
    if (to <= from) [from, to] = [centredFrom, centredTo];
    let [fillFrom, fillTo] = [Math.max(0, Math.floor(t * fps) + 1), lastInside];
    if (fillTo <= fillFrom) [fillFrom, fillTo] = [centredFrom, centredTo];
    let fill = 0;
    for (let f = fillFrom; f < fillTo; f++) fill += Math.max(0, energy[f]! - lowEnergy[f]!);
    beats.push({
      loudness: meanOf(rms, from, to),
      kick: peak(lowEnergy, t * fps - FRAME_CENTRE, KICK_HALF_WIDTH),
      fill: fillTo > fillFrom ? fill / (fillTo - fillFrom) : 0,
    });
  }
  return beats;
}

/**
 * Each phrase from beat `anchor`: whether it is full (not intro or outro material: it has audible
 * beats and fewer than 75% of them are sparse), and its mean beat loudness — the same measure as
 * `phraseEnergy`, but on phrases that start with the music. Beats before the anchor (silence, a
 * pickup) belong to no phrase; a last phrase shorter than 8 beats counts only for density.
 */
function phrasesOf(beats: Beat[], anchor: number, audible: number): { dense: boolean; loudness: number }[] {
  const sounding = beats.filter((b) => b.loudness > audible);
  const fullFill = percentile(
    sounding.map((b) => b.fill),
    FULL_PERCENTILE,
  );
  const kickGate = KICK_GATE_SHARE * percentile(
    sounding.map((b) => b.kick),
    0.9,
  );
  const sparse = (b: Beat) => b.kick > kickGate && b.fill < SPARSE_FILL_SHARE * fullFill;

  const phrases: { dense: boolean; loudness: number }[] = [];
  for (let start = anchor; start < beats.length; start += BEATS_PER_PHRASE) {
    const all = beats.slice(start, start + BEATS_PER_PHRASE);
    const phrase = all.filter((b) => b.loudness > audible);
    const sparseShare = phrase.length ? phrase.filter(sparse).length / phrase.length : 1;
    const loudness = all.length >= MIN_LAST_PHRASE_BEATS ? all.reduce((s, b) => s + b.loudness, 0) / all.length : 0;
    phrases.push({ dense: sparseShare < SPARSE_PHRASE_SHARE, loudness });
  }
  return phrases;
}

/** The last bars of the song get quieter bar after bar, ending well below where they began. */
function fadesOut(sounding: Beat[]): boolean {
  const last = sounding.slice(-FADE_BARS * BEATS_PER_BAR);
  if (last.length < FADE_BARS * BEATS_PER_BAR) return false;
  const bars = Array.from({ length: FADE_BARS }, (_, i) => {
    const bar = last.slice(i * BEATS_PER_BAR, (i + 1) * BEATS_PER_BAR);
    return bar.reduce((s, b) => s + b.loudness, 0) / bar.length;
  });
  const falling = bars.every((v, i) => i === 0 || v < bars[i - 1]!);
  return falling && bars.at(-1)! < FADE_DROP * bars[0]!;
}

/**
 * How sure the bar grid is, and whether to move it.
 *
 * The bass margin is how far the chosen bar position's bass accent stands above the next best (as
 * downbeats.ts decides it; the onset margin, at half weight, when the bass tied). Section changes —
 * a bar at least 1.5× louder or quieter than the one before — count for a bar position when they
 * land on its phrase lines (half when only on its bar lines); with two or more changes all on the
 * chosen phrase lines, the confidence rises toward 1, and changes clearly on another position's
 * lines lower it. If the bass barely decided and the sections clearly favour another position,
 * that one wins: a four-to-the-floor kick says little about where the bar starts, a drop says a lot.
 */
function checkBar(
  frames: Frames,
  grid: Pick<BeatGrid, 'bpm' | 'firstBeat'>,
  duration: number,
  beats: Beat[],
  audible: number,
  anchorOf: (offset: number) => number,
  chosen: number,
): { offset: number; confidence: number } {
  const accents = barAccents(frames, grid, duration);
  const section = sectionScores(beats, audible, anchorOf);
  const bassConfidence = (offset: number) => {
    if (!accents) return 0;
    const { low, onset } = accents;
    const others = [0, 1, 2, 3].filter((o) => o !== offset);
    const secondLow = Math.max(...others.map((o) => low[o]!));
    const margin = (values: number[], second: number) => (values[offset]! - second) / (values[offset]! || 1);
    const bass = isBassTie(low[offset]!, secondLow)
      ? ONSET_MARGIN_WEIGHT * margin(onset, Math.max(...others.map((o) => onset[o]!)))
      : margin(low, secondLow);
    return clamp(bass / SURE_BASS_MARGIN);
  };
  const confidenceOf = (offset: number) => {
    const rival = Math.max(...[0, 1, 2, 3].filter((o) => o !== offset).map((o) => section[o]!));
    const lifted = 1 - (1 - bassConfidence(offset)) * (1 - SECTION_WEIGHT * section[offset]!);
    return clamp(lifted * (1 - CONTRADICTION_WEIGHT * Math.max(0, rival - section[offset]!)));
  };

  let offset = chosen;
  if (bassConfidence(chosen) < WEAK_BASS) {
    const best = [0, 1, 2, 3].reduce((a, b) => (section[b]! > section[a]! ? b : a), chosen);
    if (section[best]! - section[chosen]! >= SECTION_OVERRIDE) offset = best;
  }
  return { offset, confidence: confidenceOf(offset) };
}

/**
 * For each bar position 0–3, how much of the song's section changes land on its phrase lines
 * (every 16 beats from its first downbeat in the music; half credit on its other bar lines), scaled down when there is only
 * one change to go on. A change is a beat where the mean loudness of the bar starting there differs
 * from the bar before by 1.5× or more, and more than at the beats either side.
 */
function sectionScores(beats: Beat[], audible: number, anchorOf: (offset: number) => number): number[] {
  const level = beats.map((b) => Math.log(b.loudness));
  const sounding = beats.map((b) => b.loudness > audible);
  const step = beats.map((_, b) => {
    if (b < BEATS_PER_BAR || b + BEATS_PER_BAR > beats.length) return 0;
    // Only steps between music and music: the edges of the song are not section changes.
    for (let i = b - BEATS_PER_BAR; i < b + BEATS_PER_BAR; i++) if (!sounding[i]) return 0;
    let before = 0;
    let after = 0;
    for (let i = 0; i < BEATS_PER_BAR; i++) {
      before += level[b - BEATS_PER_BAR + i]!;
      after += level[b + i]!;
    }
    return Math.abs(after - before) / BEATS_PER_BAR;
  });
  const changes = step
    .map((s, b) => ({ s, b }))
    .filter(({ s, b }) => s >= SECTION_JUMP && s > (step[b - 1] ?? 0) && s >= (step[b + 1] ?? 0));
  const total = changes.reduce((sum, c) => sum + c.s, 0);
  if (!total) return [0, 0, 0, 0];
  const weight = Math.min(1, changes.length / SECTION_CHANGES_FOR_FULL_WEIGHT);
  return [0, 1, 2, 3].map((offset) => {
    let support = 0;
    for (const { s, b } of changes) {
      const fromAnchor = b - anchorOf(offset);
      if (mod(fromAnchor, BEATS_PER_PHRASE) === 0) support += s;
      else if (mod(fromAnchor, BEATS_PER_BAR) === 0) support += s / 2;
    }
    return (support / total) * weight;
  });
}

/** Frame RMS below which a frame is silence: 1% (−40 dB) of the song's loud frames, at least 1e-4. */
function silenceGate(rms: Float64Array): number {
  const loud = percentile(Array.from(rms), 0.95);
  return Math.max(SILENCE_FLOOR, SILENCE_SHARE * loud);
}

/**
 * Where the sound ends (s): the end of the last hop-long slice of audio louder than the silence
 * gate; 0 when nothing is. Frames are four hops long, so a frame only tells where sound ends to
 * within ~93 ms; but each frame's energy is its four slices' energies, so the energy of a slice is
 * its frame's minus the next frame's plus the slice four hops later. Working back from the
 * silence at the end recovers the slices of the tail to within one hop (~23 ms).
 */
function lastSound(frames: Pick<Onsets, 'fps' | 'rms'>, silence: number): number {
  const { fps, rms } = frames;
  const n = rms.length;
  let last = n - 1;
  while (last >= 0 && !(rms[last]! > silence)) last--;
  if (last < 0) return 0;
  // Sounding to the very last frame: the sound runs to the end of what the frames cover.
  if (last === n - 1) return round((n - 1 + FRAME_HOPS) / fps);

  const frameEnergy = (f: number) => rms[f]! ** 2 * ONSET_FRAME;
  const slice = new Float64Array(n + FRAME_HOPS);
  // The last frame's slices can't be told apart (nothing follows it): spread its energy evenly.
  for (let k = n - 1; k < n - 1 + FRAME_HOPS; k++) slice[k] = frameEnergy(n - 1) / FRAME_HOPS;
  for (let k = n - 2; k >= last; k--) slice[k] = Math.max(0, frameEnergy(k) - frameEnergy(k + 1) + slice[k + FRAME_HOPS]!);
  const gate = silence ** 2 * ONSET_HOP;
  for (let k = n - 2 + FRAME_HOPS; k >= last; k--) if (slice[k]! > gate) return round((k + 1) / fps);
  return round((last + FRAME_CENTRE) / fps);
}

/** The value at fraction `p` (0–1) of the sorted values (nearest rank); 0 for none. */
function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]!;
}

/** The largest value within `halfWidth` frames of the (fractional) frame `x`. */
function peak(values: Float64Array, x: number, halfWidth: number): number {
  const centre = Math.round(x);
  let best = 0;
  for (let i = Math.max(0, centre - halfWidth); i <= Math.min(values.length - 1, centre + halfWidth); i++) {
    best = Math.max(best, values[i]!);
  }
  return best;
}

function meanOf(values: Float64Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += values[i]!;
  return to > from ? sum / (to - from) : 0;
}

const mod = (n: number, m: number) => ((n % m) + m) % m;
const clamp = (v: number) => Math.min(1, Math.max(0, v));
const round = (v: number) => Math.round(v * 1000) / 1000;
