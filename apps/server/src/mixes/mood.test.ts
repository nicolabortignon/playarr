import { describe, expect, it } from 'vitest';
import {
  calibrate,
  christmasSeason,
  grooveOf,
  moodOf,
  shapeOfEnvelope,
  shapeOfPhrases,
  tensionOf,
  traitsOf,
  vocalsOf,
  wordsOf,
  type SongSound,
  type Words,
} from './mood.ts';

const quiet: Words = { energetic: 0, calm: 0, tense: 0, warmth: 0 };

function sound(over: Partial<SongSound> = {}): SongSound {
  return { meanDb: -12, onsetsPerSec: 2, centroidHz: 1100, lowShare: 0.4, rangeDb: 10, loud: 0.5, busy: 0.5, bright: 0.5, bass: 0.5, range: 0.5, ...over };
}

describe('a song’s shape', () => {
  it('reads a steady song as steady and at full tilt, and a crescendo as moving, with its jump', () => {
    const steady = shapeOfPhrases([0.3, 0.9, 0.95, 1, 0.92, 0.97, 0.9, 0.95, 0.4])!;
    expect(steady.sustain).toBe(1);
    expect(steady.swingDb).toBeLessThan(0.5);
    expect(steady.surgeDb).toBeLessThan(1);
    const crescendo = shapeOfPhrases([0.05, 0.1, 0.12, 0.15, 0.2, 0.3, 0.9, 1, 0.6])!;
    expect(crescendo.sustain).toBeLessThan(0.4);
    expect(crescendo.swingDb).toBeGreaterThan(6);
    // From 0.3 to 0.9 of the loudest is three times as loud: 9.5 dB.
    expect(crescendo.surgeDb).toBeCloseTo(9.54, 1);
  });

  it('leaves out the fade-in and fade-out, unmeasured phrases, and songs too short to tell', () => {
    expect(shapeOfPhrases([0.01, 1, 1, null, 1, 1, 0.01])).toMatchObject({ sustain: 1, surgeDb: 0 });
    expect(shapeOfPhrases([0.5, 1, 1, 0.5])).toBeUndefined();
  });

  it('falls back to the loudness envelope', () => {
    const flat = shapeOfEnvelope(Array.from({ length: 48 }, () => 0.8))!;
    expect(flat.sustain).toBe(1);
    expect(flat.swingDb).toBeCloseTo(0, 6);
    expect(flat.surgeDb).toBeCloseTo(0, 6);
    const rising = shapeOfEnvelope(Array.from({ length: 48 }, (_, i) => i / 47))!;
    expect(rising.sustain).toBeLessThan(0.1);
    expect(rising.surgeDb).toBeGreaterThan(1.5);
  });
});

describe('singing', () => {
  it('goes by the lyrics found first, then the title', () => {
    expect(vocalsOf('Teardrop', [['pop', 1]], {}, 'instrumental')).toBeLessThan(0.1);
    expect(vocalsOf('Gymnopédie No. 1', [['piano', 1]], {}, 'words')).toBeGreaterThan(0.9);
    expect(vocalsOf('Teardrop (Instrumental)', [['trip hop', 1]], {})).toBeLessThan(0.1);
  });

  it('takes each tag’s most telling hint, weighted by the tags’ weights', () => {
    expect(vocalsOf('x', [['vocal jazz', 1]], {})).toBeGreaterThan(0.9);
    expect(vocalsOf('x', [['jazz', 1], ['bebop', 1]], {})).toBeLessThan(0.35);
    expect(vocalsOf('x', [['post-rock', 1]], {})).toBeLessThan(0.2);
    expect(vocalsOf('x', [['lo-fi hip hop', 1], ['chillhop', 0.6]], {})).toBeLessThan(0.3);
    expect(vocalsOf('x', [['hip hop', 1]], {})).toBeGreaterThan(0.85);
  });

  it('falls back to the style, then to more likely than not', () => {
    expect(vocalsOf('x', [['velvet', 1]], { classical: 1 })).toBeLessThan(0.2);
    expect(vocalsOf('x', [], { hiphop: 0.5, classical: 0.5 })).toBeCloseTo(0.55, 2);
    expect(vocalsOf('x', [], {})).toBe(0.6);
  });
});

