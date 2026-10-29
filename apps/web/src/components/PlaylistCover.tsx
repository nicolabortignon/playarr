import type { PlaylistCoverInfo } from '@playarr/shared';
import { useState } from 'react';
import { sized } from '../lib/api';
import { cn } from '../lib/cn';

/** Below this size the title would be unreadable, and lists show the name next to the cover anyway. */
const TITLE_MIN_SIZE = 120;

/**
 * The playlist's generated artwork (drawn by the server from what its songs sound like), with
 * its title on cards and headers. When the URL changes (a new cover, a rename), the previous
 * image stays up until the next has loaded.
 */
export function PlaylistCover({ cover, size, name, className }: { cover: PlaylistCoverInfo; size: number; name: string; className?: string }) {
  const url = `${sized(cover.url, size)!}${size < TITLE_MIN_SIZE ? '&title=0' : ''}`;
  const [shown, setShown] = useState<string>();
  return (
    <div role="img" aria-label={name} className={cn('relative aspect-square overflow-hidden bg-ink-800', className)}>
      {shown && shown !== url && <img src={shown} alt="" draggable={false} className="absolute inset-0 size-full" />}
      <img
        key={url}
        src={url}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => setShown(url)}
        className={cn('absolute inset-0 size-full transition-opacity duration-700', shown === url ? 'opacity-100' : 'opacity-0')}
      />
    </div>
  );
}
