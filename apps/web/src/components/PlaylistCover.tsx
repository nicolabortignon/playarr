import type { PlaylistCoverInfo } from '@playarr/shared';
import { useState } from 'react';
import { sized } from '../lib/api';
import { cn } from '../lib/cn';

/**
 * The playlist's generated artwork (drawn by the server from what its songs sound like).
 * The URL changes as songs get analyzed; the previous version stays up until the next has loaded.
 */
export function PlaylistCover({ cover, size, name, className }: { cover: PlaylistCoverInfo; size: number; name: string; className?: string }) {
  const url = sized(cover.url, size)!;
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
