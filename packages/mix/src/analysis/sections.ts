// Where a song can be mixed in and out: its intro and outro (a steady beat with little else, which a
// DJ blends over another song), its first drop, whether it starts or ends on full sound, and where
// its sound ends. Also a check on the bar and phrase grid: section changes in dance music land on
// phrase lines, so where the energy jumps says something about where the bars and phrases start.

import type { BeatGrid } from './beatGrid.ts';
import { barAccents, isBassTie, phraseEnergyFrom, type BarAccents, type BarFrames, type Downbeats } from './downbeats.ts';
import { ONSET_LATENCY_FRAMES, type Onsets } from './onset.ts';
import {
  BEATS_PER_BAR,
  BEATS_PER_PHRASE,
  FRAME_CENTRE,
  FRAME_HOPS,
  MIN_BEAT_SOUND,
  MIN_LAST_PHRASE_BEATS,
  mod,
  peak,
  percentile,
  round,
  silenceGate,
  soundEndOf,
} from './shared.ts';

export interface Sections {
  /**
   * Start (s) of the first phrase that isn't mostly sparse beats: where the intro ends. When the
   * first phrase is already full, this is the music's first phrase start (no intro to mix over).
   * Never after `outroStart`.
   */
  introEnd: number;
  /**
   * End (s) of the last phrase that isn't mostly sparse beats: where the outro starts. When the
   * song is full to the end, this is where the last full phrase ends, at most `soundEnd`.
   */
  outroStart: number;
  /** Start (s) of the first phrase louder than the one before by at least 0.35 of the loudest phrase. */
  firstDrop?: number;
  /** The first sounding beat is full sound (as loud as the main part, and more than a kick): no intro or fade-in. */
  coldStart: boolean;
  /** The last sounding beat is full sound, and the song doesn't fade out to it: it ends abruptly. */
  coldEnd: boolean;
  /** Where the sound ends, before any trailing silence (s); 0 for silence. */
  soundEnd: number;
  /**
   * 0–1: how sure the bar *and phrase* starts are (the bar's confidence times the phrase's); low
   * means the planner shouldn't trust phrase alignment.
   */
  downbeatConfidence: number;
  /**
   * The bar position to use: the one from `downbeats`, unless its bass accents barely decided and
   * the section changes clearly sit on another one's phrase lines.
   */
  downbeatOffset: number;
  /** Energy 0–1 per 16-beat phrase from `firstPhrase`, relative to the loudest phrase. */
  phraseEnergy: number[];
  /**
   * Time (s) of the music's first phrase start: the phrases above count 16 beats from here. Without
   * enough music to count from, the grid's first downbeat.
   */
  firstPhrase: number;
  /** The song's main groove (see Groove), for measuring another stretch of it against; none without phrases. */
  mainGroove?: Groove;
}

/**
 * How a phrase grooves: the median kick, bass line and loudness of its beats. The main part of a song
 * has all three near their usual levels; an intro or outro lacks at least one (no bass line yet, a
 * filtered kick, everything quieter), even when it has pads or chords.
 */
export interface Groove {
  kick: number;
  bass: number;
  loudness: number;
}

type Frames = BarFrames & Pick<Onsets, 'energy' | 'onset'>;

/** Frames either side of a beat searched for its kick (as in downbeats.ts). */
const KICK_HALF_WIDTH = 2;

/**
 * "Full" levels are the upper quartile of the song's beats rather than the median: in a dance edit
 * the intro and outro can be half the song, and then the median is intro material itself. It fails
 * when more than three quarters of the beats are sparse (a DJ tool that is all kick and hats: its
 * "full" fill is itself sparse, so nothing is called sparse) and can misjudge a song whose last
 * verse or chorus is much quieter than the rest (its last beats aren't "full sound", so no cold end).
 */
