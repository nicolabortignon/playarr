import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Skeleton } from './States';

/**
 * The box the cover gets. On a phone it sits above the text, centered, small enough that the action row shows on the
 * first screen of a 375 px phone (with a two-line title and meta line, under the mini player); from md it sits beside
 * the text. An artist's picture is a smaller circle.
 */
const COVER = 'mx-auto w-[min(64vw,256px)] shrink-0 md:mx-0 md:w-48 lg:w-60 xl:w-72';
const ROUND = 'mx-auto w-[min(40vw,160px)] shrink-0 md:mx-0 md:w-40 lg:w-48';

/**
 * The header of everything you can play (album, playlist, mix, Favorites, artist), in one order: the cover, a kicker
 * saying what it is, the title, one meta line, then the action row (`children`). The cover is drawn by the page
 * (a Cover, a PlaylistCover, a MixCover) to fill the box it's given here; an artist's photo hero has none.
 */
export function DetailHeader({
  cover,
  round,
  kicker,
  title,
  titleAction,
  heading,
  meta,
  overArt,
  children,
  className,
}: {
  /** The page's art, filling its box. None on an artist's photo, which is drawn behind the header. */
  cover?: ReactNode;
  /** An artist's picture: a circle, smaller than a cover. */
  round?: boolean;
  /** What it is: "Album", "Live album", "Playlist", "Made for you", "Artist". */
  kicker: ReactNode;
  /** The h1's content: the name (or an artist's logo, with the name for screen readers). */
  title: ReactNode;
  /** Beside the h1, shown while it's hovered or the action has the focus: a playlist's Rename (a pencil). */
  titleAction?: ReactNode;
  /** In place of the h1: a playlist's name and description being edited. */
  heading?: ReactNode;
  /** The one line under the title (`joinMeta`): who, when, how many, how long. */
  meta?: ReactNode;
  /** Drawn over art (a tinted wash, a photo): the meta line is paper-dim rather than muted (docs/design.md, Color). */
  overArt?: boolean;
  /** The action row. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={className}>
      <div className="flex flex-col gap-5 md:flex-row md:items-end md:gap-8 lg:gap-10">
        {cover && <div className={cn(round ? ROUND : COVER, 'animate-rise')}>{cover}</div>}
        <div className="min-w-0 flex-1 animate-rise [animation-delay:80ms]">
          <div className="type-kicker text-muted">{kicker}</div>
          {heading ??
            (titleAction ? (
              <div className="group/title mt-1.5 flex items-center gap-2">
                <h1 className={cn('min-w-0 type-page-title text-balance text-paper', overArt && 'drop-shadow-2xl')}>{title}</h1>
                {titleAction}
              </div>
            ) : (
              <h1 className={cn('mt-1.5 type-page-title text-balance text-paper', overArt && 'drop-shadow-2xl')}>{title}</h1>
            ))}
          {meta && (
            <div className={cn('mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 type-meta', overArt ? 'text-paper-dim' : 'text-muted')}>{meta}</div>
          )}
        </div>
      </div>
      {children && <div className="mt-6 md:mt-8">{children}</div>}
    </header>
  );
}

/** The meta line's parts with a dot between them, leaving out the empty ones ("1998 · 11 songs · 63 min"). */
export function joinMeta(...parts: ReactNode[]): ReactNode[] {
  return parts
    .filter((p) => p !== undefined && p !== null && p !== false && p !== '')
    .flatMap((p, i) => [
      ...(i ? [<span key={`dot-${i}`} aria-hidden>·</span>] : []),
      <span key={i} className="min-w-0">
        {p}
      </span>,
    ]);
}

/** The detail header's shape while the page loads, so nothing moves when it arrives. */
export function DetailHeaderSkeleton({ round }: { round?: boolean }) {
  return (
    <div aria-busy="true">
      <div className="flex flex-col gap-5 md:flex-row md:items-end md:gap-8 lg:gap-10">
        <Skeleton className={cn(round ? ROUND : COVER, 'aspect-square', round && 'rounded-full')} />
        <div className="min-w-0 flex-1 space-y-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-10 w-3/4 md:h-14" />
          <Skeleton className="h-4 w-56 max-w-full" />
        </div>
      </div>
      <Skeleton className="mt-6 h-12 w-72 max-w-full rounded-full md:mt-8" />
    </div>
  );
}
