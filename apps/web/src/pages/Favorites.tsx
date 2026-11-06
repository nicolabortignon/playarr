import { Heart } from 'lucide-react';
import { ActionRow, usePlayState } from '../components/ActionRow';
import { DetailHeader, joinMeta } from '../components/DetailHeader';
import { queueItems } from '../components/menus';
import { EmptyState, ErrorState, SongRowsSkeleton } from '../components/States';
import { TrackList } from '../components/TrackList';
import { cn } from '../lib/cn';
import { formatDuration, plural } from '../lib/format';
import { useFavorites } from '../lib/queries';
import { useUI } from '../lib/ui';
import { usePlayer } from '../player/store';

export function FavoritesPage() {
  const { data: favorites, error, isPending, refetch } = useFavorites();
  const playTracks = usePlayer((s) => s.playTracks);
  const toggle = usePlayer((s) => s.toggle);
  const playState = usePlayState(FAVORITES.href);
  const openPicker = useUI((s) => s.openPlaylistPicker);
  const total = favorites?.reduce((sum, t) => sum + t.duration, 0) ?? 0;
  const songs = favorites ?? [];

  return (
    <div className="max-w-5xl px-5 pt-6 md:px-10 md:pt-14">
      <DetailHeader
        cover={<FavoritesCover className="w-full" />}
        kicker="Songs you love"
        title="Favorites"
        meta={favorites?.length ? joinMeta(plural(favorites.length, 'song'), formatDuration(total)) : undefined}
      >
        {/* Held in place (disabled) while the songs load, so nothing moves when they arrive. */}
        {(isPending || songs.length > 0) && (
          <ActionRow
            title="Favorites"
            disabled={!songs.length}
            state={playState}
            onPlay={() => (playState !== 'idle' ? toggle() : playTracks(songs, 0, { shuffle: false, source: FAVORITES }))}
            onShuffle={() => playTracks(songs, 0, { shuffle: true, source: FAVORITES })}
            download={{ item: { key: 'favorites', title: 'Favorites', subtitle: 'Your favorite songs', href: '/favorites' }, tracks: songs }}
            menu={{ label: 'More for Favorites', items: queueItems(songs, openPicker) }}
          />
        )}
      </DetailHeader>
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {isPending && <SongRowsSkeleton className="mt-6 -mx-3 md:mt-8" />}
      {favorites && favorites.length === 0 && (
        <EmptyState icon={Heart} title="Songs you heart land here." action={{ label: 'Find something to love', to: '/' }} />
      )}
      {favorites && favorites.length > 0 && (
        <div className="mt-6 -mx-3 md:mt-8">
          <TrackList tracks={favorites} variant="mixed" source={FAVORITES} />
        </div>
      )}
    </div>
  );
}

/** Favorites' cover, as it has no art of its own: a heart on a wash of the accent. */
function FavoritesCover({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        '@container grid aspect-square place-items-center overflow-hidden rounded-cover bg-gradient-to-br from-accent/55 via-accent/15 to-ink-850 shadow-cover-hero ring-1 ring-paper/10',
        className,
      )}
    >
      <Heart className="size-[34cqi] fill-paper text-paper" />
    </div>
  );
}

export const FAVORITES = { label: 'Favorites', href: '/favorites' };
