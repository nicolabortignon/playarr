import type { Track } from '@playarr/shared';
import { Heart } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn';
import { useIsFavorite, useToggleFavorite } from '../lib/queries';

interface FavoriteButtonProps {
  track: Track;
  size?: 'sm' | 'md' | 'lg';
  /** In list rows on pointer devices: only show an empty heart on hover. */
  reveal?: boolean;
  className?: string;
}

export function FavoriteButton({ track, size = 'sm', reveal, className }: FavoriteButtonProps) {
  const favorite = useIsFavorite(track.recordingId);
  const toggle = useToggleFavorite();
  const [popping, setPopping] = useState(false);
  const box = { sm: 'size-8', md: 'size-9', lg: 'size-12' }[size];
  // Only until healQueue() has refreshed tracks saved by an older version.
  if (!track.recordingId) return null;
  const icon = { sm: 'size-4', md: 'size-[18px]', lg: 'size-6' }[size];

  return (
    <button
      type="button"
      aria-label={favorite ? `Remove “${track.title}” from favorites` : `Add “${track.title}” to favorites`}
      aria-pressed={favorite}
      title={favorite ? 'Remove from favorites' : 'Add to favorites'}
      onClick={(e) => {
        e.stopPropagation();
        if (!favorite) setPopping(true);
        toggle.mutate({ track, favorite: !favorite });
      }}
      className={cn(
        'grid shrink-0 place-items-center rounded-full transition hover:bg-paper/8',
        box,
        favorite ? 'text-accent' : 'text-muted hover:text-paper',
        reveal && !favorite && 'md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100',
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
