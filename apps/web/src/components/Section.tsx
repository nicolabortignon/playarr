import { ChevronLeft, ChevronRight, RotateCw } from 'lucide-react';
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Link, useNavigate } from 'react-router';
import { KeepMounted } from '../lib/viewport';

export function SectionHeader({ title, kicker, to, action }: { title: string; kicker?: string; to?: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4 md:mb-5">
      <div>
        {kicker && <div className="mb-1 font-mono text-[11px] tracking-[0.2em] text-muted uppercase">{kicker}</div>}
        <h2 className="font-display text-2xl leading-none text-paper md:text-[1.75rem]">{title}</h2>
      </div>
      <div className="flex items-center gap-1">
        {action}
        {to && (
          <Link to={to} className="rounded-full px-3 py-1.5 font-mono text-[11px] tracking-[0.15em] text-muted uppercase transition hover:text-paper">
            See all
          </Link>
        )}
      </div>
    </div>
  );
}

/** Horizontal, snap-scrolling row with arrow buttons on pointer devices, and a thin line under it showing where it's scrolled to. */
export function Shelf({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.8, behavior: 'smooth' });
  return (
    <div className="group/shelf relative -mx-5 md:-mx-10">
      <div
        ref={ref}
        className="scrollbar-none flex snap-x snap-mandatory scroll-px-5 gap-4 overflow-x-auto px-5 pb-2 md:scroll-px-10 md:gap-6 md:px-10 overflow-y-hidden"
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
 * slides along as the row scrolls. Only there when the row is wider than the screen. Moved by hand, not by React, so
 * scrolling doesn't re-render the row.
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
  return (
    <div ref={track} aria-hidden className="invisible relative mx-auto mt-3 h-px w-[90%] bg-paper/10">
      <div ref={thumb} className="absolute -top-px left-0 h-[3px] rounded-full bg-paper/55 transition-[width] duration-300" />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-ink-800 ${className ?? ''}`} />;
}

/** A page that couldn't load: what went wrong, a retry where there's one, and a way home. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="mx-auto mt-24 max-w-md px-5 text-center" role="alert">
      <div className="font-display text-3xl text-paper">Something skipped.</div>
      <p className="mt-3 text-sm text-muted">{error instanceof Error ? error.message : 'Unknown error'}</p>
      <div className="mt-6 flex justify-center gap-3">
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-10 items-center gap-2 rounded-full bg-accent px-5 text-[14px] font-medium text-accent-ink transition hover:brightness-110"
          >
            <RotateCw className="size-4" /> Try again
          </button>
        )}
        <Link
          to="/"
          className="inline-flex h-10 items-center rounded-full border border-line px-5 text-[14px] text-paper transition hover:bg-paper/5"
        >
          Back home
        </Link>
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
    <button
      type="button"
      onClick={back}
      aria-label="Back"
      className={`grid size-10 place-items-center rounded-full bg-ink-950/55 text-paper ring-1 ring-paper/10 md:hidden ${className ?? ''}`}
    >
      <ChevronLeft className="size-5" />
    </button>
  );
}
