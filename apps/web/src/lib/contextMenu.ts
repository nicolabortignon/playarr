import { useRef, type MouseEvent, type PointerEvent } from 'react';

export interface Point {
  x: number;
  y: number;
  /** Pressed by a finger, which hides what's under it: the menu opens a little below. */
  touch?: boolean;
}

/** How long a finger stays down for the menu: about what iOS waits. */
export const HOLD_MS = 500;
/** A finger that moves further than this is scrolling, not pressing. */
const SLOP = 10;
/** A contextmenu this soon after a pointer went down came from that pointer; later, from the keyboard's menu key. */
const SAME_GESTURE_MS = 1500;
/** After a long press, how long the click that may end it is swallowed once the finger lifts. */
const SWALLOW_MS = 400;

/**
 * The menu of a row or a card from a right-click (with a mouse), a long press (on a touch screen) or the keyboard's
 * menu key, as long-press does on iOS. Spread the handlers on the row; `open` gets the point, or nothing for the
 * keyboard (open by the ⋯ button then, and focus the first item).
 *
 * - A long press doesn't also play: the click that may end it is swallowed.
 * - Scrolling cancels it: the browser takes the touch over (pointercancel), or the finger moves.
 * - A drag handle (`data-drag-handle`) starts a drag at once, so it never waits for a long press.
 * - With a mouse, a link inside keeps the browser's own menu (Open in new tab), unless `links` says otherwise (a card,
 *   which is a link all over).
 */
export function useContextMenu(open: (at: Point | undefined, keyboard: boolean) => void, { links = 'native' as 'native' | 'ours' } = {}) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = useRef<Point | null>(null);
  const fired = useRef(false);
  const down = useRef({ type: '', at: -Infinity });

  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    start.current = null;
  };
  const release = () => {
    cancel();
    if (fired.current) setTimeout(() => (fired.current = false), SWALLOW_MS);
  };
  // React passes on events from portals inside (the menu itself, drawn at the end of the page): not the row's.
  const outside = (e: { currentTarget: EventTarget; target: EventTarget }) => !(e.currentTarget as Node).contains(e.target as Node);

  return {
    onPointerDown(e: PointerEvent) {
      if (outside(e)) return;
      cancel();
      fired.current = false;
      down.current = { type: e.pointerType, at: Date.now() };
      if (e.pointerType === 'mouse' || e.button !== 0 || (e.target as Element).closest('[data-drag-handle]')) return;
      const at = { x: e.clientX, y: e.clientY, touch: true };
      start.current = at;
      timer.current = setTimeout(() => {
        timer.current = undefined;
        start.current = null;
        fired.current = true;
        open(at, false);
      }, HOLD_MS);
    },
    onPointerMove(e: PointerEvent) {
      const s = start.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > SLOP) cancel();
    },
    onPointerUp: release,
    onPointerCancel: release,
    onContextMenu(e: MouseEvent) {
      if (outside(e)) return;
      // A long press opened it already (Android sends a contextmenu too).
      if (fired.current) return e.preventDefault();
      const pointer = Date.now() - down.current.at < SAME_GESTURE_MS;
      const mouse = pointer && down.current.type === 'mouse';
      if (mouse && links === 'native' && (e.target as Element).closest('a[href]')) return;
      e.preventDefault();
      cancel();
      // A touch's contextmenu (Android) may be followed by a click: swallow it too.
      if (pointer && !mouse) fired.current = true;
      open(pointer ? { x: e.clientX, y: e.clientY, touch: !mouse } : undefined, !pointer);
    },
    onClickCapture(e: MouseEvent) {
      if (!fired.current || outside(e)) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}
