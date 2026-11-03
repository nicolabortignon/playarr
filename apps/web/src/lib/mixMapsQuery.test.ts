import { MIX_MAP_VERSION, type MixMap } from '@playarr/mix';
import type { Query } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { mixMapsQuery } from './queries';

/** When the query asks again, given its answer so far and how many times it has asked. */
const nextAsk = (ids: string[], data: Record<string, Partial<MixMap>> | undefined, dataUpdateCount = 1) => {
  const interval = mixMapsQuery(ids).refetchInterval as unknown as (q: Query) => number | false;
  return interval({ state: { data, dataUpdateCount } } as unknown as Query);
};

describe('mix maps', () => {
  it('asks again for songs not measured yet, or measured by an older version, until they’re current', () => {
    expect(nextAsk(['a', 'b'], { a: { version: MIX_MAP_VERSION } })).toBe(30_000);
    expect(nextAsk(['a'], { a: { version: MIX_MAP_VERSION - 1 } })).toBe(30_000);
    expect(nextAsk(['a', 'b'], { a: { version: MIX_MAP_VERSION }, b: { version: MIX_MAP_VERSION } })).toBe(false);
  });

  it('gives up after a few tries, and waits for a first answer', () => {
    expect(nextAsk(['a'], { a: { version: MIX_MAP_VERSION - 1 } }, 10)).toBe(false);
    expect(nextAsk(['a'], undefined)).toBe(false);
  });
});
