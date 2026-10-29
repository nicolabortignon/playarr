import type { PlaylistItem } from '@playarr/shared';
import { describe, expect, it } from 'vitest';
import type { Analyzer, TrackMeta } from '../analysis/analyzer.ts';
import { ANALYSIS_VERSION, ENVELOPE_POINTS, type AudioFeatures } from '../analysis/dsp.ts';
import type { Library } from '../library/library.ts';
import { lch } from './color.ts';
import { PlaylistCovers } from './index.ts';
import type { Palette } from './palette.ts';
import { titleLayer } from './title.ts';

const features = (bpm: number): AudioFeatures => ({
  version: ANALYSIS_VERSION,
  bpm,
  pulse: 0.8,
  loudness: 0.6,
  dynamics: 0.3,
  brightness: 0.5,
  busyness: 0.5,
  bass: 0.6,
  envelope: Array.from({ length: ENVELOPE_POINTS }, () => 0.6),
  seconds: 200,
  raw: { meanDb: -14, rangeDb: 12, centroidHz: 1200, onsetsPerSec: 2.5, lowShare: 0.5, beatPeak: 0.6 },
});

/** Covers over an in-memory analyzer: every song is analyzed unless listed as `pending`. */
function setup(pending: Set<string> = new Set()) {
  const analyzer = {
    ensure() {},
    features: (ids: string[]) => new Map(ids.filter((id) => !pending.has(id)).map((id, i) => [id, features(100 + i)])),
    meta: (ids: string[]) => new Map(ids.map((id): [string, TrackMeta] => [id, { tags: [['electronic', 1]] }])),
    pending: (ids: string[]) => ids.filter((id) => pending.has(id)).length,
  } as unknown as Analyzer;
  const library = { artists: async () => [], albums: async () => [] } as unknown as Library;
  return new PlaylistCovers(analyzer, library, '/tmp/playarr-covers-test');
}

const items = (ids: string[]) =>
  ids.map((recordingId, i): PlaylistItem => ({ itemId: i, recordingId, title: recordingId, artistName: 'A', albumTitle: 'B', addedAt: '' }));
const songs = (n: number, prefix = 'song') => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

describe('playlist cover lifecycle', () => {
  it('stays provisional while songs are still being heard, then pins itself', async () => {
    const ids = songs(6);
    const listening = await setup(new Set([ids[0]!])).describe({ id: 1, name: 'Mix', items: items(ids) });
    expect(listening.freeze).toBeUndefined();
    expect(listening.info).toMatchObject({ frozen: false, pending: true });

    const heard = await setup().describe({ id: 1, name: 'Mix', items: items(ids) });
    expect(heard.freeze?.songs).toEqual([...ids].sort());
    expect(heard.info).toMatchObject({ frozen: true, pending: false, stale: false });
  });

  it('keeps a pinned cover through small changes and flags big ones as out of date', async () => {
    const covers = setup();
    const ids = songs(10);
    const { freeze: snapshot } = await covers.describe({ id: 1, name: 'Mix', items: items(ids) });

    const oneMore = await covers.describe({ id: 1, name: 'Mix', items: items([...ids, 'new-0']), snapshot });
    expect(oneMore.art.dna).toBe(snapshot!.dna);
    expect(oneMore.freeze).toBeUndefined();
    expect(oneMore.info.stale).toBe(false);

    const reshuffled = await covers.describe({ id: 1, name: 'Mix', items: items([...ids.slice(0, 5), ...songs(5, 'new')]), snapshot });
    expect(reshuffled.art.dna).toBe(snapshot!.dna);
    expect(reshuffled.info.stale).toBe(true);
  });

  it('changes the image URL on rename, without redrawing the art', async () => {
    const covers = setup();
    const ids = songs(4);
    const { freeze: snapshot } = await covers.describe({ id: 1, name: 'Mix', items: items(ids) });
    const before = await covers.describe({ id: 1, name: 'Mix', items: items(ids), snapshot });
    const after = await covers.describe({ id: 1, name: 'Road trip', items: items(ids), snapshot });
    expect(after.info.url).not.toBe(before.info.url);
    expect(after.art).toEqual(before.art);
  });
});

describe('cover title', () => {
  const pal = { bg: lch(0.2, 0.05, 280), fg: lch(0.93, 0.02, 85) } as Palette;
  const panelHeight = (svg: string) => Number(/<rect width="[\d.]+" height="([\d.]+)"/.exec(svg)![1]);

  it('sets the title as outlines on a panel, wrapping long names onto more lines', () => {
    const short = titleLayer('Chillax', pal, 'currents');
    const long = titleLayer('A very long playlist name for the train home on Fridays', pal, 'currents');
    for (const svg of [short, long]) {
      expect(svg).toMatch(/<path d="M[\d.\s-]+/);
      expect(svg).not.toMatch(/NaN|<text/);
    }
    expect(panelHeight(long)).toBeGreaterThan(panelHeight(short));
  });

  it('floats over a horizon’s sky without a panel, and falls back to text for emoji', () => {
    expect(titleLayer('Dusk', pal, 'horizon')).not.toMatch(/<rect/);
    expect(titleLayer('Workout 🔥', pal, 'currents')).toMatch(/<text [^>]*>Workout 🔥<\/text>/);
  });
});
