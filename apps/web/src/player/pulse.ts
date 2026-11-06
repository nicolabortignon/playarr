import type { MixMap, TransitionPlan } from '@playarr/mix';
import { create } from 'zustand';

/*
 * Keeping time with the music (plan 7 §2): what the now-playing bars, Now Playing's glow and a DJ blend's covers follow.
 * Every analyzed song has a beat grid (its mix map). The engine says where the song is, to the millisecond, and on
 * desktop, where it plays through Web Audio, how loud each part of what's heard is right now (the meter on the graph,
 * player/joinGraph.ts). One loop of animation frames reads them for everything that listens.
 */

/** A song's beat, where its grid can be trusted. Times in seconds of the song. */
export interface SongBeat {
  /** Seconds per beat. */
  beat: number;
  /** The music's first downbeat: bars start there and every four beats, before it and after. */
  firstBar: number;
  /** Energy per 16-beat phrase from the first bar, 0–1 (null: not measured). */
  phraseEnergy: readonly (number | null)[];
}

/**
 * The song's beat from its mix map, when the grid holds over the whole song: a tempo that wanders (a live drummer),
 * or a beat too unsure to go by (noise, beatless music, where `gridStable` is false too), would drift off it. Null
 * then, and for a song not analyzed: the bars keep their loop, and there's no glow.
 */
