import { Ellipsis, type LucideIcon } from 'lucide-react';
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';
import type { Point } from '../lib/contextMenu';
import { useOverlay } from '../lib/overlays';
import { IconButton } from './Button';

export interface MenuItem {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
}

/** A line between groups of items: the place's own actions (Remove from playlist, Move up…) come after it. */
export const DIVIDER = 'divider';
export type MenuEntry = MenuItem | typeof DIVIDER;

/** Opening a menu from elsewhere: a right-click, a long press or the menu key on its row (lib/contextMenu.ts). */
export interface MenuHandle {
  /** At a point; without one, by the ⋯ button. From the keyboard, the first item takes the focus. */
  open: (at?: Point, keyboard?: boolean) => void;
}

const WIDTH = 220;
const ITEM = 40;
const LINE = 13;
const PADDING = 12;
/** Room left between a menu and the screen's edges. */
const EDGE = 8;
/** Opened by a finger: the menu starts this far below it, so the finger doesn't hide the first item. */
const UNDER_FINGER = 24;
/** After the finger that opened a menu lifts, how long its items still ignore the click that lifting may send. */
const LIFT_MS = 300;
/** A click this soon after Enter or Space on the ⋯ came from those keys. */
const KEY_CLICK_MS = 1000;

/** The entries to draw: a group may be empty, so no line first, last or twice in a row. */
function tidy(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) if (e !== DIVIDER || (out.length && out[out.length - 1] !== DIVIDER)) out.push(e);
  if (out[out.length - 1] === DIVIDER) out.pop();
  return out;
}

/**
 * "⋯" button with a popover menu, portaled so it escapes scroll/overflow containers. Its row can open the same menu at
 * a point through `ref` (lib/contextMenu.ts); a card, which has no ⋯, uses ContextMenu.
 */
