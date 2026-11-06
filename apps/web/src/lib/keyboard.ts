import { create } from 'zustand';
import { useMediaQuery } from './useMediaQuery';

/*
 * Whether this device has a keyboard to press shortcuts on. No browser says so outright, so two signs count:
 * - a fine pointer (a mouse or a trackpad, which come with a keyboard: desktops, laptops, an iPad on a Magic
 *   Keyboard), known at once;
 * - a key pressed outside a text field (an iPad in a keyboard case, which brings no pointer), remembered on this
 *   device from then on. The on-screen keyboard of a phone or a tablet only ever types into a field, so it never
 *   counts.
 * Phones and tablets without a keyboard have neither, and don't list shortcuts they can't use.
 */

export const KEYBOARD_KEY = 'playarr.keyboard';

function remembered(): boolean {
  try {
    return localStorage.getItem(KEYBOARD_KEY) === '1';
  } catch {
    return false;
  }
}

export const useKeyboardSeen = create<{ seen: boolean }>(() => ({ seen: remembered() }));

/** Typing into a field: the on-screen keyboard does it too, so it says nothing about a keyboard. */
export const isTyping = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"]');

/** A key went down (AppShell's shortcuts hear them all): outside a field, there's a keyboard. */
export function noteKeyPress(e: KeyboardEvent) {
  if (useKeyboardSeen.getState().seen || isTyping(e.target) || e.isComposing) return;
  useKeyboardSeen.setState({ seen: true });
  try {
    localStorage.setItem(KEYBOARD_KEY, '1');
  } catch {
    // Storage full or blocked: known for this visit.
  }
}

/** This device has a keyboard: a fine pointer, or a key pressed outside a field. */
export function useHasKeyboard(): boolean {
  const pointer = useMediaQuery('(any-pointer: fine)');
  const seen = useKeyboardSeen((s) => s.seen);
  return pointer || seen;
}
