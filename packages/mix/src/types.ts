/** Bump when the mix map changes, so stored maps are measured again. */
export const MIX_MAP_VERSION = 1;

/** Camelot wheel position: 1–12 and A (minor) or B (major), e.g. "8A". */
export type Camelot = `${number}${'A' | 'B'}`;

/** What Playarr knows about a song for mixing it. Times in seconds from the start of the song. */
export interface MixMap {
  version: number;
  duration: number;
  /** Beats per minute of the grid (not folded: a 174 BPM song stays 174). */
  bpm: number;
  /** Time of the first beat of the grid; beat n is at firstBeat + n * 60 / bpm. */
  firstBeat: number;
  /**
   * Beats from firstBeat to the music's first downbeat, 0–3 (analysis moves firstBeat to the grid
   * beat up to three beats before that downbeat, so it never needs more). Bars start there and every
   * 4 beats after; phrases every 16.
   */
  downbeatOffset: number;
  /**
   * 0–1: how sure the bar starts are. Below 0.4 the planner doesn't trust phrase alignment (no long
   * blend; quick mixes land on a beat). Missing counts as sure.
   */
  downbeatConfidence?: number;
  /**
   * The grid holds over the whole song (no wandering tempo): long blends allowed. Read it together
   * with `beatConfidence`: it is false whenever the confidence is below 0.35 (noise, beatless music).
   */
  gridStable: boolean;
  /** 0–1: how sure the beat grid is. */
  beatConfidence: number;
  key?: { camelot: Camelot; confidence: number };
  /** Seconds from the start with a steady beat and little else: where the song can be brought in. */
  introEnd: number;
  /** Seconds from the start where the outro begins (beat-led, sparse): where the song can be left. */
  outroStart: number;
  /** The first big rise in energy, if any. */
  firstDrop?: number;
  /** The song starts on full sound (no fade or intro), or ends abruptly. */
  coldStart: boolean;
  coldEnd: boolean;
  /** Where sound ends (before trailing silence). */
  soundEnd: number;
  /** Energy 0–1 per 16-beat phrase, from the first downbeat. */
  phraseEnergy: number[];
}

/** Hand-set mix points that override the detected ones (Edit mix points). */
export interface CuePoints {
  mixIn?: number;
  mixOut?: number;
}

export type TransitionStyle = 'straight' | 'long' | 'quick' | 'fade';
/** The per-queue override: Auto, Party (longer blends), No mixing (gapless only). */
export type MixMode = 'auto' | 'party' | 'off';

/** A gain or filter value over time, linear between points. Times are seconds into the transition. */
export type Automation = { at: number; value: number }[];

export interface TransitionPlan {
  style: TransitionStyle;
  /** Where in A the transition starts (A plays normally until here). */
  aStart: number;
  /** Where in B the transition starts. */
  bStart: number;
  /**
   * Seconds of transition output. It can run past A's end (a long blend's ease-back is B alone): A's gain
   * is 0 by then, so the renderer treats A as silent past its end.
   */
  length: number;
  /** Where in B normal playback resumes after the transition. */
  bResume: number;
  /** Seconds into the transition where the listener hears B take over (lock screen switches here). */
  switchAt: number;
  /** B's playback rate over the transition (1 = its own tempo), per point; A always plays at 1. */
  bRate: Automation;
  aGain: Automation;
  bGain: Automation;
  /** Low-shelf gain in dB on each side (0 = flat, −24 = bass gone): the bass swap. */
  aLowDb: Automation;
  bLowDb: Automation;
  /** High-pass cutoff in Hz on A (20 = off): the quick-mix sweep. */
  aHighPassHz: Automation;
  /** Why this style: for the transition view and logs. */
  reason: string;
  /**
   * Beats of A in the move, for the transition view: the overlap for a long blend (not B's ease-back after
   * it), the lead-in up to the landing (8 or 4) for a quick mix, cuts included; 0 for a fade or straight on.
   */
  beats: number;
}