const FULL_PERCENTILE = 0.75;
/** A beat with less mid/high "fill" than this share of the song's full fill is sparse (if it has a kick). */
const SPARSE_FILL_SHARE = 0.35;
/** A beat has a kick when its bass peak is above this share of the song's typical (90th pct) kick. */
const KICK_GATE_SHARE = 0.1;
/**
 * A beat without a kick whose strongest onset is under this share of the song's median beat onset
 * has nothing starting in it: a held pad or a chord ringing out, however loud. Measured: a held pad
 * ~0.005 of the median, piano-like chord stabs ~0.25 (the median rather than a high percentile,
 * which snare hits dominate).
 */
const ATTACK_GATE_SHARE = 0.05;
/** A phrase with at least this share of sparse beats (among those that count) is intro or outro. */
const SPARSE_PHRASE_SHARE = 0.75;
/** …and one with fewer beats that count than a bar is too: one loud chord doesn't make a phrase full. */
const MIN_COUNTED_BEATS = 4;
/** A phrase this much louder (as a share of the loudest phrase) than the one before is a drop. */
const DROP_RISE = 0.35;
/**
 * "Full sound" for cold starts and ends: at least this share of the song's upper-quartile beat
 * loudness. Also the line under which a beat without a kick is an edge beat (a ringing last chord,
 * a quiet pad before the beat comes in): neither intro/outro material nor the main part.
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
/** Without a beat grid, cold edges are judged on half-second slices, as if at 120 BPM. */
const SLICE_GRID = { bpm: 120, firstBeat: 0 };
/** A song's main groove: each of its phrases' levels at this percentile (most of a song is its main part). */
const MAIN_PERCENTILE = 0.8;
/**
 * A phrase is in the main groove when its kick and bass line are within 6 dB of the main groove's and
 * its loudness within 4 dB: an intro with pads but no bass line, or a lighter, filtered kick, isn't.
 */
const MAIN_KICK_SHARE = 10 ** (-6 / 10);
const MAIN_BASS_SHARE = 10 ** (-6 / 10);
const MAIN_LOUDNESS_SHARE = 10 ** (-4 / 20);
/**
 * Out of the main groove but with a kick within 12 dB of its: still beat-led, an intro or outro to
 * mix over. A phrase with less (a piano or vocal opening) is music to hear, not to mix over.
 */
const LED_KICK_SHARE = 10 ** (-12 / 10);
/**
 * Intros and outros found by their groove are at most this many phrases (64 beats, a club intro's
 * length). More is a song whose verses are lighter than its choruses (pop, disco): its "main groove"
 * is its loudest part, and the verses aren't intro.
 */
const MAX_GROOVE_PHRASES = 4;
/**
 * The last phrases of a song that is ending (fading out, a last hit ringing out) aren't a groove: the
 * outro is looked for before them, and runs on through them. Ending: this much quieter than the main
 * groove (12 dB), or quieter than it (see MAIN_LOUDNESS_SHARE) with its beat gone (see LED_KICK_SHARE).
 */
const ENDING_SHARE = 10 ** (-12 / 20);

/** A loudness step of at least this ratio between consecutive bars is a section change. */
const SECTION_JUMP = Math.log(1.5);
/** A bar needs this many audible beats for its loudness to count toward a section change. */
const MIN_SOUNDING_IN_BAR = 3;
/** Bass margin (best over second-best accent, as a share of the best) that counts as fully sure. */
const SURE_BASS_MARGIN = 0.25;
/** Bass onset accents are weaker evidence than bass level: their margin counts this much on a tie. */
const ONSET_MARGIN_WEIGHT = 0.5;
/** How far section changes on the phrase lines can lift the bar's confidence toward 1… */
const SECTION_WEIGHT = 0.7;
/** …and how far changes on another bar position's phrase lines can pull it down. */
const CONTRADICTION_WEIGHT = 0.5;
/** Below this bass confidence, section changes may move the bar… */
const WEAK_BASS = 0.5;
/** …when another bar position's section score beats the chosen one's by this much. */
const SECTION_OVERRIDE = 0.5;
/** Section changes needed for full weight: one change could be chance. */
const SECTION_CHANGES_FOR_FULL_WEIGHT = 2;
/**
 * The music's first downbeat is the phrase start to go by when nothing else says otherwise. How
 * much to trust it: fully when the music starts cleanly (its first beat about as loud as the rest
 * of its first two bars), half when it fades or creeps in, where the first audible beat says little
 * about where the phrase began.
 */
