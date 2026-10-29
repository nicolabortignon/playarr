import { HardDriveDownload } from 'lucide-react';
import { cn } from '../lib/cn';
import { formatBytes, plural } from '../lib/format';
import { canKeepOffline, clearOffline, keptBytes, OFFLINE_LIMITS, setOfflineLimit, useOffline, useWorkerReady } from '../player/offline';
import { SectionHeader } from './Section';

/** Library → On this device: what's kept, how much may be, and a way to free the space. */
export function OfflineStorage() {
  const songs = useOffline((s) => s.songs);
  const limit = useOffline((s) => s.limit);
  const count = Object.keys(songs).length;
  const used = keptBytes(songs);
  const ready = useWorkerReady();

  return (
    <section className="mt-12">
      <SectionHeader title="On this device" />
      {!canKeepOffline ? (
        <p className="max-w-prose text-sm text-muted">
          Playarr can keep the next songs in your queue on this device, so they start instantly and play without a connection. Browsers only
          allow that on a secure connection: open Playarr over HTTPS (or on localhost) to turn it on.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-md bg-ink-800 text-accent">
              <HardDriveDownload className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[17px] text-paper">{limit ? plural(count, 'song') : 'Off'}</span>
                {limit > 0 && (
                  <span className="font-mono text-[12px] text-muted tabular">
                    {formatBytes(used)} of {formatBytes(limit)}
                  </span>
                )}
              </div>
              {limit > 0 && (
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-paper/10" role="meter" aria-label="Space used" aria-valuenow={used} aria-valuemax={limit}>
                  <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} />
                </div>
              )}
            </div>
          </div>

          <p className="mt-4 max-w-prose text-sm text-muted">
            As you listen, the next songs in your queue are saved here, so they start instantly and keep playing without a connection. When
            space runs out, the songs you played longest ago make room.
          </p>
          {!ready && limit > 0 && (
            <p className="mt-2 max-w-prose text-sm text-paper-dim">
              {import.meta.env.DEV
                ? 'Paused: the dev server runs without the service worker that plays saved songs. Use a production build (pnpm build && pnpm preview).'
                : 'Starting up: reload Playarr to finish setting up offline songs.'}
            </p>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
            <span className="font-mono text-[11px] tracking-[0.2em] text-muted uppercase">Keep up to</span>
            <div role="radiogroup" aria-label="Space for songs on this device" className="flex flex-wrap gap-1.5">
              {OFFLINE_LIMITS.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={limit === value}
                  onClick={() => void setOfflineLimit(value)}
                  className={cn(
                    'h-8 rounded-full border px-3.5 font-mono text-[11px] tracking-wider uppercase transition',
                    limit === value ? 'border-accent bg-accent text-accent-ink' : 'border-line text-paper-dim hover:border-paper/25',
                  )}
                >
                  {value ? formatBytes(value) : 'Off'}
                </button>
              ))}
            </div>
            {count > 0 && (
              <button
                type="button"
                onClick={() => void clearOffline()}
                className="ml-auto font-mono text-[11px] tracking-[0.15em] text-muted uppercase transition hover:text-paper"
              >
                Remove all
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
