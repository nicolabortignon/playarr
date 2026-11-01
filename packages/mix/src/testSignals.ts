// Synthetic audio for the mix tests: songs whose beats, bars, key and sections are known exactly,
// so analysis and planning can be checked against the truth instead of against a recording.
// Test-only: deliberately not exported from the package index.

export type PitchName = 'C' | 'C#' | 'D' | 'D#' | 'E' | 'F' | 'F#' | 'G' | 'G#' | 'A' | 'A#' | 'B';
export const PITCH_NAMES: readonly PitchName[] = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export interface ClickTrackOptions {
  bpm: number;
  seconds: number;
  rate: number;
  /** Time of the first beat, in seconds. */
  firstBeat?: number;
  /** Beats per bar: every accentEvery-th beat is a downbeat. */
  accentEvery?: number;
  /** Index of the first downbeat, so a track can start mid-bar. */
  accentOffset?: number;
  /** Pitch of the kick, so two overlapping tracks can be told apart by frequency band. */
  kickHz?: number;
  /** Tempo (bpm) as a function of time, for songs that drift. Defaults to a constant `bpm`. */
  tempoAt?: (t: number) => number;
}

export interface BeatSignal {
  samples: Float32Array;
  /** Beat times in seconds. */
  beats: number[];
  /** The beats that start a bar, in seconds. */
  downbeats: number[];
}

/** Levels chosen so kick + chord + snare together still stay inside −1…1. */
const KICK_SECONDS = 0.15;
const KICK_DECAY = 0.04;
const KICK_LEVEL = 0.35;
const DOWNBEAT_LEVEL = 0.5;
const TICK_SECONDS = 0.012;
const TICK_LEVEL = 0.05;
const SNARE_SECONDS = 0.1;
const SNARE_DECAY = 0.02;
const SNARE_LEVEL = 0.35;
const CHORD_NOTE_LEVEL = 0.06;
const TAIL_SILENCE = 1;

/**
 * A metronome-like track: a decaying sine "kick" on every beat (louder on downbeats) and a quiet
 * high tick halfway between beats. The kick starts at zero phase, so the loudest sample lands a
 * quarter of its period (~4 ms at 60 Hz) after the beat time.
 */
export function clickTrack(options: ClickTrackOptions): BeatSignal {
  const { bpm, seconds, rate, firstBeat = 0.5, tempoAt = () => bpm } = options;
  const beats: number[] = [];
  for (let t = firstBeat; t < seconds; t += 60 / tempoAt(t)) beats.push(t);
  const samples = new Float32Array(Math.round(seconds * rate));
  const downbeats = renderBeats(samples, rate, beats, options);
  return { samples, beats, downbeats };
}

/** Adds kicks and off-beat ticks for `beats` into `out`; returns the downbeats. */
function renderBeats(
  out: Float32Array,
  rate: number,
  beats: number[],
  { accentEvery = 4, accentOffset = 0, kickHz = 60 }: Pick<ClickTrackOptions, 'accentEvery' | 'accentOffset' | 'kickHz'>,
): number[] {
  const downbeats: number[] = [];
  // 8 kHz when the rate allows it; at low analysis rates it would alias, so stay below Nyquist.
  const tickHz = Math.min(8000, 0.4 * rate);
  beats.forEach((beat, index) => {
    const isDownbeat = mod(index - accentOffset, accentEvery) === 0;
    if (isDownbeat) downbeats.push(beat);
    addBurst(out, rate, beat, KICK_SECONDS, (t) => {
      const level = isDownbeat ? DOWNBEAT_LEVEL : KICK_LEVEL;
      return level * Math.exp(-t / KICK_DECAY) * Math.sin(2 * Math.PI * kickHz * t);
    });
    const next = beats[index + 1];
    if (next !== undefined) {
      addBurst(out, rate, (beat + next) / 2, TICK_SECONDS, (t) => {
        const fade = 1 - t / TICK_SECONDS;
        return TICK_LEVEL * fade * Math.sin(2 * Math.PI * tickHz * t);
      });
    }
  });
  return downbeats;
}

/** Adds `shape(t)` for t in [0, seconds) starting at time `at`, clipped to the buffer. */
function addBurst(out: Float32Array, rate: number, at: number, seconds: number, shape: (t: number) => number) {
  const start = Math.round(at * rate);
  const length = Math.round(seconds * rate);
  for (let i = Math.max(0, -start); i < length && start + i < out.length; i++) out[start + i]! += shape(i / rate);
}

export interface ChordOptions {
  root: PitchName;
  minor: boolean;
  seconds: number;
  rate: number;
}

/**
 * A sustained triad (root, third, fifth) with the root in octave 3, each note a sine plus two
 * softer harmonics so it reads like an instrument rather than a test tone. Short fades at both
 * ends keep it free of clicks.
 */