const CLEAN_START_SHARE = 0.5;
const UNSURE_START_TRUST = 0.5;

/** Per grid beat, what the section analysis needs. */
interface Beat {
  /**
   * Mean full-band RMS of the frames whose window starts at the beat (give or take a hop, for the
   * grid's error) and ends by the next beat or by the end of the sound, whichever is first: how
   * loud it is, without hearing the next beat's attack or the silence after a last hit.
   */
  loudness: number;
  /** Peak bass power around the beat: the kick. */
  kick: number;
  /** The strongest onset anywhere in the beat: whether anything (a note, a drum) starts in it. */
  attack: number;
  /**
   * Mean mid/high power (above ~150 Hz) of the frames that lie wholly between this beat and the
   * next, so the kick's and the next kick's attacks don't count: the chords, pads and vocals.
   */
  fill: number;
  /** Mean bass power (below ~150 Hz) over the beat's second half, once its kick has died away: the bass line. */
  bass: number;
}

/** A beat where the song's loudness steps up or down by at least 1.5×, and by how much (log ratio). */
interface Change {
  beat: number;
  step: number;
}

/**
 * Finds the sections of a song from one `analyzeOnsets` pass, its `beatGrid` and its `downbeats`.
 *
 * Each audible beat is one of three kinds: *sparse* when it has a kick but little else (mid/high
 * fill under 35% of the song's full fill), an *edge* beat when it has no kick and either is quieter
 * than full sound or has nothing starting in it (a pad before the beat comes in, a last chord
 * ringing out), and full otherwise. A phrase that is 75% or more sparse (edge beats not counted),
 * or has fewer than four beats that count, is intro or outro. A loud intro without a kick but with
 * notes starting in it (a vocal or piano opening) is full: the planner skips what comes before the
 * mix-in point, and that would cut it. Intro, outro and drop snap to phrase edges, because that's where a DJ starts and
 * ends a blend.
 *
 * Phrases count from the music's first phrase start: after leading silence, a phrase counted from
 * the grid's first downbeat could cut the music's phrases in half. Of the four downbeats a phrase
 * could start on, the one most section changes land 16 beats apart from wins; with no such
 * evidence, the music's first downbeat. A fade-in or a quiet intro shifts the first audible beat, but
 * not the drop. `phraseLine`, when given, is a time known to start a phrase (measured on another
 * stretch of the same song, e.g. its beginning when this is its last minutes): phrases then count
 * from the first beat on that line's 16-beat grid at or after the music starts, and the bar follows.
 */
