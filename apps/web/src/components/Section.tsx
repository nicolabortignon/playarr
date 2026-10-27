import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { Link } from 'react-router';

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

/** Horizontal, snap-scrolling row with arrow buttons on pointer devices. */
export function Shelf({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.8, behavior: 'smooth' });
  return (
    <div className="group/shelf relative -mx-5 md:-mx-10">
      <div
        ref={ref}
        className="scrollbar-none flex snap-x snap-mandatory scroll-px-5 gap-4 overflow-x-auto px-5 pb-2 md:scroll-px-10 md:gap-6 md:px-10"
      >
        {children}
      </div>
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

export function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-ink-800 ${className ?? ''}`} />;
}

export function ErrorState({ error }: { error: unknown }) {
  return (
    <div className="mx-auto mt-24 max-w-md text-center">
      <div className="font-display text-3xl text-paper">Something skipped.</div>
      <p className="mt-3 text-sm text-muted">{error instanceof Error ? error.message : 'Unknown error'}</p>
    </div>
  );
}
