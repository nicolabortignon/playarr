import type { Lyrics, Track } from '@playarr/shared';
import { useEffect, useRef } from 'react';
import { cn } from '../lib/cn';
import { useLyrics } from '../lib/queries';
import { useClock } from '../player/store';

/** The line being sung at `time`: the last that started; -1 before the first. */
export function lineAt(lines: { at: number }[], time: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.at <= time + 0.15) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Now Playing → Lyrics: the words of the song playing, following along when they're timed. */
export function LyricsView({ track, className }: { track: Track; className?: string }) {
  const { data, isPending, isError } = useLyrics(track.id);
  return (
    <div className={cn('relative h-full min-h-0 w-full', className)}>
      {isPending ? (
        <div aria-busy="true" aria-label="Loading lyrics" className="space-y-4 pt-10">
          {[70, 85, 55, 78].map((w) => (
            <div key={w} className="h-7 animate-pulse rounded bg-paper/10" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : isError ? (
        <Notice>Lyrics are unavailable right now.</Notice>
      ) : !data ? (
        <Notice>No lyrics found for this song.</Notice>
      ) : data.instrumental ? (
        <Notice>Instrumental</Notice>
      ) : data.synced ? (
        <Synced lines={data.synced} source={data.source} />
      ) : (
        <div className="h-full overflow-y-auto overscroll-contain py-8 [mask-image:linear-gradient(transparent,black_6%,black_94%,transparent)]">
          <p className="font-display text-2xl leading-snug whitespace-pre-line text-paper md:text-3xl">{data.plain}</p>
          <Credit source={data.source} />
        </div>
      )}
    </div>
  );
}

function Synced({ lines, source }: { lines: NonNullable<Lyrics['synced']>; source: Lyrics['source'] }) {
  const current = useClock((s) => lineAt(lines, s.time));
  const box = useRef<HTMLDivElement>(null);
  /** Following pauses for a few seconds after scrolling by hand. */
  const touchedAt = useRef(0);

  useEffect(() => {
    if (Date.now() - touchedAt.current < 4000) return;
    const line = box.current?.querySelector<HTMLElement>(`[data-line="${Math.max(0, current)}"]`);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    line?.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }, [current]);

  const touched = () => (touchedAt.current = Date.now());
  return (
    <div
      ref={box}
      onWheel={touched}
      onTouchMove={touched}
      className="h-full overflow-y-auto overscroll-contain py-[40%] [mask-image:linear-gradient(transparent,black_15%,black_85%,transparent)]"
    >
      <ol className="space-y-3">
        {lines.map((line, i) => (
          <li key={i} data-line={i}>
            <button
              type="button"
              onClick={() => useClock.getState().seek(line.at)}
              aria-current={i === current || undefined}
              className={cn(
                'text-left font-display text-2xl leading-snug transition-[color,opacity] duration-300 md:text-[2rem]',
                i === current ? 'text-paper' : i < current ? 'text-paper/35 hover:text-paper/70' : 'text-paper/55 hover:text-paper/80',
              )}
            >
              {line.text || '♪'}
            </button>
          </li>
        ))}
      </ol>
      <Credit source={source} />
    </div>
  );
}

function Credit({ source }: { source: Lyrics['source'] }) {
  return (
    <p className="mt-8 font-mono text-[10px] tracking-[0.2em] text-muted uppercase">
      {source === 'lrclib' ? (
        <>
          Lyrics from{' '}
          <a href="https://lrclib.net" target="_blank" rel="noreferrer" className="hover:text-paper">
            LRCLIB
          </a>
        </>
      ) : (
        'Lyrics from the file'
      )}
    </p>
  );
}

function Notice({ children }: { children: string }) {
  return <p className="grid h-full place-items-center text-center font-display text-xl text-paper-dim">{children}</p>;
}