export function sections(
  frames: Frames,
  grid: Pick<BeatGrid, 'bpm' | 'firstBeat'>,
  found: Downbeats,
  duration: number,
  phraseLine?: number,
  /**
   * The bar is known (the beat model's): `found.downbeatOffset` stays, and this 0–1 takes the place of
   * the bass accents' confidence. Section changes still lift or lower it, and still place the phrase.
   */
  knownBar?: { confidence: number },
  /** The song's main groove, measured elsewhere in it (its beginning, when this is its last minutes). */
  mainGroove?: Groove,
): Sections {
  const silence = silenceGate(frames.rms);
  const soundEnd = Math.min(soundEndOf(frames, silence), Math.max(0, duration));
  const hasGrid = grid.bpm > 0 && Number.isFinite(grid.bpm) && Number.isFinite(grid.firstBeat);
  const beats = beatsOf(frames, hasGrid ? grid : SLICE_GRID, soundEnd);
  const fullLoudness = percentile(beats.map((b) => b.loudness), FULL_PERCENTILE);
  const audible = Math.max(silence, AUDIBLE_SHARE * fullLoudness);
  const sounding = beats.filter((b) => b.loudness > audible);
  const fullSound = COLD_SHARE * fullLoudness;
  const kinds = beatKinds(sounding, audible, fullSound);
  // Full sound: as loud as the main part of the song, and more than a kick.
  const isFull = (b: Beat | undefined) => b !== undefined && b.loudness >= fullSound && !kinds.thin(b);
  const coldStart = isFull(sounding[0]);
  const coldEnd = isFull(sounding.at(-1)) && !fadesOut(sounding);

  const period = 60 / grid.bpm;
  // The grid beat index of the given phrase line, if any.
  const lineBeat = phraseLine !== undefined && hasGrid ? Math.round((phraseLine - grid.firstBeat) / period) : undefined;
  const givenOffset = lineBeat === undefined ? undefined : mod(lineBeat, BEATS_PER_BAR);
  if (!hasGrid || sounding.length < BEATS_PER_BAR) {
    const offset = givenOffset ?? found.downbeatOffset;
    return {
      introEnd: 0,
      outroStart: soundEnd,
      coldStart,
      coldEnd,
      soundEnd,
      downbeatConfidence: 0,
      downbeatOffset: offset,
      phraseEnergy: found.phraseEnergy,
      firstPhrase: hasGrid ? round(grid.firstBeat + offset * period) : 0,
    };
  }

  const isSounding = beats.map((b) => b.loudness > audible);
  const musicStart = isSounding.indexOf(true);
  // The first beat at or after the music starts that is a downbeat for bar position `offset`.
  const anchorOf = (offset: number) => musicStart + mod(offset - musicStart, BEATS_PER_BAR);
  const changes = sectionChanges(beats, isSounding);
  const accents = found.accents ?? barAccents(frames, grid, duration);
  const bar = checkBar(accents, changes, anchorOf, givenOffset ?? found.downbeatOffset, givenOffset === undefined && !knownBar, knownBar?.confidence);
  const downbeatOffset = bar.offset;
  const phrase =
    lineBeat === undefined
      ? choosePhrase(beats, changes, musicStart, anchorOf(downbeatOffset), audible)
      : { anchor: musicStart + mod(lineBeat - musicStart, BEATS_PER_PHRASE), confidence: 1 };
  const { anchor } = phrase;
  const phraseStart = (k: number) => round(grid.firstBeat + (anchor + k * BEATS_PER_PHRASE) * period);

  const phrases = phrasesOf(beats, anchor, kinds);
  const dense = phrases.map((p) => p.dense);
  const firstDense = dense.indexOf(true);
  const lastDense = dense.lastIndexOf(true);
  // Intro and outro: sparse phrases, and beat-led phrases out of the main groove, whichever reach further.
  const grooves = groovesOf(beats, anchor);
  const main = mainGroove ?? mainGrooveOf(grooves);
  const mixable = (g: Groove | undefined) =>
    !!g &&
    !!main &&
    g.kick >= LED_KICK_SHARE * main.kick &&
    !(g.kick >= MAIN_KICK_SHARE * main.kick && g.bass >= MAIN_BASS_SHARE * main.bass && g.loudness >= MAIN_LOUDNESS_SHARE * main.loudness);
  let leading = 0;
  while (leading < grooves.length && mixable(grooves[leading])) leading++;
  // A last phrase too short to judge goes with the one before it.
  const whole = grooves.length - (grooves.at(-1) === undefined ? 1 : 0);
  // The song ending (a fade out) after its outro: the outro is the beat-led phrases before it.
  const ending = (g: Groove | undefined) =>
    !!g &&
    !!main &&
    (g.loudness < ENDING_SHARE * main.loudness || (g.loudness < MAIN_LOUDNESS_SHARE * main.loudness && g.kick < LED_KICK_SHARE * main.kick));
  let beforeEnding = whole;
  while (beforeEnding > leading && ending(grooves[beforeEnding - 1])) beforeEnding--;
  let trailing = beforeEnding;
  while (trailing > leading && mixable(grooves[trailing - 1])) trailing--;
  // No main groove at all (all intro, say): nothing to go by.
  const grooved = trailing > leading;
  let outroStart = lastDense < 0 ? soundEnd : Math.min(soundEnd, phraseStart(lastDense + 1));
  if (grooved && trailing < beforeEnding && beforeEnding - trailing <= MAX_GROOVE_PHRASES) outroStart = Math.min(outroStart, phraseStart(trailing));
  // A song fading out can be left from where the fade begins, at the latest: the next one comes in as it fades.
  if (grooved && beforeEnding < whole) outroStart = Math.min(outroStart, phraseStart(beforeEnding));
  let introEnd = firstDense < 0 ? phraseStart(0) : phraseStart(firstDense);
  if (grooved && leading > 0 && leading <= MAX_GROOVE_PHRASES) introEnd = Math.max(introEnd, phraseStart(leading));
  introEnd = Math.min(outroStart, introEnd);

  const loudest = Math.max(...phrases.map((p) => p.loudness)) || 1;
  const rise = phrases.findIndex((p, k) => k > 0 && (p.loudness - phrases[k - 1]!.loudness) / loudest >= DROP_RISE);
  const firstPhrase = phraseStart(0);

  return {
    introEnd,
    outroStart,
    ...(rise > 0 ? { firstDrop: phraseStart(rise) } : {}),
    coldStart,
    coldEnd,
    soundEnd,
    downbeatConfidence: round(bar.confidence * phrase.confidence),
    downbeatOffset,
    phraseEnergy: phraseEnergyFrom(frames, { bpm: grid.bpm, firstBeat: firstPhrase }, 0, duration),
    firstPhrase,
    ...(main ? { mainGroove: main } : {}),
  };
}

