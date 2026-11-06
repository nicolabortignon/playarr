import type { Track } from '@playarr/shared';
import { Heart } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn';
import { useIsFavorite, useToggleFavorite } from '../lib/queries';

interface FavoriteButtonProps {
  track: Track;
  size?: 'sm' | 'md' | 'lg';
  /** In list rows on pointer devices: an empty heart shows only while the row is hovered or has the focus. */
  reveal?: boolean;
  className?: string;
}

export function FavoriteButton({ track, size = 'sm', reveal, className }: FavoriteButtonProps) {
  const favorite = useIsFavorite(track.recordingId);
  const toggle = useToggleFavorite();
  const [popping, setPopping] = useState(false);
  // An icon button (docs/design.md, Controls): 44 to tap on touch screens, 36 with a mouse; Now Playing's is 48.
  const box = { sm: 'size-11 pointer-fine:size-9', md: 'size-11 pointer-fine:size-9', lg: 'size-12' }[size];
  // Only until healQueue() has refreshed tracks saved by an older version.
  if (!track.recordingId) return null;
  const icon = { sm: 'size-4', md: 'size-[18px]', lg: 'size-6' }[size];

  return (
    <button
      type="button"
      aria-label={favorite ? `Remove “${track.title}” from Favorites` : `Add “${track.title}” to Favorites`}
      aria-pressed={favorite}
      title={favorite ? 'Remove from Favorites' : 'Add to Favorites'}
      onClick={(e) => {
        e.stopPropagation();
        if (!favorite) setPopping(true);
        toggle.mutate({ track, favorite: !favorite });
      }}
      className={cn(
        'grid shrink-0 place-items-center rounded-full transition hover:bg-paper/8',
        box,
        favorite ? 'text-accent' : 'text-muted hover:text-paper',
        reveal && !favorite && 'pointer-fine:opacity-0 pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100',
        className,
      )}
    >
      <Heart
        className={cn(icon, favorite && 'fill-current', popping && 'animate-pop')}
        onAnimationEnd={() => setPopping(false)}
        strokeWidth={favorite ? 2 : 1.75}
      />
    </button>
  );
}
