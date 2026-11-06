import { Heart, ListEnd, ListMusic, ListPlus } from 'lucide-react';
import { ActionRow, usePlayState } from '../components/ActionRow';
import { ErrorState, Skeleton } from '../components/Section';
import { TrackList } from '../components/TrackList';
import { formatDuration, plural } from '../lib/format';
import { useFavorites } from '../lib/queries';
import { useUI } from '../lib/ui';
import { queueTracks } from '../player/actions';
import { usePlayer } from '../player/store';
import { PageTitle } from './Albums';

export function FavoritesPage() {
  const { data: favorites, error, isPending, refetch } = useFavorites();
  const playTracks = usePlayer((s) => s.playTracks);
  const toggle = usePlayer((s) => s.toggle);
  const playState = usePlayState(FAVORITES.href);
  const openPicker = useUI((s) => s.openPlaylistPicker);
  const total = favorites?.reduce((sum, t) => sum + t.duration, 0) ?? 0;

  return (
    <div className="max-w-5xl px-5 pt-8 md:px-10 md:pt-14">
      <PageTitle title="Favorites" count={favorites?.length} />
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {isPending && (
        <div className="space-y-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      )}
      {favorites && favorites.length === 0 && (
        <div className="mt-16 max-w-md">
          <Heart className="size-10 text-ink-600" strokeWidth={1.5} />
          <p className="mt-4 font-display text-3xl text-paper">Nothing hearted yet.</p>
          <p className="mt-2 text-sm text-muted">
            Tap the heart next to any song: in an album, the queue, the player or Now Playing. It shows up here, on every
            device.
          </p>
        </div>
      )}
      {favorites && favorites.length > 0 && (
        <>
          <p className="-mt-4 type-meta text-muted md:-mt-6">
            {plural(favorites.length, 'song')} · {formatDuration(total)}
          </p>
          <ActionRow
            className="mt-6 mb-8"
            title="Favorites"
            state={playState}
            onPlay={() => (playState !== 'idle' ? toggle() : playTracks(favorites, 0, { shuffle: false, source: FAVORITES }))}
            onShuffle={() => playTracks(favorites, 0, { shuffle: true, source: FAVORITES })}
            download={{ item: { key: 'favorites', title: 'Favorites', subtitle: 'Your favorite songs', href: '/favorites' }, tracks: favorites }}
            menu={{
              items: [
                { label: 'Play next', icon: ListPlus, onSelect: () => queueTracks(favorites, 'next') },
                { label: 'Add to queue', icon: ListEnd, onSelect: () => queueTracks(favorites, 'end') },
                { label: 'Add to playlist…', icon: ListMusic, onSelect: () => openPicker(favorites) },
              ],
            }}
          />
          <div className="-mx-3">
            <TrackList tracks={favorites} variant="mixed" source={FAVORITES} />
          </div>
        </>
      )}
    </div>
  );
}

export const FAVORITES = { label: 'Favorites', href: '/favorites' };
