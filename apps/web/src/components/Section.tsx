import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { Link, useNavigate } from 'react-router';
import { cn } from '../lib/cn';
import { nearestEdge, scrollForPoint } from '../lib/shelfScroll';
import { KeepMounted } from '../lib/viewport';
import { IconButton } from './Button';

export function SectionHeader({ title, kicker, to, action }: { title: string; kicker?: string; to?: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4 md:mb-5">
      <div>
        {kicker && <div className="mb-1 type-kicker text-muted">{kicker}</div>}
        <h2 className="type-section-title text-paper">{title}</h2>
      </div>
      <div className="flex items-center gap-1">
        {action}
        {to && (
          <Link to={to} className="rounded-full px-3 py-1.5 type-kicker text-muted transition hover:text-paper">
            See all
          </Link>
        )}
      </div>
    </div>
  );
}

/** Every card on a shelf is this wide (docs/design.md): albums, playlists, mixes and artists alike. */
export const SHELF_CARD = 'w-[42vw] max-w-52 shrink-0 snap-start sm:w-44 md:w-52';

/**
 * Horizontal row with arrow buttons on pointer devices, and a thin line under it showing where it's scrolled to. It
 * snaps to cards on touch screens only: with a trackpad, snapping fights the scroll's own momentum. Scrolling past its
 * ends doesn't swipe the browser back a page.
 */
export function Shelf({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Most of a screen along, landing on a card's edge (the row only snaps to cards on touch screens). The row is
  // positioned, so the cards' offsets are from its start.
  const scroll = (dir: 1 | -1) => {
    const row = ref.current;
    if (!row) return;
    const pad = parseFloat(getComputedStyle(row).scrollPaddingLeft) || 0;
    const goal = row.scrollLeft + dir * row.clientWidth * 0.8;
    const edges = [...row.children].map((card) => (card as HTMLElement).offsetLeft - pad);
    row.scrollTo({ left: nearestEdge(edges, goal), behavior: 'smooth' });
  };
  return (
    <div className="group/shelf relative -mx-5 md:-mx-10">
      <div
        ref={ref}
        className="scrollbar-none relative flex snap-x snap-mandatory scroll-px-5 gap-4 overflow-x-auto overflow-y-hidden overscroll-x-contain px-5 pb-2 md:scroll-px-10 md:gap-6 md:px-10 pointer-fine:snap-none"
      >
        <KeepMounted value>{children}</KeepMounted>
      </div>
      <ScrollIndicator target={ref} />
      {[-1, 1].map((dir) => (
        <button
          key={dir}
          type="button"
          aria-label={dir < 0 ? 'Scroll left' : 'Scroll right'}
          onClick={() => scroll(dir as 1 | -1)}
          className={`absolute top-[38%] hidden size-10 -translate-y-1/2 place-items-center rounded-full border border-line bg-ink-800/90 text-paper opacity-0 shadow-xl backdrop-blur transition group-hover/shelf:opacity-100 hover:bg-ink-700 pointer-fine:grid ${dir < 0 ? 'left-3' : 'right-3'}`}
        >
          {dir < 0 ? <ChevronLeft className="size-5" /> : <ChevronRight className="size-5" />}
        </button>
      ))}
    </div>
  );
}

/**
 * In place of a scrollbar: a hairline across most of the row, with a brighter stretch on it for the part in view, which
 * slides along as the row scrolls. Press anywhere on it to glide the row there, or drag along it. Only there when the row is wider than
 * the screen. Moved by hand, not by React, so scrolling doesn't re-render the row.
 */
function ScrollIndicator({ target }: { target: RefObject<HTMLDivElement | null> }) {
  const track = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = target.current;
    if (!row) return;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const { scrollLeft, scrollWidth, clientWidth } = row;
      const over = scrollWidth - clientWidth;
      track.current!.style.visibility = over > 1 ? 'visible' : 'hidden';
      if (over <= 1) return;
      const size = clientWidth / scrollWidth;
      thumb.current!.style.width = `${size * 100}%`;
      // translateX's percentages are of the thumb's own width.
      thumb.current!.style.transform = `translateX(${(((scrollLeft / over) * (1 - size)) / size) * 100}%)`;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    draw();
    row.addEventListener('scroll', schedule, { passive: true });
    // The row's width, and its cards' (they mount, load, come and go), change how far it scrolls.
    const sizes = new ResizeObserver(schedule);
    const watch = () => {
      sizes.disconnect();
      sizes.observe(row);
      for (const card of row.children) sizes.observe(card);
      schedule();
    };
    watch();
    const cards = new MutationObserver(watch);
    cards.observe(row, { childList: true });
    return () => {
      row.removeEventListener('scroll', schedule);
      sizes.disconnect();
      cards.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [target]);
  // Pressing anywhere on the line glides the row there; dragging moves it along with the pointer, held where it was
  // grabbed when that's on the marker. The row stops snapping to cards while dragged.
  const drag = useRef<{ line: DOMRect; grab: number } | null>(null);
  const to = (row: HTMLDivElement, x: number, behavior: ScrollBehavior) => {
    const { line, grab } = drag.current!;
    row.scrollTo({ left: scrollForPoint((x - line.left) / line.width - grab, row.clientWidth, row.scrollWidth), behavior });
  };
  const press = (e: PointerEvent<HTMLDivElement>) => {
    const row = target.current;
    const line = e.currentTarget.firstElementChild!.getBoundingClientRect();
    if (!row || !line.width || e.button !== 0) return;
    const marker = thumb.current!.getBoundingClientRect();
    const onMarker = e.clientX >= marker.left && e.clientX <= marker.right;
    drag.current = { line, grab: onMarker ? (e.clientX - (marker.left + marker.width / 2)) / line.width : 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
    row.style.scrollSnapType = 'none';
    if (!onMarker) to(row, e.clientX, 'smooth');
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current && target.current) to(target.current, e.clientX, 'instant');
  };
  const release = () => {
    drag.current = null;
    if (target.current) target.current.style.scrollSnapType = '';
  };
  // The line is a hairline; the space round it takes the pointer. The arrows and keys scroll the row for everyone else.
  return (
    <div
      ref={track}
      aria-hidden
      onPointerDown={press}
      onPointerMove={move}
      onPointerUp={release}
      onPointerCancel={release}
      className="group/line invisible mx-auto mt-1 w-[90%] cursor-grab touch-pan-y py-2 select-none active:cursor-grabbing"
    >
      <div className="relative h-px bg-paper/[0.04] transition-colors group-hover/line:bg-paper/[0.07]">
        <div ref={thumb} className="absolute top-0 left-0 h-px bg-paper/20 transition-[width,background-color] duration-300 group-hover/line:bg-paper/35" />
      </div>
    </div>
  );
}

/**
 * Back, on phones: the installed app has no browser bar. Goes back where there's somewhere to go back
 * to in the app, else to `fallback` (a link opened straight to this page).
 */
export function BackButton({ fallback, className }: { fallback: string; className?: string }) {
  const navigate = useNavigate();
  const back = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(fallback);
  };
  return (
    <IconButton label="Back" onClick={back} className={cn('bg-ink-950/55 text-paper ring-1 ring-paper/10 md:hidden', className)}>
      <ChevronLeft className="size-5" />
    </IconButton>
  );
}
