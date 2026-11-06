import { afterEach, describe, expect, it, vi } from 'vitest';
import { toastWithUndo, useToasts } from './toast';

afterEach(() => useToasts.setState({ toasts: [] }));

const only = () => useToasts.getState().toasts[0]!;

describe('toastWithUndo', () => {
  it('runs the Undo when it’s pressed, and not what waited on the toast', () => {
    const undo = vi.fn();
    const done = vi.fn();
    toastWithUndo('Removed “Teardrop” from the queue', undo, done);
    useToasts.getState().act(only().id);
    expect(undo).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
    expect(useToasts.getState().toasts).toEqual([]);
  });

  it('goes ahead with what waited once the Undo has gone by', () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      toastWithUndo('Removed “OK Computer” from Requests', () => {}, done);
      vi.advanceTimersByTime(5999);
      expect(done).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(done).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits while the toast is held, then gives it its time again', () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      toastWithUndo('Removed “Kid A” from Requests', () => {}, done);
      useToasts.getState().hold(only().id, true);
      vi.advanceTimersByTime(60_000);
      expect(done).not.toHaveBeenCalled();
      useToasts.getState().hold(only().id, false);
      vi.advanceTimersByTime(6000);
      expect(done).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes way for newer toasts, going ahead with what an older one waited for', () => {
    const done = vi.fn();
    toastWithUndo('Removed “Amnesiac” from Requests', () => {}, done);
    for (const n of [1, 2, 3]) toastWithUndo(`Removed “Song ${n}” from the queue`, () => {});
    expect(useToasts.getState().toasts.map((t) => t.message)).not.toContain('Removed “Amnesiac” from Requests');
    expect(done).toHaveBeenCalledOnce();
  });
});
