import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reduceMotionNow, useReduceMotion } from './motion';
import { usePrefs } from './prefs';

/** The system's Reduce Motion, on or off. */
const system = (reduce: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)' && reduce,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  usePrefs.setState({ motion: 'system' });
});

describe('Reduce Motion', () => {
  it('follows the system while Settings → Appearance → Motion says System', () => {
    usePrefs.setState({ motion: 'system' });
    system(true);
    expect(renderHook(() => useReduceMotion()).result.current).toBe(true);
    expect(reduceMotionNow()).toBe(true);
    system(false);
    expect(renderHook(() => useReduceMotion()).result.current).toBe(false);
    expect(reduceMotionNow()).toBe(false);
  });

  it('keeps still when the setting says Reduced, and moves when it says Full, whatever the system says', () => {
    system(false);
    usePrefs.setState({ motion: 'reduce' });
    expect(renderHook(() => useReduceMotion()).result.current).toBe(true);
    expect(reduceMotionNow()).toBe(true);
    system(true);
    usePrefs.setState({ motion: 'full' });
    expect(renderHook(() => useReduceMotion()).result.current).toBe(false);
    expect(reduceMotionNow()).toBe(false);
  });
});
