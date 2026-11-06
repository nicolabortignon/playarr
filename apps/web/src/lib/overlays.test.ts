import { afterEach, describe, expect, it, vi } from 'vitest';
import { openOverlay } from './overlays';

const escape = (init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(e);
  return e;
};

const opened: (() => void)[] = [];
const open = (close: () => void) => opened.push(openOverlay(close));
afterEach(() => opened.splice(0).forEach((off) => off()));

describe('the overlay stack', () => {
  it('closes only the one on top, then the one under it', () => {
    const below = vi.fn();
    const top = vi.fn();
    open(below);
    const offTop = openOverlay(top);
    escape();
    expect(top).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
    offTop();
    escape();
    expect(below).toHaveBeenCalledTimes(1);
  });

  it('keeps an overlay’s place when one under it goes first', () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = openOverlay(first);
    open(second);
    offFirst();
    escape();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('leaves Escape alone with nothing open, when something took it first, and while composing', () => {
    expect(escape().defaultPrevented).toBe(false);
    const close = vi.fn();
    open(close);
    const taken = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    taken.preventDefault();
    document.body.dispatchEvent(taken);
    escape({ isComposing: true });
    expect(close).not.toHaveBeenCalled();
    expect(escape().defaultPrevented).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
