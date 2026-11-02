import { describe, expect, it } from 'vitest';
import { MIX_MAP_VERSION } from './index.ts';

describe('@playarr/mix', () => {
  it('exports the mix map version', () => {
    expect(MIX_MAP_VERSION).toBe(7);
  });
});
