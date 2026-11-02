import { describe, expect, it } from 'vitest';
import { beatHolds } from './drift.ts';

// 120 BPM from 1 s: phrase k runs from 1 + 8k to 9 + 8k seconds.
const grid = { bpm: 120, firstBeat: 1, downbeatOffset: 0, gridStable: false };

describe('beatHolds', () => {
  it('judges just the phrases a span overlaps', () => {
    const song = { ...grid, phraseDrift: [0, 3, 60, -4] };
    expect(beatHolds(song, 1, 17)).toBe(true); // phrases 0–1, ending on phrase 2's line
    expect(beatHolds(song, 1, 17.01)).toBe(false); // into phrase 2
    expect(beatHolds(song, 25, 33)).toBe(true); // phrase 3
    expect(beatHolds(song, 20, 26)).toBe(false); // the end of phrase 2
  });

  it('holds at the limit, over phrases without a beat, and outside what was measured', () => {
    expect(beatHolds({ ...grid, phraseDrift: [25, -25, null] }, 0, 100)).toBe(true);
    expect(beatHolds({ ...grid, phraseDrift: [26] }, 0, 100)).toBe(false);
    expect(beatHolds({ ...grid, phraseDrift: [80] }, 10, 100)).toBe(true); // after phrase 0
  });

  it('goes by the whole song without phrase drift', () => {
    expect(beatHolds({ ...grid, gridStable: true }, 0, 10)).toBe(true);
    expect(beatHolds(grid, 0, 10)).toBe(false);
  });
});
