import type { AudioFeatures } from '../analysis/dsp.ts';
import { ENVELOPE_POINTS } from '../analysis/dsp.ts';
import type { TrackMeta } from '../analysis/analyzer.ts';
import { styleProfile, type StyleFamily } from '../analysis/styles.ts';
import { hash32, Rng, smoothNoise } from './random.ts';

/** One song, as the cover sees it. */
export interface Glyph {
  id: string;
  seconds: number;
  /** False until the audio has been analyzed; until then the values are neutral guesses. */
  analyzed: boolean;
  bpm: number;
  pulse: number;
  loudness: number;
  dynamics: number;
  brightness: number;
  busyness: number;
  bass: number;
  envelope: number[];
  /** 0–1 blend of loudness, busyness, tempo and brightness. */
  intensity: number;
  family?: StyleFamily;
  year?: number;
}

/** The playlist's character: everything the generator draws from. */
export interface Dna {
  seed: number;
  /** Songs in playlist order (each recording once). */
  glyphs: Glyph[];
  /** Typical tempo of the songs with a clear beat. */
  tempo?: number;
  /** 0–1: how much the tempo varies. */
  tempoSpread: number;
  pulse: number;
  intensity: number;
  brightness: number;
  dynamics: number;
  busyness: number;
  bass: number;
  /** 0–1: acoustic/organic (loose, dynamic, light on bass) vs machine-tight. */
  organic: number;
  /** Strongest first, weights summing to 1. */
  styles: { family: StyleFamily; weight: number }[];
  /** 0–1: spread of styles and of sound. */
  diversity: number;
  warmth: number;
  calm: number;
  era?: { median: number; from: number; to: number };
  analyzed: number;
  total: number;
}

export interface DnaInput {
  recordingId: string;
  /** Song length when known (from the library). */
  duration?: number;
  /** Lidarr genres of the song's artist. */
  genres?: string[];
  /** Album year from the library, used when ListenBrainz has none. */
  year?: number;
}

export function buildDna(
  items: DnaInput[],
  features: Map<string, AudioFeatures>,
  meta: Map<string, TrackMeta>,
  emptySeed: string,
): Dna {
  const seen = new Set<string>();
  const songs = items.filter((i) => !seen.has(i.recordingId) && seen.add(i.recordingId));
  const seed = songs.length ? hash32([...seen].sort().join('|')) : hash32(`empty:${emptySeed}`);

  let warmth = 0;
  let calm = 0;
  const familyTotals = new Map<StyleFamily, number>();
  const glyphs = songs.map((song): Glyph => {
    const f = features.get(song.recordingId);
    const m = meta.get(song.recordingId);
    const tags: [string, number][] = [...(m?.tags ?? []), ...(song.genres ?? []).map((g): [string, number] => [g, 0.5])];
    const profile = styleProfile(tags);
    warmth += profile.warmth;
    calm += profile.calm;
    for (const [family, w] of Object.entries(profile.families) as [StyleFamily, number][]) {
      familyTotals.set(family, (familyTotals.get(family) ?? 0) + w);
    }
    const family = (Object.entries(profile.families) as [StyleFamily, number][]).sort((a, b) => b[1] - a[1])[0]?.[0];
    const base = f ?? guess(song.recordingId);
    const tempoDrive = ((base.bpm - 70) / 110) * base.pulse;
    return {
      id: song.recordingId,
      seconds: song.duration || f?.seconds || 210,
      analyzed: !!f,
      bpm: base.bpm,
      pulse: base.pulse,
      loudness: base.loudness,
      dynamics: base.dynamics,
      brightness: base.brightness,
      busyness: base.busyness,
      bass: base.bass,
      envelope: base.envelope,
      intensity: clamp(0.4 * base.loudness + 0.25 * base.busyness + 0.2 * tempoDrive + 0.15 * base.brightness),
      family,
      year: m?.year ?? song.year,
    };
  });

  const n = glyphs.length || 1;
  const mean = (pick: (g: Glyph) => number) => glyphs.reduce((s, g) => s + pick(g), 0) / n;
  const std = (pick: (g: Glyph) => number) => {
    const mu = mean(pick);
    return Math.sqrt(glyphs.reduce((s, g) => s + (pick(g) - mu) ** 2, 0) / n);
  };

  const beats = glyphs.filter((g) => g.pulse > 0.35).map((g) => g.bpm).sort((a, b) => a - b);
  const tempo = beats.length ? beats[Math.floor(beats.length / 2)] : undefined;
  const iqr = beats.length > 1 ? beats[Math.floor(beats.length * 0.75)]! - beats[Math.floor(beats.length * 0.25)]! : 0;

  const styleTotal = [...familyTotals.values()].reduce((s, w) => s + w, 0);
  const styles = [...familyTotals]
    .map(([family, w]) => ({ family, weight: w / styleTotal }))
    .sort((a, b) => b.weight - a.weight);
  // Diversity counts each song's main style once: songs are tagged across several styles each,
  // so mixing every tag would make even a focused playlist look eclectic.
  const votes = new Map<StyleFamily, number>();
  for (const g of glyphs) if (g.family) votes.set(g.family, (votes.get(g.family) ?? 0) + 1);
  const voters = [...votes.values()].reduce((s, v) => s + v, 0) || 1;
  const entropy = -[...votes.values()].reduce((s, v) => s + (v / voters) * Math.log(v / voters), 0) / Math.log(5);
  const soundSpread = (std((g) => g.intensity) + std((g) => g.brightness) + std((g) => g.pulse)) / 0.6;

  const years = glyphs.flatMap((g) => (g.year ? [g.year] : [])).sort((a, b) => a - b);

  return {
    seed,
    glyphs,
    tempo,
    tempoSpread: clamp(iqr / 40),
    pulse: mean((g) => g.pulse),
    intensity: mean((g) => g.intensity),
    brightness: mean((g) => g.brightness),
    dynamics: mean((g) => g.dynamics),
    busyness: mean((g) => g.busyness),
    bass: mean((g) => g.bass),
    organic: mean((g) => 0.4 * (1 - g.pulse) + 0.3 * g.dynamics + 0.3 * (1 - g.bass)),
    styles,
    diversity: clamp(0.65 * clamp(entropy) + 0.35 * clamp(soundSpread)),
    warmth: warmth / n,
    calm: calm / n,
    era: years.length
      ? { median: years[Math.floor(years.length / 2)]!, from: years[0]!, to: years[years.length - 1]! }
      : undefined,
    analyzed: glyphs.filter((g) => g.analyzed).length,
    total: glyphs.length,
  };
}

/** Neutral, per-song stand-in until the real analysis lands (stable, so the cover doesn't flicker). */
function guess(id: string): Omit<AudioFeatures, 'version' | 'raw' | 'seconds'> {
  const rng = new Rng(hash32(`guess:${id}`));
  const wobble = smoothNoise(rng, 6);
  return {
    bpm: rng.range(90, 130),
    pulse: 0.4,
    loudness: 0.55,
    dynamics: 0.4,
    brightness: 0.45,
    busyness: 0.4,
    bass: 0.5,
    envelope: Array.from({ length: ENVELOPE_POINTS }, (_, i) => clamp(0.55 + 0.2 * wobble(i / ENVELOPE_POINTS))),
  };
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