describe('what a song should never be picked for', () => {
  it('knows intros, interludes, skits and sketches under a minute, but not songs named like them', () => {
    expect(traitsOf('Intro', 200, []).filler).toBe(true);
    expect(traitsOf('Interlude (Rain)', 200, []).filler).toBe(true);
    expect(traitsOf('Phone Call Skit', 200, []).filler).toBe(true);
    expect(traitsOf('Happiness', 45, []).filler).toBe(true);
    expect(traitsOf('Introduction to the Blues', 200, []).filler).toBe(false);
    expect(traitsOf('Sketches of Spain', 200, []).filler).toBe(false);
  });

  it('knows spoken word and comedy by their telling tags, not by a passing one', () => {
    expect(traitsOf('Track 3', 300, [['comedy', 1], ['stand-up', 0.8]]).filler).toBe(true);
    expect(traitsOf('Track 3', 300, [['hip hop', 1], ['spoken word', 0.2]]).filler).toBe(false);
  });

  it('knows live recordings, but not songs about living', () => {
    expect(traitsOf('Wonderwall (Live at Knebworth)', 260, []).live).toBe(true);
    expect(traitsOf('Roxanne - Live', 260, []).live).toBe(true);
    expect(traitsOf('Live Forever', 276, []).live).toBe(false);
    expect(traitsOf('Live and Let Die', 192, []).live).toBe(false);
  });

  it('knows Christmas songs, and when they’re in season', () => {
    expect(traitsOf('Last Christmas', 260, []).christmas).toBe(true);
    expect(traitsOf('Song', 260, [['christmas', 1]]).christmas).toBe(true);
    expect(traitsOf('Santa Monica', 260, []).christmas).toBe(false);
    expect(christmasSeason({ month: 11, day: 23 })).toBe(false);
    expect(christmasSeason({ month: 11, day: 24 })).toBe(true);
    expect(christmasSeason({ month: 1, day: 6 })).toBe(true);
    expect(christmasSeason({ month: 1, day: 7 })).toBe(false);
  });
});

describe('mood, tension and groove', () => {
  it('reads major keys and happy tags as brighter than minor keys and sad ones', () => {
    const major = moodOf({ camelot: '8B', confidence: 0.8 }, { ...quiet, warmth: 0.5 }, 0.6);
    const minor = moodOf({ camelot: '8A', confidence: 0.8 }, { ...quiet, warmth: -0.5 }, 0.4);
    expect(major).toBeGreaterThan(0.7);
    expect(minor).toBeLessThan(0.3);
    expect(moodOf(undefined, quiet, undefined)).toBe(0.5);
  });

  it('hears tension in dark and aggressive tags and in metal', () => {
    const dark = wordsOf([['dark ambient', 1], ['ambient', 1]], { calm: 0, warmth: 0 });
    expect(tensionOf(dark, { chill: 1 })).toBeGreaterThan(0.9);
    expect(tensionOf(quiet, { metal: 1 })).toBeCloseTo(0.4, 5);
    expect(tensionOf(quiet, { jazz: 1 })).toBe(0);
  });

  it('feels groove in a sure, steady beat at a swaying tempo, and none without a beat', () => {
    expect(grooveOf(sound({ pulse: 0.9, bpm: 96, gridStable: true, bass: 0.8 }))).toBeGreaterThan(0.8);
    // Drum and bass at 174 sways at half time.
    expect(grooveOf(sound({ pulse: 0.9, bpm: 174, gridStable: true, bass: 0.8 }))).toBeGreaterThan(0.8);
    expect(grooveOf(sound({ pulse: 0.2, bpm: 96, gridStable: false }))).toBeLessThan(0.15);
    expect(grooveOf(sound())).toBeUndefined();
  });
});

describe('placing songs in the library', () => {
  it('hears a 1965 single as loud next to music of its time, and a quiet 2015 ballad as quiet, however hot its master', () => {
    const era = (year: number, meanDb: number) => ({ sound: sound({ meanDb }), words: quiet, year });
    const sixties = Array.from({ length: 40 }, (_, i) => era(1963 + (i % 5), -22 + (i % 8)));
    const tens = Array.from({ length: 40 }, (_, i) => era(2013 + (i % 5), -11 + (i % 8) / 2));
    const garage = era(1965, -14);
    const ballad = era(2015, -10);
    const [g, b] = calibrate([garage, ballad, ...sixties, ...tens]);
    // Over the whole library the ballad is louder; next to music of their time, the single is.
    expect(g!.sound.loud).toBeGreaterThan(b!.sound.loud);
  });

  it('places intensity among the library’s songs, leaving unmeasured songs out', () => {
    const soft = { sound: sound({ meanDb: -24, onsetsPerSec: 0.5, centroidHz: 700, rangeDb: 18, pulse: 0.1, bpm: 70 }), words: quiet };
    const hard = { sound: sound({ meanDb: -8, onsetsPerSec: 4.5, centroidHz: 1800, rangeDb: 5, pulse: 0.95, bpm: 170 }), words: quiet };
    const middle = { sound: sound(), words: quiet };
    const unmeasured = { words: quiet };
    const [s, h, m, u] = calibrate([soft, hard, middle, unmeasured]);
    expect(s!.intensity).toBeLessThan(m!.intensity);
    expect(m!.intensity).toBeLessThan(h!.intensity);
    expect(u).toBeUndefined();
  });
});
