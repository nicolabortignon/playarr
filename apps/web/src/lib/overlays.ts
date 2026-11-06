import { useEffect, useRef } from 'react';

/**
 * What's open over the page, in the order it opened: Now Playing, dialogs, menus. Escape closes only the one on top, so
 * a menu over a dialog over Now Playing closes one at a time (docs/design.md, Rows, menus and toasts).
 */
const layers: { close: () => void }[] = [];

function onKeyDown(e: KeyboardEvent) {
  // Something took the key for itself (a field's own Escape), or it ends a composition in a field (Japanese input).
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
  const top = layers[layers.length - 1];
  if (!top) return;
  e.preventDefault();
  top.close();
}

/** Puts an overlay on top of the stack; the function returned takes it off, wherever it is by then. */
export function openOverlay(close: () => void): () => void {
  const layer = { close };
  if (!layers.length) window.addEventListener('keydown', onKeyDown);
  layers.push(layer);
  return () => {
    const at = layers.indexOf(layer);
    if (at >= 0) layers.splice(at, 1);
    if (!layers.length) window.removeEventListener('keydown', onKeyDown);
  };
}

/**
 * While `open`, the overlay is on the stack, and Escape calls `close` when it's on top. Callers may pass a new `close`
 * on every render; the latest one is called, and the overlay keeps its place.
 */
export function useOverlay(open: boolean, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => (open ? openOverlay(() => latest.current()) : undefined), [open]);
}
