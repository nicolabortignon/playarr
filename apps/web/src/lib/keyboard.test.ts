import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEYBOARD_KEY, noteKeyPress, useHasKeyboard, useKeyboardSeen } from './keyboard';

/** A device whose pointer is fine (a mouse, a trackpad) or isn't (a finger). */
const pointer = (fine: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(any-pointer: fine)' && fine, media: query, addEventListener() {}, removeEventListener() {} }));

const press = (target: EventTarget, key = 'k') => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true });
  Object.defineProperty(e, 'target', { value: target });
  act(() => noteKeyPress(e));
};

beforeEach(() => {
  localStorage.removeItem(KEYBOARD_KEY);
  useKeyboardSeen.setState({ seen: false });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useHasKeyboard', () => {
  it('counts a mouse or a trackpad as a keyboard at once', () => {
    pointer(true);
    expect(renderHook(() => useHasKeyboard()).result.current).toBe(true);
  });

  it('has none on a touch screen until a key is pressed outside a field, then remembers it', () => {
    pointer(false);
    const { result } = renderHook(() => useHasKeyboard());
    expect(result.current).toBe(false);
    // The on-screen keyboard only types into fields.
    press(document.createElement('input'));
    press(document.createElement('textarea'));
    expect(result.current).toBe(false);
    press(document.body, ' ');
    expect(result.current).toBe(true);
    expect(localStorage.getItem(KEYBOARD_KEY)).toBe('1');
  });
});