export function songBeat(map: Pick<MixMap, 'bpm' | 'firstBeat' | 'downbeatOffset' | 'gridStable' | 'phraseEnergy'> | null | undefined): SongBeat | null {
  if (!map || !(map.bpm > 0) || !map.gridStable) return null;
  const beat = 60 / map.bpm;
  return { beat, firstBar: map.firstBeat + map.downbeatOffset * beat, phraseEnergy: map.phraseEnergy ?? [] };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Where `time` falls between marks `period` apart from `origin`: 0 on a mark, nearly 1 just before the next. */
export function phaseOf(time: number, origin: number, period: number): number {
  const x = (time - origin) / period;
  return x - Math.floor(x);
}

/** A beat lands this fast: two frames, so it reads as on the beat rather than rising to it. */
const LAND_S = 0.03;

/** A beat landing, 0–1: up within LAND_S, then falling away until the next (to e^-fall of it). */
export function hit(phase: number, period: number, fall = 3): number {
  const land = Math.min(0.3, LAND_S / period);
  return phase < land ? phase / land : Math.exp((-fall * (phase - land)) / (1 - land));
}

/** The lowest a bar goes, of its full height: the music at rest, silence, or paused. */
export const BAR_REST = 0.22;
/** Between beats a bar keeps this much of its level: a loud passage stays tall, and the beat lifts it the rest. */
const BAR_HOLD = 0.4;

/**
 * The three bars at `time`, of their full height: the bass, the middle and the treble, each as loud as its part of the
 * music is (`levels`, 0–1), lifted as each beat lands and falling away until the next; the middle falls slower, and the
 * treble lands on every half beat, as hi-hats do.
 */
export function barHeights(beat: SongBeat, time: number, levels: readonly [number, number, number]): [number, number, number] {
  const half = beat.beat / 2;
  const onBeat = phaseOf(time, beat.firstBar, beat.beat);
  const lifts = [hit(onBeat, beat.beat, 3.2), hit(onBeat, beat.beat, 1.6), hit(phaseOf(time, beat.firstBar, half), half, 3)];
  return levels.map((level, i) => BAR_REST + (1 - BAR_REST) * clamp01(level) * (BAR_HOLD + (1 - BAR_HOLD) * lifts[i]!)) as [number, number, number];
}

/** Now Playing's glow breathes in over the last part of each bar… */
const INHALE_FROM = 0.82;
/** …and out from its downbeat, to e^-EXHALE by the end of the bar. */
const EXHALE = 4;

/**
 * Where Now Playing's glow is in its breath at `time`, 0–1: fullest on each bar's downbeat, breathing out across the
 * bar and in again before the next. Smooth both ways, so it swells rather than flashes.
 */
export function breath(beat: SongBeat, time: number): number {
  const p = phaseOf(time, beat.firstBar, 4 * beat.beat);
  const x = (p - INHALE_FROM) / (1 - INHALE_FROM);
  return Math.max(Math.exp(-EXHALE * p), x > 0 ? x * x * (3 - 2 * x) : 0);
}

/** How much is going on in the phrase at `time`, from the mix map, 0–1 (1 where it wasn't measured). */
export function energyAt(beat: SongBeat, time: number): number {
  const k = Math.max(0, Math.floor((time - beat.firstBar) / (16 * beat.beat)));
  const energy = beat.phraseEnergy[k];
  return energy == null ? 1 : clamp01(energy);
}

/** The three bars' parts of the spectrum, in Hz: the bass, the middle, the treble. */
const BANDS = [
  [40, 200],
  [200, 2000],
  [2000, 10_000],
] as const;
/** A band reads against the loudest it has lately been, over this much of the analyzer's range (about 24 dB)… */
const RANGE = 0.35;
/** …that loudest falling back this much a second (about 1.4 dB), so a quiet bridge reads quiet for a while… */
const PEAK_FALL_PER_S = 0.02;
/** …and never below this (about -68 dB): near silence reads as silence, not as the loudest yet. */
const MIN_PEAK = 0.45;

interface Meter {
  data: Uint8Array<ArrayBuffer>;
  peaks: [number, number, number];
  at: number;
}
const meters = new WeakMap<AnalyserNode, Meter>();

/**
 * What's heard at `now` (ms), 0–1 for the bass, the middle and the treble, each against how loud it has lately been,
 * so the volume set doesn't matter and a quiet song moves its bars as much as a loud one. Null without an analyzer.
 */
export function levelsOf(analyzer: AnalyserNode | null, now: number): [number, number, number] | null {
  if (!analyzer) return null;
  let meter = meters.get(analyzer);
  if (!meter) meters.set(analyzer, (meter = { data: new Uint8Array(analyzer.frequencyBinCount), peaks: [0, 0, 0], at: now }));
  const m = meter;
  analyzer.getByteFrequencyData(m.data);
  const fall = (PEAK_FALL_PER_S * Math.max(0, now - m.at)) / 1000;
  m.at = now;
  const binHz = analyzer.context.sampleRate / analyzer.fftSize;
  return BANDS.map(([low, high], i) => {
    const from = Math.max(1, Math.floor(low / binHz));
    const to = Math.max(from, Math.min(m.data.length - 1, Math.ceil(high / binHz)));
    let sum = 0;
    for (let k = from; k <= to; k++) sum += m.data[k]!;
    const level = sum / (to - from + 1) / 255;
    const top = Math.max((m.peaks[i] = Math.max(level, m.peaks[i]! - fall)), MIN_PEAK);
    return clamp01((level - (top - RANGE)) / RANGE);
  }) as [number, number, number];
}

/** One frame of the music, for whatever keeps time with it. */
export interface PulseFrame {
  /** Where the song playing is, in seconds, as it's heard. */
  time: number;
  /** What's heard, 0–1 for the bass, the middle and the treble (levelsOf); null where the player doesn't run through Web Audio. */
  levels: [number, number, number] | null;
  /** The DJ transition being heard, and how far into it (s, negative in its lead of the first song); null when none. */
  blend: { plan: TransitionPlan; time: number } | null;
}

/** What the engine tells the bars, the glow and a blend's covers: set while it's mounted (AudioEngine.tsx). */
export interface PulseSource {
  /** Where the song shown is, as it's heard (the clock store moves only a few times a second). */
  songTime(): number;
  /** The meter on what's heard, where the player runs through Web Audio; else null. */
  meter(): AnalyserNode | null;
  blend(): { plan: TransitionPlan; time: number } | null;
}

let source: PulseSource | null = null;

export function setPulseSource(next: PulseSource | null) {
  source = next;
}

/** Whether the player runs through Web Audio here (desktop), so the bars can follow what's heard. Set by the engine. */
export const useMetered = create<{ metered: boolean }>()(() => ({ metered: false }));

/** Where the music is now, outside the loop (a cover set right while paused); levels aren't read. Null without an engine. */
export function pulseNow(): PulseFrame | null {
  return source && { time: source.songTime(), levels: null, blend: source.blend() };
}

const listeners = new Set<(frame: PulseFrame) => void>();
let request = 0;

function tick(now: number) {
  request = requestAnimationFrame(tick);
  if (!source) return;
  const frame: PulseFrame = { time: source.songTime(), levels: levelsOf(source.meter(), now), blend: source.blend() };
  for (const listener of listeners) listener(frame);
}

/**
 * Calls `listener` on every animation frame while it listens (the browser pauses them in a page out of sight), with
 * where the music is: one loop for every listener. Returns how to stop listening.
 */
export function onPulse(listener: (frame: PulseFrame) => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof requestAnimationFrame === 'function') request = requestAnimationFrame(tick);
  return () => {
    listeners.delete(listener);
    if (listeners.size || !request) return;
    cancelAnimationFrame(request);
    request = 0;
  };
}
