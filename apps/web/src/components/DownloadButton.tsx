import type { Track } from '@playarr/shared';
import { ArrowDownToLine, CircleCheck } from 'lucide-react';
import { useEffect } from 'react';
import { toast } from '../lib/toast';
import { addDownload, canKeepOffline, downloadProgress, removeDownload, useOffline, type Download } from '../player/offline';
import { IconButton } from './Button';

const R = 9;
const CIRCUMFERENCE = 2 * Math.PI * R;

/**
 * Download an album, playlist, mix or Favorites to this device, to play without a connection: the action row's
 * outlined icon button, whose ring fills as songs arrive and ends in a tick. Tapped again, it removes the download.
 */
export function DownloadButton({ item, tracks, className }: { item: Omit<Download, 'tracks' | 'addedAt'>; tracks: Track[]; className?: string }) {
  const pin = useOffline((s) => s.pins[item.key]);
  const progress = useOffline((s) => (pin ? downloadProgress(pin, s.songs) : null));
  const songs = tracks.filter((t) => t.fileId);

  // A playlist edited (or an album changed) since it was downloaded: download what it has now.
  const signature = songs.map((t) => t.fileId).join(',');
  useEffect(() => {
    if (pin && pin.tracks.map((t) => t.fileId).join(',') !== signature) addDownload({ ...item, tracks: songs });
  }, [pin, signature]);

  const toggle = () => {
    if (!canKeepOffline) {
      toast('Downloads need Playarr opened over HTTPS: see Settings → Playback → On this device', 'error');
      return;
    }
    if (pin) {
      void removeDownload(item.key);
      toast(`${item.title} removed from this device`);
    } else {
      addDownload({ ...item, tracks: songs });
      toast(`Downloading ${item.title}`);
    }
  };

  const done = progress && progress.done === progress.total;
  const label = !pin ? 'Download' : done ? 'Downloaded' : `Downloading, ${progress!.done} of ${progress!.total}`;
  return (
    <IconButton
      size="large"
      label={pin ? `${label}: remove ${item.title} from this device` : `Download ${item.title}`}
      onClick={toggle}
      disabled={!songs.length}
      aria-pressed={!!pin}
      title={label}
      className={className}
    >
      {!pin ? (
        <ArrowDownToLine className="size-5" />
      ) : done ? (
        <CircleCheck className="size-5 text-success" />
      ) : (
        <svg viewBox="0 0 22 22" className="size-5.5 -rotate-90" aria-hidden>
          <circle cx="11" cy="11" r={R} fill="none" strokeWidth="2" className="stroke-paper/15" />
          <circle
            cx="11"
            cy="11"
            r={R}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${CIRCUMFERENCE * (progress!.total ? progress!.done / progress!.total : 0)} ${CIRCUMFERENCE}`}
            className="stroke-accent transition-[stroke-dasharray] duration-300"
          />
        </svg>
      )}
    </IconButton>
  );
}
