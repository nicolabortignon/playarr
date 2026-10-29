import { describe, expect, it } from 'vitest';
import type { TrackMeta } from '../analysis/analyzer.ts';
import { ANALYSIS_VERSION, ENVELOPE_POINTS, type AudioFeatures } from '../analysis/dsp.ts';
import { styleProfile } from '../analysis/styles.ts';
import { buildDna, type DnaInput } from './dna.ts';
import { chooseLayout, renderCover } from './render.ts';
import { Rng } from './random.ts';

interface Song {
  id: string;
  tags: string[];
  bpm?: number;
  pulse?: number;
  loudness?: number;
  dynamics?: number;
  busyness?: number;
  envelope?: number[];
  year?: number;
}

function dnaOf(songs: Song[]) {
  const features = new Map<string, AudioFeatures>();
  const meta = new Map<string, TrackMeta>();
  const items: DnaInput[] = [];
  for (const s of songs) {
    features.set(s.id, {
      version: ANALYSIS_VERSION,
      bpm: s.bpm ?? 120,
      pulse: s.pulse ?? 0.8,
      loudness: s.loudness ?? 0.7,
      dynamics: s.dynamics ?? 0.3,
      brightness: 0.5,
      busyness: s.busyness ?? 0.5,
      bass: 0.6,
      envelope: s.envelope ?? Array.from({ length: ENVELOPE_POINTS }, () => 0.7),
      seconds: 240,
      raw: { meanDb: -14, rangeDb: 12, centroidHz: 1200, onsetsPerSec: 2.5, lowShare: 0.5, beatPeak: 0.6 },
    });
    meta.set(s.id, { tags: s.tags.map((t): [string, number] => [t, 1]), year: s.year });
    items.push({ recordingId: s.id, duration: 240 });
  }
  return buildDna(items, features, meta, 'test');
}

const dance = (n: number) => Array.from({ length: n }, (_, i): Song => ({ id: `dance-${i}`, tags: ['electronic', 'house'], bpm: 122 + i }));
const calm = (n: number) =>
  Array.from({ length: n }, (_, i): Song => ({ id: `calm-${i}`, tags: ['ambient', 'drone'], pulse: 0.05, loudness: 0.2, dynamics: 0.8, busyness: 0.05 }));
const eclectic = ['rock', 'jazz', 'hip hop', 'classical', 'folk', 'electronic', 'soul', 'metal'].map(
  (tag, i): Song => ({ id: `mix-${i}`, tags: [tag], bpm: 80 + i * 12, pulse: (i % 4) / 3, loudness: 0.2 + (i % 5) / 6, busyness: (i % 3) / 2 }),
);

describe('styleProfile', () => {
  it('maps tags to style families without false friends', () => {
    expect(Object.keys(styleProfile([['trip hop', 1]]).families)).toEqual(['chill']);
    expect(Object.keys(styleProfile([['progressive electronic', 1]]).families)).toEqual(['electronic']);
    expect(Object.keys(styleProfile([['hip hop', 1]]).families)).toEqual(['hiphop']);
  });

  it('ignores styles that are only a trace of the tags', () => {
    const { families } = styleProfile([['electronic', 10], ['house', 5], ['rock', 1]]);
    expect(families.rock).toBeUndefined();
    expect(families.electronic).toBe(1);
  });
});

describe('playlist DNA and covers', () => {
  it('is deterministic, and depends on which songs are in the playlist', () => {
    const songs = dance(8);
    expect(renderCover(dnaOf(songs)).svg).toBe(renderCover(dnaOf(songs)).svg);
    expect(dnaOf([...songs].reverse()).seed).toBe(dnaOf(songs).seed);
    expect(dnaOf(songs.slice(1)).seed).not.toBe(dnaOf(songs).seed);
  });

  it('measures a single-style playlist as focused and a mixtape as diverse', () => {
    expect(dnaOf(dance(10)).diversity).toBeLessThan(0.3);
    expect(dnaOf(eclectic).diversity).toBeGreaterThan(0.7);
  });

  it('picks the visual language from the character of the music', () => {
    const layout = (songs: Song[]) => {
      const dna = dnaOf(songs);
      return chooseLayout(dna, new Rng(dna.seed));
    };
    expect(layout(calm(8))).toBe('horizon');
    expect(layout(eclectic)).toBe('blocks');
    expect(['ridges', 'grooves']).toContain(layout(dance(10)));
  });

  it('draws every song: a tile per song in blocks, a band of lines per song in ridges', () => {
    const blocks = renderCover(dnaOf(eclectic), 'blocks').svg;
    expect(blocks.match(/<clipPath /g)).toHaveLength(eclectic.length);
    const ridges = renderCover(dnaOf(dance(6)), 'ridges').svg;
    // Every song gets the same number of lines (a band), several each.
    const lines = ridges.match(/stroke-linejoin="round"/g)!.length;
    expect(lines % 6).toBe(0);
    expect(lines).toBeGreaterThan(6);
  });

  it('shapes the picture from each song’s loudness over time', () => {
    const flat = dance(4);
    const swelling = flat.map((s, i) => (i === 0 ? { ...s, envelope: Array.from({ length: ENVELOPE_POINTS }, (_, k) => k / ENVELOPE_POINTS) } : s));
    for (const layout of ['ridges', 'grooves', 'horizon'] as const) {
      expect(renderCover(dnaOf(swelling), layout).svg).not.toBe(renderCover(dnaOf(flat), layout).svg);
    }
  });

  it('renders an empty playlist', () => {
    const dna = buildDna([], new Map(), new Map(), '7');
    expect(renderCover(dna).svg).toMatch(/^<svg [^>]+>.*<\/svg>$/);
  });
});
