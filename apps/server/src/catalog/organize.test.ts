import { describe, expect, it } from 'vitest';
import { type OrganizeFile, planMoves, safeSegment, targetFor } from './organize.ts';

const file = (rel: string, f: Partial<OrganizeFile> = {}): OrganizeFile => ({
  rel,
  artist: 'Massive Attack',
  album: 'Mezzanine',
  title: 'Angel',
  trackNumber: 1,
  discNumber: 1,
  multiDisc: false,
  confident: true,
  ...f,
});

describe('safeSegment', () => {
  it('makes names safe for every filesystem', () => {
    expect(safeSegment('AC/DC')).toBe('AC_DC');
    expect(safeSegment('What? Why: "Now" <here>|')).toBe('What_ Why_ _Now_ _here__');
    expect(safeSegment('...Hidden. ')).toBe('Hidden');
    expect(safeSegment('  a   b  ')).toBe('a b');
    expect(safeSegment('')).toBe('Unknown');
    expect(safeSegment('x'.repeat(300))).toHaveLength(120);
  });
});

describe('targetFor', () => {
  it('builds Artist/Album/NN Title.ext', () => {
    expect(targetFor(file('x/01.FLAC'))).toBe('Massive Attack/Mezzanine/01 Angel.flac');
  });
  it('adds the disc on multi-disc albums', () => {
    expect(targetFor(file('x.flac', { discNumber: 2, trackNumber: 3, multiDisc: true }))).toBe('Massive Attack/Mezzanine/2-03 Angel.flac');
  });
  it('leaves out a missing track number', () => {
    expect(targetFor(file('x.mp3', { trackNumber: 0 }))).toBe('Massive Attack/Mezzanine/Angel.mp3');
  });
  it('puts songs without an album under their artist', () => {
    expect(targetFor(file('x.mp3', { album: undefined }))).toBe('Massive Attack/Angel.mp3');
  });
});

describe('planMoves', () => {
  it('proposes moves and leaves files already in place alone', () => {
    const { moves, skipped } = planMoves([file('Massive Attack/Mezzanine/01 Angel.flac'), file('misc/angel.flac', { title: 'Teardrop', trackNumber: 3 })], () => false);
    expect(moves).toEqual([
      { from: 'misc/angel.flac', to: 'Massive Attack/Mezzanine/03 Teardrop.flac', artist: 'Massive Attack', album: 'Mezzanine', confident: true },
    ]);
    expect(skipped).toEqual([]);
  });

  it('skips a target that already exists', () => {
    const { moves, skipped } = planMoves([file('a.flac')], (rel) => rel === 'Massive Attack/Mezzanine/01 Angel.flac');
    expect(moves).toEqual([]);
    expect(skipped).toEqual([{ from: 'a.flac', to: 'Massive Attack/Mezzanine/01 Angel.flac', reason: 'A file is already there' }]);
  });

  it('lets one file have a target that two files want, preferring a confident one', () => {
    const { moves, skipped } = planMoves([file('b.flac', { confident: false }), file('a.mp3', {}), file('c.flac')], () => false);
    expect(moves.map((m) => m.from)).toEqual(['a.mp3', 'c.flac']);
    expect(skipped).toEqual([{ from: 'b.flac', to: 'Massive Attack/Mezzanine/01 Angel.flac', reason: 'Another file is going there' }]);
  });

  it('allows a case-only rename of the same file', () => {
    const { moves } = planMoves([file('massive attack/mezzanine/01 angel.flac')], (rel) => rel.toLowerCase() === 'massive attack/mezzanine/01 angel.flac');
    expect(moves).toHaveLength(1);
  });

  it('never proposes a case-only rename onto a file already in place', () => {
    const inPlace = file('Massive Attack/Mezzanine/01 Angel.flac');
    const other = file('massive attack/mezzanine/01 angel.flac');
    for (const files of [[inPlace, other], [other, inPlace]]) {
      const { moves, skipped } = planMoves(files, () => true);
      expect(moves).toEqual([]);
      expect(skipped).toEqual([{ from: other.rel, to: inPlace.rel, reason: 'A file is already there' }]);
    }
  });
});
