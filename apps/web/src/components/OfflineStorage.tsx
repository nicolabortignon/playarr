import { HardDrive } from 'lucide-react';
import { useState } from 'react';
import { formatBytes, plural } from '../lib/format';
import { Link } from 'react-router';
import { canKeepOffline, clearOffline, keptBytes, OFFLINE_LIMITS, setOfflineLimit, splitKept, useOffline, useWorkerReady } from '../player/offline';
import { Button } from './Button';
import { Choice } from './Choice';
import { ConfirmDialog } from './Dialog';
import { SettingsSection } from './SettingsControls';

const LIMIT_OPTIONS = OFFLINE_LIMITS.map((value) => ({ value, label: value ? formatBytes(value) : 'Off' }));

/** Settings → Playback → On this device: what's kept, how much may be, and a way to free the space. */
export function OfflineStorage({ className }: { className?: string }) {
  const songs = useOffline((s) => s.songs);
  const limit = useOffline((s) => s.limit);
  const pins = useOffline((s) => s.pins);
  const { inDownloads, rest } = splitKept(songs, pins);
  const count = Object.keys(rest).length;
  const used = keptBytes(rest);
  const downloads = Object.keys(pins).length;
  const ready = useWorkerReady();
  const [confirming, setConfirming] = useState(false);
  // Songs only: transitions kept with downloads have ids below zero.
  const allSongs = Object.keys(songs).filter((id) => Number(id) > 0).length;

  return (
    <SettingsSection title="On this device" className={className}>
      {!canKeepOffline ? (
        <p className="max-w-prose type-small text-muted">
          Playarr can keep the next songs in your queue on this device, so they start instantly and play without a connection. Browsers only
          allow that on a secure connection: open Playarr over HTTPS (or on localhost) to turn it on.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-md bg-ink-800 text-accent">
              <HardDrive className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="type-body text-paper">{limit ? plural(count, 'song') : 'Off'}</span>
                {limit > 0 && (
                  <span className="type-meta text-muted">
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

          {downloads > 0 && (
            <p className="mt-4 type-small text-paper-dim">
              Plus{' '}
              <Link to="/downloads" className="text-accent hover:underline">
                {plural(downloads, 'download')}
              </Link>{' '}
              ({formatBytes(keptBytes(inDownloads))}), kept until you remove them.
            </p>
          )}
          <p className="mt-4 max-w-prose type-small text-muted">
            As you listen, the next songs in your queue are saved here, so they start instantly and keep playing without a connection. When
            space runs out, the songs you played longest ago make room.
          </p>
          {!ready && limit > 0 && (
            <p className="mt-2 max-w-prose type-small text-paper-dim">
              {import.meta.env.DEV
                ? 'Paused: the dev server runs without the service worker that plays saved songs. Use a production build (pnpm build && pnpm preview).'
                : 'Starting up: reload Playarr to finish setting up offline songs.'}
            </p>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
            <span className="type-kicker text-muted">Keep up to</span>
            <Choice
              label="Space for songs on this device"
              options={LIMIT_OPTIONS}
              value={limit}
              onChange={(value) => void setOfflineLimit(value)}
            />
            {(count > 0 || downloads > 0) && (
              <Button variant="ghost" size="small" className="ml-auto" onClick={() => setConfirming(true)}>
                Remove all
              </Button>
            )}
          </div>
          <ConfirmDialog
            open={confirming}
            onClose={() => setConfirming(false)}
            title={`Remove ${plural(allSongs, 'song')} from this device?`}
            confirmLabel="Remove all"
            onConfirm={() => {
              setConfirming(false);
              void clearOffline();
            }}
          >
            <p>{whatGoes(downloads, keptBytes(inDownloads), count, used)}</p>
            <p>Nothing leaves your library: anything can be downloaded again.</p>
          </ConfirmDialog>
        </>
      )}
    </SettingsSection>
  );
}

/** "2 downloads (1.2 GB) and 40 songs saved as you listened (310 MB) leave this device." */
function whatGoes(downloads: number, downloadBytes: number, saved: number, savedBytes: number): string {
  const parts = [
    ...(downloads ? [`${plural(downloads, 'download')} (${formatBytes(downloadBytes)})`] : []),
    ...(saved ? [`${plural(saved, 'song')} saved as you listened (${formatBytes(savedBytes)})`] : []),
  ];
  const one = parts.length === 1 && (downloads || saved) === 1;
  return `${parts.join(' and ')} ${one ? 'leaves' : 'leave'} this device.`;
}