/** Each whole-enough phrase's groove from beat `anchor` (see Groove); a last phrase under 8 beats has none. */
function groovesOf(beats: Beat[], anchor: number): (Groove | undefined)[] {
  const grooves: (Groove | undefined)[] = [];
  const median = (values: number[]) => percentile(values, 0.5);
  for (let start = Math.max(0, anchor); start < beats.length; start += BEATS_PER_PHRASE) {
    const phrase = beats.slice(start, start + BEATS_PER_PHRASE);
    grooves.push(
      phrase.length < MIN_LAST_PHRASE_BEATS
        ? undefined
        : { kick: median(phrase.map((b) => b.kick)), bass: median(phrase.map((b) => b.bass)), loudness: median(phrase.map((b) => b.loudness)) },
    );
  }
  return grooves;
}

/** The song's main groove: each level at MAIN_PERCENTILE of its phrases'. None without whole phrases. */
function mainGrooveOf(grooves: (Groove | undefined)[]): Groove | undefined {
  const whole = grooves.filter((g): g is Groove => g !== undefined);
  if (!whole.length) return undefined;
  const at = (key: keyof Groove) => percentile(whole.map((g) => g[key]), MAIN_PERCENTILE);
  return { kick: at('kick'), bass: at('bass'), loudness: at('loudness') };
}

/** Loudness, kick and fill of every grid beat with some sound in it (see MIN_BEAT_SOUND). */
function beatsOf(frames: Frames, grid: Pick<BeatGrid, 'bpm' | 'firstBeat'>, soundEnd: number): Beat[] {
  const { fps, rms, lowEnergy, energy, onset } = frames;
  if (!rms.length) return [];
  const period = 60 / grid.bpm;
  const end = Math.min(soundEnd - MIN_BEAT_SOUND, (rms.length + FRAME_CENTRE) / fps);
  // The last frame whose window ends by the end of the sound.
  const lastSounding = Math.floor(soundEnd * fps - FRAME_HOPS) + 1;
  // The onset envelope runs ahead of the sound: the frame where a sound at time t peaks in it.
  const onsetFrame = (t: number) => Math.round(t * fps - ONSET_LATENCY_FRAMES);
  const beats: Beat[] = [];
  for (let t = grid.firstBeat; t < end; t += period) {
    // Frame f's window covers frames-worth of time [f, f + FRAME_HOPS). Windows from the beat's
    // attack to the next beat (or the end of the sound) for its loudness; windows strictly after the
    // attack for its fill. When no window fits (a last hit shorter than a frame, or a tempo too fast
    // for any), the first frame from the attack.
    const lastInside = Math.min(rms.length, Math.floor((t + period) * fps - FRAME_HOPS) + 1, lastSounding);
    const from = Math.min(rms.length - 1, Math.max(0, Math.ceil(t * fps - 1)));
    const to = Math.max(lastInside, from + 1);
    let [fillFrom, fillTo] = [Math.max(0, Math.floor(t * fps) + 1), lastInside];
    if (fillTo <= fillFrom) [fillFrom, fillTo] = [from, to];
    let fill = 0;
    for (let f = fillFrom; f < fillTo; f++) fill += Math.max(0, energy[f]! - lowEnergy[f]!);
    // The bass line: windows from halfway to the next beat, past the kick's decay.
    const bassFrom = Math.min(rms.length - 1, Math.ceil((t + period / 2) * fps));
    beats.push({
      loudness: meanOf(rms, from, to),
      kick: peak(lowEnergy, t * fps - FRAME_CENTRE, KICK_HALF_WIDTH),
      attack: maxOf(onset, onsetFrame(t) - 1, onsetFrame(t + period)),
      fill: fill / (fillTo - fillFrom),
      bass: meanOf(lowEnergy, bassFrom, Math.max(bassFrom + 1, lastInside)),
    });
  }
  return beats;
}

