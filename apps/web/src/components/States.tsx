import { CircleAlert, RotateCw, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Button } from './Button';
import { LuckyButton } from './LuckyButton';

/*
 * A page's empty, loading and error states, one way each (docs/design.md, Empty, loading and error): `EmptyState` for a
 * list with nothing in it, skeletons shaped like what they stand for, `ErrorState` for a page that couldn't load and
 * `InlineError` for a part of one (a panel, a section, a dialog).
 */

/** The look an empty page and a failed one share: an icon in a circle, one line, a quieter one, the way on. */
function StateLayout({
  icon: Icon,
  tone,
  title,
  hint,
  actions,
  className,
  role,
}: {
  icon: LucideIcon;
  tone: 'accent' | 'danger';
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  className?: string;
  role?: 'alert';
}) {
  return (
    <div role={role} className={cn('mx-auto flex max-w-md animate-rise flex-col items-center px-5 py-12 text-center md:py-16', className)}>
      <span aria-hidden className={cn('grid size-14 place-items-center rounded-full bg-ink-800 ring-1 ring-line', tone === 'accent' ? 'text-accent' : 'text-danger')}>
        <Icon className="size-6" />
      </span>
      <p className="mt-5 type-section-title text-balance text-paper">{title}</p>
      {hint && <p className="mt-3 type-body text-balance text-paper-dim">{hint}</p>}
      {actions && <div className="mt-7 flex flex-wrap justify-center gap-3">{actions}</div>}
    </div>
  );
}

/** What fills an empty page: a link, a button, or Feeling lucky (songs in the queue at once). */
export type EmptyAction = { label: string; icon?: ReactNode; to: string } | { label: string; icon?: ReactNode; onClick: () => void } | 'lucky';

/**
 * A list with nothing in it yet: an icon, one line in the app's voice (warm, brief, specific: "Songs you heart land
 * here."), and the action that fills it, as a large primary button. A second, quieter line only where the first can't
 * say it all.
 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
  className,
}: {
  /** The page's own glyph (lucide): a heart for Favorites, a disc for Albums. */
  icon: LucideIcon;
  title: ReactNode;
  hint?: ReactNode;
  action?: EmptyAction;
  className?: string;
}) {
  return (
    <StateLayout
      icon={icon}
      tone="accent"
      title={title}
      hint={hint}
      className={className}
      actions={
        action === 'lucky' ? (
          <LuckyButton />
        ) : action && 'to' in action ? (
          <Button variant="primary" size="large" icon={action.icon} to={action.to}>
            {action.label}
          </Button>
        ) : action ? (
          <Button variant="primary" size="large" icon={action.icon} onClick={action.onClick}>
            {action.label}
          </Button>
        ) : undefined
      }
    />
  );
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : typeof error === 'string' ? error : undefined);

/** A page that couldn't load: what went wrong, a retry where there's one, and a way home. */
export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <StateLayout
      role="alert"
      icon={CircleAlert}
      tone="danger"
      title="Something skipped."
      hint={messageOf(error) ?? 'Unknown error'}
      className={cn('mt-12', className)}
      actions={
        <>
          {onRetry && (
            <Button variant="primary" icon={<RotateCw />} onClick={onRetry}>
              Try again
            </Button>
          )}
          <Button to="/">Back home</Button>
        </>
      }
    />
  );
}

/**
 * Part of a page that couldn't load or save, in its place (a panel, a section, a dialog): a danger icon, what
 * happened and why, and Try again when there's a retry. `children` says what happened ("Couldn’t reach
 * ListenBrainz"); `error` adds the reason after it.
 */
export function InlineError({
  children,
  error,
  onRetry,
  retrying,
  className,
}: {
  children?: ReactNode;
  error?: unknown;
  onRetry?: () => void;
  /** The retry is under way: Try again says so. */
  retrying?: boolean;
  className?: string;
}) {
  const reason = messageOf(error);
  return (
    <div role="alert" className={cn('flex flex-wrap items-center gap-x-4 gap-y-3', className)}>
      <p className="flex min-w-0 items-start gap-2 type-small text-danger">
        <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 break-words">
          {children}
          {children && reason ? ': ' : ''}
          {reason}
          {!children && !reason && 'Something went wrong'}
        </span>
      </p>
      {onRetry && (
        <Button size="small" icon={<RotateCw />} onClick={onRetry} pending={retrying} pendingLabel="Trying again…">
          Try again
        </Button>
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-ink-800', className)} />;
}

/** A bar as tall as a line of text in its type role, sitting on that line, so the skeleton is as tall as the text. */
function TextBar({ className }: { className?: string }) {
  return <span className={cn('inline-block h-[0.8em] animate-pulse rounded bg-ink-800 align-middle', className)} />;
}

/**
 * A card while it loads (an album, an artist, a playlist, a mix), the size of the real one: the cover, then its two
 * lines of text. In the grid (`GRID`) or on a shelf (`SHELF_CARD`), as many as fill the first screen.
 */
export function CardSkeleton({ round, className }: { round?: boolean; className?: string }) {
  return (
    <div aria-hidden className={cn(round && 'text-center', className)}>
      <Skeleton className={cn('aspect-square', round ? 'rounded-full' : 'rounded-cover')} />
      <div className="mt-3 type-body leading-snug">
        <TextBar className="w-3/4" />
      </div>
      <div className="type-small">
        <TextBar className="w-1/2" />
      </div>
    </div>
  );
}

/** A grid's first screen of cards while they load. */
export function CardSkeletons({ count = 12, round }: { count?: number; round?: boolean }) {
  return Array.from({ length: count }, (_, i) => <CardSkeleton key={i} round={round} />);
}

/**
 * Song rows while they load, each the height and spacing of the real row (components/SongRow.tsx): 60 with a cover,
 * 52 with a number (60 on touch screens), the length and the room for ♥ and ⋯ at the end.
 */
export function SongRowsSkeleton({ count = 8, lead = 'cover', className }: { count?: number; lead?: 'cover' | 'number'; className?: string }) {
  return (
    <div aria-busy="true" aria-label="Loading songs" className={cn('flex flex-col', className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} aria-hidden className="flex min-h-13 items-center gap-3 px-3 py-2 md:gap-4 pointer-coarse:min-h-15">
          {lead === 'cover' ? (
            <Skeleton className="size-11 shrink-0 rounded-cover" />
          ) : (
            <span className="grid w-8 shrink-0 place-items-center">
              <Skeleton className="h-3 w-3.5" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="type-body">
              <TextBar className={i % 3 === 0 ? 'w-2/5' : i % 3 === 1 ? 'w-1/2' : 'w-1/3'} />
            </div>
            {lead === 'cover' && (
              <div className="type-small">
                <TextBar className="w-1/4" />
              </div>
            )}
          </div>
          <Skeleton className="h-3 w-9 shrink-0" />
          <span className="size-11 shrink-0 pointer-fine:size-9" />
          <span className="size-11 shrink-0 pointer-fine:size-9" />
        </div>
      ))}
    </div>
  );
}