export function Menu({
  items,
  label,
  size,
  className,
  trigger,
  ref,
}: {
  items: MenuEntry[];
  /** What it's about, never just "More": "More for “Teardrop”", "More for “Late night”", "More for Sam". */
  label: string;
  /** Large and outlined in a page's action row; else 44 to tap on touch screens, 36 with a mouse. */
  size?: 'regular' | 'large';
  className?: string;
  /** What the button shows, in place of ⋯. */
  trigger?: ReactNode;
  ref?: Ref<MenuHandle>;
}) {
  const [open, setOpen] = useState<{ at?: Point; keyboard: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  // When Enter or Space last went down on the ⋯ (0: since then, a pointer did).
  const keyAt = useRef(0);
  const entries = tidy(items);
  useImperativeHandle(ref, () => ({ open: (at, keyboard = false) => setOpen({ at, keyboard }) }), []);
  if (!entries.length) return null;

  return (
    <>
      <IconButton
        ref={btn}
        label={label}
        size={size}
        aria-haspopup="menu"
        aria-expanded={!!open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') keyAt.current = Date.now();
        }}
        onPointerDown={() => (keyAt.current = 0)}
        onClick={(e) => {
          e.stopPropagation();
          // From the keyboard only when Enter or Space just went down on it: a tap, a click and a click made by a
          // script or an assistive tool (no pointer, no keys) open it without the focus ring round its first item.
          const keyboard = e.detail === 0 && Date.now() - keyAt.current < KEY_CLICK_MS;
          keyAt.current = 0;
          setOpen((o) => (o ? null : { keyboard }));
        }}
        className={className}
      >
        {trigger ?? <Ellipsis className={size === 'large' ? 'size-5' : 'size-4.5'} />}
      </IconButton>
      {open && (
        <Popover entries={entries} label={label} at={open.at} button={btn.current} keyboard={open.keyboard} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

/**
 * A menu with no ⋯ of its own, open while it's mounted: a card mounts it on a right-click or a long press, so the
 * cards of a long grid cost nothing until then.
 */
export function ContextMenu({
  items,
  label,
  at,
  keyboard = false,
  onClose,
}: {
  items: MenuEntry[];
  label: string;
  at: Point;
  keyboard?: boolean;
  onClose: () => void;
}) {
  const entries = tidy(items);
  if (!entries.length) return null;
  return <Popover entries={entries} label={label} at={at} button={null} keyboard={keyboard} onClose={onClose} />;
}

function Popover({
  entries,
  label,
  at,
  button,
  keyboard,
  onClose,
}: {
  entries: MenuEntry[];
  label: string;
  /** Where a right-click or a long press was; else beside `button`. */
  at?: Point;
  button: HTMLButtonElement | null;
  keyboard: boolean;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, up: false });
  // Opened by a long press, the finger is still down, and lifting it may click whatever is under it: the items take
  // clicks only once it's up (and a moment after), or once a press lands on them.
  const ready = useRef(!at?.touch);
  const close = useRef(onClose);
  close.current = onClose;
  // On top of whatever it was opened over (a dialog, Now Playing): Escape closes the menu alone.
  useOverlay(true, () => close.current());

  useEffect(() => {
    if (ready.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lifted = () => (timer = setTimeout(() => (ready.current = true), LIFT_MS));
    document.addEventListener('pointerup', lifted, { once: true });
    document.addEventListener('pointercancel', lifted, { once: true });
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerup', lifted);
      document.removeEventListener('pointercancel', lifted);
    };
  }, []);

  const height = entries.reduce((h, e) => h + (e === DIVIDER ? LINE : ITEM), PADDING);
  useLayoutEffect(() => {
    const fit = (left: number) => Math.min(Math.max(EDGE, left), window.innerWidth - WIDTH - EDGE);
    if (at || !button) {
      // A finger hides what's under it: from a touch, the menu opens below it (above it, near the bottom).
      const point = at ?? { x: EDGE, y: EDGE };
      const below = point.y + (point.touch ? UNDER_FINGER : 0);
      const up = below + height > window.innerHeight - EDGE;
      const left = point.x + WIDTH > window.innerWidth - EDGE ? point.x - WIDTH : point.x;
      setPos({ top: Math.max(EDGE, up ? point.y - height - 4 : below), left: fit(left), up });
      return;
    }
    const r = button.getBoundingClientRect();
    const up = r.bottom + height > window.innerHeight - 16;
    setPos({ top: up ? r.top - height - 4 : r.bottom + 4, left: fit(r.right - WIDTH), up });
  }, [height, at, button]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dismiss = (e: Event) => {
      if (e.type === 'pointerdown' && (menu.current?.contains(e.target as Node) || button?.contains(e.target as Node))) return;
      close.current();
    };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    // From the keyboard, the first item; from a pointer, the menu itself (the arrows still reach the items), so a tap
    // doesn't draw the focus ring round "Play next".
    if (keyboard) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    else menu.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      // Back where it was opened from, so keyboard users carry on from there: the ⋯ button, else what had the focus.
      const back = button ?? previous;
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, [button, keyboard]);

  /** Up/Down (wrapping), Home and End move between the items. */
  const moveFocus = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = { ArrowDown: at + 1, ArrowUp: at < 0 ? items.length - 1 : at - 1, Home: 0, End: items.length - 1 }[e.key];
    if (next === undefined || !items.length) return;
    e.preventDefault();
    items[(next + items.length) % items.length]!.focus();
  };

  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={moveFocus}
      onPointerDown={() => (ready.current = true)}
      style={{ top: pos.top, left: pos.left }}
      className={cn(
        'fixed z-[150] w-[220px] origin-top-right animate-[fade_.15s_ease-out] rounded-lg border border-line bg-ink-800/95 p-1.5 shadow-2xl shadow-black/60 outline-none backdrop-blur-xl',
        pos.up && 'origin-bottom-right',
      )}
    >
      {entries.map((entry, i) =>
        entry === DIVIDER ? (
          <div key={`line-${i}`} role="separator" className="mx-2 my-1.5 h-px bg-line" />
        ) : (
          <button
            key={entry.label}
            role="menuitem"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (!ready.current) return;
              onClose();
              entry.onSelect();
            }}
            className="flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm text-paper-dim transition outline-none hover:bg-paper/8 hover:text-paper focus-visible:bg-paper/8 focus-visible:text-paper"
          >
            <entry.icon className="size-4 shrink-0" />
            {entry.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