export function chord({ root, minor, seconds, rate }: ChordOptions): Float32Array {
  const rootMidi = 48 + PITCH_NAMES.indexOf(root); // C3 = MIDI 48
  const notes = [rootMidi, rootMidi + (minor ? 3 : 4), rootMidi + 7].map((m) => 440 * 2 ** ((m - 69) / 12));
  const harmonics = [1, 0.5, 0.25];
  const length = Math.round(seconds * rate);
  const ramp = Math.min(0.01 * rate, length / 2);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    let v = 0;
    for (const hz of notes) harmonics.forEach((gain, h) => (v += gain * Math.sin(2 * Math.PI * hz * (h + 1) * t)));
    const edge = Math.min(1, i / ramp, (length - 1 - i) / ramp);
    out[i] = CHORD_NOTE_LEVEL * edge * v;
  }
  return out;
}

export interface SongOptions {
  bpm: number;
  rate: number;
  introBeats: number;
  bodyBeats: number;
  outroBeats: number;
  /** Key of the body's chord. Defaults to C major. */
  key?: { root: PitchName; minor: boolean };
  /** Linear fade to silence over this many seconds, ending where the sound ends. */
  fadeOutSeconds?: number;
  /** Skip the intro: the first beat is already the full body. */
  startDense?: boolean;
}

export interface SongTruth {
  /** First beat of the body (equals the first beat when there's no intro). */
  introEnd: number;
  /** First beat of the outro. */
  outroStart: number;
  /** Where the last kick has died away; only silence follows. */
  soundEnd: number;
  /** Length of the whole signal: soundEnd plus one second of silence. */
  duration: number;
}

/**
 * A dance-music-shaped song with known sections: an intro of kick and ticks only, a body that adds
 * a chord and snare-like noise bursts on beats 2 and 4 (so it is clearly louder), an outro of kick
 * only again, then a second of silence. The first beat is at 0.5 s and every section has a whole
 * number of beats, so the truth is exact.
 */
export function song(options: SongOptions): BeatSignal & { truth: SongTruth } {
  const { bpm, rate, bodyBeats, outroBeats, key = { root: 'C', minor: false }, fadeOutSeconds, startDense } = options;
  const introBeats = startDense ? 0 : options.introBeats;
  const firstBeat = 0.5;
  const period = 60 / bpm;
  const beats = Array.from({ length: introBeats + bodyBeats + outroBeats }, (_, i) => firstBeat + i * period);
  const introEnd = firstBeat + introBeats * period;
  const outroStart = introEnd + bodyBeats * period;
  const soundEnd = beats.at(-1)! + KICK_SECONDS;
  const duration = soundEnd + TAIL_SILENCE;

  const samples = new Float32Array(Math.round(duration * rate));
  const downbeats = renderBeats(samples, rate, beats, {});

  const pad = chord({ ...key, seconds: outroStart - introEnd, rate });
  const padStart = Math.round(introEnd * rate);
  pad.forEach((v, i) => (samples[padStart + i]! += v));

  const rand = random(bpm);
  for (let i = introBeats; i < introBeats + bodyBeats; i++) {
    if (mod(i, 4) !== 1 && mod(i, 4) !== 3) continue; // beats 2 and 4 of the bar
    addBurst(samples, rate, beats[i]!, SNARE_SECONDS, (t) => SNARE_LEVEL * Math.exp(-t / SNARE_DECAY) * rand());
  }

  if (fadeOutSeconds) {
    const fadeStart = soundEnd - fadeOutSeconds;
    for (let i = Math.max(0, Math.floor(fadeStart * rate)); i < samples.length; i++) {
      samples[i]! *= Math.max(0, Math.min(1, (soundEnd - i / rate) / fadeOutSeconds));
    }
  }

  return { samples, beats, downbeats, truth: { introEnd, outroStart, soundEnd, duration } };
}

/** Two copies of a mono signal, the right a little quieter so the channels are distinguishable. */
export function stereo(mono: Float32Array): { left: Float32Array; right: Float32Array } {
  return { left: Float32Array.from(mono), right: mono.map((v) => v * 0.8) };
}

/** Deterministic white noise in ±0.5: for checks that analysis finds no beat, key or sections in it. */
export function noise(seconds: number, rate: number, seed = 1): Float32Array {
  const rand = random(seed);
  return Float32Array.from({ length: Math.round(seconds * rate) }, () => 0.5 * rand());
}

/**
 * Seeded uniform numbers in −1…1 (mulberry32). A naive LCG repeats within a second, which would
 * itself look like a beat.
 */
function random(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

const mod = (n: number, m: number) => ((n % m) + m) % m;