/**
 * Each phrase from beat `anchor`: whether it is full (not intro or outro material), and its mean
 * beat loudness — the same measure as `phraseEnergy`. Only audible beats that aren't edge beats
 * count toward fullness: a phrase is full when it has at least four and fewer than 75% of them are
 * sparse. Beats before the anchor (silence, a pickup) belong to no phrase; a last phrase shorter
 * than 8 beats counts only for fullness.
 */
function phrasesOf(beats: Beat[], anchor: number, { counts, sparse }: BeatKinds): { dense: boolean; loudness: number }[] {
  const phrases: { dense: boolean; loudness: number }[] = [];
  for (let start = Math.max(0, anchor); start < beats.length; start += BEATS_PER_PHRASE) {
    const all = beats.slice(start, start + BEATS_PER_PHRASE);
    const counted = all.filter(counts);
    const dense = counted.length >= MIN_COUNTED_BEATS && counted.filter(sparse).length / counted.length < SPARSE_PHRASE_SHARE;
    const loudness = all.length >= MIN_LAST_PHRASE_BEATS ? all.reduce((s, b) => s + b.loudness, 0) / all.length : 0;
    phrases.push({ dense, loudness });
  }
  return phrases;
}

/** What kind of beat a beat is, against the levels of the song's audible beats. */
interface BeatKinds {
  /** Little mid/high fill: just a kick, or nothing but a kick and a hat. */
  thin: (b: Beat) => boolean;
  /** Has a kick and is thin: intro or outro material. */
  sparse: (b: Beat) => boolean;
  /** Counts toward a phrase's fullness: audible and not an edge beat. */
  counts: (b: Beat) => boolean;
}

function beatKinds(sounding: Beat[], audible: number, fullSound: number): BeatKinds {
  const fullFill = percentile(sounding.map((b) => b.fill), FULL_PERCENTILE);
  const kickGate = KICK_GATE_SHARE * percentile(sounding.map((b) => b.kick), 0.9);
  const attackGate = ATTACK_GATE_SHARE * percentile(sounding.map((b) => b.attack), 0.5);
  const hasKick = (b: Beat) => b.kick > kickGate;
  const thin = (b: Beat) => b.fill < SPARSE_FILL_SHARE * fullFill;
  return {
    thin,
    sparse: (b) => hasKick(b) && thin(b),
    counts: (b) => b.loudness > audible && (hasKick(b) || (b.loudness >= fullSound && b.attack > attackGate)),
  };
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
 * The section changes: beats where the mean loudness of the bar starting there differs from the bar
 * before by 1.5× or more, and more than at the beats either side. Both bars must lie within the
 * music (the song's edges aren't section changes) and are measured on their audible beats, of which
 * they need three: a drop after a beat of silence (a common build-up trick) still counts. The
 * change itself must be on an audible beat, so it lands on the drop and not on the silent beat.
 */
function sectionChanges(beats: Beat[], isSounding: boolean[]): Change[] {
  const level = beats.map((b) => Math.log(b.loudness));
  const barLevel = (from: number) => {
    let sum = 0;
    let count = 0;
    for (let i = from; i < from + BEATS_PER_BAR; i++) {
      if (!isSounding[i]) continue;
      sum += level[i]!;
      count++;
    }
    return count >= MIN_SOUNDING_IN_BAR ? sum / count : undefined;
  };
  const first = isSounding.indexOf(true);
  const last = isSounding.lastIndexOf(true);
  const steps = beats.map((_, b) => {
    if (!isSounding[b] || b - BEATS_PER_BAR < first || b + BEATS_PER_BAR - 1 > last) return 0;
    const before = barLevel(b - BEATS_PER_BAR);
    const after = barLevel(b);
    return before === undefined || after === undefined ? 0 : Math.abs(after - before);
  });
  return steps
    .map((step, beat) => ({ step, beat }))
    .filter(({ step, beat }) => step >= SECTION_JUMP && step > (steps[beat - 1] ?? 0) && step >= (steps[beat + 1] ?? 0));
}

/**
 * How sure the bar grid is, and whether to move it.
 *
 * The bass margin is how far the chosen bar position's bass accent stands above the next best (as
 * downbeats.ts decides it; the bass onset margin, at half weight, when the bass level tied). Section
 * changes count for a bar position when they land on its phrase lines (half when only on its bar
 * lines), on whichever of its four possible phrase grids they fit best; with two or more changes
 * all on the chosen position's lines, the confidence rises toward 1, and changes clearly on another
 * position's lines lower it. If the bass barely decided and the sections clearly favour another
 * position, that one wins: a four-to-the-floor kick says little about where the bar starts, a drop
 * says a lot. A bar known from elsewhere (`mayMove` false) stays; only its confidence is measured.
 */
function checkBar(
  accents: BarAccents | undefined,
  changes: Change[],
  anchorOf: (offset: number) => number,
  chosen: number,
  mayMove: boolean,
  /** How sure the chosen bar is from elsewhere (the beat model), instead of from the bass accents. */
  sure?: number,
): { offset: number; confidence: number } {
  const section = sectionScores(changes, anchorOf);
  const bassConfidence = (offset: number) => {
    if (sure !== undefined) return offset === chosen ? sure : 0;
    if (!accents) return 0;
    const { low, lowOnset } = accents;
    const others = [0, 1, 2, 3].filter((o) => o !== offset);
    const secondLow = Math.max(...others.map((o) => low[o]!));
    const margin = (values: number[], second: number) => (values[offset]! - second) / (values[offset]! || 1);
    const bass = isBassTie(low[offset]!, secondLow)
      ? ONSET_MARGIN_WEIGHT * margin(lowOnset, Math.max(...others.map((o) => lowOnset[o]!)))
      : margin(low, secondLow);
    return clamp(bass / SURE_BASS_MARGIN);
  };
  const confidenceOf = (offset: number) => {
    const rival = Math.max(...[0, 1, 2, 3].filter((o) => o !== offset).map((o) => section[o]!));
    const lifted = 1 - (1 - bassConfidence(offset)) * (1 - SECTION_WEIGHT * section[offset]!);
    return clamp(lifted * (1 - CONTRADICTION_WEIGHT * Math.max(0, rival - section[offset]!)));
  };

  let offset = chosen;
  if (mayMove && bassConfidence(chosen) < WEAK_BASS) {
    const best = [0, 1, 2, 3].reduce((a, b) => (section[b]! > section[a]! ? b : a), chosen);
    if (section[best]! - section[chosen]! >= SECTION_OVERRIDE) offset = best;
  }
  return { offset, confidence: confidenceOf(offset) };
}

/**
 * For each bar position 0–3, how much of the song's section changes land on its lines: full credit
 * on its phrase lines, half on its other bar lines, taking the best of its four possible phrase
 * grids (the phrase may start on any of the first four downbeats). Scaled down when there is only
 * one change to go on.
 */
function sectionScores(changes: Change[], anchorOf: (offset: number) => number): number[] {
  const total = changes.reduce((sum, c) => sum + c.step, 0);
  if (!total) return [0, 0, 0, 0];
  const weight = Math.min(1, changes.length / SECTION_CHANGES_FOR_FULL_WEIGHT);
  return [0, 1, 2, 3].map((offset) => {
    const downbeat = anchorOf(offset);
    const onBar = support(changes, downbeat, BEATS_PER_BAR);
    const onPhrase = Math.max(...[0, 1, 2, 3].map((j) => support(changes, downbeat + j * BEATS_PER_BAR, BEATS_PER_PHRASE)));
    return ((onPhrase + (onBar - onPhrase) / 2) / total) * weight;
  });
}

/**
 * Where the music's first phrase starts, as a beat index, and how sure that is (0.25–1).
 *
 * The candidates are the four downbeats from the music's first (`firstDownbeat`): each defines a
 * phrase grid. Each scores the share of the section changes on the bar's lines that land on its
 * phrase lines, weighted by how many changes there are (one could be chance), plus the prior for
 * the rest: the music's first downbeat gets the trust its start deserves (see CLEAN_START_SHARE),
 * the others share what's left. The scores add up to 1, so the winner's is its confidence; ties go
 * to the first downbeat.
 *
 * The phrase is then placed on the winning grid at the line nearest the music's start, up to half
 * a phrase before it (a phrase whose first beats faded in) and never before the grid's first beat.
 */
function choosePhrase(
  beats: Beat[],
  changes: Change[],
  musicStart: number,
  firstDownbeat: number,
  audible: number,
): { anchor: number; confidence: number } {
  const onBar = changes.filter((c) => mod(c.beat - firstDownbeat, BEATS_PER_BAR) === 0);
  const total = onBar.reduce((sum, c) => sum + c.step, 0);
  const weight = total ? Math.min(1, onBar.length / SECTION_CHANGES_FOR_FULL_WEIGHT) : 0;
  const trust = cleanStart(beats, musicStart, audible) ? 1 : UNSURE_START_TRUST;
  const scores = [0, 1, 2, 3].map((j) => {
    const evidence = total ? support(onBar, firstDownbeat + j * BEATS_PER_BAR, BEATS_PER_PHRASE) / total : 0;
    const prior = j === 0 ? trust : (1 - trust) / 3;
    return weight * evidence + (1 - weight) * prior;
  });
  const best = scores.reduce((a, s, j) => (s > scores[a]! + 1e-9 ? j : a), 0);
  const line = firstDownbeat + best * BEATS_PER_BAR;
  // The line on this grid in [musicStart − 8, musicStart + 8), moved a phrase later if before beat 0.
  let anchor = line - Math.floor((line - (musicStart - BEATS_PER_PHRASE / 2)) / BEATS_PER_PHRASE) * BEATS_PER_PHRASE;
  if (anchor < 0) anchor += BEATS_PER_PHRASE;
  return { anchor, confidence: scores[best]! };
}

/** The music's first audible beat is at least half as loud as the loudest of the eight from there. */
function cleanStart(beats: Beat[], musicStart: number, audible: number): boolean {
  const first = beats[musicStart]!.loudness;
  const loudest = Math.max(audible, ...beats.slice(musicStart, musicStart + 2 * BEATS_PER_BAR).map((b) => b.loudness));
  return first >= CLEAN_START_SHARE * loudest;
}

/** Total step of the changes on the lines `every` beats apart through beat `line`. */
function support(changes: Change[], line: number, every: number): number {
  return changes.reduce((sum, c) => (mod(c.beat - line, every) === 0 ? sum + c.step : sum), 0);
}

/** The largest of values[from, to) (clipped to the array); 0 for none. */
function maxOf(values: Float64Array, from: number, to: number): number {
  let best = 0;
  for (let i = Math.max(0, from); i < Math.min(values.length, to); i++) best = Math.max(best, values[i]!);
  return best;
}

function meanOf(values: Float64Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += values[i]!;
  return to > from ? sum / (to - from) : 0;
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));
